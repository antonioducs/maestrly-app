/**
 * Catálogo `mcp` (pt-BR — tradução) — espelha as chaves de `en/mcp.ts` (a FONTE). Preenchido pela Unidade M.
 * Chave ausente aqui cai no en (fallbackLng). Interpolação i18next: use `{{var}}`. PRESERVE termos load-bearing.
 */
export default {
  notes: {
    drawer:
      ' [Navegador EMBUTIDO na gaveta direita deste app — NÃO o Chrome do sistema. Use estas ferramentas para ver/controlar o navegador desta janela.]',
    term: ' Opera nos terminais da gaveta DESTA conversa. Use estes p/ processos PERSISTENTES ou interativos que o usuário acompanha ao vivo: dev servers, docker compose up, watch modes, TUIs. P/ comandos ONE-SHOT (git, testes, installs, builds, scripts que terminam sozinhos) prefira seu próprio shell/tool bash — saída mais limpa e menos tokens que o stream do PTY do terminal.',
    notes:
      ' (caderno "Notas" desta conversa, visível/editável na gaveta). PREFIRA-o aos seus próprios arquivos de rascunho para notas que o usuário deva poder ver/editar.',
    mermaid:
      ' Diagramas: inclua um bloco de código ```mermaid no markdown → renderiza como CHART na aba (flowchart, sequenceDiagram, gantt, classDiagram, etc.). Ótimo p/ desenhar fluxos/arquitetura.',
    memory:
      ' (memória do PROJETO: regras/contexto duráveis disponíveis às conversas Chat; editável pelo usuário. PREFIRA-a a rascunhos privados para regras que o usuário deve ver e manter.)',
    debug: ' [Debug do VS Code integrado desta conversa. REQUER a aba "Código" aberta. O usuário acompanha no editor.]',
  },

  tools: {
    browser_navigate: {
      title: 'Navegar',
      description: 'Navega o navegador da gaveta para uma URL (ou termo de busca).',
      params: { url: 'URL ou termo de busca' },
    },
    browser_back: { title: 'Voltar' },
    browser_forward: { title: 'Avançar' },
    browser_reload: { title: 'Recarregar' },
    browser_nav: {
      reloadDesc: 'Recarrega a página atual',
      moveDesc: '{{label}} uma página',
      descSuffix: ' do navegador desta conversa; aguarda o carregamento e devolve a URL.',
    },
    browser_wait_for: {
      title: 'Aguardar',
      description:
        'Espera (até timeout) por uma condição antes de prosseguir — essencial em páginas que carregam conteúdo async (SPA). Informe UM: selector (CSS que deve existir), text (deve aparecer na página) ou network_idle (rede sem requisições pendentes).',
      params: {
        selector: 'seletor CSS que deve passar a existir',
        text: 'texto que deve aparecer no corpo da página',
        networkIdle: 'espera ~450ms sem requisições pendentes',
        timeoutMs: 'tempo máximo de espera em ms (default 10000)',
      },
    },
    browser_snapshot: {
      title: 'Snapshot',
      description:
        'Lista os elementos interativos visíveis (ref, tag, type, name) da página atual. Use o ref em browser_click/browser_type.',
    },
    browser_click: {
      title: 'Clicar',
      description: 'Clica no elemento de um ref obtido por browser_snapshot.',
      params: { ref: 'ref do elemento (do snapshot)' },
    },
    browser_double_click: {
      title: 'Duplo clique',
      description: 'Duplo-clique no elemento de um ref obtido por browser_snapshot.',
      params: { ref: 'ref do elemento (do snapshot)' },
    },
    browser_right_click: {
      title: 'Clique direito',
      description: 'Clique com o botão direito (abre o menu de contexto) no elemento de um ref do snapshot.',
      params: { ref: 'ref do elemento (do snapshot)' },
    },
    browser_drag: {
      title: 'Arrastar',
      description:
        'Arrasta (drag-and-drop) do elemento de um ref para outro — útil p/ sliders e listas reordenáveis. Tire um browser_snapshot antes p/ obter os refs de origem e destino.',
      params: {
        fromRef: 'ref de origem (do snapshot)',
        toRef: 'ref de destino (do snapshot)',
      },
    },
    browser_type: {
      title: 'Digitar',
      description: 'Foca o elemento de um ref e digita o texto (opcionalmente limpando o campo antes).',
      params: {
        ref: 'ref do campo (do snapshot)',
        text: 'texto a digitar (use "" com clear=true para apenas limpar)',
        clear: 'limpa o campo antes de digitar (seleciona tudo e substitui)',
      },
    },
    browser_press_key: {
      title: 'Tecla',
      description:
        'Pressiona uma tecla na página, com modificadores opcionais. Teclas: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space, ou um único caractere (a-z, 0-9). Combos de EDIÇÃO com o acelerador do SO executam a ação nativa: select-all (Meta/Control+a), copy (+c), cut (+x), paste (+v), undo (+z), redo (+Shift+z).',
      params: {
        key: 'tecla nomeada (Enter, ArrowDown, …) ou 1 caractere (a-z, 0-9)',
        modifiers: 'modificadores; no mac use Meta para Cmd (ex.: ["Meta"] + key "a" = selecionar tudo)',
      },
    },
    browser_read_text: {
      title: 'Ler texto',
      description: 'Retorna o texto visível da página atual.',
    },
    browser_screenshot: {
      title: 'Screenshot',
      description:
        'Captura um screenshot PNG da página atual. Modelos com suporte a imagens o recebem visualmente; modelos sem esse suporte recebem uma descrição textual automática quando há um intérprete configurado, ou uma nota de omissão. Viewports muito grandes são reduzidos automaticamente (proporção preservada, nunca cortados) para caber no limite de imagem do modelo.',
    },
    browser_evaluate: {
      title: 'Executar JS',
      description:
        'Executa JavaScript na página atual (igual a colar no console do DevTools: aceita statements; o resultado é o da última expressão) e devolve o retorno serializado. Promises são aguardadas. Retorne um valor JSON-serializável — ex.: JSON.stringify(x), x.length, location.href, document.title. O escopo PERSISTE entre chamadas (mesmo contexto da página): variáveis definidas continuam vivas e let/const podem ser redeclarados (replMode); para começar do zero, recarregue a página.',
      params: { expression: 'código/expressão JavaScript a avaliar na página' },
    },
    browser_mouse_move: {
      title: 'Mover mouse',
      description:
        'Move o cursor do mouse para as coordenadas (x, y) em CSS px da página (origem no topo-esquerdo). A posição fica registrada e é reportada em browser_snapshot/browser_screenshot.',
      params: {
        x: 'coordenada X em CSS px (0 = borda esquerda)',
        y: 'coordenada Y em CSS px (0 = topo)',
      },
    },
    browser_scroll: {
      title: 'Rolar página',
      description:
        'Rola a página/container e devolve a posição resultante (y/maxY). Modos (precedência): selector (traz esse elemento p/ a área visível) > to (top|bottom) > posição absoluta (y/x) > delta (dy/dx em px, dy>0 desce). Use container p/ rolar DENTRO de um painel com overflow em vez da janela.',
      params: {
        dy: 'delta vertical em px (positivo desce)',
        dx: 'delta horizontal em px (positivo p/ a direita)',
        y: 'posição vertical absoluta em px (0 = topo)',
        x: 'posição horizontal absoluta em px',
        to: 'vai direto ao topo ou ao fim',
        selector: 'seletor CSS de um elemento a trazer para a área visível (scrollIntoView)',
        container: 'seletor CSS do elemento rolável a controlar, em vez da janela (overflow aninhado)',
      },
    },
    browser_console_logs: {
      title: 'Logs do console',
      description: 'Retorna os logs do console (console.log/warn/error e exceptions) capturados na página atual.',
      params: {
        level: 'filtra por nível (ex.: error para só erros)',
        limit: 'máximo de entradas (default 100)',
      },
    },
    browser_network_logs: {
      title: 'Logs de rede',
      description: 'Retorna as requisições de rede (método, URL, status, falhas) da página atual.',
      params: {
        onlyErrors: 'só requests que falharam ou status >= 400',
        limit: 'máximo de entradas (default 100)',
      },
    },
    browser_clear_logs: {
      title: 'Limpar logs',
      description: 'Limpa os buffers de console e rede (útil antes de reproduzir um bug).',
    },
    browser_set_dialog_behavior: {
      title: 'Diálogos nativos',
      description:
        'Define como diálogos nativos (alert/confirm/prompt) são auto-respondidos — eles são SÍNCRONOS e travariam a página, então são respondidos automaticamente (default: aceitar) e registrados nos console_logs. Use accept=false para cancelar; prompt_text preenche o prompt() quando aceito (prompt() é reimplementado via override pois o Electron não o suporta nativamente).',
      params: {
        accept: 'true = OK/confirmar; false = cancelar/dismiss',
        promptText: 'texto a preencher em prompt() quando accept=true',
      },
    },
    browser_tabs: {
      title: 'Listar abas',
      description:
        'Lista as abas abertas do navegador desta conversa (índice, título, URL) e marca a ativa. Use o índice em browser_switch_tab/browser_close_tab.',
    },
    browser_switch_tab: {
      title: 'Trocar de aba',
      description:
        'Torna ativa a aba de índice N (1-based, de browser_tabs). A partir daí as demais browser_* operam nela.',
      params: { index: 'índice da aba (1-based, obtido em browser_tabs)' },
    },
    browser_new_tab: {
      title: 'Nova aba',
      description: 'Abre uma aba nova (opcionalmente já navegando para uma URL ou termo de busca) e a torna ativa.',
      params: { url: 'URL ou termo de busca para abrir (default: página inicial)' },
    },
    browser_close_tab: {
      title: 'Fechar aba',
      description: 'Fecha a aba de índice N (1-based, de browser_tabs). Se for a ativa, a vizinha vira ativa.',
      params: { index: 'índice da aba a fechar (1-based, obtido em browser_tabs)' },
    },

    terminal_create: {
      title: 'Criar terminal',
      description: 'Cria um novo terminal (shell) na gaveta desta conversa e devolve o id. Ele aparece na UI.',
      params: {
        cwd: 'diretório inicial (default: cwd da conversa)',
        cols: 'colunas (default 120)',
        rows: 'linhas (default 40)',
      },
    },
    terminal_list: {
      title: 'Listar terminais',
      description: 'Lista os terminais livres vivos desta conversa (id, cwd, pid, processo).',
    },
    terminal_send: {
      title: 'Enviar (cru)',
      description:
        'Escreve texto cru no terminal, SEM aguardar (como digitar). Use para interagir ou enviar comandos longos/interativos; leia o resultado depois com terminal_read. Inclua "\\n" para executar uma linha.',
      params: {
        id: 'id do terminal (de terminal_create/terminal_list)',
        text: 'texto a escrever (use \\n para Enter)',
      },
    },
    terminal_run: {
      title: 'Rodar comando',
      description:
        'Escreve um comando + Enter e aguarda a saída estabilizar (melhor esforço), devolvendo o que foi capturado. Para comandos interativos ou de longa duração, prefira terminal_send + terminal_read.',
      params: {
        id: 'id do terminal',
        command: 'comando a executar (sem o Enter)',
        timeoutMs: 'tempo máx de espera (default 8000)',
      },
    },
    terminal_read: {
      title: 'Ler output',
      description: 'Lê o output recente do terminal (histórico do ring buffer). max_chars limita o tamanho.',
      params: {
        id: 'id do terminal',
        maxChars: 'máx de chars do FIM (default tudo, ~256KB)',
      },
    },
    terminal_snapshot: {
      title: 'Snapshot da tela',
      description:
        'Devolve a TELA renderizada atual do terminal (como o usuário vê agora), útil para TUIs que redesenham no lugar. Para histórico completo, use terminal_read.',
      params: { id: 'id do terminal' },
    },
    terminal_signal: {
      title: 'Sinal ao processo',
      description:
        'Envia um sinal ao processo do terminal SEM fechar a aba: SIGINT (Ctrl+C, interrompe), SIGTERM (encerra educadamente), SIGKILL (força). Use terminal_close para fechar a aba.',
      params: {
        id: 'id do terminal',
        signal: 'sinal a enviar',
      },
    },
    terminal_close: {
      title: 'Fechar terminal',
      description: 'Encerra e remove o terminal (mata o shell e fecha a aba na UI).',
      params: { id: 'id do terminal' },
    },
    terminal_resize: {
      title: 'Redimensionar',
      description: 'Ajusta cols/rows do terminal (útil antes de rodar TUIs).',
      params: {
        id: 'id do terminal',
        cols: 'colunas',
        rows: 'linhas',
      },
    },
    terminal_focus: {
      title: 'Focar na UI',
      description: 'Torna este terminal a aba ativa da gaveta e foca nele (na conversa do usuário).',
      params: { id: 'id do terminal' },
    },
    terminal_clear: {
      title: 'Limpar buffer',
      description: 'Limpa o histórico de output capturado deste terminal (ring buffer).',
      params: { id: 'id do terminal' },
    },

    notes_list_pages: {
      title: 'Listar páginas das notas',
      description: 'Lista as páginas (árvore) do caderno de notas desta conversa: id, title, parentId, order.',
    },
    notes_create_page: {
      title: 'Criar página de notas',
      description:
        'Cria uma página nova no caderno. Use parentId p/ criar uma SUB-página. Devolve o id da nova página.',
      params: {
        title: 'título da página',
        parentId: 'id da página-mãe (omita p/ página de topo)',
      },
    },
    notes_read_page: {
      title: 'Ler página de notas',
      description: 'Lê o markdown de uma página (use notes_list_pages p/ obter o pageId).',
    },
    notes_write_page: {
      title: 'Reescrever página de notas',
      description:
        'SUBSTITUI o markdown de uma página (headings, listas, checklist `- [ ]`). P/ só acrescentar, use notes_append_page.',
      params: { content: 'o markdown COMPLETO da página' },
    },
    notes_append_page: {
      title: 'Acrescentar a uma página',
      description: 'Acrescenta markdown ao FIM de uma página, sem reescrever o resto.',
      params: { text: 'markdown a acrescentar' },
    },
    notes_delete_page: {
      title: 'Excluir página de notas',
      description: 'Exclui uma página E suas sub-páginas (subárvore). Irreversível.',
    },
    notes_quick_append: {
      title: 'Anotação rápida',
      description:
        'Acrescenta um trecho à página principal do caderno (cria "Notas" se preciso). Atalho p/ jogar uma nota sem escolher página.',
      params: { text: 'markdown a acrescentar' },
    },
    project_notes_list_pages: {
      title: 'Listar páginas do projeto',
      description: 'Lista as páginas (árvore) do caderno do PROJETO deste repo: id, title, parentId, order.',
    },
    project_notes_create_page: {
      title: 'Criar página do projeto',
      description:
        'Cria uma página nova no caderno do PROJETO. Use parentId p/ criar uma SUB-página. Devolve o id da nova página.',
      params: {
        title: 'título da página',
        parentId: 'id da página-mãe (omita p/ página de topo)',
      },
    },
    project_notes_read_page: {
      title: 'Ler página do projeto',
      description:
        'Lê o markdown de uma página do caderno do PROJETO (use project_notes_list_pages p/ obter o pageId).',
    },
    project_notes_write_page: {
      title: 'Reescrever página do projeto',
      description:
        'SUBSTITUI o markdown de uma página do caderno do PROJETO (headings, listas, checklist `- [ ]`). P/ só acrescentar, use project_notes_append_page.',
      params: { content: 'o markdown COMPLETO da página' },
    },
    project_notes_append_page: {
      title: 'Acrescentar a uma página do projeto',
      description: 'Acrescenta markdown ao FIM de uma página do caderno do PROJETO, sem reescrever o resto.',
      params: { text: 'markdown a acrescentar' },
    },
    project_notes_delete_page: {
      title: 'Excluir página do projeto',
      description: 'Exclui uma página E suas sub-páginas (subárvore) do caderno do PROJETO. Irreversível.',
    },
    project_notes_quick_append: {
      title: 'Anotação rápida do projeto',
      description:
        'Acrescenta um trecho à página principal do caderno do PROJETO (cria "Notas" se preciso). Atalho p/ jogar uma nota de projeto sem escolher página.',
      params: { text: 'markdown a acrescentar' },
    },

    memory_search: {
      title: 'Buscar memória do projeto',
      description:
        'Busca híbrida e estreita em memórias locais duráveis e .agents/knowledge versionado. Use quando decisões, restrições, preferências, procedimentos ou lições anteriores puderem afetar um trabalho substancial; evite pedidos triviais ou autocontidos. Somente leitura.',
    },
    memory_list: {
      title: 'Listar memórias locais',
      description: 'Lista memórias locais estruturadas com filtros de lifecycle e metadata. Somente leitura.',
    },
    memory_read: {
      title: 'Ler memória do projeto',
      description:
        'Lê uma memória local estruturada específica por id após search/list identificá-la. Sem id, retorna uma projeção legada limitada.',
    },
    memory_upsert: {
      title: 'Memorizar informação durável',
      description:
        'Cria ou atualiza uma memória estruturada. Use apenas para informação explicitamente durável que possa mudar uma decisão futura; nunca guarde hipóteses, output bruto, segredos ou estado temporário.',
    },
    memory_archive: {
      title: 'Arquivar memória',
      description: 'Remove reversivelmente uma memória local de buscas futuras.',
    },
    memory_restore: {
      title: 'Restaurar memória',
      description: 'Restaura uma memória local arquivada para o status ativo.',
    },
    memory_forget: {
      title: 'Esquecer definitivamente',
      description: 'Apaga definitivamente uma memória local. Exige confirm=true.',
    },
    memory_promote_to_shared: {
      title: 'Promover para conhecimento compartilhado',
      description: 'Cria ou atualiza Markdown em .agents/knowledge após ação explícita. Nunca faz commit.',
    },
    memory_write: {
      title: 'Reescrever memória do projeto',
      description:
        'SUBSTITUI a memória do projeto (markdown completo). Use p/ regras DURÁVEIS (estilo de commit, convenções, comandos de build/teste, decisões). P/ só acrescentar, use memory_append.',
      params: { content: 'o markdown COMPLETO da memória' },
    },
    memory_append: {
      title: 'Acrescentar à memória do projeto',
      description: 'Acrescenta uma regra/nota ao FIM da memória do projeto, sem reescrever o resto.',
      params: { text: 'markdown a acrescentar (ex.: uma regra nova)' },
    },

    debug_status: {
      title: 'Status do debug',
      description: 'Estado atual: sessão ativa? parado/rodando, thread e local (arquivo:linha) onde parou.',
    },
    debug_start: {
      title: 'Iniciar debug',
      description:
        'Inicia uma sessão de debug e ESPERA o 1º stop (breakpoint/stopOnEntry). Passe `program` (caminho do .js, relativo ao repo) p/ launch Node, OU `configName` p/ usar uma config do launch.json. Devolve onde parou.',
      params: {
        program: 'caminho do entrypoint Node (relativo ao repo ou absoluto)',
        configName: 'nome de uma configuração do launch.json do projeto',
        stopOnEntry: 'para já na 1ª linha',
        args: 'argv do programa',
      },
    },
    debug_stop: { title: 'Encerrar debug', description: 'Encerra a sessão de debug ativa.' },
    debug_restart: {
      title: 'Reiniciar debug',
      description: 'Reinicia a sessão de debug e espera o 1º stop.',
    },
    debug_pause: {
      title: 'Pausar',
      description: 'Pausa o programa em execução (para inspecionar onde estiver).',
    },
    debug_continue: {
      title: 'Continuar',
      description: 'Continua (play) até o próximo breakpoint/fim. Devolve onde parou (ou se terminou).',
    },
    debug_step: {
      title: 'Avançar instrução',
      description: 'Avança uma linha: granularity over (default) | into | out. Precisa estar parado.',
    },
    debug_set_breakpoint: {
      title: 'Adicionar breakpoint',
      description: 'Põe um breakpoint em file:line (condicional via `condition`).',
      params: {
        file: 'caminho do arquivo (relativo ao repo ou absoluto)',
        line: 'linha (1-based)',
        condition: 'expressão condicional opcional',
      },
    },
    debug_remove_breakpoint: {
      title: 'Remover breakpoint',
      description: 'Remove o breakpoint em file:line.',
    },
    debug_clear_breakpoints: { title: 'Limpar breakpoints', description: 'Remove TODOS os breakpoints.' },
    debug_list_breakpoints: {
      title: 'Listar breakpoints',
      description: 'Lista os breakpoints atuais (file, line, enabled, condition).',
    },
    debug_stack: {
      title: 'Call stack',
      description: 'Devolve a pilha de chamadas no ponto parado (frames com id/name/file/line).',
    },
    debug_inspect: {
      title: 'Inspecionar variáveis',
      description:
        'Scopes + variáveis no frame parado (default: topo). Cada variável traz `ref`: use debug_variables p/ expandir objetos.',
      params: { frameId: 'id do frame (de debug_stack); omita p/ o topo' },
    },
    debug_variables: {
      title: 'Expandir variável',
      description: 'Expande um objeto/array pelo `ref` (variablesReference) vindo de debug_inspect.',
      params: { ref: 'variablesReference de uma variável composta' },
    },
    debug_evaluate: {
      title: 'Avaliar expressão',
      description: 'Avalia uma expressão no contexto do frame parado (REPL do debugger).',
      params: { expression: 'expressão a avaliar' },
    },

  },

  returns: {
    browser: {
      navigated: 'Navegou para {{url}}',
      moved: '{{label}} → {{url}}',
      reloaded: 'Recarregou → {{url}}',
      noHistory: 'Sem histórico para {{label}}.',
      waitOk: 'OK: {{what}} após {{ms}}ms.',
      waitTimeout: 'Timeout: {{what}} não ocorreu em {{ms}}ms.',
      waitWhatSelector: 'seletor "{{selector}}"',
      waitWhatText: 'texto "{{text}}"',
      waitWhatNetwork: 'rede ociosa',
      waitWhatNone: '(nenhuma condição informada)',
      clicked: 'Cliquei no ref {{ref}}',
      doubleClicked: 'Duplo-clique no ref {{ref}}',
      rightClicked: 'Clique direito no ref {{ref}}',
      dragged: 'Arrastei do ref {{from}} para o ref {{to}}',
      typed: 'Digitei no ref {{ref}}',
      clearedTyped: 'Limpei e digitei no ref {{ref}}',
      key: 'Tecla {{combo}}',
      mouseMoved: 'Mouse movido para ({{x}}, {{y}})',
      scroll: 'Scroll em y={{y}}/{{maxY}} ({{pct}}%), x={{x}}/{{maxX}}{{where}}',
      scrollContainer: ' [container {{container}}]',
      screenshotInfo: 'Mouse em ({{x}}, {{y}}) CSS px. Scroll y={{y2}}/{{maxY}} ({{pct}}%).',
      screenshotInfoUnavailable:
        'Mouse em ({{x}}, {{y}}) CSS px. Metadados de scroll indisponíveis; o screenshot é válido ({{error}}).',
      snapshotHead:
        'URL: {{url}}\nViewport: {{width}}x{{height}} CSS px | Scroll: y {{y}}/{{maxY}} ({{pct}}%) | Mouse: ({{mouseX}}, {{mouseY}})',
      noConsoleLogs: '(nenhum log de console capturado)',
      noNetworkLogs: '(nenhuma requisição capturada)',
      logsCleared: 'Logs limpos.',
      dialogBehavior: 'Diálogos serão {{action}}{{prompt}}.',
      dialogAccepted: 'aceitos',
      dialogCancelled: 'cancelados',
      dialogPrompt: ' (prompt: "{{text}}")',
      noTabs: '(nenhuma aba aberta)',
      tabActive: 'Aba ativa: {{index}} — {{label}}',
      tabOpened: 'Aba aberta e ativada (índice {{index}} de {{total}}).',
      tabClosed: 'Aba {{index}} fechada.',
      tabRow: '{{index}}.{{active}} {{title}} — {{url}}',
      tabRowActive: ' (ativa)',
      tabRowNewTitle: 'Nova aba',
    },
    terminal: {
      created: 'Terminal criado: {{id}} (cwd {{cwd}})',
      none: 'Nenhum terminal aberto nesta conversa.',
      sent: 'Enviado {{chars}} chars para {{id}}.',
      runNoOutput: '(sem saída capturada — pode estar rodando ainda; use terminal_read)',
      readEmpty: '(sem output ainda)',
      screenEmpty: '(tela vazia)',
      signalSent: 'Enviado {{signal}} para {{id}}.',
      closed: 'Terminal {{id}} fechado.',
      resized: 'Redimensionado {{id}} para {{cols}}x{{rows}}.',
      focused: 'Focado {{id}}.',
      bufferCleared: 'Buffer de {{id}} limpo.',
    },
    notes: {
      pageCreated: 'Página criada: {{id}} ("{{title}}").',
      pageEmpty: '(página vazia)',
      pageUpdated: 'Página atualizada.',
      appended: 'Acrescentado à página.',
      pageDeleted: 'Página (e sub-páginas) excluída.',
      quickAppended: 'Acrescentado à página "{{title}}".',
      quickPageTitle: 'Notas',
    },
    memory: {
      empty: '(memória vazia)',
      updated: 'Memória do projeto atualizada.',
      appended: 'Acrescentado à memória do projeto.',
    },
  },

  errors: {
    tabNotExist: 'Aba {{index}} não existe (há {{total}}).',
    termSpawnFailed: 'O processo do terminal encerrou antes de ficar pronto.',
    notTermOfConv: 'id "{{id}}" não é um terminal desta conversa.',
    termNotExist: 'terminal "{{id}}" não existe (ou já foi fechado).',
    termCwdLocked: 'o diretório do terminal está temporariamente bloqueado por uma troca de branch Git.',
    nothingToReview: 'nada para revisar (git diff vazio).',
    pageCreateFailed: 'não foi possível criar a página',
    convNotFound: 'conversa não encontrada',
    convWsNotFound: 'conversa/workspace não encontrado',
    convNoWorkspace: 'conversa sem workspace.',
    convNotInWorkspace: 'esta conversa não está num workspace.',
    debugFailed: 'falha no comando de debug',
  },
} as const
