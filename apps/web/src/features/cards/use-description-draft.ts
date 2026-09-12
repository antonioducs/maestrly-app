import { useEffect, useRef, useState } from 'react'
import type { Card } from '@maestrly/protocol'
import { write } from '../../app/api.js'

// A failed save never replaces the user's text. Store drafts per account, organization and card.
export function useDescriptionDraft(card: Card, userId: string, onSaved: (card: Card) => void, enabled = true) {
  const key = 'maestrly-description:' + userId + ':' + card.organizationId + ':' + card.id
  const initial = () => {
    try {
      return sessionStorage.getItem(key) ?? card.description
    } catch {
      return card.description
    }
  }
  const [description, setDescription] = useState(initial)
  const [status, setStatus] = useState<'saved' | 'dirty' | 'saving' | 'error' | 'conflict'>(
    description === card.description ? 'saved' : 'dirty'
  )
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [remote, setRemote] = useState<Card | null>(null)
  const current = useRef(card),
    text = useRef(description),
    saving = useRef<Promise<boolean> | null>(null)
  const stopped = useRef(false),
    saved = useRef(onSaved)
  saved.current = onSaved
  const statusRef = useRef(status)
  statusRef.current = status
  useEffect(() => {
    stopped.current = false
    return () => {
      stopped.current = true
    }
  }, [])
  useEffect(() => {
    if (saving.current || current.current.version === card.version) return
    if (text.current === current.current.description) {
      current.current = card
      text.current = card.description
      setDescription(card.description)
      setRevision((value) => value + 1)
    } else if (card.description !== current.current.description) {
      setRemote(card)
      statusRef.current = 'conflict'
      setStatus('conflict')
    } else current.current = card
  }, [card])
  function edit(value: string) {
    text.current = value
    setDescription(value)
    try {
      sessionStorage.setItem(key, value)
    } catch {
      /* session-only draft still retained in state */
    }
    if (statusRef.current !== 'conflict') setStatus('dirty')
  }
  async function flush(): Promise<boolean> {
    if (!enabled) return true
    if (saving.current) {
      const ok = await saving.current
      if (!ok) return false
      return flush()
    }
    if (statusRef.current === 'conflict') return false
    if (text.current === current.current.description) return true
    const body = text.current
    setStatus('saving')
    saving.current = (async () => {
      try {
        const updated = await write<Card>(`/api/v1/organizations/${card.organizationId}/cards/${card.id}`, 'PATCH', {
          expectedVersion: current.current.version,
          description: body,
        })
        current.current = updated
        saved.current(updated)
        if (!stopped.current) {
          setStatus(text.current === body ? 'saved' : 'dirty')
          setError('')
        }
        if (text.current === body)
          try {
            sessionStorage.removeItem(key)
          } catch {
            /* storage unavailable */
          }
        return true
      } catch (caught) {
        const candidate = caught as Error & { status?: number; details?: { current?: Card } }
        if (!stopped.current) {
          setError(candidate.message ?? 'Could not save. Please try again.')
          setRemote(candidate.details?.current ?? null)
          statusRef.current = candidate.status === 409 ? 'conflict' : 'error'
          setStatus(statusRef.current)
        }
        return false
      } finally {
        saving.current = null
      }
    })()
    return saving.current
  }
  useEffect(() => {
    if (!enabled || status !== 'dirty') return
    const timer = setTimeout(() => void flush(), 900)
    return () => clearTimeout(timer)
  }, [description, status, enabled])
  function keepMine() {
    if (!remote) return
    current.current = remote
    setRemote(null)
    statusRef.current = 'dirty'
    setStatus('dirty')
  }
  function useServer() {
    if (!remote) return
    current.current = remote
    text.current = remote.description
    setDescription(remote.description)
    setRevision((value) => value + 1)
    saved.current(remote)
    setRemote(null)
    setStatus('saved')
    setError('')
    try {
      sessionStorage.removeItem(key)
    } catch {
      /* storage unavailable */
    }
  }
  function replace(updated: Card) {
    current.current = updated
    text.current = updated.description
    setDescription(updated.description)
    setRevision((value) => value + 1)
    setStatus('saved')
    saved.current(updated)
    try {
      sessionStorage.removeItem(key)
    } catch {
      /* storage unavailable */
    }
  }
  return { revision, description, edit, status, error, remote, keepMine, useServer, flush, replace }
}
