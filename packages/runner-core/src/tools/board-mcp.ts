import { BoardToolsClient, MaestrlyClient } from '@maestrly/client-sdk'

export function buildBoardTools(input: { baseUrl: string; organizationId: string; runId: string; token: string }) {
  const client = new MaestrlyClient({
    baseUrl: input.baseUrl,
    authentication: { headers: () => ({ authorization: `Bearer ${input.token}`, 'x-maestrly-organization-id': input.organizationId }) },
  })
  return new BoardToolsClient(client, input.organizationId, input.runId)
}
