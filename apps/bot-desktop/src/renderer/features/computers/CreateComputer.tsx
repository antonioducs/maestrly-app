import { Button, Input, Select } from '../../ui'
import { useAdminT } from '../../i18n/admin'
import type { Host, Method } from '../../../shared/types'
type Props = {
  host?: Host
  images: { id: string; name?: string; available?: boolean }[]
  disabled: boolean
  setCreating: (value: boolean) => void
  run: (action: () => Promise<void>) => Promise<void>
  mutation: (method: Method, params: Record<string, unknown>) => Promise<void>
}
export function CreateComputer({ host, images, disabled, setCreating, run, mutation }: Props) {
  const a = useAdminT()
  return (
    <div className="backdrop">
      <dialog
        ref={(node) => {
          if (node && !node.open) node.showModal()
        }}
        onCancel={() => setCreating(false)}
        aria-labelledby="create-title"
      >
        <h2 id="create-title">{a('Create a virtual machine')}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            run(async () => {
              await mutation('vm.create', {
                name: data.get('name'),
                imageId: data.get('image'),
                runtimeId: data.get('runtime'),
                cpus: Number(data.get('cpus')),
                memoryMiB: Number(data.get('memory')),
                diskGiB: Number(data.get('disk')),
              })
              setCreating(false)
            })
          }}
        >
          <label>
            {a('Name')} <Input name="name" required maxLength={80} autoFocus />
          </label>
          <label>
            {a('Image')}{' '}
            <Select aria-label="Image" name="image" required>
              {images
                .filter((i) => i.available !== false)
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name ?? i.id}
                  </option>
                ))}
            </Select>
          </label>
          <label>
            {a('Runtime')}{' '}
            <Select aria-label="Runtime" name="runtime" required>
              {host?.runtimes
                .filter((r) => r.available)
                .map((r) => (
                  <option key={r.id}>{r.id}</option>
                ))}
            </Select>
          </label>
          <div className="resource-fields">
            <label>
              {a('CPU cores')}{' '}
              <Input name="cpus" type="number" min="1" max={host?.capacity.cpus ?? 128} defaultValue="2" required />
            </label>
            <label>
              {a('Memory (MiB)')}{' '}
              <Input
                name="memory"
                type="number"
                min="256"
                max={host?.capacity.memoryMiB}
                defaultValue="2048"
                required
              />
            </label>
            <label>
              {a('Disk (GiB)')}{' '}
              <Input name="disk" type="number" min="1" max={host?.capacity.diskGiB} defaultValue="20" required />
            </label>
          </div>
          <div className="actions">
            <Button type="button" onClick={() => setCreating(false)}>
              {a('Cancel')}{' '}
            </Button>
            <Button className="primary" disabled={disabled || !images.length}>
              {a('Create VM')}{' '}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  )
}
