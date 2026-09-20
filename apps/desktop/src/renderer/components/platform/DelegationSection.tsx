import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import type { DelegationStatusView } from '../../../shared/platform'

/**
 * What this computer currently offers for delegated stages, and what it is running.
 *
 * It is deliberately read-only: a delegated stage is started, paused and configured in Maestrly, where the
 * person who delegated it can see the evidence. Showing controls here would suggest an authority this
 * computer does not have.
 */
export function DelegationSection() {
  const { i18n } = useTranslation()
  const L = (en: string, pt: string) => (i18n.language.startsWith('pt') ? pt : en)
  const [status, setStatus] = useState<DelegationStatusView | null>(null)

  useEffect(() => {
    let active = true
    const refresh = () =>
      void window.api
        .platformDelegationStatus()
        .then((value) => {
          if (active) setStatus(value)
        })
        .catch(() => {
          if (active) setStatus(null)
        })
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  const issueText = (issue: string) =>
    ({
      'Start the executor to offer delegated stages.': L(
        'Start the executor to offer delegated stages.',
        'Inicie o executor para oferecer etapas delegadas.'
      ),
      'This Maestrly instance did not accept a stage inventory from this computer.': L(
        'This Maestrly instance did not accept a stage inventory from this computer.',
        'Esta instância da Maestrly não aceitou um inventário de etapas deste computador.'
      ),
      'Connect provider accounts and select them in the desktop executor settings.': L(
        'Connect provider accounts and select them in the desktop executor settings.',
        'Conecte contas de provedor e selecione-as nas configurações do executor.'
      ),
      'Bind a project to a local workspace with a committed branch.': L(
        'Bind a project to a local workspace with a committed branch.',
        'Vincule um projeto a um workspace local com uma branch commitada.'
      ),
    })[issue] ?? issue

  return (
    <section className="space-y-4 rounded-xl border border-border p-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
        <div>
          <h3 className="text-sm font-semibold">{L('Delegated stages', 'Etapas delegadas')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {L(
              'Work delegated from Maestrly runs here with the account and model chosen for each stage. Start, pause and configuration happen in Maestrly, not on this computer.',
              'O trabalho delegado pela Maestrly roda aqui com a conta e o modelo escolhidos para cada etapa. Iniciar, pausar e configurar acontece na Maestrly, não neste computador.'
            )}
          </p>
        </div>
      </div>
      {!status ? (
        <p className="text-xs text-muted-foreground">{L('Loading…', 'Carregando…')}</p>
      ) : (
        <>
          <p className="text-xs">
            <span className="font-medium">
              {status.enabled
                ? L('Offering delegated stages', 'Oferecendo etapas delegadas')
                : L('Not offering delegated stages', 'Não está oferecendo etapas delegadas')}
            </span>
            {status.revision ? (
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                {L('inventory', 'inventário')} {status.revision.slice(0, 12)}
              </span>
            ) : null}
          </p>
          {status.issues.length ? (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {status.issues.map((issue) => (
                <li key={issue}>{issueText(issue)}</li>
              ))}
            </ul>
          ) : null}
          {status.selections.length ? (
            <div>
              <p className="text-xs font-medium">{L('Published selections', 'Seleções publicadas')}</p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {status.selections.map((selection) => (
                  <li key={selection.selectionId}>
                    {selection.accountLabel} · {selection.modelLabel}
                    {selection.efforts.length ? ` · ${selection.efforts.join(', ')}` : ''}
                    {selection.fastMode ? ` · ${L('fast mode', 'modo rápido')}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {status.workspaces.length ? (
            <div>
              <p className="text-xs font-medium">{L('Workspaces offered', 'Workspaces oferecidos')}</p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {status.workspaces.map((workspace) => (
                  <li key={workspace.key}>
                    {workspace.label} · {workspace.branches.slice(0, 4).join(', ')}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-medium">{L('Running now', 'Executando agora')}</p>
            {status.active.length ? (
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-muted-foreground">
                {status.active.map((attempt) => (
                  <li key={attempt.attemptId}>
                    {attempt.taskId.slice(0, 8)} · {attempt.stageId.slice(0, 8)} · {attempt.state}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                {L('No delegated stage is running on this computer.', 'Nenhuma etapa delegada rodando neste computador.')}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
