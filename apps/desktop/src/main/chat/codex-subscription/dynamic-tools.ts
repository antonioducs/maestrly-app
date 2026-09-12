export interface DynamicToolFunctionSpec {
  type: 'function'
  name: string
  description: string
  inputSchema: unknown
  deferLoading?: boolean
}

export interface DynamicToolNamespaceSpec {
  type: 'namespace'
  name: string
  description: string
  tools: DynamicToolFunctionSpec[]
}

export type DynamicToolRegistrationSpec = DynamicToolFunctionSpec | DynamicToolNamespaceSpec

const DEFERRED_NAMESPACE_BASE = 'maestrly_deferred'
const DEFERRED_NAMESPACE_DESCRIPTION = 'Maestrly MCP and app tools discovered on demand.'

function deferredNamespaceName(specs: readonly DynamicToolFunctionSpec[]): string {
  const functionNames = new Set(specs.map((spec) => spec.name))
  if (!functionNames.has(DEFERRED_NAMESPACE_BASE)) return DEFERRED_NAMESPACE_BASE
  let suffix = 2
  while (functionNames.has(`${DEFERRED_NAMESPACE_BASE}_${suffix}`)) suffix += 1
  return `${DEFERRED_NAMESPACE_BASE}_${suffix}`
}

/**
 * The Codex app-server accepts deferLoading only on functions nested under a namespace. Runtime dispatch remains
 * flat because item/tool/call sends the child function name separately from its namespace.
 */
export function dynamicToolRegistrations(
  specs: readonly DynamicToolFunctionSpec[]
): DynamicToolRegistrationSpec[] {
  const eager = specs.filter((spec) => spec.deferLoading !== true)
  const deferred = specs.filter((spec) => spec.deferLoading === true)
  if (!deferred.length) return [...eager]
  return [
    ...eager,
    {
      type: 'namespace',
      name: deferredNamespaceName(specs),
      description: DEFERRED_NAMESPACE_DESCRIPTION,
      tools: deferred,
    },
  ]
}
