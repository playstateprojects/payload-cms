// src/payload/hooks/aiLocalize.ts
import type { Payload, RequestContext } from 'payload'
import type { AfterChangeHook as CollectionAfterChangeHook } from 'payload/types'

type ClientOpts = {
  baseURL?: string
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

type LocalizeConfig = {
  fields?: string[]
  /** Optional. If omitted, the hook auto-detects the best source locale by content */
  sourceLocale?: string
  /** Optional. If omitted, targets are all locales except source */
  targetLocales?: string[]
  /** Optional boolean field name on the doc to gate the hook (false disables) */
  guardFlagField?: string
  /** If true, log patches but don't write */
  dryRun?: boolean
  /** If true, skip writing when the target richText looks like Slate */
  skipIfSlateTarget?: boolean
}

const HEADER_GUARD = 'x-ai-localize'

// ---------- utils ----------
type FieldMeta = { type: 'text' | 'textarea' | 'richText' }
type FieldMap = Map<string, FieldMeta>

/** Build both: list of localized fields AND a map of their types */
function detectLocalizedFieldsWithMeta(collection: any): { fields: string[]; meta: FieldMap } {
  const fields: string[] = []
  const meta: FieldMap = new Map()

  function visit(arr: any[], prefix = ''): void {
    for (const field of arr || []) {
      const name = field?.name
      const hasName = !!name
      const path = hasName ? (prefix ? `${prefix}.${name}` : name) : prefix

      // record if it's a localized content field
      if (
        hasName &&
        field.localized === true &&
        (field.type === 'text' || field.type === 'textarea' || field.type === 'richText')
      ) {
        fields.push(path)
        meta.set(path, { type: field.type })
      }

      // dive into children
      if (field?.fields) visit(field.fields, hasName ? path : prefix)
      if (field?.blocks) {
        for (const b of field.blocks || []) {
          visit(b.fields || [], hasName ? `${path}.${b.slug}` : prefix)
        }
      }
    }
  }

  visit(collection.config?.fields || collection.fields || [])
  return { fields, meta }
}

function getByPath(obj: any, path: string) {
  if (!obj) return undefined
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj)
}

function setByPath(target: any, path: string, value: any) {
  const parts = path.split('.')
  let node = target
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (typeof node[p] !== 'object' || node[p] == null) node[p] = {}
    node = node[p]
  }
  node[parts[parts.length - 1]] = value
}

/** ------- RichText helpers ------- **/
function looksLikeSlate(val: any): boolean {
  return Array.isArray(val) && val.every((n) => typeof n === 'object' && n != null && !!n.type)
}

function looksLikeLexical(val: any): boolean {
  return !!val && typeof val === 'object' && !!val.root && val.root.type === 'root'
}

