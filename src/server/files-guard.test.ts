import { describe, expect, it } from 'vitest'
import { guardAppFiles, type FilesRequest } from './files-guard'

const base: FilesRequest = {
  method: 'GET',
  subPath: '/videos/u1/abcdefghijklmnop.mp4',
  scope: 'app',
  key: null,
  userId: 'u1',
  ownerId: 'owner',
}
const ok = (r: Partial<FilesRequest>) => expect(guardAppFiles({ ...base, ...r }).ok).toBe(true)
const no = (r: Partial<FilesRequest>) => expect(guardAppFiles({ ...base, ...r }).ok).toBe(false)

describe('guardAppFiles', () => {
  it('lets anyone read a single app file, even signed out', () => {
    ok({})
    ok({ userId: null })
    ok({ method: 'HEAD' })
  })
  it('blocks listing for non-owners', () => {
    no({ subPath: '' })
    no({ subPath: '/' })
    no({ subPath: '', userId: null })
    ok({ subPath: '', userId: 'owner' })
  })
  it('only allows uploads to the caller’s own videos/ prefix', () => {
    ok({ method: 'POST', subPath: '/upload', key: 'videos/u1/abcdefghijklmnop.mp4' })
    ok({ method: 'POST', subPath: '/multipart', key: 'videos/u1/abcdefghijklmnop_-12.mov' })
    no({ method: 'POST', subPath: '/upload', key: 'videos/u2/abcdefghijklmnop.mp4' })
    no({ method: 'POST', subPath: '/upload', key: 'videos/u1/short.mp4' })
    no({ method: 'POST', subPath: '/upload', key: null })
    no({ method: 'POST', subPath: '/upload', key: 'videos/u1/../u2/abcdefghijklmnop.mp4' })
    no({ method: 'POST', subPath: '/upload', key: 'videos/u1/abcdefghijklmnop.mp4', userId: null })
  })
  it('allows multipart continuation but not file deletes', () => {
    ok({ method: 'PUT', subPath: '/multipart/part' })
    ok({ method: 'POST', subPath: '/multipart/complete' })
    ok({ method: 'DELETE', subPath: '/multipart' })
    no({ method: 'DELETE', subPath: '/videos/u1/abcdefghijklmnop.mp4' })
    ok({ method: 'DELETE', subPath: '/videos/u1/abcdefghijklmnop.mp4', userId: 'owner' })
  })
  it('ignores other scopes', () => {
    ok({ scope: 'self', subPath: '', method: 'GET' })
    ok({ scope: null, method: 'DELETE' })
  })
})
