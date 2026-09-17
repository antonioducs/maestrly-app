import { useState } from 'react'
import { Button, Checkbox } from '../../ui'
import { useT } from '../../i18n'

/**
 * Widening a bot to full access is never a one-click change: the person reads what it means and
 * ticks the confirmation before the request carries `confirmFullVm`.
 */
export function FullVmConfirm({
  onConfirm,
  onCancel,
  busy = false,
}: {
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}) {
  const t = useT()
  const [checked, setChecked] = useState(false)
  return (
    <dialog
      ref={(node) => {
        if (node && !node.open) node.showModal()
      }}
      aria-labelledby="full-vm-title"
      onCancel={onCancel}
      className="danger"
    >
      <h2 id="full-vm-title">{t('fullMode')}</h2>
      <p>{t('fullWarning')}</p>
      <label className="check">
        <Checkbox checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        {t('confirmFull')}
      </label>
      <div className="actions">
        <Button onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
        <Button className="primary" disabled={!checked || busy} onClick={onConfirm}>
          {t('enableFull')}
        </Button>
      </div>
    </dialog>
  )
}
