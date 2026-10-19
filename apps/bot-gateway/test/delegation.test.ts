import { expect, test } from 'vitest'
import { FLEET_BOT_DELEGATION_DEFAULT, FLEET_BOT_DELEGATION_FEATURE } from '@maestrly/bot-fleet-protocol'
import { harness } from './harness.js'

const sonnet = { providerId: 'builtin_claude_subscription', modelId: 'sonnet', tier: 'balanced' as const }

test('stores how a bot splits its work and sends it to its environment', async () => {
  const h = await harness(Date.now, { environments: true })
  expect(h.store.getBot(h.bot.id)?.delegation).toBeNull()
  await h.lifecycle.patch(h.bot.id, {
    delegation: { ...FLEET_BOT_DELEGATION_DEFAULT, mode: 'delegate', models: [sonnet] },
  })
  expect(h.store.getBot(h.bot.id)?.delegation?.mode).toBe('delegate')
  expect(h.instance.installs.at(-1)?.profile.delegation?.models).toEqual([sonnet])
})

test('sends no delegation to a bot whose owner never set it', async () => {
  const h = await harness(Date.now, { environments: true })
  await h.lifecycle.patch(h.bot.id, { instructions: 'Keep notes.' })
  const profile = h.instance.installs.at(-1)?.profile
  expect(profile?.instructions).toBe('Keep notes.')
  expect(profile).not.toHaveProperty('delegation')
})

test('announces bot delegation to devices', async () => {
  const h = await harness()
  const features = await (await h.request('GET', '/v1/meta')).json()
  expect(features.moreFeatures).toContain(FLEET_BOT_DELEGATION_FEATURE)
})
