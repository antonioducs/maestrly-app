/**
 * MCP tool catalog. Every entry is a thin adapter over the same services the REST API uses, so the
 * connector cannot reach a capability the web UI does not also expose.
 */
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import type { ConnectorTool } from './mcp.js'
import { connectorVisibleProjects } from './grants.js'

export const emptyObjectSchema = { type: 'object', properties: {}, additionalProperties: false } as const

export function connectorToolCatalog(pool: DatabasePool, config: ServerConfig): ConnectorTool[] {
  return [
    {
      name: 'maestrly_list_projects',
      title: 'List authorized projects',
      description:
        'List the Maestrly projects this connection may use, with the actions the owner authorized for each ' +
        'one. Always start here: project ids from any other source are not valid input.',
      inputSchema: emptyObjectSchema as unknown as Record<string, unknown>,
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (_input, context) => ({
        organizationId: context.principal.organizationId,
        instance: { name: config.instanceName, url: config.canonicalUrl },
        projects: (await connectorVisibleProjects(pool, context.principal)).map((project) => ({
          projectId: project.projectId,
          name: project.name,
          actions: project.actions,
          url: `${config.webOrigin}/?organization=${context.principal.organizationId}&project=${project.projectId}`,
        })),
      }),
    },
  ]
}
