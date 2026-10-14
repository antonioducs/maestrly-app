// Adapted from OpenUI lang-core (packages/lang-core/src/library.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt. Changes: no custom actions, library extension, cloud spec or tools, and each
// component must own its props schema (upstream silently renamed a shared one).

import { object as zObject } from 'zod'
import * as z from 'zod/v4/core'
import { ACTION_DEFS, isBuiltin } from './builtins'
import type { DefinedFunction } from './functions'
import { type ComponentPromptSpec, generatePrompt, type PromptOptions } from './prompt'
import { assertV4Schema, schemaSignature, schemaIdTags, tagSchemaId, type SchemaRegistry } from './signature'
import type { FunctionSchema, JSONSchemaDef, LibraryJSONSchema } from './types'

/** What every component renderer receives; `RenderNode` is the framework's node type. */
export interface ComponentRenderProps<P = Record<string, unknown>, RenderNode = unknown> {
  props: P
  renderNode: (value: unknown) => RenderNode
  /** Statement that defined the component (e.g. "header"); undefined when inline. */
  statementId?: string
}

/** A component a program may call. `C` is the framework renderer, stored opaquely. */
export interface DefinedComponent<T extends z.$ZodObject = z.$ZodObject, C = unknown> {
  name: string
  props: T
  description: string
  component: C
}

export function defineComponent<T extends z.$ZodObject, C>(config: {
  name: string
  props: T
  description: string
  component: C
}): DefinedComponent<T, C> {
  assertV4Schema(config.props, config.name)
  const owner = schemaIdTags.get(config.props)
  if (owner && owner !== config.name)
    throw new Error(`[genui] "${config.name}" reuses the props schema of "${owner}"; give each component its own.`)
  tagSchemaId(config.props, config.name)
  return config
}

export interface ComponentGroup {
  name: string
  components: string[]
  notes?: string[]
}

export interface Library<C = unknown> {
  readonly components: Record<string, DefinedComponent<any, C>>
  readonly componentGroups: ComponentGroup[] | undefined
  readonly functions: Record<string, DefinedFunction<any, any>>
  /** The component every program's `root` calls. */
  readonly root: string
  prompt(options: PromptOptions): string
  toJSONSchema(): LibraryJSONSchema
}

export interface LibraryDefinition<C = unknown> {
  components: DefinedComponent<any, C>[]
  componentGroups?: ComponentGroup[]
  /** Library functions, called as `@Name(...)` in programs. */
  functions?: DefinedFunction<any, any>[]
  root: string
}

function buildComponentSpecs(
  components: Record<string, DefinedComponent<any, any>>,
  reg: SchemaRegistry
): Record<string, ComponentPromptSpec> {
  const specs: Record<string, ComponentPromptSpec> = {}
  for (const [name, def] of Object.entries(components)) {
    specs[name] = { signature: schemaSignature(name, def.props, undefined, reg), description: def.description }
  }
  return specs
}

function buildFunctionSpecs(
  functions: Record<string, DefinedFunction<any, any>>,
  reg: SchemaRegistry
): Record<string, ComponentPromptSpec> | undefined {
  const entries = Object.entries(functions)
  if (!entries.length) return undefined
  const specs: Record<string, ComponentPromptSpec> = {}
  for (const [name, def] of entries) {
    specs[name] = { signature: schemaSignature(name, def.params, def.returns, reg), description: def.description }
  }
  return specs
}

export function createLibrary<C = unknown>(input: LibraryDefinition<C>): Library<C> {
  const components: Record<string, DefinedComponent<any, C>> = {}
  const reg = z.registry<{ id: string }>()

  for (const comp of input.components) {
    reg.add(comp.props as z.$ZodType, { id: comp.name })
    components[comp.name] = comp
  }
  // Action slots are $refs like component slots; a component of the same name wins
  for (const [id, schema] of Object.entries(ACTION_DEFS)) {
    if (!components[id]) reg.add(schema, { id })
  }
  if (!components[input.root])
    throw new Error(
      `[genui] Root component "${input.root}" is not among the components: ${Object.keys(components).join(', ')}`
    )

  const names = new Set(Object.keys(components))
  const functions: Record<string, DefinedFunction<any, any>> = {}
  for (const fn of input.functions ?? []) {
    if (isBuiltin(fn.name) || names.has(fn.name))
      throw new Error(`[genui] Function "${fn.name}" collides with a built-in or a component of the same name.`)
    names.add(fn.name)
    functions[fn.name] = fn
  }

  // Component refs resolve against the library's top-level $defs
  const toCallJSONSchema = (schema: z.$ZodType): Record<string, unknown> => {
    const { $schema: _, $defs: __, ...rest } = z.toJSONSchema(schema, { metadata: reg })
    return rest
  }

  const buildJSONSchema = (): LibraryJSONSchema => {
    const combined = zObject(Object.fromEntries(Object.entries(components).map(([k, v]) => [k, v.props])) as any)
    const schema = z.toJSONSchema(combined, { metadata: reg }) as LibraryJSONSchema
    for (const [name, comp] of Object.entries(components)) {
      const def = schema.$defs?.[name]
      if (def && comp.description) def.description = comp.description
    }
    const fnEntries = Object.entries(functions)
    if (fnEntries.length) {
      schema.functions = Object.fromEntries(
        fnEntries.map(([name, def]): [string, FunctionSchema] => [
          name,
          {
            description: def.description,
            params: toCallJSONSchema(def.params) as JSONSchemaDef,
            ...(def.returns ? { returns: toCallJSONSchema(def.returns) } : {}),
          },
        ])
      )
    }
    return schema
  }

  return {
    components,
    componentGroups: input.componentGroups,
    functions,
    root: input.root,
    prompt: (options) =>
      generatePrompt({
        root: input.root,
        components: buildComponentSpecs(components, reg),
        componentGroups: input.componentGroups,
        functions: buildFunctionSpecs(functions, reg),
        ...options,
      }),
    toJSONSchema: buildJSONSchema,
  }
}
