# Platform security model

Human users, runners, and execution agents have separate identities.

- Human sessions use secure Better Auth cookies in the web app. Distributed desktop clients use OAuth Device Authorization with a public native client, audience-bound access tokens, explicit scopes, and refresh tokens kept in operating-system secure storage.
- Runner enrollment produces a revocable machine credential limited to approved projects. It cannot manage members or policies.
- Each run receives a short-lived execution token limited to one organization, project, board, assigned card, and operation list. It is revoked when the run ends.

Organization roles are `owner`, `admin`, and `member`. Project roles are `maintainer`, `contributor`, and `viewer`. Professional job titles do not grant technical privileges. Authorization is checked on each operation so removing a membership takes effect without waiting for token expiry.

All domain access runs in a short transaction with organization and actor context. Domain tables carry organization/project identifiers, use composite foreign keys where cross-tenant associations would be dangerous, and have forced row-level security as defense in depth. Runtime database credentials have neither ownership nor `BYPASSRLS`.

Card text is untrusted input. It cannot replace provider, model, repository binding, capabilities, limits, delivery behavior, or approval rules captured in the versioned policy snapshot. Markdown and artifacts are rendered/downloaded as untrusted content. Active HTML from agents is not rendered.

The server distributes approved snapshots; it does not execute card commands or access runner filesystems. Runners initiate outbound connections. Provider and delivery credentials stay outside the executed workspace, and the provider proxy allows only configured HTTPS origins and operations.

Late results cannot complete a current lease. Their evidence is retained as orphaned material for reconciliation. Agent-originated movement does not chain another automation unless an explicit bounded policy says so.
