import type { CollectionConfig } from 'payload'

export const PushNotifications: CollectionConfig = {
  slug: 'push-notifications',
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
      localized: true,
    },
  ],
}
