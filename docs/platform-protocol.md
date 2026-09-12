# Platform protocol

## Interactive project chat

The additive `chat:interactive:v1` capability identifies desktop executors that support persistent multi-turn chat. Project routes under `/api/v1/organizations/:organizationId/projects/:projectId/chat` expose owned sessions, messages, versioned settings/interaction decisions and SSE replay. Session settings include model, Agent/Ask mode, optional reasoning effort, Fast mode and Request approval/Approve for me/Full access profile. Settings updates require the current session version and are rejected while a turn is active. Runner routes under `/api/v1/runners/chat` publish model capabilities, supported settings and operator limits; claim turns; renew leases; fetch controls; and acknowledge event batches. Inventories without the settings capability retain the conservative legacy defaults. Chat tool tokens are bound to the requester, project, session, turn and lease. See [project chat](project-chat.md).

The public REST API is rooted at `/api/v1`. `GET /api/v1/meta` and liveness/readiness endpoints are available before authentication. Other API calls send `X-Maestrly-Protocol-Version: 1.0`; incompatible clients receive `PROTOCOL_INCOMPATIBLE` without disabling local desktop features.

The protocol deliberately separates:

- a **card**, which describes work;
- a **job**, which records an authorized request produced by a transition or continuation; and
- a **run**, which records one leased attempt by one runner.

Execution envelopes include organization, project, board, card, job, run, attempt, lease, source event, card/policy versions, execution profile, and the approved snapshot. They contain no administrative credential or arbitrary runner path.

Business IDs are opaque strings to clients. Times are UTC RFC 3339 values ending in `Z`. Writes require an idempotency key. Reusing a key with different method/path/body returns `IDEMPOTENCY_CONFLICT`; a same-content retry returns the recorded response.

Errors use:

```json
{ "code": "CONFLICT", "message": "The card changed after it was loaded.", "requestId": "opaque", "details": {} }
```

`details` never contains tokens, SQL, or stack traces. Additive response fields are compatible within v1.

Project events are durable rows ordered by a project-local sequence. The sequence row is updated under the same transaction as the domain change, preventing a later commit from being published ahead of an earlier one. SSE resumes with `Last-Event-ID` or `cursor`; clients ignore duplicate sequence values.

## Project team endpoints

`GET /api/v1/organizations/:organizationId/projects/:projectId/team` returns the team version, effective members, inherited access, and (for team managers) candidate organization members, invitations and recent audit history.

Writes below that route require `Idempotency-Key` and `expectedVersion`. Conflicting versions return 409. Permission is rechecked even when replaying a saved response:

- `PUT /members`: `{userId, role}`; `role: null` removes project access.
- `POST /invitations`: `{email, role, expiresInHours}`; returns the invitation id and shareable URL.
- `POST /invitations/change`: `{invitationId, action: "renew" | "revoke", expiresInHours}`; renewing returns a replacement URL.

The public invitation inspection, registration and authenticated acceptance endpoints take the invitation's organization, email and token. Tokens are stored as hashes in invitations; shareable URLs are returned only to an authorized manager on creation/renewal (including an authorized idempotent retry). An `access_revoked` SSE control event closes an existing subscription when project access is removed; it is not a domain event.
