import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  type FleetBackupRun,
  type FleetBackupStatus,
  fleetBackupErrorCodeSchema,
  fleetBackupRestoreProblemSchema,
} from '@maestrly/bot-fleet-protocol'
import { describe, expect, it, vi } from 'vitest'

// The texts come back as their keys, with the values they are given, so that what each place says is what is asserted.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
    i18n: { language: 'en' },
  }),
}))
import {
  BackupsSectionView,
  type BackupsSectionViewProps,
} from '../../src/renderer/components/settings/bot-server/BackupsSection'
import en from '../../src/shared/i18n/en/fleet'
import ptBr from '../../src/shared/i18n/pt-BR/fleet'

const plain = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'")
const AT = '2026-11-07T03:00:00.000Z'
function status(overrides: Partial<FleetBackupStatus> = {}): FleetBackupStatus {
  return {
    destination: { provider: 's3', label: 's3://my-bucket/maestrly-backups', account: '…1234', repositoryBytes: 5000 },
    enabled: true,
    schedule: { kind: 'weekly', days: [], time: '03:00', timezone: 'UTC' },
    retention: { daily: 7, weekly: 4, monthly: 6 },
    selection: { mode: 'all' },
    environments: [
      {
        environmentId: 'work',
        included: true,
        eligibility: 'ok',
        nextRunAt: '2026-11-08T03:00:00.000Z',
        lastRun: null,
        lastSuccessAt: null,
      },
    ],
    active: [],
    ...overrides,
  }
}
const failedRun: FleetBackupRun = {
  id: '0b7a3c52-9d41-4c2e-8f60-1a2b3c4d5e6f',
  kind: 'backup',
  environmentId: 'work',
  environmentName: 'Work',
  trigger: 'schedule',
  state: 'failed',
  phase: 'finish',
  progress: null,
  snapshotId: null,
  bytesAdded: null,
  bytesTotal: null,
  error: { code: 'storage-full', message: '' },
  startedAt: AT,
  finishedAt: AT,
}
function render(state: BackupsSectionViewProps['state'], overrides: Partial<BackupsSectionViewProps> = {}) {
  const noop = () => {}
  return plain(
    renderToStaticMarkup(
      createElement(BackupsSectionView, {
        state,
        environmentNames: { work: 'Work' },
        pending: new Set<string>(),
        onRetry: noop,
        onSetUp: noop,
        onRestore: noop,
        onRunNow: noop,
        onCancel: noop,
        onChange: noop,
        onToggle: noop,
        onShowKey: noop,
        onDisconnect: noop,
        ...overrides,
      })
    )
  )
}

describe('Backups in Settings', () => {
  it('asks to update a server without backups', () => {
    const html = render({ kind: 'old' })
    expect(html).toContain('botServer.backups.old')
    expect(html).not.toContain('botServer.backups.setUp')
  })

  it('offers to set up or restore backups without a destination', () => {
    const html = render({ kind: 'ready', status: status({ destination: null, enabled: false, schedule: null }) })
    expect(html).toContain('botServer.backups.intro')
    expect(html).toContain('botServer.backups.setUp')
    expect(html).toContain('botServer.backups.restore')
  })

  it('shows each environment with its next backup', () => {
    const html = render({ kind: 'ready', status: status() })
    expect(html).toContain('Work')
    expect(html).toContain('botServer.backups.status.never')
    expect(html).toContain('botServer.backups.status.next {"when":"')
    expect(html).toContain('botServer.backups.actions.runNow')
    expect(html).toContain('botServer.backups.destination {"label":"s3://my-bucket/maestrly-backups"}')
    expect(html).toContain('botServer.backups.status.used')
    expect(html).toContain('botServer.backups.actions.pause')
  })

  it('tells why the last backup failed', () => {
    const [row] = status().environments
    const html = render({ kind: 'ready', status: status({ environments: [{ ...row, lastRun: failedRun }] }) })
    expect(html).toContain('botServer.backups.status.failed {"reason":"botServer.backups.errors.storage-full')
    expect(en.botServer.backups.errors['storage-full']).toBe('The storage is full.')
    expect(ptBr.botServer.backups.errors['storage-full']).toBe('O armazenamento está cheio.')
  })

  it('shows a running backup with its progress and a way to cancel it', () => {
    const running = { ...failedRun, state: 'running' as const, phase: 'upload' as const, progress: 0.5, error: null }
    const html = render({ kind: 'ready', status: status({ active: [running] }) })
    expect(html).toContain('botServer.backups.status.running {"percent":50}')
    expect(html).toContain('aria-valuenow="50"')
    expect(html).toContain('botServer.backups.actions.cancel')
    expect(html).not.toContain('botServer.backups.actions.runNow')
  })

  it('says when backups are paused', () => {
    const html = render({ kind: 'ready', status: status({ enabled: false }) })
    expect(html).toContain('botServer.backups.status.paused')
    expect(html).toContain('botServer.backups.actions.resume')
    expect(html).not.toContain('botServer.backups.status.next')
  })

  it('has a text for every error and every reason a backup cannot be restored', () => {
    for (const catalog of [en, ptBr]) {
      const { errors, restoreDialog } = catalog.botServer.backups
      for (const code of fleetBackupErrorCodeSchema.options) expect(errors[code], code).toBeTruthy()
      for (const problem of fleetBackupRestoreProblemSchema.options)
        expect(restoreDialog.problems[problem], problem).toBeTruthy()
    }
  })
})
