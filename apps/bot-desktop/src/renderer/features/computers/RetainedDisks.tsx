import type { Vm } from '../../../shared/types'
export function RetainedDisks({
  disks,
  connected,
  inspect,
}: {
  disks: Vm[]
  connected: boolean
  inspect: (vm: Vm) => void
}) {
  return (
    <section aria-label="Retained disks">
      <h2>
        Retained disks <span>{disks.length}</span>
      </h2>
      <p>Disks retained on this host. They remain included in host storage allocation.</p>
      {disks.map((vm) => (
        <button key={vm.id} disabled={!connected} onClick={() => inspect(vm)}>
          {vm.name} · {vm.diskGiB} GiB · Inspect retained data
        </button>
      ))}
    </section>
  )
}
