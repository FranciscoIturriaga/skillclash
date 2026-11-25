import { describe, expect, it } from 'vitest'
import { guardAppFiles, type FilesRequest } from './files-guard'

const base: FilesRequest = {
  method: 'GET',
  subPath: '/videos/u1/abcdefghijklmnop.mp4',
  scope: 'app',
  key: null,
  userId: 'u1',
  ownerId: 'owner',
  appId: 'app_X',
}
const ok = (r: Partial<FilesRequest>) => expect(guardAppFiles({ ...base, ...r }).ok).toBe(true)
const no = (r: Partial<FilesRequest>) => expect(guardAppFiles({ ...base, ...r }).ok).toBe(false)

describe('guardAppFiles', () => {
  it('lets the uploader read their own video before reveal, with no lookup', () => {
    const path = '/apps/app_X/videos/u1/abcdefghijklmnop.mp4'
    expect(guardAppFiles({ ...base, subPath: path })).toEqual({ ok: true })
    expect(guardAppFiles({ ...base, subPath: path, method: 'HEAD' })).toEqual({ ok: true })
  })
  it('makes opponents, voters, signed-out viewers and the owner pass a reveal lookup', () => {
    const path = '/apps/app_X/videos/u1/abcdefghijklmnop.mp4'
    const rel = 'videos/u1/abcdefghijklmnop.mp4'
    for (const userId of ['u2', 'voter', 'owner', null]) {
      expect(guardAppFiles({ ...base, subPath: path, userId })).toEqual({ ok: true, revealCheck: rel })
    }
    // Without the apps/<id> prefix (the platform refuses that path anyway).
    expect(guardAppFiles({ ...base, userId: 'u2' })).toEqual({ ok: true, revealCheck: rel })
    // Encoded paths decode to the same key.
    expect(guardAppFiles({ ...base, subPath: '/apps/app_X/videos/u1/abcdefghijklmnop%2Emp4', userId: 'u2' })).toEqual({
      ok: true,
      revealCheck: rel,
    })
  })
  it('refuses traversal and undecodable paths', () => {
    no({ subPath: '/apps/app_X/videos/u1/../u2/abcdefghijklmnop.mp4' })
    no({ subPath: '/apps/app_X/videos/u1/%2e%2e/u2/x.mp4' })
    no({ subPath: '/apps/app_X/videos/u1/%E0%A4%A' })
  })
  it("doesn't treat another user's folder as the caller's own", () => {
    expect(guardAppFiles({ ...base, subPath: '/apps/app_X/videos/u2/abcdefghijklmnop.mp4' })).toEqual({
      ok: true,
      revealCheck: 'videos/u2/abcdefghijklmnop.mp4',
    })
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
