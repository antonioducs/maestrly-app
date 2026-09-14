import { Button, Input, Checkbox } from '../../ui'
import { useAdminT } from '../../i18n/admin'
import { useT } from '../../i18n'
import { AffectedBots } from './AffectedBots'
import { RetainedDisks } from './RetainedDisks'
import { mergeEvents } from '../hosts/events'
import { CreateComputer } from './CreateComputer'
import { HostResources } from '../hosts/HostResources'
import { useEffect, useRef, useState } from 'react'
import type { Method } from '../../../shared/types'
import type { Vm, Host, Operation, HostEvent } from '../../../shared/types'
type Image = { id: string; name?: string; available?: boolean }
const call = <T,>(method: Method, params: Record<string, unknown> = {}): Promise<T> =>
  window.bot.call({ method, params }) as Promise<T>
function list<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value
  const items = (value as Record<string, unknown>)?.[key]
  if (Array.isArray(items)) return items
  throw new Error(`Invalid ${key} response`)
}
export function ComputersPage() {
  const a = useAdminT()
  const t = useT()
  const [sharedAction, setSharedAction] = useState<{ action: 'shutdown' | 'restart'; vm: Vm }>()
  const [bootLogs, setBootLogs] = useState<{ vmId: string; lines: string[] }>()
  const [alias, setAlias] = useState('')
  const [hosts, setHosts] = useState<import('../../../shared/types').HostTarget[]>([])
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
          setError(s.error ?? a('Host disconnected. Reconnect to refresh.'))
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
      const target =
        hosts.find((h) => h.id === alias || (h.kind === 'ssh' && h.alias === alias)) ??
        (await window.bot.addSshTarget(alias))
      const status = await window.bot.connect(target.id)
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
    if (!result?.id || !result.status) throw new Error(a('Host did not return an operation. Inspect before retrying.'))
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
            <small>{a('HOST CONSOLE · LAB')}</small>
          </div>
        </div>
        <h2>{a('Adicionar outro computador')}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            connect()
          }}
        >
          <label htmlFor="alias">{a('SSH configuration alias')}</label>
          <Input
            id="alias"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="studio-mac"
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
          />
          <Button disabled={busy || (!!pending && connected)} className="primary">
            {host ? a('Reconnect') : a('Connect')}
          </Button>
        </form>
        <div className="host-list">
          {hosts.map((target) => (
            <div key={target.id}>
              <Button
                onClick={() => setAlias(target.kind === 'ssh' ? target.alias : target.id)}
                className={target.id === alias || (target.kind === 'ssh' && target.alias === alias) ? 'chosen' : ''}
              >
                {target.displayName}
                <span>↗</span>
              </Button>
              <Button
                disabled={
                  busy ||
                  (connected &&
                    (connectedAlias.current === target.id ||
                      (target.kind === 'ssh' && connectedAlias.current === target.alias)))
                }
                aria-label={`${a('Remove target')} ${target.displayName}`}
                onClick={() =>
                  void run(async () => {
                    await window.bot.removeTarget(target.id)
                    setHosts(await window.bot.hosts())
                  })
                }
              >
                {a('Remove target')}
              </Button>
            </div>
          ))}
        </div>
        <p className="aside-note">
          {a('Connect using an alias from your SSH configuration. The host key must already be trusted.')}{' '}
        </p>
        <div className="connection">
          <i className={connected ? 'online' : ''} />
          {connected ? a('Connected') : a('Disconnected')}
          {connected ? (
            <Button
              onClick={() =>
                run(async () => {
                  generation.current++
                  await window.bot.disconnect()
                  setConnected(false)
                })
              }
            >
              {a('Disconnect')}{' '}
            </Button>
          ) : null}
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">{a('YOUR COMPUTE, CLOSE AT HAND')}</p>
            <h1>{host ? alias : a('A place for your machines.')}</h1>
            <p>
              {host
                ? `${host.platform} / ${host.arch} · ${a('Service')} ${host.serviceVersion} · ${a('Protocol')} ${host.protocolVersion} · ${a(host.health)}`
                : a('Connect a host to inspect capacity and manage virtual machines.')}
            </p>
          </div>
          <Button disabled={!connected || busy} onClick={() => run(refresh)}>
            {a('Diagnose & refresh')}{' '}
          </Button>
        </header>
        {recoveryIssue ? (
          <div className="alert" role="alert">
            {recoveryIssue}
            {retryableKeys.map((key) => (
              <Button
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
                {a('Retry same request')}{' '}
              </Button>
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
            {a('Disconnected · displayed state is stale. Reconnect before making changes.')}{' '}
          </div>
        ) : null}
        {host ? (
          <HostResources host={host} />
        ) : (
          <section className="empty">
            <div className="machine">▤</div>
            <h2>{a('Your hosts. Your workloads.')}</h2>
            <p>{a('Add an SSH alias on the left to bring your machines into view.')}</p>
          </section>
        )}
        {host ? (
          <section>
            <div className="section-heading">
              <h2>
                {a('Virtual machines')} <span>{vms.length}</span>
              </h2>
              <Button className="primary" disabled={disabled || !host.supported} onClick={() => setCreating(true)}>
                {a('Create VM')}{' '}
              </Button>
            </div>
            {vms.length ? (
              <div className="vm-list">
                {vms.map((vm) => (
                  <Button
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
                    <span className={`state ${a(vm.state)}`}>
                      {a('Observed:')} {a(vm.state)}
                      <small>
                        {a('Desired:')} {a(vm.desiredState)}
                        {a('· Health:')} {a(vm.health)}
                      </small>
                    </span>
                    <span>→</span>
                  </Button>
                ))}
              </div>
            ) : (
              <p className="empty-list">{a('No VMs yet. Create one from an available image.')}</p>
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
          <section className={`operation ${a(op.status)}`} role="status">
            <strong>
              {a('Operation')} {a(op.status)}
            </strong>
            <span>{op.id}</span>
            {op.error ? <p>{op.error.message}</p> : null}
            {pending ? (
              <>
                <p>{a('Request accepted. Waiting for the host to finish.')}</p>
                <Button
                  disabled={!connected || busy}
                  onClick={() => run(async () => setOp(await call('operation.cancel', { operationId: op.id })))}
                >
                  {a('Cancel operation')}{' '}
                </Button>
              </>
            ) : null}
          </section>
        ) : null}
        {selected ? (
          <section className="detail">
            <div className="section-heading">
              <h2>{selected.name}</h2>
              <Button onClick={() => setSelected(undefined)}>{a('Close details')}</Button>
            </div>
            <AffectedBots vmId={selected.id} />
            <div className="actions">
              {(['start', 'shutdown', 'restart'] as const).map((action) => (
                <Button
                  key={action}
                  disabled={disabled || selected.state === 'removed'}
                  onClick={() =>
                    run(async () => {
                      const current = vms.find((v) => v.id === selected.id) ?? selected
                      const bots = host?.capabilities.includes('bot.sessions.v1') ? await window.bot.bot({ method: 'bot.list', params: {} }) : []
                      if (action !== 'start' && bots.filter(bot => bot.vmId === current.id).length > 1) setSharedAction({ action, vm: current })
                      else await mutation(`vm.${action}`, { vmId: current.id, expectedRevision: current.revision })
                    })
                  }
                >
                  {action === 'start' ? a('Start') : action === 'shutdown' ? a('Shut down') : a('Restart')}
                </Button>
              ))}
              <Button
                className="danger"
                disabled={disabled || (selected.state === 'removed' && !selected.diskRetained)}
                onClick={() => {
                  setConfirmed(false)
                  setDeleting(true)
                }}
              >
                {selected.state === 'removed' ? a('Purge retained disk') : a('Remove VM')}
              </Button>
            </div>
            {selected.state === 'removed' ? (
              <p>
                {a('Removed ·')}{' '}
                {selected.diskRetained
                  ? a('Disk data retained and counted in host storage allocation.')
                  : a('Disk data deleted.')}
              </p>
            ) : null}
            <Button
              disabled={!connected || busy || selected.state !== 'running' || !!pending}
              onClick={() =>
                run(async () =>
                  setBootLogs({ vmId: selected.id, lines: await call<string[]>('vm.logs', { vmId: selected.id }) })
                )
              }
            >
              {a('Read recent boot log')}{' '}
            </Button>
            {bootLogs?.vmId === selected.id ? (
              <pre aria-label={a('Recent guest boot log')}>
                {bootLogs.lines.join('\n') || a('No new console output.')}
              </pre>
            ) : null}
            <h3>{a('Health & inspection')}</h3>
            <pre>{JSON.stringify(detail, null, 2)}</pre>
          </section>
        ) : null}
        {host ? (
          <section className="events">
            <h2>{a('Events & logs')}</h2>
            <p>{a('Recent host events and diagnostic output.')}</p>
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
      {sharedAction && <dialog ref={node => { if (node && !node.open) node.showModal() }} aria-labelledby="shared-action-title" onCancel={() => setSharedAction(undefined)}>
        <h2 id="shared-action-title">{sharedAction.action === 'restart' ? a('Restart') : a('Shut down')} · {sharedAction.vm.name}</h2>
        <AffectedBots vmId={sharedAction.vm.id} />
        <Button onClick={() => setSharedAction(undefined)}>{t('cancel')}</Button>
        <Button className="danger" onClick={() => void run(async () => {
          await mutation(`vm.${sharedAction.action}`, { vmId: sharedAction.vm.id, expectedRevision: sharedAction.vm.revision })
          setSharedAction(undefined)
        })}>{sharedAction.action === 'restart' ? a('Restart') : a('Shut down')}</Button>
      </dialog>}
      {deleting && selected ? (
        <div className="backdrop">
          <dialog
            ref={(node) => {
              if (node && !node.open) node.showModal()
            }}
            onCancel={() => setDeleting(false)}
            aria-labelledby="remove-title"
          >
            <AffectedBots vmId={selected.id} />
            <h2 id="remove-title">
              {a('Remove')} {selected.name}?
            </h2>
            <p>
              {a('Remove this VM and retain its disk data by default. Check below to permanently delete its data.')}
            </p>
            <label className="check">
              <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {a('Delete VM data permanently')}{' '}
            </label>
            <div className="actions">
              <Button onClick={() => setDeleting(false)}>{a('Cancel')}</Button>
              <Button
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
                {confirmed ? a('Delete VM and data') : a('Remove VM, retain data')}
              </Button>
            </div>
          </dialog>
        </div>
      ) : null}
    </div>
  )
}
