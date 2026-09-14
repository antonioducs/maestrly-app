import { Button } from '../../ui'
import { useAdminT } from '../../i18n/admin'
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
  const a = useAdminT()
  return (
    <section aria-label={a('Retained disks')}>
      <h2>
        {a('Retained disks')} <span>{disks.length}</span>
      </h2>
      <p>{a('Disks retained on this host. They remain included in host storage allocation.')}</p>
      {disks.map((vm) => (
        <Button key={vm.id} disabled={!connected} onClick={() => inspect(vm)}>
          {vm.name} · {vm.diskGiB}
          {a('GiB · Inspect retained data')}{' '}
        </Button>
      ))}
    </section>
  )
}
