# Protótipo · Editor de automação da coluna

> Implementado no app em `apps/web/src/features/automations/AutomationEditor.tsx` + `ModelFields.tsx` + `EditorField.tsx` e `apps/web/src/styles/automation-editor.css`. Este protótipo permanece como referência visual; o e2e `apps/web/e2e/automation.spec.ts` gera prints do app real em 1440/390 × light/dark e verifica que trocar destino/provedor/modo não desloca nenhuma seção.

Proposta de redesign do modal **Automação · <coluna>** (`apps/web/src/features/automations/AutomationEditor.tsx`), focada em duas coisas:

1. **Seções numeradas e fixas** — Ativação · Onde roda · Modelo · Modo de execução · Prompt · Avançado (colapsado).
2. **Zero layout shift** — nenhum campo é montado/desmontado conforme a seleção; campos ficam `disabled` com um *hint* que explica o porquê, e cada campo reserva a linha do hint (`grid-template-rows: 20px auto 18px`). Mensagens de erro/aviso vivem num footer sticky, junto do botão Salvar.

Abrir: `npx serve prototypes/automation-editor` (ou qualquer servidor estático) e acessar `http://localhost:3000`.

A barra superior do protótipo permite alternar tema escuro e desligar os slots reservados para comparar o comportamento antigo — o contador "shift acumulado" mede quanto as seções se moveram após cada interação.

**Regra de UI:** nenhum `<select>` nativo. `select.js` transforma cada `<select>` do markup num combobox customizado (trigger + listbox popover, navegação por teclado, type-ahead, aria) que espelha `apps/web/src/components/Select.tsx` e as classes `.select-trigger/.select-menu/.select-option` de `base.css`. O `<select>` original fica oculto como fonte de verdade (`.value`, `change`, `disabled`).

Tudo é estado em memória com dados fictícios; salvar/histórico/atualizar runners são simulados.

## Medição (viewport 1000×800, fontes carregadas)

Soma do deslocamento vertical das seções após cada interação, comparando com a posição inicial:

| Interação | Slots reservados | Sem reserva (comportamento atual) |
|---|---|---|
| Destino → runner específico | 0 px | 0 px |
| Runner → ci-runner-01 | 0 px | 409 px |
| Provedor → Codex | 0 px | 118 px |
| Provedor → Claude (sem effort/fast) | 0 px | 409 px |
| Runner → pessoal | 0 px | 297 px |
| Modo → Maestro | 0 px | 291 px |
| Destino → pool | 0 px | 291 px |
| Agente desabilitado | 0 px | 291 px |

Regras que garantem o zero: (1) nenhum campo é montado/desmontado, só `disabled` + hint; (2) todo slot de hint tem `min-height` (um `<p>` vazio colapsa para 0); (3) o dialog é ancorado pelo topo, não centralizado — crescer o conteúdo nunca re-centraliza; (4) `scrollbar-gutter: stable` no corpo rolável; (5) mensagens de erro/sucesso vivem no footer sticky com altura reservada.

Expandir o prompt, abrir o preview e abrir "Avançado" são crescimentos intencionais disparados pelo usuário e não contam como CLS.
