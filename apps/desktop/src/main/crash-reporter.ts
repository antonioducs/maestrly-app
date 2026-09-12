/** Process failures stay in the local application log; no diagnostics are uploaded. */
export type ProcessExitSource =
  | 'pty-shell'
  | 'render-process-gone'
  | 'child-process-gone'
  | 'vscode-serve-web'
  | 'ml-worker'
  | 'asr-worker'
export interface ProcessExitInfo {
  exitCode?: number | null
  signal?: number | string | null
  reason?: string
}
export function captureProcessExit(source: ProcessExitSource, info: ProcessExitInfo): void {
  console.error('[process-exit]', source, info)
}
