import { CheckCircle2, Loader2, SquareTerminal, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TFn } from './shared'

export const WIN_SHELL_IDS = ['auto', 'cmd', 'powershell', 'pwsh', 'git-bash', 'custom']

const winShells = (t: TFn): { id: string; label: string }[] => [
  { id: 'auto', label: t('settings.terminal.shellAuto') },
  { id: 'cmd', label: t('settings.terminal.shellCmd') },
  { id: 'powershell', label: t('settings.terminal.shellPowershell') },
  { id: 'pwsh', label: t('settings.terminal.shellPwsh') },
  { id: 'git-bash', label: t('settings.terminal.shellGitBash') },
  { id: 'custom', label: t('settings.terminal.shellCustom') },
]

export function TerminalShellSection({
  t,
  freeShell,
  customShell,
  setCustomShell,
  shellTesting,
  shellTest,
  selectShell,
  commitCustomShell,
  testShell,
}: {
  t: TFn
  freeShell: string
  customShell: string
  setCustomShell: (v: string) => void
  shellTesting: boolean
  shellTest: { ok: boolean; error?: string } | null
  selectShell: (id: string) => void
  commitCustomShell: () => void
  testShell: () => Promise<void>
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-6">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('settings.terminal.heading')}</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{t('settings.terminal.desc')}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {winShells(t).map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => selectShell(s.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors',
              freeShell === s.id
                ? 'border-primary/50 bg-primary/15 text-foreground'
                : 'border-border bg-white/[0.02] text-muted-foreground hover:text-foreground'
            )}
          >
            <SquareTerminal className="size-3.5" /> {s.label}
          </button>
        ))}
      </div>
      {freeShell === 'custom' && (
        <input
          type="text"
          value={customShell}
          onChange={(e) => setCustomShell(e.target.value)}
          onBlur={commitCustomShell}
          placeholder={t('settings.terminal.customPlaceholder')}
          className="w-full rounded-lg border border-border bg-white/[0.02] px-3 py-2 text-[12px] text-foreground outline-none focus:border-primary/50"
        />
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-[12px]"
          onClick={() => void testShell()}
          disabled={shellTesting || (freeShell === 'custom' && !customShell.trim())}
        >
          {shellTesting ? <Loader2 className="size-3.5 animate-spin" /> : <SquareTerminal className="size-3.5" />}
          {t('settings.terminal.test')}
        </Button>
        {shellTest && (
          <span
            className={cn(
              'flex items-center gap-1 text-[11px]',
              shellTest.ok ? 'text-status-ready' : 'text-destructive'
            )}
          >
            {shellTest.ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
            {shellTest.ok ? t('settings.terminal.testOk') : (shellTest.error ?? t('settings.terminal.testFail'))}
          </span>
        )}
      </div>
    </section>
  )
}
