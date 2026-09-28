import { cn } from '@/lib/utils'

/** The on/off switch of the Bots settings, the same as the app's: green when on. */
export function SettingsSwitch({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean
  label: string
  onChange: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-emerald-500/70' : 'bg-white/10'
      )}
    >
      <span
        className={cn(
          'block size-4 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
          checked && 'translate-x-4'
        )}
      />
    </button>
  )
}
