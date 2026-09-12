# Maestrly desktop executor

The Maestrly app can execute Kanban jobs using its normal chat engine. It includes connected provider accounts and subscriptions, project/global skills, enabled MCP servers, conversations, the browser and the editor. A separate CLI installation is optional.

## Setup

1. Open **Settings → Platform**. Add your Kanban URL and connect by confirming the code in your browser.
2. Under **Projects on this computer**, select the Kanban project, then the folder on this computer. Use **Choose folder** for an existing checkout (a folder that is not a Git repository yet is initialized automatically), or **Clone <repository>** when the Kanban repository has a clone URL — the desktop clones it with your local Git credentials and selects it. Choose **Link project**. Analysis jobs can run without a Kanban repository binding.
3. Under **Maestrly executor**, choose **Only me** for a personal computer or **Approved projects** for a team executor. Team enrollment requires permission to administer runners for the selected projects.
4. Select the connected accounts to make available. **Accounts, skills and MCPs** opens the existing chat settings, including subscription login. Refresh accounts after connecting one. Credentials, provider endpoints and native account state remain local; the platform receives opaque model identifiers, model labels, supported effort/Fast capabilities and the operator-configured provider display label so the authorized user can distinguish available account slots.
5. Choose allowed tools and press **Start executor**. Enable **Continue in background** to keep work running after closing the window. **Start with login** starts the installed app and its saved executor configuration at operating-system login.

## Workspace link and agent tools

The linked project appears below the workspace name and above its chats. **Open Kanban** opens the selected project and board directly. The link applies to all conversations and worktrees owned by that workspace, even when their folders are outside the original checkout. Cached labels remain visible offline, with a reconnect indication.

Local agents can discover boards, search active/completed/archived cards, create and update cards and subtasks, manage comments, move/archive/restore/delete cards, inspect history, restore descriptions, and manage boards and columns. The executor does not need to be running for these tools. Code execution requires a repository binding separately; **Board access · Code execution not configured** means the board tools are available without enabling code jobs.

For **GPT Web**, choose **Linked Kanban → Read & write** in the conversation access controls to allow changes; the default is **Read**. Refresh the Maestrly app's tool catalog in ChatGPT when prompted, then reconnect the companion. Ask/Plan modes stay read-only. Removing or changing the link or account invalidates already-created tool access; start a new turn or reconnect GPT Web after linking again.

Every operation checks the signed-in user's current project permissions. Mutations require an idempotency key, and updates require the current resource version. Agent actions are attributed to their conversation and never start an automation chain merely by moving a card. Completing an agent response does not mark the card done.

Use the tray/menu-bar icon to reopen Maestrly or pause execution. **Pause executor** cancels active work and stops taking jobs. Quitting the app waits for runner/chat cleanup. Provider authentication and initial Kanban authorization still require the account owner; they are setup steps, never questions left waiting inside a job.

For a personal computer, configure a column with automatic entry disabled and use **Run on my computer** on a card. Only your own enabled devices contribute personal models to your configuration catalog. They remain excluded from team destinations and automatic claims. For team automation, select a published Maestrly model from an authorized team executor and configure the column normally.

## Unattended execution

Maestrly-provider jobs do not enter a plan-review or question queue. The host removes interactive tools and rejects attempts through the plan, question and permission brokers immediately. Permission checks use the operator's saved executor settings. Subagents and subscription failover may use only selected accounts. Plans remain internal; missing essential information, credentials or authorization must be reported as a failed execution with a concrete blocker.

The main agent records `executor_report` after implementation and verification. Missing terminal reports fail the job; a blocked task is not considered successful merely because the model finished its turn. The executor retains its native conversation for inspection and future manual work. A job timeout or lost lease cancels the real chat turn and delegated work.

Each code job starts from the approved committed branch in a separate clone. The original checkout is preserved. Execution folders are retained so the conversation's editor, browser and files remain usable after completion. They consume disk space until removed by the operator; there is no automatic retention cleanup in this version.

Commands and enabled MCPs run with this machine's access. An isolated checkout is not an OS security sandbox. The Git-push toggle governs recognized Git push commands, not arbitrary shell programs that could contact a remote service. Use a dedicated operating-system account for a team executor when its projects should not share access with personal work. Optional pre-commands keep the existing provisioned Docker-image requirement.

## Conversation visibility

For an interactive conversation started in the Kanban web app, enable **Interactive project chat in the web**. This uses a separate turn queue and the normal question, permission and plan brokers; column jobs remain unattended. See [project chat](project-chat.md) for setup, privacy and recovery.

**Execution conversations** in desktop settings opens the full local conversation. The card's **Executions → Execution conversation** shows the task, assistant messages and tool names/status, with a bounded transcript artifact. Raw tool inputs/outputs, internal messages and unrelated local conversations are not uploaded through this projection. Normal output can contain project information and is visible to authorized project members.

Local conversation creation, tools, cancellation, background execution and transcript delivery are exercised by the real Electron/API test with a deterministic local model. Live subscription authentication, provider availability and billing require the operator's own accounts.
