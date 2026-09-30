// The viewer's calls to its artifact's API. The custom header marks them as the shell's own requests.
import { ARTIFACT_HEADER, type ViewerGate, type ViewerState } from './contract.js'

export interface ArtifactApi {
  read(path: string): Promise<Response>
  write(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<Response>
  /** What this browser may see: the page's state, what it may do to get in, or nothing. */
  state(): Promise<ViewerState | ViewerGate | null>
}

export function createApi(base: string): ArtifactApi {
  const read = (path: string) =>
    fetch(`${base}/${path}`, { credentials: 'same-origin', headers: { [ARTIFACT_HEADER]: '1' } })
  const write = (path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) =>
    fetch(`${base}/${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', [ARTIFACT_HEADER]: '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return {
    read,
    write,
    async state() {
      try {
        const response = await read('state')
        if (response.status !== 200) return null
        return (await response.json()) as ViewerState | ViewerGate
      } catch {
        return null
      }
    },
  }
}

/** The response body as an object, or an empty one when there is none. */
export async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
