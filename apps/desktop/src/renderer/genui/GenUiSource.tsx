import { useTranslation } from 'react-i18next'

/** What the model wrote for an interface, folded under it. The answer's prose styles stop at generated interfaces. */
export function GenUiSource({ code, open = false }: { code: string; open?: boolean }) {
  const { t } = useTranslation('ui')
  return (
    <details className="text-[11px] text-muted-foreground" open={open}>
      <summary className="cursor-pointer select-none hover:text-foreground">{t('genUi.source')}</summary>
      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre rounded-md border border-white/[0.06] bg-black/30 p-2 font-mono text-[11px]">
        <code>{code}</code>
      </pre>
    </details>
  )
}
