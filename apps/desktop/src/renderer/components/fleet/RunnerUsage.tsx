import { useTranslation } from 'react-i18next'
import { fileSizeLabel } from '@/lib/fleet/downloads'
import { cn } from '@/lib/utils'

/** What a running job uses, as its computer last sampled it (`FleetRunnerJobUsage` and `RunnerJobUsageItem` both fit). */
export interface RunnerUsageValues {
  /** A percentage of one logical CPU: 400 is four of them. */
  cpuPercent: number
  memoryBytes: number
  peakMemoryBytes: number
  processes: number
}

/**
 * One line with what a running job uses: the CPU it takes, the memory it holds and the most it held, and how many
 * processes it has. `cpus` is how many processors its computer has, when known, so that the CPU reads as a share of them.
 */
export function RunnerUsage({
  usage,
  cpus,
  className,
}: {
  usage: RunnerUsageValues
  cpus: number | null
  className?: string
}) {
  const { t, i18n } = useTranslation('fleet')
  const locale = i18n.language
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)
  const cpu = cpus
    ? t('botSettings.runners.usage.cpuOf', { count: cpus, used: number(usage.cpuPercent / 100, 1) })
    : t('botSettings.runners.usage.cpu', { percent: number(usage.cpuPercent, 0) })
  const memory = t('botSettings.runners.usage.memory', {
    now: fileSizeLabel(usage.memoryBytes, locale),
    peak: fileSizeLabel(usage.peakMemoryBytes, locale),
  })
  const processes = t('botSettings.runners.usage.processes', { count: usage.processes })
  return (
    <p data-testid="runner-job-usage" className={cn('text-[11px] tabular-nums text-muted-foreground', className)}>
      {[cpu, memory, processes].join(' · ')}
    </p>
  )
}
