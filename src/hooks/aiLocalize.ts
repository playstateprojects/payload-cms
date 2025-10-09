// src/payload/hooks/aiLocalize.ts
import type { Payload, RequestContext } from 'payload'
import type { AfterChangeHook } from 'payload/dist/globals/config/types'
import type { AfterChangeHook as CollectionAfterChangeHook } from 'payload/types'

type ClientOpts = {
  baseURL?: string // e.g. 'https://api.deepseek.com' (OpenAI-compatible)
  apiKey: string
  model: string // e.g. 'deepseek-chat', 'deepseek-reasoner', etc.
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

type LocalizeConfig = {
  fields: string[] // localized field names to fill (e.g., ['label','description'])
  sourceLocale?: string // default 'en'
  targetLocales?: string[] // if omitted, use all configured locales except source
  guardFlagField?: string // optional boolean field (e.g. 'autoLocalize') to gate the hook
  dryRun?: boolean // if true, logs but does not write back
}

const HEADER_GUARD = 'x-ai-localize' // prevents recursion

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
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: opts.temperature ?? 0.2,
        response_format: { type: 'json_object' },
        // Some OpenAI-compatible impls ignore this; harmless if unsupported:
        max_tokens: opts.maxTokens ?? 512,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`LLM error ${res.status}: ${txt}`)
    }
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
  sourceValues: Record<string, string>
  extraContext?: Record<string, any>
}) {
  const { collection, sourceLocale, targetLocale, fields, sourceValues, extraContext } = params

  const sys = [
    `You fill missing localized fields for a CMS.`,
    `Return a strict JSON object with exactly these keys: ${fields.map((f) => `"${f}"`).join(', ')}.`,
    `Preserve meaning, tone, and domain terms.`,
    `Keep placeholders like {name}, {count}, %{var} unchanged.`,
    `Do not invent data if the source is empty; return an empty string for that key.`,
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

  const user = JSON.stringify(userObj, null, 2)
  return { sys, user }
}

/**
 * Create an afterChange hook for a collection that:
 * - Detects empty localized fields in target locales
 * - Calls a JSON-only LLM to generate translations
 * - Writes back ONLY the missing locales
 *
 * Usage (in a collection): hooks.afterChange.push(aiLocalizeCollection({...}))
 */
export function aiLocalizeCollection(
  client: ClientOpts,
  config: LocalizeConfig,
): CollectionAfterChangeHook {
  return async ({ req, doc, previousDoc, collection, operation, context }) => {
    // Avoid recursion when we write back via payload.update
    if (req.headers?.[HEADER_GUARD] === '1') return doc

    const payload = req.payload as Payload
    const localesCfg = payload.config.localization
    if (!localesCfg) return doc // localization must be enabled

    const sourceLocale = config.sourceLocale || localesCfg.defaultLocale || 'en'
    // Payload locales can be strings or objects with a 'code' property
    const allLocales = (localesCfg.locales as any[]).map((l) =>
      typeof l === 'string' ? l : l.code,
    )
    const targetLocales =
      config.targetLocales && config.targetLocales.length > 0
        ? config.targetLocales
        : allLocales.filter((l) => l !== sourceLocale)

    // Optional per-doc gate
    if (config.guardFlagField && doc?.[config.guardFlagField] === false) return doc

    // Detect which locale actually has content
    // When fields are plain strings, they represent the req.locale's value
    let actualSourceLocale = sourceLocale
    const sourceValues: Record<string, string> = {}

    // Check if fields are plain strings (locale-specific view) or objects (all-locale view)
    const firstField = config.fields[0]
    const firstValue = doc?.[firstField]
    const isLocalizedView = typeof firstValue === 'string'

    if (isLocalizedView) {
      // Fields are plain strings - this means we're in a specific locale context
      // Use req.locale as the actual source locale
      actualSourceLocale = req.locale || sourceLocale
      for (const f of config.fields) {
        sourceValues[f] = (doc?.[f] ?? '').toString()
      }
      console.log(
        `[aiLocalize] ${collection.slug}#${doc.id} - detected locale context: ${actualSourceLocale}`,
      )
    } else {
      // Fields are objects with locale keys - we need to find which locale has content
      // First, try the configured sourceLocale
      for (const f of config.fields) {
        const v = doc?.[f]
        if (typeof v === 'object' && v !== null) {
          sourceValues[f] = (v[sourceLocale] ?? '').toString()
        } else {
          sourceValues[f] = ''
        }
      }

      // If configured sourceLocale is empty, try to find any locale with content
      const hasSourceContent = Object.values(sourceValues).some((s) => (s || '').trim().length > 0)
      if (!hasSourceContent) {
        for (const locale of allLocales) {
          const testValues: Record<string, string> = {}
          for (const f of config.fields) {
            const v = doc?.[f]
            if (typeof v === 'object' && v !== null) {
              testValues[f] = (v[locale] ?? '').toString()
            } else {
              testValues[f] = ''
            }
          }
          const hasContent = Object.values(testValues).some((s) => (s || '').trim().length > 0)
          if (hasContent) {
            actualSourceLocale = locale
            Object.assign(sourceValues, testValues)
            console.log(
              `[aiLocalize] ${collection.slug}#${doc.id} - detected actual source locale: ${actualSourceLocale}`,
            )
            break
          }
        }
      }
    }

    // Early exit if still no source text at all
    const hasAnySource = Object.values(sourceValues).some((s) => (s || '').trim().length > 0)
    if (!hasAnySource) {
      console.log(`[aiLocalize] ${collection.slug}#${doc.id} - no source text found in any locale`)
      return doc
    }

    console.log(
      `[aiLocalize] ${collection.slug}#${doc.id} - sourceLocale: ${actualSourceLocale}, sourceValues:`,
      sourceValues,
    )

    // For each target locale (excluding the actual source), detect missing/empty fields
    const toFill: Array<{ locale: string; fieldsMissing: string[] }> = []
    const localesNeedingTranslation = allLocales.filter((l) => l !== actualSourceLocale)

    for (const locale of localesNeedingTranslation) {
      const fieldsMissing: string[] = []
      for (const f of config.fields) {
        const v = doc?.[f]
        const val = typeof v === 'object' && v !== null ? (v[locale] ?? '') : '' // non-localized field cannot be localized; treat as missing
        if (!val || String(val).trim() === '') fieldsMissing.push(f)
      }
      if (fieldsMissing.length) toFill.push({ locale, fieldsMissing })
    }

    console.log(`[aiLocalize] ${collection.slug}#${doc.id} - toFill:`, toFill)

    if (!toFill.length) return doc

    // Optional extra context to improve quality (you can tailor per collection)
    const extraContext = {
      collection: collection.slug,
      knownKeys: config.fields,
      hints: {
        // add domain hints here if desired
      },
    }

    // Fill each locale separately
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

        // Sanitize result: ensure only requested keys
        const patch: Record<string, any> = {}
        for (const f of fieldsMissing) {
          const proposed = (result?.[f] ?? '').toString()
          // When updating with a specific locale, send just the value, not the localized object
          patch[f] = proposed
        }

        console.log(
          `[aiLocalize] ${collection.slug}#${doc.id} ${actualSourceLocale}->${locale} patch:`,
          patch,
        )

        if (config.dryRun) {
          console.log(`[aiLocalize][dryRun] ${collection.slug}#${doc.id} -> ${locale}`, patch)
          continue
        }

        // Write back to that locale ONLY (prevents version thrash)
        await (req.payload as Payload).update({
          collection: collection.slug,
          id: doc.id,
          locale,
          data: patch,
          depth: 0,
          context: { ...(context as RequestContext), [HEADER_GUARD]: '1' },
          overrideAccess: true,
          // Prevent our own hook from re-firing recursively:
          req: { ...req, headers: { ...(req.headers || {}), [HEADER_GUARD]: '1' } } as any,
        })
      } catch (err) {
        console.error(
          `[aiLocalize] ${collection.slug}#${doc.id} ${actualSourceLocale}->${locale} failed`,
          err,
        )
        // continue with other locales; don't throw
      }
    }

    return doc
  }
}
