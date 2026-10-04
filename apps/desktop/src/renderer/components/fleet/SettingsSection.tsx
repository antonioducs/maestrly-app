import type { ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

/** Marks a section whose changes are saved at once, apart from those that wait for the save button. */
export function SavesNowTag() {
  const { t } = useTranslation('fleet')
  return (
    <span
      title={t('botSettings.savesNowTitle')}
      className="inline-flex items-center rounded-full border border-border px-2 py-px text-[11.5px] text-muted-foreground"
    >
      {t('botSettings.savesNow')}
    </span>
  )
}

/**
 * One section of the bot settings: a heading the save bar can move the focus to, a line saying what it is for, and its
 * content. The section is a region named by its heading.
 */
export function SettingsSection({
  id,
  title,
  note,
  aside,
  children,
  sectionRef,
  className,
}: {
  id: string
  title: string
  note?: ReactNode
  aside?: ReactNode
  children: ReactNode
  sectionRef?: Ref<HTMLElement>
  className?: string
}) {
  return (
    <section ref={sectionRef} id={id} aria-labelledby={`${id}-heading`} className={className}>
      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 id={`${id}-heading`} tabIndex={-1} className="text-base font-semibold focus:outline-none">
            {title}
          </h2>
          {aside}
        </div>
        {note && <p className="mt-0.5 text-[13px] text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

/** The card that holds a section's fields. */
export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-border bg-foreground/[0.025]', className)}>{children}</div>
}
