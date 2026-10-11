import type { ReactNode } from 'react'
/** Shared presentation for local and environment catalogs; persistence belongs to the caller. */
export function ModelVisibilityCheckbox({
  name,
  checked,
  onChange,
  children,
  disabled,
}: {
  name: string
  checked: boolean
  onChange: () => void
  children?: ReactNode
  disabled?: boolean
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1 hover:bg-white/[0.04]">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-foreground">{name}</span>
        {children}
      </span>
    </label>
  )
}
