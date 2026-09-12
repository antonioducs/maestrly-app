export default {
  openExternal: {
    pathNotFound: 'path not found',
    vscodeNotFound: 'VS Code (code) not found',
    invalidTarget: 'invalid target',
  },

  workspace: {
    notGitRepo: 'The selected folder is not a git repository.',
    bareNotSupported: 'Bare repositories are not supported.',
    cannotResolveRoot: 'Could not resolve the repository root.',
    notFound: 'Workspace not found.',
    siblingSourceNotFound: 'Source conversation not found.',
    siblingSourceInvalid: 'A sibling conversation requires an active, single-repository source conversation.',
  },

  debug: {
    extTimeout:
      'timeout: the extension did not respond. Open the “Code” tab of this conversation (VS Code must be loaded to control debugging).',
  },
  floating: {
    browser: 'Browser',
    vscode: 'Code',
    terminal: 'Terminal',
    plan: 'Plan',
    review: 'Review',
    notes: 'Notes',
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
    chatgptRestoringTitle: 'Restoring ChatGPT…',
    chatgptRestoringSub: 'Reloading the last conversation. Your login and session stay intact.',
  },
} as const
