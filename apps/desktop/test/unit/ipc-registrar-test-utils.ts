import type { IpcRegistrar } from '../../src/main/ipc-registrar'

export type HandleFn = Parameters<IpcRegistrar['handle']>[1]
export type OnFn = Parameters<IpcRegistrar['on']>[1]

export interface TestRegistrar {
  reg: IpcRegistrar
  handles: Map<string, HandleFn>
  mhandles: Map<string, HandleFn>
  ons: Map<string, OnFn>
  mons: Map<string, OnFn>
}

export function createTestRegistrar(): TestRegistrar {
  const handles = new Map<string, HandleFn>()
  const mhandles = new Map<string, HandleFn>()
  const ons = new Map<string, OnFn>()
  const mons = new Map<string, OnFn>()
  const reg: IpcRegistrar = {
    handle: (channel, fn) => void handles.set(channel, fn),
    mhandle: (channel, fn) => void mhandles.set(channel, fn),
    on: (channel, fn) => void ons.set(channel, fn),
    mon: (channel, fn) => void mons.set(channel, fn),
  }
  return { reg, handles, mhandles, ons, mons }
}
