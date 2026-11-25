import { describe, expect, it } from 'vitest'
import { emailsEnabledFor } from './notify'

describe('emailsEnabledFor (D48)', () => {
  it('sends for real modes and skips test mode', () => {
    expect(emailsEnabledFor({ modeId: 'standard' })).toBe(true)
    expect(emailsEnabledFor({ modeId: 'test' })).toBe(false)
  })
})
