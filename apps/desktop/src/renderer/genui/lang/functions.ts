// Adapted from OpenUI lang-core (packages/lang-core/src/functions.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt.

import { literal, object } from 'zod'
import type * as z from 'zod/v4/core'
import type { ActionRef } from './builtins'
import { actionRef, assertV4Schema } from './signature'

function assertParamsObject(params: z.$ZodType, name: string): void {
  assertV4Schema(params, name)
  if (params?._zod?.def.type !== 'object') throw new Error(`[genui] "${name}" params must be a z.object().`)
}

/** defineFunction({name: "Percent", params, fn}) -> called as @Percent(done, total). */
export interface DefinedFunction<
  T extends z.$ZodObject = z.$ZodObject,
  R extends z.$ZodType | undefined = z.$ZodType | undefined,
> {
  name: string
  description: string
  /** z.object({part, total}) -> @Percent(part, total), in key order. */
  params: T
  /** The return type in the prompt signature, checked at runtime. */
  returns?: R
  /** `@Percent(3, 4)` -> fn({part: 3, total: 4}); bad args or result, or a throw -> null. */
  fn: (args: z.infer<T>) => R extends z.$ZodType ? z.infer<R> : unknown
}

export function defineFunction<T extends z.$ZodObject, R extends z.$ZodType | undefined = undefined>(
  config: DefinedFunction<T, R>
): DefinedFunction<T, R> {
  assertParamsObject(config.params, config.name)
  if (config.returns) assertV4Schema(config.returns, config.name)
  return config
}

/** An action step: here only the built-in ones, which the prompt lists like functions. */
export interface DefinedAction<T extends z.$ZodObject = z.$ZodObject, N extends string = string> {
  name: N
  description: string
  /** Key order is the positional order in programs. */
  params: T
  ref: ActionRef
}

export function defineAction<const N extends string, T extends z.$ZodObject>(
  config: Omit<DefinedAction<T, N>, 'ref'>
): DefinedAction<T, N> {
  assertParamsObject(config.params, config.name)
  const data = object({ type: literal(config.name), params: config.params as any })
  return { ...config, ref: actionRef(config.name, data) }
}
