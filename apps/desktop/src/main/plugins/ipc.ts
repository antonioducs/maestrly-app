import { z } from 'zod'
import type { PluginOpResult } from '../../shared/plugins'
import type { IpcRegistrar } from '../ipc-registrar'
import { isSafeTreePath } from './paths'
import * as service from './service'

/**
 * `chat:plugins:*` channels. They are not local-only: on a remote workspaces host, the host's main process serves them
 * for its own plugins. Every input is validated here; anything unexpected is `invalid-input`.
 */

const KEY = /^[a-z0-9][a-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const key = z.string().regex(KEY)
const marketplaceId = z.string().regex(/^mkt_[0-9a-f]{16}$/)
const name = z.string().regex(NAME)
const scope = z.union([
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('projects'), workspaceIds: z.array(z.string().regex(UUID)).max(200) }).strict(),
])
const consent = z
  .object({
    consentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    stdio: z.array(z.string().min(1).max(64)).max(100),
    executables: z.boolean(),
    hooks: z.boolean().optional(),
  })
  .strict()
const inputValue = z.string().max(16 * 1024)
const inputId = z.string().min(1).max(300)

export const PLUGIN_IPC_SCHEMAS = {
  catalog: z.tuple([marketplaceId]),
  inspect: z.tuple([z.object({ marketplaceId, name }).strict()]),
  logo: z.tuple([z.object({ marketplaceId, name }).strict()]),
  marketplaceAdd: z.tuple([
    z
      .object({
        url: z.string().min(1).max(2048),
        ref: z.string().max(255).nullable().optional(),
        sparsePaths: z
          .array(
            z
              .string()
              .max(400)
              .refine((p) => isSafeTreePath(p.replace(/^\.?\/+|\/+$/g, '')))
          )
          .max(20)
          .optional(),
      })
      .strict(),
  ]),
  marketplaceRefresh: z.tuple([marketplaceId]),
  marketplaceRemove: z.tuple([z.object({ id: marketplaceId, uninstall: z.boolean() }).strict()]),
  install: z.tuple([
    z
      .object({
        marketplaceId,
        name,
        consent,
        scope,
        inputs: z.record(inputId, inputValue).optional(),
      })
      .strict()
      .refine((value) => Object.keys(value.inputs ?? {}).length <= 100),
  ]),
  update: z.tuple([z.object({ key, consent: consent.optional() }).strict()]),
  setEnabled: z.tuple([z.object({ key, enabled: z.boolean() }).strict()]),
  setScope: z.tuple([z.object({ key, scope }).strict()]),
  setServer: z.tuple([
    z
      .object({ key, serverKey: z.string().min(1).max(64), enabled: z.boolean(), consent: z.boolean().optional() })
      .strict(),
  ]),
  setInputs: z.tuple([
    z
      .object({ key, values: z.record(inputId, inputValue.nullable()) })
      .strict()
      .refine((value) => Object.keys(value.values).length <= 100),
  ]),
  setHooks: z.tuple([z.object({ key, enabled: z.boolean(), consent: z.boolean().optional() }).strict()]),
  uninstall: z.tuple([z.object({ key, deleteData: z.boolean() }).strict()]),
} as const

const invalid = <T>(): PluginOpResult<T> => ({ ok: false, error: 'invalid-input' })

function guarded<S extends z.ZodType<unknown[]>, R>(
  schema: S,
  run: (...args: z.infer<S>) => Promise<R>,
  onInvalid: () => R
): (_event: unknown, ...args: unknown[]) => Promise<R> {
  return async (_event, ...args) => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) return onInvalid()
    return run(...(parsed.data as z.infer<S>))
  }
}

export const PLUGIN_READ_CHANNELS = [
  'chat:plugins:state',
  'chat:plugins:catalog',
  'chat:plugins:inspect',
  'chat:plugins:logo',
] as const
export const PLUGIN_MUTATION_CHANNELS = [
  'chat:plugins:marketplace-add',
  'chat:plugins:marketplace-refresh',
  'chat:plugins:marketplace-remove',
  'chat:plugins:install',
  'chat:plugins:update',
  'chat:plugins:set-enabled',
  'chat:plugins:set-scope',
  'chat:plugins:set-server',
  'chat:plugins:set-inputs',
  'chat:plugins:set-hooks',
  'chat:plugins:uninstall',
] as const

export function registerPluginIpc(reg: IpcRegistrar): void {
  const s = PLUGIN_IPC_SCHEMAS
  reg.handle('chat:plugins:state', () => service.pluginsState())
  reg.handle(
    'chat:plugins:catalog',
    guarded(s.catalog, (id) => service.catalog(id), invalid)
  )
  reg.handle(
    'chat:plugins:inspect',
    guarded(s.inspect, (input) => service.inspect(input), invalid)
  )
  reg.handle(
    'chat:plugins:logo',
    guarded(
      s.logo,
      (input) => service.logo(input),
      () => null
    )
  )
  reg.mhandle(
    'chat:plugins:marketplace-add',
    guarded(s.marketplaceAdd, (input) => service.addMarketplace(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:marketplace-refresh',
    guarded(s.marketplaceRefresh, (id) => service.refreshMarketplace(id), invalid)
  )
  reg.mhandle(
    'chat:plugins:marketplace-remove',
    guarded(s.marketplaceRemove, (input) => service.removeMarketplace(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:install',
    guarded(s.install, (input) => service.install(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:update',
    guarded(s.update, (input) => service.update(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:set-enabled',
    guarded(s.setEnabled, (input) => service.setEnabled(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:set-scope',
    guarded(s.setScope, (input) => service.setScope(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:set-server',
    guarded(s.setServer, (input) => service.setServer(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:set-inputs',
    guarded(s.setInputs, (input) => service.setInputs(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:set-hooks',
    guarded(s.setHooks, (input) => service.setHooks(input), invalid)
  )
  reg.mhandle(
    'chat:plugins:uninstall',
    guarded(s.uninstall, (input) => service.uninstall(input), invalid)
  )
}
