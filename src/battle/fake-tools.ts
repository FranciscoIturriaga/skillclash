/**
 * Minimal in-memory ActionTools for unit tests (not used by the app): create
 * (upsert with an id, Duplicate on a uniqueOn clash), get, query by equality,
 * update. Same behaviour as the one in stats.test.ts.
 */
import type { ActionTools } from 'deepspace/worker'

export function fakeTools(uniqueOn: Record<string, string[]>) {
  const db = new Map<string, Map<string, Record<string, unknown>>>()
  const table = (c: string) => db.get(c) ?? db.set(c, new Map()).get(c)!
  let seq = 0
  const tools = {
    async create(collection: string, data: Record<string, unknown>, recordId?: string) {
      const t = table(collection)
      const keys = uniqueOn[collection]
      if (keys) {
        for (const [id, row] of t) {
          if (id !== recordId && keys.every((k) => row[k] === data[k])) {
            return { success: false, error: `Duplicate value for unique constraint (${keys.join(', ')})` }
          }
        }
      }
      const id = recordId ?? `r${++seq}`
      t.set(id, { ...data })
      return { success: true, data: { recordId: id } }
    },
    async get(collection: string, recordId: string) {
      const row = table(collection).get(recordId)
      return row ? { success: true, data: { record: { recordId, data: row } } } : { success: false, error: 'not found' }
    },
    async query(collection: string, opts: { where?: Record<string, unknown> } = {}) {
      const records = [...table(collection)]
        .filter(([, row]) => Object.entries(opts.where ?? {}).every(([k, v]) => row[k] === v))
        .map(([recordId, data]) => ({ recordId, data }))
      return { success: true, data: { records, count: records.length } }
    },
    async update(collection: string, recordId: string, patch: Record<string, unknown>) {
      const t = table(collection)
      t.set(recordId, { ...t.get(recordId), ...patch })
      return { success: true, data: { recordId } }
    },
  }
  return { tools: tools as unknown as ActionTools, table }
}
