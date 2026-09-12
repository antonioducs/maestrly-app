# Kanban workflows

Projects can contain multiple boards. The board tabs select the active board, and the last selection is saved per project in the browser. Create boards with the complete, simple or empty template. Archived boards can be restored from **Archived boards**.

Column controls create, rename, reorder and remove columns. Drag a column header, or use the left/right buttons. Removing a populated column requires a destination for all its cards, including archived cards. This administrative migration records events but does not enqueue automation. Removed columns remain as historical records for older execution snapshots.

Cards support title, description, labels, priority, acceptance criteria and project-member assignees. Drag onto a card to insert at its position; the up/down buttons provide another way to reorder. The destination selector moves between columns. A repeated movement within the same column does not create another automation job.

## Card details

- **General:** fields, rich Markdown description, source/preview, assignees, one-level subtasks and attachments.
- **Events:** a paginated, read-only audit timeline.
- **Comments:** Markdown writing/preview; authors and project maintainers can edit or remove comments.
- **History:** description versions, line comparison and explicit restoration. Restoring creates a new version. Existing descriptions are seeded when the migration runs; earlier versions cannot be reconstructed.
- **Executions:** jobs, attempts, approvals, requests for information and downloadable evidence.

Descriptions autosave. A conflicting version stops autosave and presents the server content alongside the retained draft. The user must explicitly choose the server version or save their draft over the displayed version. Drafts are scoped by account, organization and card in browser session storage.

Archiving hides a card and its subtasks and can be undone in **Archived cards**. Deletion is logical and removes the family from normal use while retaining audit records and execution evidence. Active runs must be cancelled and reach a terminal state before removal. Pending jobs are cancelled during removal.

Completing an agent execution never automatically moves the card to Done.

## Git setup

1. Open **Git repositories** in the project navigation and add a repository name and base branch. A clone URL is optional metadata; server-side URLs do not grant access to a filesystem or Git credentials.
2. Mark the repository as the project default, or select it explicitly in an automation policy. An optional policy branch overrides the repository default. Changes affect future job snapshots.
3. In **Runners**, create a one-use enrollment and enroll the runner on the intended machine.
4. Authorize an existing local checkout and verify it:

   ```bash
   node apps/runner/dist/cli.js repository --binding REPOSITORY_ID --path /absolute/path/to/repository --branch main
   node apps/runner/dist/cli.js doctor
   node apps/runner/dist/cli.js run
   ```

   The branch must exist locally and contain a commit. Restart the runner after changing its checkout mappings. Keep the source checkout up to date using the machine's own Git tools and credentials.

5. For the embedded desktop runner, bind the remote project and repository ID to a local workspace under **Settings → Platform**, then enable the runner. Mappings for the selected organization's projects are included in its machine enrollment.
6. Configure the column's repository, branch, provider, model and approval requirement. The runner will only claim a linked job when it reports the matching repository and branch. The Runners panel reports missing repository/branch availability.

Each job keeps its repository/branch snapshot. The runner clones the chosen local branch into an isolated workspace, records the base commit, and uploads a patch (including new files) for review. The original checkout is unchanged. There is no automatic commit or push. A project without a default Git repository remains usable for planning; repository-free analysis is an explicit policy task type.

## Verification

```bash
npm run check
npm run test:integration
npm run test:e2e:kanban
```

The Kanban E2E command creates an isolated PostgreSQL container, migrates and bootstraps temporary accounts, starts API/web on free ports, runs browser flows in English and pt-BR, and tests a Git → runner → patch flow with a deterministic executor. It does not use personal provider credentials. Containers, temporary checkouts and services are removed after the run.

Back up the existing installation as described in [Backup and restore](backup-restore.md) before applying migrations. Deploy API and web together so their management endpoints match.

## Automations by column

Use the gear on a normal column, or **Automations**, to open the same contextual editor. Each column has its own configuration; saving the policy version and linking it to the column is one atomic, idempotent operation.

Backlog and Done have explicit protected roles. They cannot run column agents, be renamed, deleted or moved away from their boundary positions. Migration recognizes unambiguous existing endpoint pairs. Boards with ambiguous or missing endpoints offer **Define fixed columns**, either selecting existing columns or creating new fixed endpoints, without moving cards or starting agents.

The editor supports provider/model, model-supported effort and fast mode, initialization prompt, manual versus automatic entry, execution destination, Git inheritance, Standard/Maestro mode, strategy, subagents, pre-commands and limits. Enabling requires a runner that supports the combination. Disabled configurations can be saved as drafts. Configuration history retains prior policy versions; restoring creates a new version.

Prompt variables are `{task_number}` (the card's short identifier), `{task_title}`, `{task_body}` and `{column_name}`. Preview uses an actual card. User text is substituted once, never recursively. The job records the rendered prompt, resolved settings and source card version.

Under a card's **Executions → Column agent**, override only provider/model/effort/fast for a chosen normal column, or restore inheritance. Manual execution uses the card's current column, presents the resolved prompt and requires unchanged card, policy and override versions. Automatic entry is a separate setting; an enabled manual-only column does not run merely because a card enters it.

Board limits inherit defaults of three starts per card/column in a ten-minute counting window, a one-hour execution timeout and 10 MiB of logs. A blocked card remains blocked after the window expires until a user explicitly releases it. Pending/running jobs prevent duplicate manual dispatch. Configuration changes apply to future jobs; they do not rewrite authorized snapshots. Successful execution still does not move the card or push Git changes.

## Project team

Open **Team** in the project navigation to search members, inspect their roles and see whether access comes from the project or the organization. Owners and organization administrators inherit access; removing a project membership cannot revoke that administrative access.

Project maintainers can add existing organization members, change project roles, remove access and manage invitation links. Viewers can read work; contributors can also edit work and request executions; maintainers additionally manage automation, runners and the project team. Project controls cannot grant organization administrator or owner roles.

An invitation selects an email, a project role and an expiry of 1–168 hours. Copy and share the generated link; the server does not send email. Invitees can register a local account or sign in to an existing one with the invited email. Registration and acceptance commit together. New organization memberships have the `member` role. Accepting an invitation never overwrites access granted independently after the invitation was created.

The invitation list shows pending, accepted, expired and revoked links. Renewing a link invalidates its previous token. Removing access also revokes unconsumed project invitations for that person's email. Existing accounts, cards, comments, histories and historical assignments are preserved; removed people cannot receive new assignments. Access changes are audited, enforced on subsequent requests and checked during open event streams. Clients clear the project when access is lost.
