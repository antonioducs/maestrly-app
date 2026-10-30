export default {
  accountPool: {
    providerName: '{{provider}} — Active account',
    providerNameWithAccount: '{{provider}} — Active account ({{account}})',
    defaultAccountLabel: 'Default account',
  },

  openExternal: {
    pathNotFound: 'path not found',
    vscodeNotFound: 'VS Code (code) not found',
    invalidTarget: 'invalid target',
  },

  workspace: {
    publicRepoHeader: 'Public repository',
    publicRepoQuestion: 'Create {{repo}} on GitHub as a PUBLIC repository? Anyone will be able to see it.',
    publicRepoConfirm: 'Create public',
    publicRepoPrivate: 'Make it private',
    publicRepoCancel: 'Cancel',
    notGitRepo: 'The selected folder is not a git repository.',
    bareNotSupported: 'Bare repositories are not supported.',
    cannotResolveRoot: 'Could not resolve the repository root.',
    notFound: 'Workspace not found.',
    siblingSourceNotFound: 'Source conversation not found.',
    siblingSourceInvalid: 'A sibling conversation requires an active, single-repository source conversation.',
  },

  conversationDispatch: {
    confirmHeader: 'New conversations',
    confirmQuestion: 'Start {{count}} new conversation(s)?\n{{list}}',
    confirmItem: '• {{title}} ({{workspace}})',
    confirmThisProject: 'this project',
    confirmStart: 'Start',
    confirmCancel: "Don't start",
  },
  conversationLink: {
    sendHeader: 'Message another conversation',
    sendQuestion: 'Send this message to “{{name}}”{{workspace}}?\n\n{{preview}}',
    sendConfirm: 'Send',
    sendCancel: "Don't send",
  },
  debug: {
    extTimeout:
      'timeout: the extension did not respond. Open the “Code” tab of this conversation (VS Code must be loaded to control debugging).',
  },
  botDesktop: {
    presenterUnavailable: 'The browser window is not available on this desktop.',
    noConversation: 'This bot has no conversation yet.',
    invalidUrl: 'Only http and https links open in the browser.',
    terminalFailed: 'The terminal window could not open.',
    terminalTitle: 'Terminal {{number}}',
    exitOk: 'The shell ended.',
    exitFailed: 'The shell ended with code {{code}}. Press any key to close this window.',
  },
  remoteComputer: {
    untitled: 'Untitled conversation',
  },
  floating: {
    browser: 'Browser',
    computer: 'Computer',
    vscode: 'Code',
    terminal: 'Terminal',
    plan: 'Plan',
    review: 'Review',
    notes: 'Notes',
    files: 'Files',
    chatgpt: 'ChatGPT',

    pin: 'Keep open when switching conversations',
    unpin: 'Unpin',
    goToConversation: 'Go to conversation',
  },

  dialog: {
    convNotFound: 'conversation not found',
    cwdUnavailable: 'conversation cwd unavailable',
    invalidVersion: 'invalid version',
    versionNotFound: 'version not found',
    convWorkspaceNotFound: 'conversation/workspace not found',
    cannotOpenTitle: 'Could not open',
    unknownError: 'unknown error',
    multiRepoInUse:
      'There are {{count}} multi-repo conversation(s) using this repository. Delete them before removing the workspace.',
    windowUnavailable: 'window unavailable',
    mcpStartFailedTitle: 'Could not start the MCP',
    mcpStartFailedDetail:
      '{{message}}\n\nClose other instances/services occupying the local ports and open the app again.',
    exportTitle: 'Export my data',
    appImageInstallTitle: 'Add {{name}} to your applications?',
    appImageInstallDetail:
      'The file will be moved to the Applications folder and the app joins your app menu, with an icon and automatic updates. Nothing is installed outside your home folder.',
    appImageInstallConfirm: 'Add',
    appImageInstallLater: 'Not now',
    quitTitle: 'Close the app?',
    quitConfirmDetail: 'Agents and terminals in progress will be terminated.',
    cancel: 'Cancel',
    close: 'Close',
  },

  drawerLoading: {
    downloadingTitle: 'Setting up VS Code',
    downloadingSub:
      'Downloading VS Code to use right inside the app — nothing to install. This may take a few minutes, depending on your connection.',
    updatingTitle: 'Updating VS Code',
    updatingSub:
      'A new version of VS Code is out and is being downloaded. This may take a few minutes, depending on your connection.',
    progressDownload: '{{percent}}% · {{received}} of {{total}} MB',
    progressDownloading: 'Downloading…',
    progressInstalling: 'Installing…',
    progressStarting: 'Starting the editor…',
    startingTitle: 'Preparing the editor',
    startingSub: 'Starting VS Code for this conversation…',
    restartingTitle: 'Restarting VS Code',
    restartingSub:
      'Bringing up a new editor server without closing the app. Your conversation and terminals stay intact.',
    errorTitle: 'Couldn’t set up VS Code',
    errorSub: 'Failed to download the editor. Check your internet connection and open the Code tab again to retry.',
    remoteDownloadingTitle: 'Setting up VS Code on the server',
    remoteDownloadingSub:
      'The server downloads VS Code the first time its editor opens. This may take a minute; it runs there, in the conversation’s folder.',
    remoteStartingTitle: 'Starting the server’s editor',
    remoteStartingSub: 'Opening VS Code on the server for this conversation…',
    remoteOfflineTitle: 'The server is not connected',
    remoteOfflineSub: 'Open the Code tab again once the server is back.',
    remoteUnauthorizedTitle: 'This computer is not paired with the server',
    remoteUnauthorizedSub: 'Pair it again in Settings → Bot servers, then open the Code tab again.',
    remoteGatewayUpdateTitle: 'Update the bot server to open its editor',
    remoteGatewayUpdateSub:
      'The bot server runs a version from before the remote editor. Update it, then open the Code tab again.',
    remoteHostUpdateTitle: 'Update the workspaces environment to open its editor',
    remoteHostUpdateSub: 'Use Update bots on the server page, then open the Code tab again.',
    remoteFailedTitle: 'Couldn’t start VS Code on the server',
    remoteFailedSub:
      'The server could not download or start the editor. Check its internet connection and open the Code tab again to retry.',
    chatgptRestoringTitle: 'Restoring ChatGPT…',
    chatgptRestoringSub: 'Reloading the last conversation. Your login and session stay intact.',
  },
  peer: {
    pairingNotice: {
      title: '{{name}} wants to use this computer',
      body: 'Open Maestrly to see the pairing code.',
    },
  },
  notices: {
    untitled: 'Conversation',
    finished: 'Finished its turn',
    failed: 'The turn failed',
    question: 'Has a question for you',
    plan: 'Has a plan for you to review',
    badge: 'Things that need you: {{count}}',
    bot: {
      untitled: 'Bot',
      finished: 'Finished what you asked',
      failed: 'Could not finish what you asked',
      routineFinished: 'Finished a routine run',
      routineFailed: 'A routine run failed',
      needsYou: 'Needs you',
      threadPaused: 'Paused a conversation with another bot',
    },
  },
  chatProviderError: {
    http: '{{provider}} returned HTTP {{status}}: {{detail}}',
    httpWithoutDetail: '{{provider}} returned HTTP {{status}} without an error message.',
    withoutDetail: '{{provider}} failed without an error message.',
    unnamedProvider: 'The provider',
  },
} as const
