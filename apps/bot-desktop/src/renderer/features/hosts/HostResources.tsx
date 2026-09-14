import { useAdminT } from '../../i18n/admin'
import type { Host } from '../../../shared/types'
export function HostResources({ host }: { host: Host }) {
  const a = useAdminT()
  return (
    <>
      {' '}
      <section className="capacity" aria-label={a('Host resources')}>
        {(
          [
            ['CPU', host.allocated.cpus, host.capacity.cpus, 'cores'],
            ['Memory', Math.round(host.allocated.memoryMiB / 1024), Math.round(host.capacity.memoryMiB / 1024), 'GiB'],
            ['Storage', host.allocated.diskGiB, host.capacity.diskGiB, 'GiB'],
          ] as const
        ).map(([label, used, total, unit]) => (
          <div key={a(label)}>
            <span>{a(label)}</span>
            <p>
              <strong>{used}</strong> / {total} <small>{a(unit)}</small>
            </p>
            <progress value={used} max={total || 1} />
          </div>
        ))}
      </section>
      <p className="health">
        Host {host.id}
        {a('· Observed memory')} {host.observedMemoryMiB}
        {a('MiB · Capabilities:')} {host.capabilities.join(', ')}
        <br />
        {host.supported ? a('Host supported') : a('Host unsupported')} ·{' '}
        {host.runtimes.map((r) => `${r.id}: ${r.available ? a('ready') : (r.reason ?? a('unavailable'))}`).join(' · ')}
      </p>
    </>
  )
}
