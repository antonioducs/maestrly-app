import { useTranslation } from 'react-i18next'
import type { GenUiIssue } from './issues'

/** The problems found in an interface, folded under one line; nothing when there are none. */
export function GenUiIssues({ issues }: { issues: readonly GenUiIssue[] }) {
  const { t } = useTranslation('ui')
  if (issues.length === 0) return null
  return (
    <details className="genui-issues text-[11px] text-amber-200/80">
      <summary className="cursor-pointer select-none hover:text-amber-100">
        {t('genUi.issues.summary', { count: issues.length })}
      </summary>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
        {issues.map((issue, i) => (
          <li key={i} className="break-words">
            {t(`genUi.issues.${issue.kind}`, { detail: issue.detail })}
          </li>
        ))}
      </ul>
    </details>
  )
}
