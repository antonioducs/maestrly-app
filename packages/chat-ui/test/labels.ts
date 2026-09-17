import type { ChatUiLabels } from '../src'
/** Every label filled in English, so a test can assert on the exact copy it injected. */
export const labels: ChatUiLabels = {
  copy: 'Copy',
  copied: 'Copied',
  responseDuration: (seconds) => `${seconds}s`,
  tool: { running: 'Running', done: 'Done', error: 'Failed', output: 'Output', command: 'Command', changes: 'Changes', pending: 'Preparing', awaitingPermission: 'Awaiting permission', denied: 'Denied', imageOutput: 'Image output', imageLoading: 'Loading image…', imageUnavailable: 'Image unavailable' },
  context: { title: 'Context', used: (used, limit) => `${used} / ${limit}`, cost: (cost) => `~${cost}`, unknownWindow: 'Window unknown' },
  composer: { placeholder: 'Write a message', message: 'Message', send: 'Send', stop: 'Stop', stopping: 'Stopping', attach: 'Attach', add: 'Add', attachments: 'Attachments', removeAttachment: 'Remove attachment', commands: 'Commands', skills: 'Skills', noCommands: 'No commands' },
  model: { title: 'Model', effort: 'Effort' },
  permission: { ask: 'Ask', full: 'Full access', askHint: 'Asks before acting', fullHint: 'Acts without asking' },
  usage: { title: 'Usage', period: 'Period', model: 'Model', input: 'Input', output: 'Output', cached: 'Cached', turns: 'Turns', cost: 'Cost', empty: 'Nothing yet', refresh: 'Refresh' },
  mermaid: { failed: 'Invalid diagram', rendering: 'Rendering diagram…', expand: 'Expand', zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Reset', close: 'Close', dialog: 'Diagram' },
}
