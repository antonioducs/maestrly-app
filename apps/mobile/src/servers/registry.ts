import { z } from 'zod'

/** A bot server this phone paired with. `id` is the device id the server gave this phone. */
export type PairedServer = {
  id: string
  origin: string
  name: string
  deviceName: string
  features: string[]
  pairedAt: string
}

export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
export type KeyValueStore = SecretStore

const pairedServerSchema = z.object({
  id: z.string().min(1),
  origin: z.string().min(1),
  name: z.string(),
  deviceName: z.string(),
  features: z.array(z.string()),
  pairedAt: z.string(),
})
const LIST = 'servers'
const ACTIVE = 'servers.active'
const tokenKey = (id: string) => `server-token.${id}`

/** Stores in memory: the web preview and the demo server use them, and so do tests. */
export function memoryStores(): { secrets: SecretStore; kv: KeyValueStore } {
  const store = () => {
    const values = new Map<string, string>()
    return {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    }
  }
  return { secrets: store(), kv: store() }
}

/**
 * The servers this phone paired with. Tokens stay in the secret store (Keychain or Keystore); the list in ordinary
 * storage holds only what is safe to read. Writes are ordered so a failure never leaves a listed server without its
 * token: the token is written before the server is listed, and a server is unlisted before its token is deleted.
 */
export class ServerRegistry {
  constructor(
    private readonly secrets: SecretStore,
    private readonly kv: KeyValueStore
  ) {}

  async list(): Promise<PairedServer[]> {
    const raw = await this.kv.get(LIST)
    if (!raw) return []
    try {
      const parsed = z.array(pairedServerSchema).safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  token(id: string): Promise<string | null> {
    return this.secrets.get(tokenKey(id))
  }

  async add(server: PairedServer, token: string): Promise<void> {
    await this.secrets.set(tokenKey(server.id), token)
    const others = (await this.list()).filter((item) => item.id !== server.id)
    await this.kv.set(LIST, JSON.stringify([...others, server]))
    await this.kv.set(ACTIVE, server.id)
  }

  async remove(id: string): Promise<void> {
    const remaining = (await this.list()).filter((item) => item.id !== id)
    await this.kv.set(LIST, JSON.stringify(remaining))
    await this.secrets.delete(tokenKey(id))
    if ((await this.kv.get(ACTIVE)) === id) {
      if (remaining[0]) await this.kv.set(ACTIVE, remaining[0].id)
      else await this.kv.delete(ACTIVE)
    }
  }

  async activeId(): Promise<string | null> {
    const servers = await this.list()
    const active = await this.kv.get(ACTIVE)
    return servers.find((item) => item.id === active)?.id ?? servers[0]?.id ?? null
  }

  setActive(id: string): Promise<void> {
    return this.kv.set(ACTIVE, id)
  }

  async updateFeatures(id: string, features: string[]): Promise<void> {
    const servers = await this.list()
    await this.kv.set(LIST, JSON.stringify(servers.map((item) => (item.id === id ? { ...item, features } : item))))
  }
}
