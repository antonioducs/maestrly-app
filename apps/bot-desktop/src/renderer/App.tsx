import { RetainedDisks } from './features/computers/RetainedDisks'
import { mergeEvents } from './features/hosts/events'
import { CreateComputer } from './features/computers/CreateComputer'
import { HostResources } from './features/hosts/HostResources'
import { useEffect, useRef, useState } from 'react'
import type { Method } from '../shared/types'
import './style.css'
import type { Vm, Host, Operation, HostEvent } from '../shared/types'
type Image = { id: string; name?: string; available?: boolean }
const call = <T,>(method: Method, params: Record<string, unknown> = {}): Promise<T> =>
  window.bot.call({ method, params }) as Promise<T>
function list<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value
  const items = (value as Record<string, unknown>)?.[key]
  if (Array.isArray(items)) return items
  throw new Error(`Invalid ${key} response`)
}
export function App() {
  const [bootLogs, setBootLogs] = useState<{ vmId: string; lines: string[] }>()
  const [alias, setAlias] = useState('')
  const [hosts, setHosts] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [host, setHost] = useState<Host>()
  const [vms, setVms] = useState<Vm[]>([])
  const [retainedDisks, setRetainedDisks] = useState<Vm[]>([])
  const [images, setImages] = useState<Image[]>([])
  const [events, setEvents] = useState<HostEvent[]>([])
  const [selected, setSelected] = useState<Vm>()
  const [detail, setDetail] = useState<unknown>()
  const [op, setOp] = useState<Operation>()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [retryableKeys, setRetryableKeys] = useState<string[]>([])
  const [recoveryIssue, setRecoveryIssue] = useState('')
  const cursor = useRef(0)
  const generation = useRef(0)
  const connectedAlias = useRef('')
  const refresh = async () => {
    const token = generation.current
    const [h, v, i, e, status] = await Promise.all([
      call<Host>('host.inspect'),
      call('vm.list', { includeRetained: true }),
      call('image.list'),
      call<HostEvent[]>('events.list', { after: cursor.current, limit: 100 }),
      window.bot.status(),
    ])
    const inventory = list<Vm>(v, 'vms')
    const retained = await Promise.all(
      (status.retainedVmIds ?? [])
        .filter((id) => !inventory.some((vm) => vm.id === id))
        .map((vmId) => call<Vm>('vm.inspect', { vmId }))
    )
    if (token !== generation.current) return
    setHost(h)
    setRetainedDisks([...inventory, ...retained].filter((vm) => vm.state === 'removed' && vm.diskRetained))
    setVms(inventory.filter((vm) => vm.state !== 'removed'))
    setRecoveryIssue(status.recoveryIssue ?? '')
    setRetryableKeys(status.retryableKeys ?? [])
    if (selected) {
      const inspected = await call<Vm>('vm.inspect', { vmId: selected.id })
      if (token !== generation.current) return
      setSelected(inspected)
      setDetail(inspected)
      setVms((previous) => previous.map((vm) => (vm.id === inspected.id ? inspected : vm)))
    }
    setImages(list<Image>(i, 'images'))
    appendEvents(e)
  }
  const appendEvents = (batch: HostEvent[]) => {
    cursor.current = Math.max(cursor.current, ...batch.map((e) => e.seq))
    setEvents((previous) => mergeEvents(previous, batch))
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      const status = await window.bot.status()
      setRecoveryIssue(status.recoveryIssue ?? '')
      setRetryableKeys(status.retryableKeys ?? [])
      if (!status.connected) setConnected(false)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    window.bot
      .hosts()
      .then(setHosts)
      .catch((e) => setError(String(e)))
  }, [])
  useEffect(() => {
    if (!connected) return
    let active = true
    let polling = false
    const timer = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const token = generation.current
        const s = await window.bot.status()
        if (!active || token !== generation.current) return
        setRecoveryIssue(s.recoveryIssue ?? '')
        setRetryableKeys(s.retryableKeys ?? [])
        if (s.connected) {
          const batch = await call<HostEvent[]>('events.list', { after: cursor.current, limit: 100 })
          if (active && token === generation.current) appendEvents(batch)
        }
        if (active && !s.connected) {
          setConnected(false)
          setError(s.error ?? 'Host disconnected. Reconnect to refresh.')
        }
      } catch (e) {
        if (active) setError(String(e))
      } finally {
        polling = false
      }
    }, 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [connected])
  useEffect(() => {
    if (!connected || !op || !['queued', 'running'].includes(op.status)) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const token = generation.current
    const poll = async () => {
      try {
        const next = await call<Operation>('operation.get', { operationId: op.id })
        if (!active || token !== generation.current) return
        setOp(next)
        if (['queued', 'running'].includes(next.status)) timer = setTimeout(poll, 800)
        else {
          await refresh()
        }
      } catch (e) {
        if (active) {
          setError(`Operation outcome unavailable. ${String(e)}`)
          setConnected(false)
        }
      }
    }
    timer = setTimeout(poll, 800)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [op?.id, connected])
  const connect = () =>
    run(async () => {
      generation.current++
      setConnected(false)
      setSelected(undefined)
      setDetail(undefined)
      if (connectedAlias.current !== alias) setOp(undefined)
      connectedAlias.current = alias
      const status = await window.bot.connect(alias)
      cursor.current = 0
      setEvents([])
      setRecoveryIssue(status.recoveryIssue ?? '')
      setRetryableKeys(status.retryableKeys ?? [])
      setOp(status.pending?.[0] ?? status.lastOperation)
      await refresh()
      setConnected(true)
      setHosts(await window.bot.hosts())
    })
  const mutation = async (method: Method, params: Record<string, unknown>) => {
    const result = await call<Operation>(method, { ...params, idempotencyKey: crypto.randomUUID() })
    if (!result?.id || !result.status) throw new Error('Host did not return an operation. Inspect before retrying.')
    setOp(result)
  }
  const pending = op && ['queued', 'running'].includes(op.status)
  const disabled = !connected || busy || !!pending || !!recoveryIssue
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="mark">m.</span>
          <div>
            Maestrly <strong>Bot</strong>
            <small>HOST CONSOLE · LAB</small>
          </div>
        </div>
        <h2>Hosts</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            connect()
          }}
        >
          <label htmlFor="alias">SSH configuration alias</label>
          <input
            id="alias"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="studio-mac"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
          />
          <button disabled={busy || (!!pending && connected)} className="primary">
            {host ? 'Reconnect' : 'Connect'}
          </button>
        </form>
        <div className="host-list">
          {hosts.map((name) => (
            <button key={name} onClick={() => setAlias(name)} className={name === alias ? 'chosen' : ''}>
              {name}
              <span>↗</span>
            </button>
          ))}
        </div>
        <p className="aside-note">
          Connect using an alias from your SSH configuration. The host key must already be trusted.
        </p>
        <div className="connection">
          <i className={connected ? 'online' : ''} />
          {connected ? 'Connected' : 'Disconnected'}
          {connected ? (
            <button
              onClick={() =>
                run(async () => {
                  generation.current++
                  await window.bot.disconnect()
                  setConnected(false)
                })
              }
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">YOUR COMPUTE, CLOSE AT HAND</p>
            <h1>{host ? alias : 'A place for your machines.'}</h1>
            <p>
              {host
                ? `${host.platform} / ${host.arch} · Service ${host.serviceVersion} · Protocol ${host.protocolVersion} · ${host.health}`
                : 'Connect a host to inspect capacity and manage virtual machines.'}
            </p>
          </div>
          <button disabled={!connected || busy} onClick={() => run(refresh)}>
            Diagnose & refresh
          </button>
        </header>
        {recoveryIssue ? (
          <div className="alert" role="alert">
            {recoveryIssue}
            {retryableKeys.map((key) => (
              <button
                key={key}
                disabled={!connected || busy}
                onClick={() =>
                  run(async () => {
                    await refresh()
                    try {
                      setOp(await window.bot.retry(key))
                    } finally {
                      await refresh()
                    }
                  })
                }
              >
                Retry same request
              </button>
            ))}
          </div>
        ) : null}
        {error ? (
          <div role="alert" className="alert">
            {error}
          </div>
        ) : null}
        {!connected && host ? (
          <div className="stale" role="status">
            Disconnected · displayed state is stale. Reconnect before making changes.
          </div>
        ) : null}
        {host ? (
          <HostResources host={host} />
        ) : (
          <section className="empty">
            <div className="machine">▤</div>
            <h2>Your hosts. Your workloads.</h2>
            <p>Add an SSH alias on the left to bring your machines into view.</p>
          </section>
        )}
        {host ? (
          <section>
            <div className="section-heading">
              <h2>
                Virtual machines <span>{vms.length}</span>
              </h2>
              <button className="primary" disabled={disabled || !host.supported} onClick={() => setCreating(true)}>
                Create VM
              </button>
            </div>
            {vms.length ? (
              <div className="vm-list">
                {vms.map((vm) => (
                  <button
                    className={`vm-row ${selected?.id === vm.id ? 'selected' : ''}`}
                    key={vm.id}
                    onClick={() =>
                      run(async () => {
                        const inspected = await call<Vm>('vm.inspect', { vmId: vm.id })
                        setSelected(inspected)
                        setDetail(inspected)
                        setVms((previous) => previous.map((value) => (value.id === inspected.id ? inspected : value)))
                      })
                    }
                    disabled={!connected}
                  >
                    <span className="vm-icon">▤</span>
                    <span>
                      <strong>{vm.name}</strong>
                      <small>
                        {vm.cpus} CPU · {vm.memoryMiB} MiB · {vm.diskGiB} GiB
                      </small>
                    </span>
                    <span className={`state ${vm.state}`}>
                      Observed: {vm.state}
                      <small>
                        Desired: {vm.desiredState} · Health: {vm.health}
                      </small>
                    </span>
                    <span>→</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="empty-list">No VMs yet. Create one from an available image.</p>
            )}
          </section>
        ) : null}
        {host ? (
          <RetainedDisks
            disks={retainedDisks}
            connected={connected}
            inspect={(vm) =>
              run(async () => {
                setSelected(vm)
                setDetail(vm)
              })
            }
          />
        ) : null}
        {op ? (
          <section className={`operation ${op.status}`} role="status">
            <strong>Operation {op.status}</strong>
            <span>{op.id}</span>
            {op.error ? <p>{op.error.message}</p> : null}
            {pending ? (
              <>
                <p>Request accepted. Waiting for the host to finish.</p>
                <button
                  disabled={!connected || busy}
                  onClick={() => run(async () => setOp(await call('operation.cancel', { operationId: op.id })))}
                >
                  Cancel operation
                </button>
              </>
            ) : null}
          </section>
        ) : null}
        {selected ? (
          <section className="detail">
            <div className="section-heading">
              <h2>{selected.name}</h2>
              <button onClick={() => setSelected(undefined)}>Close details</button>
            </div>
            <div className="actions">
              {(['start', 'shutdown', 'restart'] as const).map((action) => (
                <button
                  key={action}
                  disabled={disabled || selected.state === 'removed'}
                  onClick={() =>
                    run(async () => {
                      const current = vms.find((v) => v.id === selected.id) ?? selected
                      await mutation(`vm.${action}`, { vmId: current.id, expectedRevision: current.revision })
                    })
                  }
                >
                  {action === 'start' ? 'Start' : action === 'shutdown' ? 'Shut down' : 'Restart'}
                </button>
              ))}
              <button
                className="danger"
                disabled={disabled || (selected.state === 'removed' && !selected.diskRetained)}
                onClick={() => {
                  setConfirmed(false)
                  setDeleting(true)
                }}
              >
                {selected.state === 'removed' ? 'Purge retained disk' : 'Remove VM'}
              </button>
            </div>
            {selected.state === 'removed' ? (
              <p>
                Removed ·{' '}
                {selected.diskRetained
                  ? 'Disk data retained and counted in host storage allocation.'
                  : 'Disk data deleted.'}
              </p>
            ) : null}
            <button
              disabled={!connected || busy || selected.state !== 'running' || !!pending}
              onClick={() =>
                run(async () =>
                  setBootLogs({ vmId: selected.id, lines: await call<string[]>('vm.logs', { vmId: selected.id }) })
                )
              }
            >
              Read recent boot log
            </button>
            {bootLogs?.vmId === selected.id ? (
              <pre aria-label="Recent guest boot log">{bootLogs.lines.join('\n') || 'No new console output.'}</pre>
            ) : null}
            <h3>Health & inspection</h3>
            <pre>{JSON.stringify(detail, null, 2)}</pre>
          </section>
        ) : null}
        {host ? (
          <section className="events">
            <h2>Events & logs</h2>
            <p>Recent host events and diagnostic output.</p>
            <pre>{JSON.stringify(events, null, 2)}</pre>
          </section>
        ) : null}
      </main>
      {creating ? (
        <CreateComputer
          host={host}
          images={images}
          disabled={disabled}
          setCreating={setCreating}
          run={run}
          mutation={mutation}
        />
      ) : null}
      {deleting && selected ? (
        <div className="backdrop">
          <dialog
            ref={(node) => {
              if (node && !node.open) node.showModal()
            }}
            onCancel={() => setDeleting(false)}
            aria-labelledby="remove-title"
          >
            <h2 id="remove-title">Remove {selected.name}?</h2>
            <p>Remove this VM and retain its disk data by default. Check below to permanently delete its data.</p>
            <label className="check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              Delete VM data permanently
            </label>
            <div className="actions">
              <button onClick={() => setDeleting(false)}>Cancel</button>
              <button
                className="danger"
                disabled={disabled || (selected.state === 'removed' && !confirmed)}
                onClick={() =>
                  run(async () => {
                    const vm = vms.find((v) => v.id === selected.id) ?? selected
                    await mutation('vm.remove', { vmId: vm.id, expectedRevision: vm.revision, deleteData: confirmed })
                    setDeleting(false)
                  })
                }
              >
                {confirmed ? 'Delete VM and data' : 'Remove VM, retain data'}
              </button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  )
}
