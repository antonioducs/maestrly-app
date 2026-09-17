import type { ChatModelMeta } from '@maestrly/chat-ui/cost'
export type { Vm, Host, Operation } from '@maestrly/host-protocol'
import type {
  ExtensionMethod,
  ExtensionResult,
  PromptMethod,
  PromptResult,
  BotMethod,
  BotResult,
  DesktopInput,
  DesktopState,
  Operation,
  RoutineMethod,
  RoutineResult,
  TargetRef,
  TeamMethod,
  TeamResult,
  VoiceClip,
  VoiceMethod,
  VoiceResult,
} from '@maestrly/host-protocol'
export type HostEvent = { seq: number; kind: string; createdAt: string; value: unknown }
export const vmMethods = [
  'host.inspect',
  'vm.list',
  'vm.create',
  'vm.inspect',
  'vm.logs',
  'vm.start',
  'vm.shutdown',
  'vm.restart',
  'vm.remove',
  'operation.get',
  'operation.lookup',
  'operation.cancel',
  'events.list',
  'image.list',
] as const
export const methods = vmMethods
export type Method = (typeof vmMethods)[number]
export type Call = { method: Method; params: Record<string, unknown> }
export type BotCall<M extends BotMethod = BotMethod> = { method: M; params: Record<string, unknown> }
export type TeamCall<M extends TeamMethod = TeamMethod> = { method: M; params: Record<string, unknown> }
export type RoutineCall<M extends RoutineMethod = RoutineMethod> = { method: M; params: Record<string, unknown> }
export type VoiceCall<M extends VoiceMethod = VoiceMethod> = { method: M; params: Record<string, unknown> }
export type PromptCall<M extends PromptMethod = PromptMethod> = { method: M; params: Record<string, unknown> }
export type ExtensionCall<M extends ExtensionMethod = ExtensionMethod> = { method: M; params: Record<string, unknown> }
/** A folder read for a skill install: relative paths and contents, bounded by the Host limits. */
export type PickedFolder = { name: string; files: { path: string; dataBase64: string }[] }
/** Where a Host runs: this Mac through the fixed local command, or a remote alias already trusted in SSH config. */
export type HostTarget =
  | { kind: 'local'; id: 'local'; displayName: string; hostId?: string; lastConnectedAt?: string }
  | { kind: 'ssh'; id: string; alias: string; displayName: string; hostId?: string; lastConnectedAt?: string }
export type Connection = {
  connected: boolean
  alias: string | null
  target?: HostTarget
  error?: string
  hostId?: string
  retryableKeys?: string[]
  recoveryIssue?: string
  lastOperation?: Operation
  pending?: Operation[]
  retainedVmIds?: string[]
  accountSupport?: 'available' | 'host-outdated' | 'unknown'
  botSupport?: 'available' | 'host-outdated' | 'unknown'
  teamSupport?: 'available' | 'host-outdated' | 'unknown'
  routineSupport?: 'available' | 'host-outdated' | 'unknown'
  /** Voice is only offered when this Host can actually transcribe; otherwise the app stays textual. */
  voiceSupport?: 'available' | 'host-outdated' | 'unknown'
  /** Rich transcripts (tool cards, reasoning) need a Host that folds them; otherwise the app shows plain messages. */
  chatSupport?: 'available' | 'host-outdated' | 'unknown'
}
export type LocalHostStatus =
  | { state: 'installed'; version?: string }
  | { state: 'missing' }
  | { state: 'unsupported'; reason: string }
  | { state: 'untrusted'; reason: string }
