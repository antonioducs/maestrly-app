// Adapted from OpenUI lang-core (packages/lang-core/src/reactive.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt.

import type * as z from 'zod/v4/core'

/** Schemas of props that take a `$variable` binding, tracked without mutating them. */
const reactiveSchemas = new WeakSet<object>()

/** Marks a prop schema as a two-way binding: `Slider($years, ...)` reads and writes `$years`. */
export function reactive<T extends z.$ZodType>(schema: T): T {
  reactiveSchemas.add(schema)
  return schema
}

export function isReactiveSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && reactiveSchemas.has(schema)
}
