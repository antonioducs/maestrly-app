import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  FLEET_INTERNAL_ROUTES,
  FLEET_ROUTINE_CONVERSATIONS_FEATURE,
  FLEET_ROUTINE_RUN_SETTINGS_DEFAULT,
  buildPath,
  fleetBotSchema,
  fleetGatewayEventSchema,
  fleetInstanceEventSchema,
  fleetInstanceInputSchema,
  fleetInstanceProfileSchema,
  fleetInstanceStatusSchema,
  fleetPendingInteractionSchema,
  fleetReaderWantsRoutineRuns,
  fleetRoutineRunSchema,
  fleetRoutineRunSettingsSchema,
  fleetSendMessageRequestSchema,
  fleetTranscriptItemSchema,
  isFleetRoutineRunEvent,
} from '../src/index.js'

const at = '2026-10-18T10:15:00.000Z'
const run = {
  id: 'run-1',
  routineId: 'post',
  botId: 'atlas',
  trigger: 'schedule',
  status: 'completed',
  deliveredAt: at,
  finishedAt: at,
  report: { summary: 'Posted', pending: null, notes: null },
  finalText: 'Done',
}

describe('routine runs in conversations of their own', () => {
  it('reads a run from an older gateway as one in the bot conversation, and a newer one in full', () => {
    expect(fleetRoutineRunSchema.parse(run)).toMatchObject({
      routineTitle: null,
      conversation: 'primary',
      quiet: false,
      pinned: false,
      lastActivityAt: null,
      expiresAt: null,
      media: null,
      kept: null,
      adjustments: 0,
    })
    const own = fleetRoutineRunSchema.parse({
      ...run,
      routineTitle: 'Post da semana',
      conversation: 'deleted',
      kept: {
        folder: 'routines/post-da-semana/2026-10-18-1015',
        files: [{ name: 'post.png', kind: 'image', byteSize: 9 }],
      },
      media: { images: 1, videos: 1, files: 1 },
      adjustments: 2,
    })
    expect(own.kept?.files[0].kind).toBe('image')
    expect(fleetRoutineRunSchema.safeParse({ ...run, conversation: 'shared' }).success).toBe(false)
  })

  it('keeps settings within their choices, and older bots and statuses without runs', () => {
    expect(fleetRoutineRunSettingsSchema.parse(FLEET_ROUTINE_RUN_SETTINGS_DEFAULT)).toEqual({
      retentionDays: 30,
      capPerRoutine: true,
      quietEarly: true,
      notify: 'notable',
    })
    expect(
      fleetRoutineRunSettingsSchema.safeParse({ ...FLEET_ROUTINE_RUN_SETTINGS_DEFAULT, retentionDays: 45 }).success
    ).toBe(false)
    expect(
      fleetRoutineRunSettingsSchema.parse({ ...FLEET_ROUTINE_RUN_SETTINGS_DEFAULT, retentionDays: null }).retentionDays
    ).toBeNull()
    const profile = fleetInstanceProfileSchema.parse({
      botId: 'atlas',
      name: 'Atlas',
      instructions: '',
      ceiling: 'ask',
      selection: null,
      gateway: { peersEnabled: false },
    })
    expect(profile.gateway.routineConversations).toBeUndefined()
    const turn = fleetInstanceStatusSchema.shape.turn.parse({ state: 'running', startedAt: at })
    expect(turn).toEqual({ state: 'running', startedAt: at, inputId: null, runId: null })
    expect(fleetBotSchema.shape.runSettings.parse(undefined)).toBeNull()
    expect(fleetBotSchema.shape.runningRun.parse(undefined)).toBeNull()
  })

  it('sends a routine input to its run, an owner change to a run, and peers only to the bot', () => {
    const routine = { id: 'post', title: 'Post', runId: 'run-1' }
    const base = { idempotencyKey: randomUUID(), text: 'Post the photo', attachments: [] }
    expect(fleetInstanceInputSchema.parse({ ...base, source: 'routine', routine, run: { id: 'run-1' } }).run).toEqual({
      id: 'run-1',
    })
    expect(
      fleetInstanceInputSchema.safeParse({ ...base, source: 'routine', routine, run: { id: 'run-2' } }).success
    ).toBe(false)
    expect(fleetInstanceInputSchema.safeParse({ ...base, source: 'owner', run: { id: 'run-1' } }).success).toBe(true)
    expect(fleetInstanceInputSchema.safeParse({ ...base, source: 'continuation', run: { id: 'run-1' } }).success).toBe(
      true
    )
    expect(
      fleetInstanceInputSchema.safeParse({
        ...base,
        source: 'peer',
        peer: { botId: 'scout', name: 'Scout' },
        run: { id: 'run-1' },
      }).success
    ).toBe(false)
    const citation = { runId: 'run-1', routineTitle: 'Post', at }
    expect(fleetInstanceInputSchema.parse({ ...base, source: 'owner', citation }).citation).toEqual(citation)
    expect(fleetSendMessageRequestSchema.parse({ ...base, citation: { runId: 'run-1' } }).citation).toEqual({
      runId: 'run-1',
    })
    const item = fleetTranscriptItemSchema.parse({
      kind: 'user',
      id: 'input:1',
      at,
      text: 'Use it',
      source: 'owner',
      queued: false,
      citation,
    })
    expect(item.kind === 'user' && item.citation).toEqual(citation)
  })

  it("names a run's events, and a reader gets them only when it asks", () => {
    const upsert = fleetInstanceEventSchema.parse({
      seq: 1,
      at,
      type: 'transcript.upsert',
      runId: 'run-1',
      item: { kind: 'assistant', id: 'm:0', at, text: 'Done', streaming: false },
    })
    expect(upsert).toMatchObject({ runId: 'run-1' })
    expect(fleetInstanceEventSchema.parse({ seq: 2, at, type: 'reset' })).toMatchObject({ runId: null })
    const finished = fleetInstanceEventSchema.parse({
      seq: 3,
      at,
      type: 'turn.finished',
      outcome: 'completed',
      summary: null,
      runId: 'run-1',
      media: { images: 2, videos: 0, files: 1 },
    })
    expect(finished).toMatchObject({ runId: 'run-1', media: { images: 2 } })
    const gateway = fleetGatewayEventSchema.parse({ type: 'routine_run.updated', at, botId: 'atlas', run })
    expect(isFleetRoutineRunEvent(gateway)).toBe(true)
    expect(isFleetRoutineRunEvent({ type: 'transcript.upsert' })).toBe(false)
    expect(fleetReaderWantsRoutineRuns(new URLSearchParams('routineRuns=1'))).toBe(true)
    expect(fleetReaderWantsRoutineRuns(new URLSearchParams('reasoning=1'))).toBe(false)
    const pending = fleetPendingInteractionSchema.parse({
      kind: 'help',
      id: 'h1',
      at,
      reason: 'Login',
      itemId: 'help:h1',
      runId: 'run-1',
    })
    expect(pending.runId).toBe('run-1')
  })

  it('declares the routes of runs and the feature', () => {
    expect(FLEET_ROUTINE_CONVERSATIONS_FEATURE).toBe('routine-conversations')
    expect(buildPath(FLEET_GATEWAY_ROUTES.botRuns.path, { id: 'atlas' }, { before: 'run-1', limit: 50 })).toBe(
      '/v1/bots/atlas/routine-runs?before=run-1&limit=50'
    )
    expect(FLEET_GATEWAY_ROUTES.botRunConversationDelete).toMatchObject({
      method: 'DELETE',
      path: '/v1/bots/:id/routine-runs/:runId/conversation',
    })
    expect(FLEET_GATEWAY_ROUTES.botRunSettings).toMatchObject({
      method: 'PUT',
      path: '/v1/bots/:id/routine-run-settings',
    })
    expect(FLEET_GATEWAY_ROUTES.botRunPatch.body.safeParse({ pinned: true, other: 1 }).success).toBe(false)
    expect(FLEET_INTERNAL_ROUTES.routineRunsList.path).toBe('/internal/v1/routine-runs')
    expect(FLEET_INSTANCE_ROUTES.botRunTranscript.path).toBe('/v1/bots/:botId/runs/:runId/transcript')
    expect(FLEET_INSTANCE_ROUTES.botRunDelete).toMatchObject({ method: 'DELETE', path: '/v1/bots/:botId/runs/:runId' })
  })
})
