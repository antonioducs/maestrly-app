# Protótipo · Detalhe do card

> Implementado no app em `apps/web/src/features/cards/CardDialog.tsx` + `MemberPicker.tsx` e `apps/web/src/styles/card-dialog.css`. O e2e `apps/web/e2e/card-dialog.spec.ts` gera prints do app real (1440/390 × light/dark), exercita o picker com busca e verifica que trocar prioridade/tab/filtro não move cabeçalho nem sidebar.

Proposta de redesign do `CardDialog` (`apps/web/src/features/cards/CardDialog.tsx`).

**Estrutura:** header sticky (breadcrumb + ID copiável · título editável inline como única fonte · chips semânticos de estado/execução · autosave · tabs) → corpo em dois painéis: conteúdo (Descrição, Critérios de aceite como checklist, Subtarefas com progresso, Anexos) e sidebar de propriedades (Coluna, Prioridade, Labels, Responsáveis, painel do Agente da coluna, metadados). Tabs: Detalhes · Atividade (comentários + eventos unificados, com filtro) · Execuções · Histórico. Ações secundárias/destrutivas no menu ⋯.

**Responsáveis:** multi-select com busca (`#assignee-picker`): busca por nome/e-mail com destaque, listbox multi-seleção com check, teclado (↑↓ Enter Esc Home End), contagem de selecionados; os escolhidos ficam como lista removível na sidebar. Escala para projetos com muitos membros.

**Regras:** nenhum `<select>` nativo (`select.js`); header/sidebar com slots fixos; painel de tab com `min-height: 100%`; dialog ancorado no topo.

Abrir: `python3 -m http.server 4174 --bind 127.0.0.1` em `prototypes/` → http://127.0.0.1:4174/card-dialog/
