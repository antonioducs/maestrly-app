import { t, useLocale, number, duration } from '../../i18n/index.js'
import { useEffect, useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { api } from '../../app/api.js'

interface Summary { cards: Array<{ count: number; oldest_seconds: number | null }>; jobs: Array<{ state: string; count: number; average_wait_seconds: number | null }>; runs: Array<{ state: string; count: number; average_duration_seconds: number | null }>; cost: { status: string } }

export function ReportsPanel({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  useLocale()
  const [summary, setSummary] = useState<Summary | null>(null)
  useEffect(() => { void api<Summary>(`/api/v1/organizations/${organizationId}/projects/${projectId}/reports/summary`).then(setSummary) }, [organizationId, projectId])
  if (!summary) return <p>{t("Loading report…")}</p>
  return <section className="report-panel"><header><BarChart3 /><div><p className="eyebrow">{t("Operational signals")}</p><h2>{t("Delivery report")}</h2></div></header>
    <div className="report-cards"><article><span>{t("Open cards")}</span><strong>{number(summary.cards.reduce((total, item) => total + item.count, 0))}</strong></article><article><span>{t("Queued work")}</span><strong>{number(summary.jobs.filter((item) => ['queued', 'active'].includes(item.state)).reduce((total, item) => total + item.count, 0))}</strong></article><article><span>{t("Estimated cost")}</span><strong className="unavailable">{t("Unavailable")}</strong></article></div>
    <div className="report-lines"><h3>{t("Execution duration")}</h3>{summary.runs.map((run) => <div key={t(run.state)}><span>{t(run.state)}</span><b>{number(run.count)}</b><time>{duration(run.average_duration_seconds)}</time></div>)}</div>
  </section>
}