export type InstallOutcome = { status: 'installed' | 'blocked' | 'cancelled' | 'failed'; message: string }
/** Persisted onboarding draft; never contains secrets. */
export type OnboardingDraft = {
  name: string
  purpose: string
  targetId?: string
  sharedVmId?: string
  accountId?: string
  model?: import('@maestrly/host-protocol').Bot['model']
  instructions?: string
  step?: number
  previewId?: string
  inventoryRevision?: string
  /** Durable key for bot.setup.start so reopening the app resumes instead of creating twice. */
  idempotencyKey?: string
  operationId?: string
  botId?: string
  updatedAt: string
}
export type UiPreferences = { theme: 'system' | 'light' | 'dark'; advanced: boolean; locale: 'pt-BR' | 'en'; lastBotId?: string; /** The audio input chosen for voice notes; absent = the system default. */ microphoneDeviceId?: string }
export interface BotApi {
  hosts(): Promise<HostTarget[]>
  connect(targetId: string): Promise<Connection>
  addSshTarget(alias: string): Promise<HostTarget>
  removeTarget(targetId: string): Promise<void>
  disconnect(): Promise<void>
  status(): Promise<Connection>
  retry(idempotencyKey: string): Promise<Operation>
  call(call: Call): Promise<unknown>
  bot<M extends BotMethod>(call: BotCall<M>): Promise<BotResult<M>>
  team<M extends TeamMethod>(call: TeamCall<M>): Promise<TeamResult<M>>
  routine<M extends RoutineMethod>(call: RoutineCall<M>): Promise<RoutineResult<M>>
  prompt<M extends PromptMethod>(call: PromptCall<M>): Promise<PromptResult<M>>
  /** Per-bot MCP servers and skills; secret values go in and never come back. */
  extension<M extends ExtensionMethod>(call: ExtensionCall<M>): Promise<ExtensionResult<M>>
  /** Chooses a skill folder with the main-process dialog; null when cancelled. */
  pickFolder(): Promise<PickedFolder | null>
  voice: VoiceApi
  syncAccounts(): Promise<{ unavailableHosts: string[] }>
  localHost(): Promise<LocalHostStatus>
  installLocalHost(): Promise<InstallOutcome>
  openExternal(url: string): Promise<boolean>
  draft(): Promise<OnboardingDraft | null>
  saveDraft(draft: OnboardingDraft | null): Promise<void>
  preferences(): Promise<UiPreferences>
  /** Context windows and prices from the public models.dev catalogue, keyed `provider/model`; empty when never fetched. */
  modelMeta(): Promise<Record<string, ChatModelMeta>>
  savePreferences(preferences: Partial<UiPreferences>): Promise<UiPreferences>
  saveFile(input: { name: string; dataBase64: string }): Promise<{ saved: boolean }>
  pickFile(): Promise<{ name: string; size: number; dataBase64: string } | null>
  desktop: DesktopApi
}
/**
 * Voice lives behind its own small surface. Recording is the renderer's job; everything that
 * touches the Host — reserving, streaming, transcribing, sending — happens in the main process,
 * so the chunk loop cannot sit in front of the frames a person is waiting on.
 */
export interface VoiceApi {
  call<M extends VoiceMethod>(call: VoiceCall<M>): Promise<VoiceResult<M>>
  /** Hands over one canonical WAV and gets back the stored clip. */
  upload(input: { target: TargetRef; clientClipId: string; dataBase64: string; durationMs: number }): Promise<VoiceClip>
  /** Reads a recording back for playback, by identity; there is no path or URL to hand out. */
  read(input: { clipId: string }): Promise<{ clipId: string; dataBase64: string }>
  /** Asks the system for microphone access, on the person's gesture. */
  requestMicrophone(): Promise<{ access: 'granted' | 'denied' | 'restricted' | 'unavailable' }>
  /** Arms or disarms the window's microphone gate around a recording. */
  arm(armed: boolean): Promise<{ armed: boolean }>
}
export type DesktopPhase = 'connecting' | 'viewing' | 'acquiring' | 'controlling' | 'returning' | 'reconnecting' | 'closed'
/** Public projection pushed by the main process; never carries tickets or capabilities. */
export type DesktopViewEvent = { handle: string; botId: string; state?: DesktopState; controlling: boolean; phase: DesktopPhase; reason?: string }
export type DesktopOpenResult = { handle: string; url: string; protocols: string[]; state: DesktopState }
export type DesktopReturnResult = { status: 'running' | 'succeeded' | 'failed'; failureCode?: string; continued: boolean; state: DesktopState }
export interface DesktopApi {
  inspect(botId: string): Promise<DesktopState>
  open(botId: string): Promise<DesktopOpenResult>
  close(handle: string): Promise<{ closed: boolean }>
  acquire(handle: string): Promise<{ handle: string; state: DesktopState; controlling: boolean; phase: DesktopPhase }>
  input(handle: string, events: DesktopInput[]): Promise<{ queued: number }>
  returnControl(input: { botId: string; handle?: string; continueTask: boolean }): Promise<DesktopReturnResult>
  onEvent(listener: (event: DesktopViewEvent) => void): () => void
}
declare global {
  interface Window {
    bot: BotApi
  }
}