// Flatten Slate to plain text for prompting
function slateToPlain(val: any): string {
  if (!Array.isArray(val)) return ''
  const collect = (node: any): string => {
    if (!node || typeof node !== 'object') return ''
    if (typeof node.text === 'string') return node.text
    if (Array.isArray(node.children)) return node.children.map(collect).join('')
    return ''
  }
  return val
    .map(collect)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Flatten Lexical to plain text for prompting
function lexicalToPlain(val: any): string {
  if (!val?.root?.children) return ''
  const walk = (nodes: any[]): string =>
    nodes
      .map((n) => {
        if (n.type === 'text' && typeof n.text === 'string') return n.text
        if (Array.isArray(n.children)) return walk(n.children)
        if (n.type === 'linebreak') return '\n'
        return ''
      })
      .join('')
  return walk(val.root.children)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Clone structure and replace only text content
function translateLexicalContent(source: any, translatedText: string): any {
  if (!source?.root) return source

  // Deep clone the source structure
  const result = JSON.parse(JSON.stringify(source))

  // Extract all text nodes in order
  const textNodes: any[] = []
  const findTextNodes = (nodes: any[]) => {
    for (const node of nodes || []) {
      if (node.type === 'text') {
        textNodes.push(node)
      }
      if (node.children) {
        findTextNodes(node.children)
      }
    }
  }
  findTextNodes(result.root.children)

  // Replace text content with translated text
  // Simple approach: replace all text with the translated string in first text node
  if (textNodes.length > 0) {
    textNodes[0].text = translatedText
    // Clear other text nodes if multiple exist
    for (let i = 1; i < textNodes.length; i++) {
      textNodes[i].text = ''
    }
  }

  return result
}

function translateSlateContent(source: any, translatedText: string): any {
  if (!Array.isArray(source)) return source

  // Deep clone the source structure
  const result = JSON.parse(JSON.stringify(source))

  // Extract all text nodes
  const textNodes: any[] = []
  const findTextNodes = (nodes: any[]) => {
    for (const node of nodes || []) {
      if (node.text !== undefined) {
        textNodes.push(node)
      }
      if (node.children) {
        findTextNodes(node.children)
      }
    }
  }
  findTextNodes(result)

  // Replace text content
  if (textNodes.length > 0) {
    textNodes[0].text = translatedText
    for (let i = 1; i < textNodes.length; i++) {
      textNodes[i].text = ''
    }
  }

  return result
}

async function callJSONModel<T = any>(
  opts: ClientOpts,
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000)
  try {
    const res = await fetch(`${opts.baseURL || 'https://api.openai.com'}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: opts.temperature ?? 0.2,
        response_format: { type: 'json_object' },
        max_tokens: opts.maxTokens ?? 512,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`LLM error ${res.status}: ${await res.text().catch(() => '')}`)
    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content
    if (!content) throw new Error('Empty LLM response')
    return JSON.parse(content) as T
  } finally {
    clearTimeout(id)
  }
}

function buildPrompt(params: {
  collection: string
  sourceLocale: string
  targetLocale: string
  fields: string[]
  sourceValues: Record<string, string> // all values are plain strings here, richText already flattened
  extraContext?: Record<string, any>
}) {
  const { collection, sourceLocale, targetLocale, fields, sourceValues, extraContext } = params
  const sys = [
    `You fill missing localized fields for a CMS.`,
    `Return a strict JSON object with exactly these keys: ${fields.map((f) => `"${f}"`).join(', ')}.`,
    `Preserve meaning, tone, and domain terms.`,
    `Keep placeholders like {name}, {count}, %{var} unchanged.`,
    `If a source key is empty, return an empty string for that key.`,
    `No markdown. No extra keys. No explanations.`,
  ].join(' ')
  const userObj: any = {
    task: 'localize',
    collection,
    from: sourceLocale,
    to: targetLocale,
    source: sourceValues,
  }
  if (extraContext) userObj.context = extraContext
  return { sys, user: JSON.stringify(userObj, null, 2) }
}

function contentScore(
  docAllLocales: any,
  fields: string[],
  locale: string,
  meta: FieldMap,
): number {
  let score = 0
  for (const f of fields) {
    const v = getByPath(docAllLocales, f)
    const val = typeof v === 'object' && v !== null ? v[locale] : v
    if (typeof val === 'string' && val.trim().length > 0) {
      score += 1
      continue
    }
    if (looksLikeSlate(val) && slateToPlain(val).length > 0) {
      score += 1
      continue
    }
    if (looksLikeLexical(val) && lexicalToPlain(val).length > 0) {
      score += 1
      continue
    }
  }
  return score
}

// ---------- hook ----------
export function aiLocalizeCollection(
  client: ClientOpts,
  config: LocalizeConfig = {},
): CollectionAfterChangeHook {
  const skipIfSlateTarget = config.skipIfSlateTarget ?? true

  return async ({ req, doc, collection, context }) => {
    if (req.headers?.[HEADER_GUARD] === '1') return doc

    const payload = req.payload as Payload
    const localesCfg = payload.config.localization
    if (!localesCfg) return doc

    const { fields: fieldsToLocalize, meta: fieldMeta } = detectLocalizedFieldsWithMeta(collection)
    if (!fieldsToLocalize.length) return doc

    const defaultLocale =
      config.sourceLocale ||
      (typeof localesCfg.defaultLocale === 'string'
        ? localesCfg.defaultLocale
        : (localesCfg.defaultLocale as any)?.code) ||
      'en'

    const allLocales = (localesCfg.locales as any[]).map((l) =>
      typeof l === 'string' ? l : l.code,
    )
    const requestedTargets = config.targetLocales?.length ? config.targetLocales : allLocales

    if (config.guardFlagField && doc?.[config.guardFlagField] === false) return doc

    // ensure all-locale view if needed
    const firstVal = getByPath(doc, fieldsToLocalize[0])
    const localizedView =
      typeof firstVal === 'string' || Array.isArray(firstVal) || looksLikeLexical(firstVal)
    const docAllLocales = localizedView
      ? await payload.findByID({ collection: collection.slug, id: doc.id, depth: 0, locale: 'all' })
      : doc

    // auto-pick source
    const scores = Object.fromEntries(
      allLocales.map((l) => [l, contentScore(docAllLocales, fieldsToLocalize, l, fieldMeta)]),
    )
    const bestLocale = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]?.[0]
    const actualSourceLocale = config.sourceLocale
      ? scores[config.sourceLocale] > 0
        ? config.sourceLocale
        : bestLocale || defaultLocale
      : scores[bestLocale!] > 0
        ? bestLocale!
        : defaultLocale

    // flatten sources to strings for the LLM + store original richText structures
    const sourceValues: Record<string, string> = {}
    const sourceRichTextStructures: Record<string, any> = {}
    for (const f of fieldsToLocalize) {
      const v = getByPath(docAllLocales, f)
      const val = typeof v === 'object' && v !== null ? v[actualSourceLocale] : v
      const kind = fieldMeta.get(f)?.type
      if (kind === 'richText') {
        if (looksLikeSlate(val)) {
          sourceValues[f] = slateToPlain(val)
          sourceRichTextStructures[f] = { type: 'slate', structure: val }
        } else if (looksLikeLexical(val)) {
          sourceValues[f] = lexicalToPlain(val)
          sourceRichTextStructures[f] = { type: 'lexical', structure: val }
        } else {
          sourceValues[f] = typeof val === 'string' ? val : ''
        }
      } else {
        sourceValues[f] = typeof val === 'string' ? val : ''
      }
    }
    if (!Object.values(sourceValues).some((s) => (s || '').trim().length > 0)) return doc

    // compute missing per target
    const targets = requestedTargets.filter((l) => l !== actualSourceLocale)
    const toFill: Array<{ locale: string; fieldsMissing: string[] }> = []
    for (const locale of targets) {
      const fieldsMissing: string[] = []
      for (const f of fieldsToLocalize) {
        const v = getByPath(docAllLocales, f)
        const val = typeof v === 'object' && v !== null ? v[locale] : undefined
        const kind = fieldMeta.get(f)?.type
        let empty = false
        if (kind === 'richText') {
          if (val == null) empty = true
          else if (looksLikeSlate(val)) empty = slateToPlain(val).trim().length === 0
          else if (looksLikeLexical(val)) empty = lexicalToPlain(val).trim().length === 0
          else if (Array.isArray(val)) empty = val.length === 0
          else if (typeof val === 'string') empty = val.trim().length === 0
          else empty = true
        } else {
          empty =
            val == null ||
            (typeof val === 'string' && val.trim() === '') ||
            (Array.isArray(val) && val.length === 0)
        }
        if (empty) fieldsMissing.push(f)
      }
      if (fieldsMissing.length) toFill.push({ locale, fieldsMissing })
    }
    if (!toFill.length) return doc

    const extraContext = { collection: collection.slug, knownKeys: config.fields, hints: {} }

    for (const { locale, fieldsMissing } of toFill) {
      const { sys, user } = buildPrompt({
        collection: collection.slug,
        sourceLocale: actualSourceLocale,
        targetLocale: locale,
        fields: fieldsMissing,
        sourceValues,
        extraContext,
      })

      try {
        const result = await callJSONModel<Record<string, string>>(client, sys, user)

        // Build nested patch object for this locale
        const patch: Record<string, any> = {}

        for (const f of fieldsMissing) {
          const proposed = (result?.[f] ?? '').toString()
          const kind = fieldMeta.get(f)?.type

          if (kind === 'richText') {
            const richTextMeta = sourceRichTextStructures[f]

            if (richTextMeta) {
              // Use the source structure and replace only text content
              if (richTextMeta.type === 'lexical') {
                setByPath(patch, f, translateLexicalContent(richTextMeta.structure, proposed))
              } else if (richTextMeta.type === 'slate') {
                setByPath(patch, f, translateSlateContent(richTextMeta.structure, proposed))
              } else {
                setByPath(patch, f, proposed)
              }
            } else {
              // Fallback if no structure found
              setByPath(patch, f, proposed)
            }
          } else {
            setByPath(patch, f, proposed)
          }
        }

        if (Object.keys(patch).length === 0) {
          // nothing to write (e.g., all skipped due to Slate)
          continue
        }

        if (config.dryRun) {
          console.log(`[aiLocalize][dryRun] ${collection.slug}#${doc.id} -> ${locale}`, patch)
          continue
        }

        await payload.update({
          collection: collection.slug,
          id: doc.id,
          locale,
          data: patch,
          depth: 0,
          overrideAccess: true,
          context: { ...(context as RequestContext), [HEADER_GUARD]: '1' },
          req: { ...req, headers: { ...(req.headers || {}), [HEADER_GUARD]: '1' } } as any,
        })
      } catch (err) {
        console.error(
          `[aiLocalize] ${collection.slug}#${doc.id} ${actualSourceLocale}->${locale} failed`,
          err,
        )
      }
    }

    return doc
  }
}
