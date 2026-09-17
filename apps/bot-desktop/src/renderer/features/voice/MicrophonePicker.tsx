import { ChevronDown, Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PANEL_CLASS, usePopover } from '@maestrly/chat-ui'
import { Button } from '../../ui'
import { useT } from '../../i18n'

export interface MicrophoneOption {
  deviceId: string
  label: string
}

/** Audio inputs the browser will name; labels only exist after the microphone permission was granted. */
export async function listMicrophones(): Promise<MicrophoneOption[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId)
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microfone ${index + 1}` }))
}

/**
 * A small chevron beside the record button: which microphone the next note uses. The choice is
 * a preference of this Mac, not of the bot, so it is saved with the other preferences.
 */
export function MicrophonePicker({ value, onChange, disabled }: { value?: string; onChange: (deviceId: string | undefined) => void; disabled: boolean }) {
  const t = useT()
  const { open, setOpen, ref } = usePopover()
  const [devices, setDevices] = useState<MicrophoneOption[]>([])
  // Names are resolved when the menu opens, and once on mount so a saved choice shows its name.
  useEffect(() => {
    if (!open && !value) return
    let alive = true
    listMicrophones()
      .then((list) => alive && setDevices(list))
      .catch(() => alive && setDevices([]))
    return () => {
      alive = false
    }
  }, [open, value])
  const current = devices.find((device) => device.deviceId === value)
  return (
    <div className="relative" ref={ref}>
      <Button
        type="button"
        className="voice-device"
        aria-label={t('voiceDevice')}
        title={current?.label ?? t('voiceDevice')}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={12} aria-hidden="true" />
      </Button>
      {open && (
        <div role="listbox" aria-label={t('voiceDevice')} className={`${PANEL_CLASS} left-auto right-0 w-64`}>
          {[{ deviceId: '', label: t('voiceDeviceDefault') }, ...devices].map((device) => (
            <button
              key={device.deviceId || 'default'}
              type="button"
              role="option"
              aria-selected={(value ?? '') === device.deviceId}
              onClick={() => {
                setOpen(false)
                onChange(device.deviceId || undefined)
              }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground hover:bg-white/[0.05]"
            >
              <Check className={`h-3.5 w-3.5 shrink-0 ${(value ?? '') === device.deviceId ? 'opacity-100' : 'opacity-0'}`} />
              <span className="min-w-0 flex-1 truncate">{device.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
