import type {ToolSet} from 'ai'
import { governRemoteChatTools, remoteChatPolicy } from './remote-policy'
import { APP_TOOL_POLICY } from './tool-policy'
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

export interface AutonomousPolicy {
  report?: { state: 'succeeded' | 'failed'; summary: string }
  providerIds?: string[]
  cwd: string
  allowCommands: boolean
  allowWeb: boolean
  allowAppTools: boolean
  allowMcp: boolean
  allowPush: boolean
}
const policies = new Map<string, AutonomousPolicy>()
const context = new AsyncLocalStorage<AutonomousPolicy>()
export function autonomousPolicy(conversationId: string): AutonomousPolicy | undefined {
  return policies.get(conversationId) ?? context.getStore()
}
export function registerAutonomousConversation(id: string, policy: AutonomousPolicy): () => void {
  policies.set(id, policy)
  return () => {
    if (policies.get(id) === policy) policies.delete(id)
  }
}
export function withAutonomousPolicy<T>(policy: AutonomousPolicy, operation: () => T): T {
  return context.run(policy, operation)
}
export const AUTONOMOUS_INSTRUCTIONS = `This is an authorized, unattended Maestrly executor task. No person is available to answer questions or approve a plan during this execution. Plan internally and carry the task through implementation and verification. Do not use review_plan, ask_question, request_user_input or other interactive approval flows. Resolve ordinary technical uncertainty by inspecting the project and making a reasonable, documented choice. Never invent missing credentials, permissions or business requirements. If indispensable information or authorization is missing, stop with a concrete blocker and explain what is needed. Do not start interactive commands or wait for keyboard input. Respect the configured tool permissions. Finish with what changed, what was verified and any unresolved blocker. Merely describing a plan is not completion. Before ending, the main executor must call executor_report with state succeeded only after completing and verifying the task, or failed with the concrete unresolved blocker. Then provide the final response.`
export class AutonomousInteractionError extends Error {
  constructor(
    message = 'No human is present for this execution. Plan internally and proceed within the authorized scope; report a blocker if essential information is unavailable.'
  ) {
    super(message)
    this.name = 'AutonomousInteractionError'
  }
}
export function autonomousProviderAllowed(providerId: string, conversationId = ''): boolean {
  const remote=remoteChatPolicy(conversationId)
  if(remote&&!remote.providerIds.includes(providerId))return false
  const policy = autonomousPolicy(conversationId)
  return !policy?.providerIds || policy.providerIds.includes(providerId)
}
/** Capture policy at admission: provider SDK callbacks may run outside the original async context. */
export function governAutonomousTools(tools:ToolSet,conversationId:string):void {
  governRemoteChatTools(tools,conversationId)
  const policy=autonomousPolicy(conversationId)
  if(!policy)return
  for(const name of Object.keys(tools)){
    if(interactiveTool(name)){delete tools[name];continue}
    const entry=tools[name]!,execute=entry.execute
    if(execute)tools[name]={...entry,execute:(...args)=>withAutonomousPolicy(policy,()=>execute(...args))}
  }
}
export function interactiveTool(name: string): boolean {
  return /(?:^|__)(?:review_plan|ask_question|request_user_input|request_user_input_async|wait_plan_review|AskUserQuestion|ExitPlanMode)(?:$|_)/.test(
    name
  )
}
export function assertAutonomousPermission(
  policy: AutonomousPolicy,
  input: { action: string; resources: string[] }
): void {
  const deny = (reason: string): never => {
    throw new AutonomousInteractionError('Operation not preauthorized for unattended execution: ' + reason)
  }
  if (input.resources.some(interactiveTool)) deny('interactive approval')
  if (input.action === 'external_directory') deny('external directory')
  if (input.action === 'bash') {
    if (!policy.allowCommands) deny('commands')
    if (!policy.allowPush && input.resources.some((r) => /\bgit\s+(?:-[^\s]+\s+)*push\b/.test(r))) deny('git push')
    return
  }
  if (input.action === 'webfetch') {
    if (!policy.allowWeb) deny('web access')
    return
  }
  if (input.action === 'mcp') {
    const appTool = input.resources.every((r) => Object.hasOwn(APP_TOOL_POLICY, r))
    if (appTool && !policy.allowCommands && input.resources.some((r) => r.startsWith('terminal_')))
      deny('terminal commands')
    if (appTool && !policy.allowWeb && input.resources.some((r) => r.startsWith('browser_'))) deny('browser')
    if (!(appTool ? policy.allowAppTools : policy.allowMcp)) deny(appTool ? 'application tools' : 'MCP tools')
    return
  }
  if (['read', 'edit', 'grep', 'glob'].includes(input.action)) {
    for (const resource of input.resources) {
      const absolute = path.resolve(policy.cwd, resource),
        relative = path.relative(policy.cwd, absolute)
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        deny('path outside execution workspace')
      if (/(?:^|[/\\])\.env(?:\.|$)/.test(relative) && !relative.endsWith('.example')) deny('environment secrets')
    }
    return
  }
  deny(input.action)
}
