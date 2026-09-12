/**
 * Catálogo `main` (pt-BR — tradução) — espelha `en/main.ts`. Chave ausente cai no en (fallbackLng). `{{var}}`.
 */
export default {
  openExternal: {
    pathNotFound: 'caminho não encontrado',
    vscodeNotFound: 'VS Code (code) não encontrado',
    invalidTarget: 'alvo inválido',
  },
  workspace: {
    notGitRepo: 'A pasta selecionada não é um repositório git.',
    bareNotSupported: 'Repositórios bare não são suportados.',
    cannotResolveRoot: 'Não foi possível resolver a raiz do repositório.',
    notFound: 'Workspace não encontrado.',
    siblingSourceNotFound: 'Conversa de origem não encontrada.',
    siblingSourceInvalid: 'Uma conversa-irmã exige uma conversa de origem ativa e de um único repositório.',
  },
  debug: {
    extTimeout:
      'timeout: a extensão não respondeu. Abra a aba “Código” desta conversa (o VS Code precisa estar carregado para controlar o debug).',
  },
  floating: {
    browser: 'Navegador',
    vscode: 'Código',
    terminal: 'Terminal',
    plan: 'Plano',
    review: 'Review',
    notes: 'Notas',
    chatgpt: 'ChatGPT',
    // pin da tira da janela flutuante (fixada permanece visível ao trocar de conversa)
    pin: 'Manter aberta ao trocar de conversa',
    unpin: 'Deixar de fixar',
    goToConversation: 'Ir para conversa',
  },
  dialog: {
    convNotFound: 'conversa não encontrada',
    cwdUnavailable: 'cwd da conversa indisponível',
    invalidVersion: 'versão inválida',
    versionNotFound: 'versão não encontrada',
    convWorkspaceNotFound: 'conversa/workspace não encontrado',
    cannotOpenTitle: 'Não foi possível abrir',
    unknownError: 'erro desconhecido',
    multiRepoInUse:
      'Há {{count}} conversa(s) multi-repo usando este repositório. Exclua-as antes de remover o workspace.',
    windowUnavailable: 'janela indisponível',
    mcpStartFailedTitle: 'Não foi possível iniciar o MCP',
    mcpStartFailedDetail:
      '{{message}}\n\nFeche outras instâncias/serviços que estejam ocupando as portas locais e abra o app novamente.',
    exportTitle: 'Exportar meus dados',
    appImageInstallTitle: 'Adicionar o {{name}} aos seus aplicativos?',
    appImageInstallDetail:
      'O arquivo será movido para a pasta Applications e o app entra no menu de aplicativos, com ícone e atualizações automáticas. Nada é instalado fora da sua pasta de usuário.',
    appImageInstallConfirm: 'Adicionar',
    appImageInstallLater: 'Agora não',
    quitTitle: 'Fechar o aplicativo?',
    quitConfirmDetail: 'Os agentes e terminais em andamento serão encerrados.',
    cancel: 'Cancelar',
    close: 'Fechar',
  },
  drawerLoading: {
    downloadingTitle: 'Preparando o VS Code',
    downloadingSub:
      'Baixando o VS Code para você usar dentro do app — não precisa instalar nada. Isso acontece só na primeira vez e pode levar alguns segundos.',
    startingTitle: 'Preparando o editor',
    startingSub: 'Iniciando o VS Code para esta conversa…',
    restartingTitle: 'Reiniciando o VS Code',
    restartingSub:
      'Subindo um novo servidor do editor sem fechar o app. Sua conversa e seus terminais seguem intactos.',
    errorTitle: 'Não foi possível preparar o VS Code',
    errorSub:
      'Falha ao baixar o editor. Verifique sua conexão com a internet e abra a aba Código novamente para tentar de novo.',
    chatgptRestoringTitle: 'Restaurando ChatGPT…',
    chatgptRestoringSub: 'Recarregando a última conversa. Login e sessão permanecem intactos.',
  },
} as const
