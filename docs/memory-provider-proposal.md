# Optional project memory provider: design proposal

This is a proposal for [issue #51](https://github.com/antonioducs/maestrly-app/issues/51), not a shipped integration. Maestrly's notes and project memory remain local and authoritative. A remote provider would only add an explicitly enabled source of recalled context and approved durable writes.

## Existing boundaries

Maestrly already has local project memory and per-conversation MCP enablement. Its MCP client accepts HTTP and stdio servers, but the current HTTP transport has no interactive OAuth sign-in. Merely entering an OAuth-protected MemCode URL in **MCP servers** will not connect; this proposal does not present that as a working setup.

## Small provider-neutral interface

The interface belongs at the desktop executor boundary, not in the web server or core project model. One project/run selects a provider explicitly. No provider is selected by default.

```ts
type MemoryScope = { projectId: string; workspaceId: string }
type MemoryHit = { text: string; source?: string; recordedAt?: string }

interface ProjectMemoryProvider {
  recall(scope: MemoryScope, query: string, signal: AbortSignal): Promise<MemoryHit[]>
  remember(scope: MemoryScope, approvedText: string, signal: AbortSignal): Promise<void>
}
```

The first implementation can be a no-op or local in-memory provider. A later MemCode adapter would implement the same interface, so no MemCode type or dependency enters project state. `projectId` and `workspaceId` are Maestrly's local routing keys; they are not accepted as proof of remote identity. The adapter must map them to a server-side authorized scope, or decline to send the request. A user-entered scope string must never be treated as authorization.

## Consent and failure behavior

1. The owner opts in per project, sees that selected snippets leave the device, and authenticates with the provider. Team jobs cannot inherit an owner's personal connection by accident.
2. Recall runs only for the opted-in project/run. The UI labels its results as externally sourced, untrusted context. They cannot override instructions, local files, permission decisions, or review gates.
3. Nothing is saved on every turn. After a completed run, the user previews and approves the exact compact note to send. The remote write is idempotent on retry.
4. Disabled, unauthenticated, revoked, timed-out, or unavailable providers return no external context and do not block local memory, chat, or jobs. Errors remain visible in diagnostics without logging tokens or recalled content.
5. Disconnect removes the local credential and stops future calls; the provider's deletion/retention policy must be exposed separately. Disconnect must not claim remote deletion.

## MemCode adapter candidate

MemCode's hosted MCP resource is `https://mcp.memcode.in/i/maestrly/mcp`. The alias is for server-side integration attribution, not authentication. Its OAuth flow requires dynamic client registration and PKCE; the existing Maestrly HTTP MCP client does not implement that flow, so it needs either a general OAuth-capable MCP transport or a separate adapter before this URL is usable. No API key should be embedded in repository config or sent to the web server.

Self-hosted/local MemCode is a separately licensed deployment, not an open-source dependency Maestrly can silently bundle. The provider interface must be useful with a local implementation even if that deployment is unavailable.

## Suggested acceptance test for an implementation PR

- Disabled/default mode makes zero remote requests and local memory still works.
- Two projects cannot read or write each other's remote records; credentials remain scoped to the owner.
- Revocation, network failure, abort, and timeout preserve the local path.
- Recall text containing instructions remains marked as data, and writing requires an exact user-approved note.
- One authenticated request appears in the provider's attribution dashboard under `maestrly`, with no caller-supplied attribution header.
