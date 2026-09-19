/** Active host executions belong to their physical Cursor account, including cross-provider children. */
const activeRuns = new WeakMap<object, Set<AbortController>>()

export function abortCursorAccountRuns(manager: object): void {
  for (const controller of activeRuns.get(manager) ?? []) {
    controller.abort(new Error('Cursor account changed'))
  }
}

export async function withCursorAccountRun<T>(
  args: { manager: object; signal: AbortSignal },
  execute: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const controllers = activeRuns.get(args.manager) ?? new Set<AbortController>()
  activeRuns.set(args.manager, controllers)
  controllers.add(controller)
  const cancel = (): void => controller.abort(args.signal.reason)
  args.signal.addEventListener('abort', cancel, { once: true })
  if (args.signal.aborted) cancel()
  try {
    return await execute(controller.signal)
  } finally {
    args.signal.removeEventListener('abort', cancel)
    controllers.delete(controller)
    if (controllers.size === 0) activeRuns.delete(args.manager)
  }
}
