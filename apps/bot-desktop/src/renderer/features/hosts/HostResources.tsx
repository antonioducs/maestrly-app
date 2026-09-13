import type { Host } from '../../../shared/types'
export function HostResources({ host }: { host: Host }) {
  return (
    <>
      {' '}
      <section className="capacity" aria-label="Host resources">
        {(
          [
            ['CPU', host.allocated.cpus, host.capacity.cpus, 'cores'],
            ['Memory', Math.round(host.allocated.memoryMiB / 1024), Math.round(host.capacity.memoryMiB / 1024), 'GiB'],
            ['Storage', host.allocated.diskGiB, host.capacity.diskGiB, 'GiB'],
          ] as const
        ).map(([label, used, total, unit]) => (
          <div key={label}>
            <span>{label}</span>
            <p>
              <strong>{used}</strong> / {total} <small>{unit}</small>
            </p>
            <progress value={used} max={total || 1} />
          </div>
        ))}
      </section>
      <p className="health">
        Host {host.id} · Observed memory {host.observedMemoryMiB} MiB · Capabilities: {host.capabilities.join(', ')}
        <br />
        {host.supported ? 'Host supported' : 'Host unsupported'} ·{' '}
        {host.runtimes.map((r) => `${r.id}: ${r.available ? 'ready' : (r.reason ?? 'unavailable')}`).join(' · ')}
      </p>
    </>
  )
}
