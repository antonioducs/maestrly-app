import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseAntigravityTier,
  parseAntigravityUsageReport,
  readAntigravityAccountTier,
  writeAntigravityAccountTier,
} from '../../src/main/chat/antigravity-subscription/account-info'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Antigravity account tier', () => {
  it('reads the vendor tier metadata and ignores empty or malformed values', () => {
    expect(
      parseAntigravityTier({ antigravity: { tier: { name: ' Google AI Pro ', id: 'g1-pro-tier', upgradeUri: '' } } })
    ).toEqual({ name: 'Google AI Pro', id: 'g1-pro-tier' })
    expect(parseAntigravityTier({ antigravity: { tier: { name: '', id: '' } } })).toBeNull()
    expect(parseAntigravityTier({ antigravity: { tier: 'pro' } })).toBeNull()
    expect(parseAntigravityTier(undefined)).toBeNull()
  })

  it('persists only the tier in a private file beside the account home', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agy-account-'))
    roots.push(root)
    expect(readAntigravityAccountTier(root)).toBeNull()
    await writeAntigravityAccountTier(root, { name: 'Google AI Ultra', id: 'g1-ultra-tier' })
    expect(readAntigravityAccountTier(root)).toEqual({ name: 'Google AI Ultra', id: 'g1-ultra-tier' })
    if (process.platform !== 'win32') {
      expect(statSync(path.join(root, 'maestrly-account.json')).mode & 0o777).toBe(0o600)
    }
    await writeAntigravityAccountTier(root, null)
    expect(readAntigravityAccountTier(root)).toBeNull()
  })
})

describe('Antigravity /usage report', () => {
  it('turns quota buckets into usage windows with the server reset times', () => {
    const report = [
      '### Session Usage',
      '- **Session total:** 1,200 tokens (prompt: 1,000, completion: 200)',
      '',
      '### Quota Limits',
      '- **Gemini Models**',
      '  - **Weekly Limit Remaining:** 91% remaining (resets Oct 02, 2026, 08:22 UTC)',
      '  - **Daily Requests:** 40% remaining (resets 2026-10-01T00:00:00Z)',
      '  - **Prompt Units:** 1,000 units remaining',
      '  - **Burst:** Disabled',
      '- **Claude and GPT models**',
      '  *(Shared by partner models)*',
      '  - **Weekly Limit Remaining:** 100% remaining',
    ].join('\n')
    expect(parseAntigravityUsageReport(report)).toEqual({
      error: null,
      windows: [
        {
          id: 'gemini-models-weekly-limit',
          kind: 'weekly-model',
          usedPercent: 9,
          resetsAt: Date.UTC(2026, 9, 2, 8, 22),
          durationMins: 10_080,
          label: 'Gemini Models',
        },
        {
          id: 'gemini-models-daily-requests',
          kind: 'other',
          usedPercent: 60,
          resetsAt: Date.parse('2026-10-01T00:00:00Z'),
          durationMins: null,
          label: 'Gemini Models · Daily Requests',
        },
        {
          id: 'claude-and-gpt-models-weekly-limit',
          kind: 'weekly-model',
          usedPercent: 0,
          resetsAt: null,
          durationMins: 10_080,
          label: 'Claude and GPT models',
        },
      ],
    })
  })

  it('reports the reason the server could not read the quota', () => {
    expect(
      parseAntigravityUsageReport(
        '### Session Usage\n- **Session total:** data not available yet\n\n### Quota Limits\n' +
          '- Unable to retrieve quota status (User not onboarded (no project ID))'
      )
    ).toEqual({ windows: [], error: 'Google AI could not read the quota: User not onboarded (no project ID)' })
  })

  it('returns no windows for empty, unrelated, or unparseable reports', () => {
    expect(parseAntigravityUsageReport('')).toEqual({ windows: [], error: null })
    expect(parseAntigravityUsageReport('### Quota Limits\n- No quota limits reported.')).toEqual({
      windows: [],
      error: null,
    })
    expect(parseAntigravityUsageReport('### Session Usage\n  - **Weekly Limit Remaining:** 10% remaining')).toEqual({
      windows: [],
      error: null,
    })
  })
})
