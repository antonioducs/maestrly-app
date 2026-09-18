import { useCallback, useEffect, useState } from 'react'
import type { RoutinePreview, RoutineProposal, TargetRef } from '@maestrly/host-protocol'
import { RoutineEditor } from './RoutineEditor'
import { RoutineProposalCard } from './RoutineProposalCard'

/**
 * Suggestions waiting for a decision, shown where they were made — inside the conversation.
 *
 * A card becomes a preview as soon as it is displayed, so the person sees the real instants
 * and the real ceiling rather than a promise. Confirming uses that exact preview; editing opens
 * the same form a routine created by hand would use. Dismissing is one click and final.
 */
export function ProposalStrip({
  target,
  targetName,
  connected,
  supported,
  onActivated,
}: {
  target: TargetRef
  targetName: string
  connected: boolean
  supported: boolean
  onActivated?: () => void
}) {
  const [proposals, setProposals] = useState<RoutineProposal[]>([])
  const [previews, setPreviews] = useState<Record<string, RoutinePreview>>({})
  const [editing, setEditing] = useState<RoutineProposal | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!connected || !supported) return
    try {
      const cards = await window.bot.routine({ method: 'routine.proposals.list', params: { target } })
      setProposals(cards)
      for (const card of cards) {
        if (!card.schedule) continue
        try {
          const preview = await window.bot.routine({
            method: 'routine.preview',
            params: { spec: { name: card.name, request: card.request, target, schedule: card.schedule }, proposalId: card.id },
          })
          setPreviews((current) => ({ ...current, [card.id]: preview }))
        } catch {
          /* a suggestion the Host cannot preview is still shown, without a confirm button */
        }
      }
    } catch (failure) {
      setError(String(failure))
    }
  }, [connected, supported, target.id, target.kind])

  useEffect(() => {
    void load()
  }, [load])
  if (!supported || (!proposals.length && !editing)) return null

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
  const activate = (proposal: RoutineProposal) =>
    guarded(async () => {
      const preview = previews[proposal.id]
      if (!preview) return
      await window.bot.routine({
        method: 'routine.activate',
        params: { previewId: preview.previewId, fingerprint: preview.fingerprint, idempotencyKey: crypto.randomUUID(), confirmSchedule: true },
      })
      await load()
      onActivated?.()
    })

  if (editing)
    return (
      <RoutineEditor
        target={target}
        targetName={targetName}
        initial={{ name: editing.name, request: editing.request, ...(editing.schedule ? { schedule: editing.schedule } : {}) }}
        preview={previews[editing.id]}
        busy={busy || !connected}
        onPreview={(spec) =>
          void guarded(async () => {
            const preview = await window.bot.routine({ method: 'routine.preview', params: { spec, proposalId: editing.id } })
            setPreviews((current) => ({ ...current, [editing.id]: preview }))
          })
        }
        onActivate={() =>
          void activate(editing).then(() => {
            setEditing(undefined)
          })
        }
        onCancel={() => setEditing(undefined)}
      />
    )

  return (
    <div className="routine-proposals">
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {proposals.map((proposal) => (
        <RoutineProposalCard
          key={proposal.id}
          proposal={proposal}
          preview={previews[proposal.id]}
          targetName={targetName}
          busy={busy || !connected}
          onActivate={() => void activate(proposal)}
          onEdit={() => setEditing(proposal)}
          onDismiss={() =>
            void guarded(async () => {
              await window.bot.routine({ method: 'routine.proposals.dismiss', params: { proposalId: proposal.id, expectedRevision: proposal.revision } })
              await load()
            })
          }
        />
      ))}
    </div>
  )
}
