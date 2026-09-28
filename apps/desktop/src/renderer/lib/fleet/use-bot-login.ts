import { useEffect, useRef, useState } from 'react'
import type { FleetLoginAttempt, FleetLoginKind, FleetLoginStartRequest } from '@maestrly/bot-fleet-protocol'
import { closeBotLogin, createLoginOwnership } from './provisioning'
import { fleetErrorMessage } from './errors'
import { targetFromParts, targetParts, type ProvisioningSubject } from './environments'

export type LoginResult = 'completed' | 'cancelled' | 'failed'

/**
 * Signs an environment (shared by its bots) or, before environments, a bot in to a provider on the server, for as
 * long as `active` holds: starting the attempt, polling it, and cancelling a pending one once left.
 */
export function useBotLogin({
  subject,
  kind,
  slot = 'auto',
  active,
}: {
  subject: ProvisioningSubject
  kind: FleetLoginKind
  slot?: FleetLoginStartRequest['slot']
  active: boolean
}) {
  // Primitives: a subject rebuilt on every render must not restart the sign-in.
  const { scope, id } = targetParts(subject.target)
  const target = targetFromParts(scope, id)
  const [attempt, setAttempt] = useState<FleetLoginAttempt | null>(null)
  const [method, setMethod] = useState<'browser' | 'device'>(kind === 'grok' ? 'device' : 'browser')
  const [revision, setRevision] = useState(0)
  const [paste, setPaste] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ownership = useRef(createLoginOwnership<Awaited<ReturnType<typeof window.api.fleetLoginStart>>>())
  const generation = useRef(0)
  const liveAttempt = useRef<FleetLoginAttempt | null>(null)
  useEffect(() => {
    if (!active) return
    const current = ++generation.current
    let timer: ReturnType<typeof setTimeout> | undefined
    let owned: FleetLoginAttempt | null = null
    setAttempt(null)
    setBusy(false)
    setError('')
    setCode('')
    setPaste(false)
    const live = () => current === generation.current
    const update = (value: FleetLoginAttempt) => {
      owned = value
      liveAttempt.current = value
      ownership.current.update(value)
      setAttempt(value)
    }
    const poll = async () => {
      if (!owned || !live()) return
      try {
        const value = await window.api.fleetLoginStatus(target, owned.loginId)
        if (!live()) return
        update(value)
        setError('')
      } catch (cause) {
        if (live()) setError(fleetErrorMessage(cause))
      }
      if (live() && owned?.state === 'pending') timer = setTimeout(() => void poll(), 2000)
    }
    const lease = ownership.current.acquire(
      JSON.stringify([scope, id, kind, slot, method, revision]),
      () => window.api.fleetLoginStart(target, { kind, slot, method }),
      (loginId) => window.api.fleetLoginCancel(target, loginId)
    )
    void lease.result
      .then((result) => {
        if (!live()) return
        update(result.attempt)
        setPaste(result.relay === 'unavailable')
        if (result.attempt.state === 'pending') timer = setTimeout(() => void poll(), 2000)
      })
      .catch((cause) => {
        if (live()) setError(fleetErrorMessage(cause))
      })
    return () => {
      generation.current++
      clearTimeout(timer)
      liveAttempt.current = null
      lease.release()
    }
  }, [active, scope, id, kind, slot, method, revision])
  async function action(run: () => Promise<unknown>) {
    if (busy) return
    const current = generation.current
    setBusy(true)
    setError('')
    try {
      await run()
    } catch (cause) {
      if (current === generation.current) setError(fleetErrorMessage(cause))
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  const loginId = attempt?.loginId
  return {
    attempt,
    error,
    busy,
    paste,
    code,
    setCode,
    togglePaste: () => setPaste((value) => !value),
    openAuth: () => loginId && void action(() => window.api.fleetLoginOpen(target, loginId, 'auth')),
    openManual: () => loginId && void action(() => window.api.fleetLoginOpen(target, loginId, 'manual')),
    openDevice: () => loginId && void action(() => window.api.fleetLoginOpen(target, loginId, 'device')),
    copyCode: () => attempt?.device && void action(() => navigator.clipboard.writeText(attempt.device!.userCode)),
    /** Codex: a device code instead of the browser relay. */
    useDeviceCode: () =>
      loginId &&
      void action(async () => {
        await window.api.fleetLoginCancel(target, loginId)
        setMethod('device')
      }),
    submitCode: () =>
      loginId &&
      void action(async () => {
        const current = generation.current
        const value = await window.api.fleetLoginSubmitCode(target, loginId, code.trim())
        if (current === generation.current) {
          ownership.current.update(value)
          liveAttempt.current = value
          setAttempt(value)
          setCode('')
        }
      }),
    retry: () => setRevision((value) => value + 1),
    /** Leaves the sign-in, cancelling it while pending, and tells how it ended. */
    close: (onClose: (result: LoginResult) => void) => {
      const value = liveAttempt.current
      closeBotLogin(
        () => {
          generation.current++
        },
        async () => {
          ownership.current.abandon()
        },
        () =>
          onClose(
            value?.state === 'completed'
              ? 'completed'
              : value && value.state !== 'pending' && value.state !== 'cancelled'
                ? 'failed'
                : 'cancelled'
          )
      )
    },
  }
}
export type BotLogin = ReturnType<typeof useBotLogin>

/** The host of a sign-in page, for naming it; empty when the URL cannot be read. */
export function loginHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
