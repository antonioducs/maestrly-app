import { isBotMode } from './config'

/**
 * How each bot conversation splits its work into `task` calls, by conversation id: a bot's conversations share one
 * folder, and so one identity, but each follows its own settings. Subagents never receive it.
 */
const policies = new Map<string, () => string>()

export function setBotTaskPolicy(conversationId: string, render: (() => string) | null): void {
  if (render) policies.set(conversationId, render)
  else policies.delete(conversationId)
}

export function botTaskPolicyPrompt(conversationId: string | undefined): string {
  if (!isBotMode() || !conversationId) return ''
  return policies.get(conversationId)?.() ?? ''
}

export function parallelTasksPolicy(maxTasks: number): string {
  return `# Tasks\nWhen work splits into independent parts that each take a while (several images, several files to convert or transcribe, separate research questions), call task for each part in the same response so they run at the same time; at most ${maxTasks} run at once and the others wait. Keep for yourself what needs this conversation, and give each task a self-contained prompt that asks for a short report with the paths of the files it wrote. Tasks running at the same time share your desktop and browser: let at most one of them use computer_* or browser_* tools.`
}
