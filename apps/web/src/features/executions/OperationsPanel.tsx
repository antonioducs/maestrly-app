import { t, useLocale, dateTime } from '../../i18n/index.js'
import { FormDialog } from '../../components/FormDialog.js'
import { useEffect, useState } from 'react'
import { Activity, Check, X } from 'lucide-react'
import { api, write } from '../../app/api.js'
import type { Operation } from './types.js'
import { EmptyState } from '../../components/EmptyState.js'

export function OperationsPanel({ organizationId, projectId }: { organizationId: string; projectId: string }) {
  useLocale()
  const [operations, setOperations] = useState<Operation[]>([])
  const reload = () => void api<Operation[]>(`/api/v1/organizations/${organizationId}/projects/${projectId}/executions`).then(setOperations)
  useEffect(reload, [organizationId, projectId])
  async function decide(item: Operation, decision: 'approved' | 'rejected') {
    if (!item.approvalId) return
    await write(`/api/v1/organizations/${organizationId}/projects/${projectId}/approvals/${item.approvalId}`, 'POST', { decision }); reload()
  }
  const [answering, setAnswering] = useState<Operation | null>(null)
  async function answer(data: FormData) {
    const item = answering
    if (!item?.informationRequestId) throw new Error('This request is no longer available.')
    const response = String(data.get('response') ?? '').trim()
    if (!response) throw new Error('Enter a response for the agent.')
    await write(`/api/v1/organizations/${organizationId}/projects/${projectId}/information-requests/${item.informationRequestId}`, 'POST', { response }); reload()
  }
  return <section className="table-panel">
    {answering ? <FormDialog title={t("Answer agent")} submitLabel={t("Send response")} onClose={() => setAnswering(null)} onSubmit={answer}>
      <p className="form-description">{answering.cardTitle}</p>
      <div className="agent-question">{answering.informationQuestion ?? t("Information requested")}</div>
      <label>{t("Your response")}<textarea name="response" required rows={6} placeholder={t("Provide the context the agent needs…")} /></label>
    </FormDialog> : null}<header><Activity /><div><p className="eyebrow">{t("Jobs and attempts")}</p><h2>{t("Execution ledger")}</h2></div></header>
    {operations.length === 0 ? <EmptyState title={t("No execution yet")}><p>{t("Move a card into an agentic column to create one authorized job.")}</p></EmptyState> : <div className="operation-table" role="table">
      {operations.map((item) => <article key={item.id} role="row"><div><strong>{item.cardTitle}</strong><span>{dateTime(item.createdAt)}</span></div><span className="state-chip">{t("Job ·")} {t(item.jobState)}</span><span className="state-chip">{t("Run ·")} {t(item.runState ?? 'not claimed')}</span>{item.approvalStatus === 'pending' ? <div className="inline-actions"><button aria-label={t("Approve")} onClick={() => void decide(item, 'approved')}><Check /></button><button aria-label={t("Reject")} onClick={() => void decide(item, 'rejected')}><X /></button></div> : item.informationRequestId ? <button className="quiet" onClick={() => setAnswering(item)}>{t("Answer agent")}</button> : <span>{t(item.approvalStatus ?? '')}</span>}</article>)}
    </div>}
  </section>
}
