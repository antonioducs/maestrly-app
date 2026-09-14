import { expect, it } from 'vitest'
import { networkPolicySchema, permitsDomain } from '../src/bot-policy.js'
it('allows public domains except blocked domains and their subdomains', () => {
  const p = networkPolicySchema.parse({ mode: 'blocklist', domains: ['Example.COM'], revision: 1 })
  expect(permitsDomain(p, 'www.google.com')).toBe(true)
  expect(permitsDomain(p, 'example.com')).toBe(false)
  expect(permitsDomain(p, 'a.b.example.com')).toBe(false)
  expect(permitsDomain(p, 'notexample.com')).toBe(true)
  expect(permitsDomain(p, 'example.com.attacker.test')).toBe(true)
  expect(permitsDomain(p, '127.0.0.1')).toBe(false)
})
it('keeps old allowlists exact and offline closed', () => {
  const p = { mode: 'allowlist' as const, domains: ['example.com'], revision: 0 }
  expect(permitsDomain(p, 'example.com')).toBe(true)
  expect(permitsDomain(p, 'www.example.com')).toBe(false)
  expect(permitsDomain({ ...p, mode: 'offline' }, 'example.com')).toBe(false)
})
