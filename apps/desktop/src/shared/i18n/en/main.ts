export default {
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
      'Downloading VS Code to use right inside the app — nothing to install. This only happens the first time and may take a few seconds.',
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
    remoteUnauthorizedSub: 'Pair it again in Settings → Bot server, then open the Code tab again.',
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
} as const
