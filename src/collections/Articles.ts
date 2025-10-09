// src/payload/collections/Articles.ts
import type { CollectionConfig } from 'payload'
import { aiLocalizeCollection } from '../hooks/aiLocalize'

// Tiny slugify (no external dep)
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 120)

export const Articles: CollectionConfig = {
  slug: 'articles',
  labels: { singular: 'Article', plural: 'Articles' },
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug', 'publishDate', 'author', 'reviewStatus', 'updatedAt'],
    group: 'Content',
  },
  access: { read: () => true },

  fields: [
    // Title — localized
    {
      name: 'title',
      type: 'text',
      required: true,
      localized: true,
    },

    // Slug — NOT localized (single canonical URL)
    {
      name: 'slug',
      type: 'text',
      unique: true,
      index: true as any, // supported in Prisma adapter; harmless otherwise
      localized: false,
      admin: { description: 'Auto-filled from Title if left blank.' },
    },

    // Hero image — NOT localized
    {
      name: 'heroImage',
      label: 'Hero image',
      type: 'upload',
      relationTo: 'media', // ensure you have a Media collection with uploads enabled
      localized: false,
    },

    // Publish date — NOT localized
    {
      name: 'publishDate',
      label: 'Publish date',
      type: 'date',
      admin: { date: { pickerAppearance: 'dayAndTime' } },
      localized: false,
    },

    // Author — NOT localized
    {
      name: 'author',
      label: 'Author',
      type: 'text',
      localized: false,
    },

    // Review Status — NOT localized
    {
      name: 'reviewStatus',
      label: 'Review Status',
      type: 'text',
      localized: false,
      admin: { width: '33%' },
    },
  ],

  hooks: {
    // Auto-generate slug from default-locale title if missing
    beforeValidate: [
      ({ data, req }) => {
        if (!data) return
        if (!data.slug || String(data.slug).trim() === '') {
          const defaultLocale = req.payload.config.localization?.defaultLocale || 'en'
          const title =
            (typeof data.title === 'object' ? data.title?.[defaultLocale] : data.title) || ''
          if (title) data.slug = slugify(title)
        } else {
          data.slug = slugify(String(data.slug))
        }
      },
    ],
    afterChange: [
      //   async ({ doc, operation }) => {
      //     // Optional: fire a webhook to your Cloudflare Worker to invalidate cache
      //     if (!process.env.OPTIONS_WEBHOOK_URL) return
      //     try {
      //       const body = JSON.stringify({
      //         event: 'space-types.updated',
      //         operation,
      //         key: doc.key,
      //       })
      //       await fetch(process.env.OPTIONS_WEBHOOK_URL, {
      //         method: 'POST',
      //         headers: { 'Content-Type': 'application/json' },
      //         body,
      //       })
      //     } catch (err) {
      //       console.error('Webhook failed', err)
      //     }
      //   },
      aiLocalizeCollection(
        {
          baseURL: 'https://api.deepseek.com', // e.g. https://api.deepseek.com (if OpenAI-compatible)
          apiKey: process.env.DEEPSEEK_API_KEY!,
          model: 'deepseek-chat',
          temperature: 0.2,
          maxTokens: 300,
        },
        {
          fields: ['label', 'description'], // the localized fields to fill
          sourceLocale: 'en', // change if your default is different
          // targetLocales: ['de','fr','it'],       // or omit to use all configured except source
          guardFlagField: 'autoLocalize', // only runs when true
        },
      ),
    ],
  },
}

export default Articles
