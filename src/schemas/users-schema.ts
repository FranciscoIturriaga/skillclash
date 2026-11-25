import { USERS_COLUMNS, type CollectionSchema } from 'deepspace/schema'

/**
 * The scaffold's required users collection, extended with `username`.
 *
 * `username` here is a private mirror for the user's own row. The public,
 * unique copy lives in the `usernames` collection (uniqueOn: ['username']),
 * because `users` rows are read: 'own' and the useUsers() roster does not
 * project extra columns. Both are written only by the `setUsername` action.
 */
export const usersSchema: CollectionSchema = {
  name: 'users',
  columns: [...USERS_COLUMNS, { name: 'username', storage: 'text', interpretation: 'plain' }],
  permissions: {
    viewer: { read: 'own', create: false, update: 'own', delete: false },
    member: { read: 'own', create: false, update: 'own', delete: false },
    admin: { read: true, create: false, update: true, delete: true },
  },
}
