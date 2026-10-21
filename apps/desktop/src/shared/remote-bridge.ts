/**
 * The bridge between this computer's main process and a remote host (a Maestrly in server mode): JSON text frames over
 * one WebSocket. A renderer of this computer is an "origin"; the host runs its IPC handlers for an origin's frames as
 * if that renderer were one of its own.
 */
export const REMOTE_BRIDGE_PROTOCOL = 1

export const REMOTE_BRIDGE_LIMITS = {
  /** Attachments and images fit; bulk files use their own transfer routes. */
  maxFrameBytes: 64 * 1024 * 1024,
  /** A client whose socket buffers more than this is dropped; it reconnects and loads its views again. */
  clientBufferMax: 32 * 1024 * 1024,
  pingMs: 15_000,
  deadMs: 45_000,
  welcomeTimeoutMs: 10_000,
} as const

export type RemoteOs = 'mac' | 'win' | 'linux'
/** A computer, or a phone (`kind: 'mobile'`), which speaks only the versioned mobile API (`mobile:v1:*`). */
export type RemoteClientOs = RemoteOs | 'ios' | 'android'
export type RemoteClientKind = 'desktop' | 'mobile'

/**
 * What a host tells a client about itself; `desktopEffects`, `editor`, `browser` and `computer` gate the UI that needs
 * them.
 */
export interface RemoteHostInfo {
  os: RemoteOs
  hostName: string
  homeDir: string
  /** The folders a client may browse and add workspaces from. */
  roots: string[]
  /** Whether opening files, folders and dialogs on the host's own desktop is of any use to the person. */
  desktopEffects: boolean
  editor: boolean
  browser: boolean
  /** Whether the host gives its conversations computers of their own (a workspaces host on the bot image). */
  computer: boolean
  /** Whether whole folders move to and from the host (`FLEET_HOST_FILES_FOLDERS_FEATURE`), not only files. */
  folderTransfers: boolean
}

/** Which of this computer's renderers an origin is: the main window, or a drawer panel of one conversation. */
export type RemoteOriginRole = { role: 'main' } | { role: 'panel'; convId: string; panel: string }

export type BridgeClientFrame =
  | {
      t: 'hello'
      protocol: number
      appVersion: string
      client: {
        deviceName: string
        os: RemoteClientOs
        locale: string
        /** Absent: a computer. */
        kind?: RemoteClientKind
        /** A phone's mobile API version. */
        mobileApi?: number
      }
    }
  | ({ t: 'open'; origin: number } & RemoteOriginRole)
  | { t: 'close'; origin: number }
  | { t: 'invoke'; id: number; origin: number; channel: string; args: unknown[] }
  | { t: 'send'; origin: number; channel: string; args: unknown[] }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }

export type BridgeHostFrame =
  | { t: 'welcome'; protocol: number; appVersion: string; host: RemoteHostInfo; mobileApi?: number }
  | { t: 'refused'; reason: 'protocol' | 'version' | 'mobile-api'; hostVersion: string }
  | { t: 'result'; id: number; ok: true; value?: unknown }
  | { t: 'result'; id: number; ok: false; error: { message: string; code?: string } }
  | { t: 'event'; origin: number; channel: string; args: unknown[] }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number }

/** Why the host closed a bridge socket. */
export const REMOTE_BRIDGE_CLOSE = {
  dead: 4001,
  badFrame: 4002,
  refused: 4003,
  slowClient: 4008,
  /** The host removed this computer from the ones it lets use it. */
  removed: 4010,
  /** The host's owner disconnected this computer for now; it stays paired and may connect again when asked. */
  disconnected: 4011,
  /** The host now listens on another port, which the close reason carries: this computer reconnects there. */
  moved: 4012,
} as const
