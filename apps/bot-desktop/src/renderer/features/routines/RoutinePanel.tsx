import { useCallback, useEffect, useState } from 'react'
import type { Routine, RoutineOccurrence, RoutinePreview, RoutineSpec, TargetRef } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import { RoutineEditor } from './RoutineEditor'
import { RoutineHistory } from './RoutineHistory'
import { RoutineList } from './RoutineList'
import { useRoutineEvents } from './useRoutineEvents'

/**
 * Routines for one bot or one team, in context. It is deliberately reachable from the details
 * of the thing it drives rather than from a global dashboard: a routine belongs to a bot the
 * way a habit belongs to a person, not to a control room.
 *
 * Every write here goes through preview → confirm, including an edit: the fingerprint that is
 * activated is the one that was on screen, and a concurrent change is reported instead of being
 * merged silently.
 */
export function RoutinePanel({
  target,
  targetName,
  connected,
  supported,
  onOpenRun,
}: {
  target: TargetRef
  targetName: string
  connected: boolean
  /** False when this Host predates routines; the panel explains instead of failing. */
  supported: boolean
  onOpenRun?: (occurrence: RoutineOccurrence) => void
}) {
  const t = useT()
  const [routines, setRoutines] = useState<Routine[]>([])
  const [selected, setSelected] = useState<Routine | undefined>()
  const [occurrences, setOccurrences] = useState<RoutineOccurrence[]>([])
  const [editing, setEditing] = useState<{ initial?: Partial<RoutineSpec>; routine?: Routine } | undefined>()
  const [preview, setPreview] = useState<RoutinePreview | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!connected || !supported) return
    try {
      const list = await window.bot.routine({ method: 'routine.list', params: { target } })
      setRoutines(list)
      setSelected((current) => (current ? list.find((routine) => routine.id === current.id) : undefined))
    } catch (error) {
      setError(String(error))
    }
  }, [connected, supported, target.id, target.kind])

  /**
   * The history of one routine. It is reloaded explicitly after every action that can add or
   * change a run — asking for one now, or stopping one — because those do not necessarily change
   * the routine itself, and a person who presses "Run now" must see the run appear.
   */
  const loadOccurrences = useCallback(async (routineId: string | undefined) => {
    if (!routineId) {
      setOccurrences([])
      return
    }
    try {
      const page = await window.bot.routine({ method: 'routine.occurrences.list', params: { routineId, limit: 20 } })
      setOccurrences(page.occurrences)
    } catch (error) {
      setError(String(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadOccurrences(selected?.id)
  }, [selected?.id, selected?.revision, loadOccurrences])
  useRoutineEvents(selected?.id, connected && supported, () => void load(), (error) => setError(String(error)))

  if (!supported) return <p className="routine-empty">{t('routineUpdateRequired')}</p>

  const guarded = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }
  const runPreview = (spec: RoutineSpec) =>
    guarded(async () => {
      setPreview(
        await window.bot.routine({
          method: 'routine.preview',
          params: { spec, ...(editing?.routine ? { routineId: editing.routine.id, expectedRevision: editing.routine.revision } : {}) },
        })
      )
    })
  const activate = () =>
    guarded(async () => {
      if (!preview) return
      // Exactly the fingerprint that was shown; the Host refuses anything else.
      const details = await window.bot.routine({
        method: 'routine.activate',
        params: { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: crypto.randomUUID(), confirmSchedule: true },
      })
      setEditing(undefined)
      setPreview(undefined)
      setSelected(details.routine)
      await load()
    })

  return (
    <div className="routine-panel">
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {editing ? (
        <RoutineEditor
          target={target}
          targetName={targetName}
          initial={editing.initial}
          preview={preview}
          busy={busy || !connected}
          onPreview={(spec) => void runPreview(spec)}
          onActivate={() => void activate()}
          onCancel={() => {
            setEditing(undefined)
            setPreview(undefined)
          }}
        />
      ) : (
        <RoutineList
          routines={routines}
          busy={busy || !connected}
          onCreate={() => {
            setPreview(undefined)
            setEditing({})
          }}
          onOpen={(routine) => setSelected(selected?.id === routine.id ? undefined : routine)}
          onPause={(routine, resume) =>
            void guarded(async () => {
              await window.bot.routine({
                method: 'routine.pause',
                params: { routineId: routine.id, expectedRevision: routine.revision, idempotencyKey: crypto.randomUUID(), resume },
              })
              await load()
            })
          }
        />
      )}
      {selected && !editing && (
        <>
          <div className="routine-actions">
            <Button
              type="button"
              disabled={busy || !connected}
              onClick={() => {
                setPreview(undefined)
                setEditing({ initial: selected.spec, routine: selected })
              }}
            >
              {t('routineEdit')}
            </Button>
          </div>
          <RoutineHistory
            routine={selected}
            occurrences={occurrences}
            busy={busy || !connected}
            onOpen={(occurrence) => onOpenRun?.(occurrence)}
            onStop={(occurrence) =>
              void guarded(async () => {
                await window.bot.routine({
                  method: 'routine.occurrence.cancel',
                  params: { occurrenceId: occurrence.id, expectedRevision: occurrence.revision, idempotencyKey: crypto.randomUUID() },
                })
                await Promise.all([load(), loadOccurrences(selected.id)])
              })
            }
            onRunNow={() =>
              void guarded(async () => {
                await window.bot.routine({
                  method: 'routine.runNow',
                  params: { routineId: selected.id, expectedRevision: selected.revision, idempotencyKey: crypto.randomUUID() },
                })
                await Promise.all([load(), loadOccurrences(selected.id)])
              })
            }
          />
        </>
      )}
    </div>
  )
}
