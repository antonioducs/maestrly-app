/**
 * Catálogo `prompts` (pt-BR — tradução) — espelha as chaves de `en/prompts.ts` (a FONTE). Preenchido pela
 * Unidade P. Chave ausente aqui cai no en (fallbackLng). ⚠️ PRESERVE placeholders `{{...}}` e guardrails.
 */
export default {
  planBroker: {
    approvedWithEdits:
      'PLANO APROVADO COM EDIÇÕES pelo usuário. Esta é a versão FINAL aprovada — implemente-a ' +
      'agora exatamente como está; NÃO chame review_plan de novo nem re-planeje:\n\n{{edited}}',
    implementApprovedPlan:
      'Implemente agora o plano FINAL aprovado incluído inline abaixo. Ele é um contexto fornecido diretamente pelo ' +
      'Maestrly e NÃO existe como arquivo no worktree. Não procure nem tente abrir approved-plan.md. Siga o plano ' +
      'exatamente, não re-planeje nem chame review_plan de novo e verifique a implementação antes de concluir.\n\n' +
      '<approved_plan>\n{{plan}}\n</approved_plan>',
    decisionTurnFailed:
      'Não foi possível iniciar o turno da sua decisão de plano ({{reason}}). Nada foi alterado — envie uma mensagem para tentar de novo.',
    approved:
      'PLANO APROVADO pelo usuário. Implemente-o agora exatamente como planejado. ' + 'NÃO chame review_plan de novo.',
    discarded: 'O usuário DESCARTOU este plano. Pare e aguarde novas instruções — não implemente nada.',
    cancelledReplaced: 'Plano substituído por uma nova versão enviada para revisão.',
    cancelledClosed: 'Revisão de plano cancelada (conversa encerrada).',
    cancelledTimedOut:
      'A revisão de plano excedeu o timeout de {{min}} min. Pare e aguarde novas instruções — não implemente nada.',
    feedbackIntro:
      'O usuário revisou o plano e pediu ajustes. Refaça o plano levando o feedback abaixo em ' +
      'conta e chame review_plan novamente com a versão revisada.',
    feedbackGeneralHeading: '## Comentário geral',
    feedbackLineHeading: '## Comentários em trechos específicos',
    feedbackLineItem: 'Sobre “{{ref}}”: {{text}}',
    feedbackLineFallback: '(linha {{line}})',
    feedbackEditedHeading: '## Versão editada pelo usuário (use como base)',
  },

  // ---- review-loop.ts (turno interno + resumo auditável do review loop automático) ----
  reviewLoop: {
    pairedReviewerRound:
      'Revise de forma fresca o estado atual do checkout de código. Use git_diff, ao menos um grep ou glob e ' +
      'read antes de chamar submit_review exatamente uma vez. Permaneça read-only e não deixe a decisão em texto livre.',
    pairedImplementFindings:
      'Implemente os findings estruturados do review para a correção {{iteration}} de {{max}}. Não crie um plano; ' +
      'aplique os findings diretamente, rode os checks relevantes e verifique as mudanças antes de concluir.',
    implementFindings:
      'Implemente agora os findings da rodada {{iteration}}/{{max}} do review automático, anexados como ' +
      'review-loop-findings.md. Trate-os como a especificação desta rodada: implemente diretamente os ' +
      'findings acionáveis; NÃO gere plano nem chame review_plan; inspecione a implementação e os contratos ' +
      'relacionados antes de alterar; faça mudanças mínimas e completas; rode as verificações relevantes ' +
      'disponíveis (testes/lint/typecheck); se um finding for inválido, não force alteração — explique com ' +
      'evidência no resumo final; não faça commit, push nem mudanças fora do escopo dos findings; finalize ' +
      'com um resumo das alterações e validações.',
    findingsHeading: 'Review loop — rodada {{iteration}}/{{max}}',
    findingsSection: 'Findings ({{count}})',
    reviewerNotes: 'Notas do reviewer',
    summaryHeading: 'Review automático encerrado',
    summaryResult: 'Resultado',
    summaryRounds: 'Ciclos executados',
    summaryDuration: 'Duração',
    summaryBaseline: 'Fingerprint inicial (workspace)',
    summaryFinal: 'Fingerprint final (workspace)',
    summaryStopReason: 'Motivo de parada',
    summaryReviewer: 'Resumo do reviewer',
    summaryRemaining: 'Findings restantes',
    summaryRemainingCount:
      '{{total}} no total ({{blocking}} blocking, {{important}} important, {{optional}} optional):',
    summaryRemainingNone: 'Nenhum informado.',
    summaryChecks: 'Verificações executadas via bridge',
    summaryChecksNone: 'Nenhuma.',
    resultClean: 'limpo',
    resultMaxIterations: 'limite de iterações atingido',
    resultNoProgress: 'sem progresso',
    resultFailed: 'falhou',
    resultCancelled: 'cancelado',
    reasonExecutorUnavailable: 'executor indisponível',
    reasonWorkspaceChanged: 'workspace alterado externamente',
    reasonSessionEnded: 'sessão encerrada',
    reasonInterrupted: 'interrompido',
  },

  // ---- memory-service.ts (wrapper/cabeçalho legado mantido por compatibilidade) ----
  memory: {
    cursorRuleDescription: 'Memória do projeto (gerenciada pelo Maestrly)',
  },

  // ---- base-instructions.ts (#327 — diretiva fixa "prefira as tools do drawer") ----
  drawerPreference: {
    directive:
      'Preferência de ferramentas (deste app): você tem ferramentas da GAVETA cujos resultados aparecem na gaveta da conversa, onde o usuário acompanha e edita — {{drawerToolExamples}}. PREFIRA-as ao seu próprio shell, à sua própria memória (CLAUDE.md/AGENTS.md) ou a arquivos de rascunho sempre que o usuário deva ver, acompanhar ou editar o resultado: subir um servidor, um build longo ou um script, ou registrar uma decisão ou uma regra durável do projeto. Uma leitura rápida/one-off interna (ex.: git status) pode ficar no seu próprio shell, e sua memória/arquivos próprios servem quando o usuário pedir ou para o que estas ferramentas não cobrem. Isto é um padrão a preferir, não uma regra rígida.',
    drawerToolExamplesWithNotes:
      'terminal_* (rodar comandos nos terminais da gaveta), memory_* (memória durável do PROJETO) e notes_* (caderno)',
    drawerToolExamplesWithoutNotes:
      'terminal_* (rodar comandos nos terminais da gaveta) e memory_* (memória durável do PROJETO)',
    cursorRuleDescription: 'Preferência pelas tools da gaveta (Maestrly)',
  },
} as const
