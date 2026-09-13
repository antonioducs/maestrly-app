import { expect, it } from 'vitest'
import { mergeEvents } from '../src/renderer/features/hosts/events'
import { validateResult } from '../src/main/host-client'
it('bounds the viewer and deduplicates overlapping cursor pages', () => {
  const events = Array.from({ length: 400 }, (_, i) => ({ seq: i + 1, kind: 'log', createdAt: 'now', value: i }))
  const merged = mergeEvents(events.slice(0, 200), events.slice(100))
  expect(merged).toHaveLength(300)
  expect(merged[0].seq).toBe(101)
  expect(merged.at(-1)?.seq).toBe(400)
})
it('removes diagnostic endpoints, secrets, and terminal escapes before IPC', () => {
  const events = validateResult('events.list', [
    {
      seq: 1,
      kind: 'log',
      createdAt: 'now',
      value: {
        socketPath: '/private/qmp.sock',
        password: 'hidden',
        message: '\u001b[31mError /Library/MaestrlyHost/vms/a/qga.sock',
        nested: { token: 'hidden' },
      },
    },
  ])
  expect(events).toEqual([
    { seq: 1, kind: 'log', createdAt: 'now', value: { message: 'Error [host path]', nested: {} } },
  ])
})
