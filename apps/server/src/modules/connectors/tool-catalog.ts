/**
 * MCP tool catalog.
 *
 * Every entry is a thin adapter over the same services the REST API uses, so a connector can never reach a
 * capability the web interface does not also expose, and every call rechecks the persisted grant for the
 * action it needs. Input schemas are derived from the Zod contracts, so the schema an agent reads and the
 * validation the server performs cannot drift apart.
 */
import { z } from 'zod'
import {
  INSPECTION_INTERACTIVE_KINDS,
  chatDecisionSchema,
  deliveryModeSchema,
  delegationConfigureApplySchema,
  delegationConfigureTargetSchema,
  delegationCreateSchema,
  delegationSubscriptionInputSchema,
  delegationTaskStateSchema,
  agentStageSettingsPatchSchema,
  inspectionOperationSchema,
  stageDefinitionInputSchema,
  type ConnectorAction,
} from '@maestrly/protocol'
import type { ServerConfig } from '../../config.js'
import type { DatabasePool } from '../../db/pool.js'
import { listDelegationArtifacts, readDelegationArtifact } from '../delegations/artifacts.js'
import { listCheckConfigs, listCheckResults } from '../delegations/checks.js'
import { applyDelegationCommand } from '../delegations/commands.js'
import { getInspection, startInspection } from '../delegations/inspections.js'
import { listDelegationExecutors } from '../delegations/model-catalog.js'
import { listDelegationPresets } from '../delegations/presets.js'
import { answerDelegationQuestion, listDelegationQuestions } from '../delegations/questions.js'
import {
  getDelegation,
  createDelegation,
  listDelegationAttempts,
  listDelegationEvents,
  listDelegations,
  type DelegationScope,
} from '../delegations/service.js'
import { listSubscriptions, subscribeTask } from '../delegations/subscriptions.js'
import { executeIdempotent } from '../events/http-idempotency.js'
import { authorizeConnector, connectorVisibleProjects } from './grants.js'
import type { ConnectorTool, ConnectorToolContext } from './mcp.js'

export const emptyObjectSchema = { type: 'object', properties: {}, additionalProperties: false } as const

const projectId = z.uuid().describe('Project id, exactly as returned by maestrly_list_projects.')
const taskId = z.uuid().describe('Task id, exactly as returned by maestrly_create_task or maestrly_list_tasks.')
const idempotencyKey = z
  .string()
  .min(1)
  .max(191)
  .describe('Stable key you reuse when retrying this exact call, so a retry cannot repeat the effect.')
const expectedVersion = z
  .number()
  .int()
  .positive()
  .describe('Task version you just read. The call is refused if the task changed since then.')

/** Inline artifact ceiling: larger evidence is described and downloaded through the web interface. */
const MAX_INLINE_ARTIFACT_BYTES = 256 * 1024
const MAX_WAIT_SECONDS = 20

interface ToolSpec<Schema extends z.ZodType> {
  name: string
  title: string
  description: string
  schema: Schema
  /** Action rechecked before the tool runs; a function when the input decides which one applies. */
  action: ConnectorAction | ((input: z.output<Schema>) => ConnectorAction) | null
  annotations: ConnectorTool['annotations']
  run(input: z.output<Schema>, context: ConnectorToolContext): Promise<unknown>
}

function textual(contentType: string): boolean {
  return /^text\/|json|xml|yaml|x-patch|x-diff|javascript/i.test(contentType)
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export function connectorToolCatalog(pool: DatabasePool, config: ServerConfig): ConnectorTool[] {
  const links = { webOrigin: config.webOrigin }

  const scopeOf = (context: ConnectorToolContext, project: string): DelegationScope => ({
    organizationId: context.principal.organizationId,
    projectId: project,
    userId: context.principal.userId,
    connectionId: context.principal.connectionId,
  })

  function defineTool<Schema extends z.ZodType>(spec: ToolSpec<Schema>): ConnectorTool {
    return {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: z.toJSONSchema(spec.schema, { io: 'input' }) as Record<string, unknown>,
      annotations: spec.annotations,
      run: async (raw, context) => {
        const input = spec.schema.parse(raw) as z.output<Schema>
        const project = (input as { projectId?: string }).projectId
        if (spec.action && project) {
          const action = typeof spec.action === 'function' ? spec.action(input) : spec.action
          await authorizeConnector(pool, context.principal, project, action)
        }
        return spec.run(input, context)
      },
    }
  }

  /**
   * Calls that create something take their idempotency key seriously: a retry replays the first result
   * instead of creating a second task, inspection or subscription.
   */
  async function once<T>(
    context: ConnectorToolContext,
    input: { projectId: string; idempotencyKey: string },
    path: string,
    body: unknown,
    operation: () => Promise<T>
  ): Promise<T & { replayed: boolean }> {
    const result = await executeIdempotent(
      pool,
      {
        organizationId: context.principal.organizationId,
        actorId: context.principal.userId,
        actor: { type: 'human', userId: context.principal.userId },
        key: input.idempotencyKey,
        method: 'POST',
        path: `/connectors/${input.projectId}/${path}`,
        body,
      },
      async () => ({ status: 201, body: await operation() })
    )
    return { ...(result.body as T), replayed: result.replayed }
  }

  /** Commands share one adapter: the task version and the idempotency key are always explicit. */
  const command = (
    context: ConnectorToolContext,
    input: { projectId: string; taskId: string; idempotencyKey: string },
    body: Parameters<typeof applyDelegationCommand>[3]
  ) => applyDelegationCommand(pool, scopeOf(context, input.projectId), input.taskId, body, input.idempotencyKey)

  return [
    defineTool({
      name: 'maestrly_list_projects',
      title: 'List authorized projects',
      description:
        'List the Maestrly projects this connection may use, with the actions the owner authorized for each ' +
        'one. Always start here: project ids from any other source are not valid input.',
      schema: z.object({}).strict(),
      action: null,
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
    }),

    defineTool({
      name: 'maestrly_list_executors',
      title: 'List executors, workspaces and model selections',
      description:
        'List the computers that can run work for this project, the workspaces and base branches they expose, ' +
        'and the exact account/model selections available on each one. A stage is configured with a ' +
        'selectionId from this list: never invent one, and never assume an effort a selection does not list.',
      schema: z.object({ projectId }).strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => ({
        executors: await listDelegationExecutors(pool, scopeOf(context, input.projectId)),
      }),
    }),

    defineTool({
      name: 'maestrly_list_presets',
      title: 'List delegation presets',
      description:
        'List the pipelines available in this project. A preset declares stages and policy but never an ' +
        'account or model, so you still choose a selectionId for its agent stages.',
      schema: z.object({ projectId }).strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => ({
        presets: await listDelegationPresets(pool, scopeOf(context, input.projectId)),
      }),
    }),

    defineTool({
      name: 'maestrly_create_task',
      title: 'Create a delegated task',
      description:
        'Create a task with the stages you want and, optionally, start it. Each agent stage carries the ' +
        'account/model selection, reasoning effort and execution mode it must run with. Creating a task does ' +
        'not create a branch, a commit or a pull request: delivery is a separate, explicitly authorized step.',
      schema: z.object({ projectId, task: delegationCreateSchema, idempotencyKey }).strict(),
      action: 'tasks:write',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) => {
        // Starting work is a different authorization from describing it.
        if (input.task.start)
          await authorizeConnector(pool, context.principal, input.projectId, 'execution:control')
        return once(context, input, 'delegations', input.task, () =>
          createDelegation(pool, scopeOf(context, input.projectId), input.task, links)
        )
      },
    }),

    defineTool({
      name: 'maestrly_list_tasks',
      title: 'List delegated tasks',
      description: 'List the delegated tasks of a project, newest first, optionally filtered by state or card.',
      schema: z
        .object({
          projectId,
          state: delegationTaskStateSchema.optional(),
          cardId: z.uuid().optional(),
          after: z.uuid().optional().describe('Task id from the previous page.'),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) =>
        listDelegations(
          pool,
          scopeOf(context, input.projectId),
          { state: input.state, cardId: input.cardId, after: input.after, limit: input.limit },
          links
        ),
    }),

    defineTool({
      name: 'maestrly_get_task',
      title: 'Read one task with its stages and attempts',
      description:
        'Read a task: its state, policy, stages with the exact configuration each one was admitted with, the ' +
        'attempts so far and links into Maestrly. Read this before any command, and send back the version it ' +
        'reports as expectedVersion.',
      schema: z.object({ projectId, taskId }).strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => getDelegation(pool, scopeOf(context, input.projectId), input.taskId, links),
    }),

    defineTool({
      name: 'maestrly_read_attempts',
      title: 'Read stage attempts',
      description:
        'Read every attempt of a task: what was requested, what the executor admitted, what it observed, and ' +
        'the code revision each attempt produced. Use it to explain why a stage failed or was superseded.',
      schema: z.object({ projectId, taskId }).strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => ({
        attempts: await listDelegationAttempts(pool, scopeOf(context, input.projectId), input.taskId),
      }),
    }),

    defineTool({
      name: 'maestrly_read_events',
      title: 'Read the task timeline',
      description:
        'Read events after a cursor. Events are ordered and durable: keep the last sequence you saw and pass ' +
        'it as cursor to continue without re-reading or missing anything.',
      schema: z
        .object({
          projectId,
          taskId,
          cursor: z.number().int().nonnegative().default(0).describe('Last sequence you already processed.'),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => {
        const events = await listDelegationEvents(
          pool,
          scopeOf(context, input.projectId),
          input.taskId,
          input.cursor,
          input.limit
        )
        return { events, cursor: events.at(-1)?.sequence ?? input.cursor }
      },
    }),

    defineTool({
      name: 'maestrly_wait_task',
      title: 'Wait briefly for the task to move',
      description:
        'Wait until new events appear or the timeout expires, whichever comes first. It never waits longer ' +
        `than ${MAX_WAIT_SECONDS} seconds: call it again to keep following, or let a routine callback wake you ` +
        'instead of polling in a loop.',
      schema: z
        .object({
          projectId,
          taskId,
          cursor: z.number().int().nonnegative().default(0),
          timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).default(MAX_WAIT_SECONDS),
        })
        .strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => {
        const scope = scopeOf(context, input.projectId)
        const deadline = Date.now() + input.timeoutSeconds * 1_000
        for (;;) {
          const events = await listDelegationEvents(pool, scope, input.taskId, input.cursor)
          const view = await getDelegation(pool, scope, input.taskId, links)
          if (events.length || Date.now() >= deadline || context.signal.aborted)
            return {
              events,
              cursor: events.at(-1)?.sequence ?? input.cursor,
              state: view.task.state,
              blocker: view.task.blocker,
              timedOut: events.length === 0,
            }
          await sleep(1_000, context.signal)
        }
      },
    }),

    defineTool({
      name: 'maestrly_follow_up',
      title: 'Send a follow-up to a running task',
      description:
        'Send an instruction to a task that is already running, optionally adding a stage for it. The message ' +
        'reaches the execution; it does not change the configuration of a stage — use maestrly_configure_task ' +
        'for that.',
      schema: z
        .object({
          projectId,
          taskId,
          expectedVersion,
          text: z.string().trim().min(1).max(100_000),
          stage: stageDefinitionInputSchema.optional(),
          idempotencyKey,
        })
        .strict(),
      action: 'tasks:write',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        command(context, input, {
          type: 'follow_up',
          expectedVersion: input.expectedVersion,
          text: input.text,
          ...(input.stage ? { stage: input.stage } : {}),
        }),
    }),

    defineTool({
      name: 'maestrly_configure_task',
      title: 'Change the account, model, effort or mode a stage runs with',
      description:
        'Change the configuration for the task defaults, one stage, or only the next attempt. Effort is never ' +
        'translated between providers: if the new selection does not offer the current effort, the call is ' +
        'refused so you can choose one it does offer. Use apply to decide whether the change waits for the ' +
        'current attempt, replaces what is queued, or interrupts and restarts.',
      schema: z
        .object({
          projectId,
          taskId,
          expectedVersion,
          target: delegationConfigureTargetSchema,
          stageId: z.uuid().optional().describe('Required when target is stage or next_attempt.'),
          settingsPatch: agentStageSettingsPatchSchema,
          apply: delegationConfigureApplySchema.default('after_current'),
          idempotencyKey,
        })
        .strict(),
      action: 'tasks:write',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        command(context, input, {
          type: 'configure',
          expectedVersion: input.expectedVersion,
          target: input.target,
          ...(input.stageId ? { stageId: input.stageId } : {}),
          settingsPatch: input.settingsPatch,
          apply: input.apply,
        }),
    }),

    defineTool({
      name: 'maestrly_control_task',
      title: 'Start, pause, resume or cancel a task',
      description:
        'Control execution. Pausing lets the current attempt finish unless immediate is set; cancelling is ' +
        'final. A paused task keeps its stages and configuration, so resuming continues where it stopped.',
      schema: z
        .object({
          projectId,
          taskId,
          expectedVersion,
          action: z.enum(['start', 'pause', 'resume', 'cancel']),
          immediate: z.boolean().default(false).describe('Only for pause: stop the current attempt as well.'),
          reason: z.string().max(2_000).default('').describe('Only for cancel: recorded in the timeline.'),
          idempotencyKey,
        })
        .strict(),
      action: 'execution:control',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: async (input, context) => {
        const base = { expectedVersion: input.expectedVersion }
        if (input.action === 'pause')
          return command(context, input, { type: 'pause', ...base, immediate: input.immediate })
        if (input.action === 'cancel')
          return command(context, input, { type: 'cancel', ...base, reason: input.reason })
        return command(context, input, { type: input.action, ...base })
      },
    }),

    defineTool({
      name: 'maestrly_request_review',
      title: 'Ask for an independent review',
      description:
        'Queue a review of the current code revision, optionally with a different account and model than the ' +
        'one that wrote the code. The reviewer reads a stable snapshot and cannot edit it.',
      schema: z
        .object({
          projectId,
          taskId,
          expectedVersion,
          settingsPatch: agentStageSettingsPatchSchema.optional(),
          instructions: z.string().max(100_000).default(''),
          idempotencyKey,
        })
        .strict(),
      action: 'tasks:write',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        command(context, input, {
          type: 'request_review',
          expectedVersion: input.expectedVersion,
          ...(input.settingsPatch ? { settingsPatch: input.settingsPatch } : {}),
          instructions: input.instructions,
        }),
    }),

    defineTool({
      name: 'maestrly_request_checks',
      title: 'Run configured project checks',
      description:
        'Ask the executor to run named checks on the current revision. Only checks configured in the project ' +
        'can run; a check result is always tied to the revision it tested.',
      schema: z
        .object({
          projectId,
          taskId,
          expectedVersion,
          checkIds: z.array(z.string().min(1).max(120)).min(1).max(50),
          idempotencyKey,
        })
        .strict(),
      action: 'evidence:read',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        command(context, input, {
          type: 'request_checks',
          expectedVersion: input.expectedVersion,
          checkIds: input.checkIds,
        }),
    }),

    defineTool({
      name: 'maestrly_deliver',
      title: 'Commit, push, open a pull request or merge',
      description:
        'Request a delivery for the reviewed code revision. Each mode must be authorized by the task policy, ' +
        'and the executor refuses a delivery whose content no longer matches what was approved. Opening a ' +
        'pull request does not complete the task: the completion target decides that.',
      schema: z
        .object({
          projectId,
          taskId,
          expectedVersion,
          mode: deliveryModeSchema,
          title: z.string().max(200).optional(),
          expectedCodeRevision: z
            .string()
            .min(1)
            .max(191)
            .nullable()
            .default(null)
            .describe('Content digest you reviewed; the delivery is refused if the code changed since.'),
          idempotencyKey,
        })
        .strict(),
      action: 'delivery:manage',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: async (input, context) =>
        command(context, input, {
          type: 'deliver',
          expectedVersion: input.expectedVersion,
          mode: input.mode,
          ...(input.title ? { title: input.title } : {}),
          expectedCodeRevision: input.expectedCodeRevision,
        }),
    }),

    defineTool({
      name: 'maestrly_watch_task',
      title: 'Keep following a task after delivery',
      description:
        'Subscribe to what happens after a pull request exists: refresh it on an interval, plan a fix round ' +
        'with a chosen account and model when checks fail, or react to requested changes. The profile is ' +
        'chosen now, so the reaction never has to guess one later.',
      schema: z.object({ projectId, taskId, subscription: delegationSubscriptionInputSchema, idempotencyKey }).strict(),
      action: 'tasks:write',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        once(context, input, `delegations/${input.taskId}/subscriptions`, input.subscription, () =>
          subscribeTask(pool, scopeOf(context, input.projectId), { taskId: input.taskId, rule: input.subscription })
        ),
    }),

    defineTool({
      name: 'maestrly_list_subscriptions',
      title: 'List what is being watched for a task',
      description: 'List the follow-up subscriptions of a task, including when each one fires next.',
      schema: z.object({ projectId, taskId }).strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => ({
        subscriptions: await listSubscriptions(pool, scopeOf(context, input.projectId), input.taskId),
      }),
    }),

    defineTool({
      name: 'maestrly_list_evidence',
      title: 'List artifacts and check results',
      description:
        'List the evidence a task produced: artifacts (logs, diffs, screenshots, videos) and the results of ' +
        'the checks that ran, each tied to the code revision it describes.',
      schema: z.object({ projectId, taskId }).strict(),
      action: 'evidence:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => {
        const scope = scopeOf(context, input.projectId)
        return {
          artifacts: await listDelegationArtifacts(pool, scope, input.taskId),
          checks: await listCheckResults(pool, scope, input.taskId),
          configuredChecks: await listCheckConfigs(pool, scope),
        }
      },
    }),

    defineTool({
      name: 'maestrly_read_artifact',
      title: 'Read one artifact',
      description:
        'Read the content of an artifact. Text is returned as text; anything else is returned base64-encoded. ' +
        `Artifacts larger than ${Math.floor(MAX_INLINE_ARTIFACT_BYTES / 1024)} KiB are not returned inline: open ` +
        'them in Maestrly instead.',
      schema: z.object({ projectId, taskId, artifactId: z.uuid() }).strict(),
      action: 'evidence:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => {
        const found = await readDelegationArtifact(pool, scopeOf(context, input.projectId), {
          taskId: input.taskId,
          artifactId: input.artifactId,
          storageDirectory: config.storageDirectory,
          maxInlineBytes: MAX_INLINE_ARTIFACT_BYTES,
        })
        const asText = textual(found.artifact.contentType)
        return {
          artifact: found.artifact,
          encoding: asText ? 'text' : 'base64',
          content: found.bytes.toString(asText ? 'utf8' : 'base64'),
        }
      },
    }),

    defineTool({
      name: 'maestrly_inspect',
      title: 'Inspect the workspace, the diff or the pull request',
      description:
        'Ask the executor for a read-only look at the work: a file, the diff, a search, or the pull request ' +
        'status. Browser navigation and interaction on a preview need their own authorization and an executor ' +
        'that offers them. Inspections are asynchronous: read the result with maestrly_get_inspection.',
      schema: z.object({ projectId, taskId, operation: inspectionOperationSchema, idempotencyKey }).strict(),
      action: (input) =>
        (INSPECTION_INTERACTIVE_KINDS as readonly string[]).includes(input.operation.kind)
          ? 'inspect:interact'
          : 'inspect:read',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        once(context, input, `delegations/${input.taskId}/inspections`, input.operation, () =>
          startInspection(pool, scopeOf(context, input.projectId), {
            taskId: input.taskId,
            operation: input.operation,
          })
        ),
    }),

    defineTool({
      name: 'maestrly_get_inspection',
      title: 'Read the result of an inspection',
      description:
        'Read an inspection once the executor answered it. A pending inspection reports that it is pending ' +
        'rather than an empty result.',
      schema: z.object({ projectId, taskId, inspectionId: z.uuid() }).strict(),
      action: 'inspect:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) =>
        getInspection(pool, scopeOf(context, input.projectId), {
          taskId: input.taskId,
          inspectionId: input.inspectionId,
        }),
    }),

    defineTool({
      name: 'maestrly_list_questions',
      title: 'List questions an execution is waiting on',
      description:
        'List the questions a stage raised and is waiting on. A task in waiting_input does not progress until ' +
        'one of them is answered.',
      schema: z.object({ projectId, taskId }).strict(),
      action: 'tasks:read',
      annotations: { readOnlyHint: true, idempotentHint: true },
      run: async (input, context) => ({
        questions: await listDelegationQuestions(pool, scopeOf(context, input.projectId), input.taskId),
      }),
    }),

    defineTool({
      name: 'maestrly_answer_question',
      title: 'Answer a question raised by an execution',
      description:
        'Answer a pending question, or approve, revise or discard a plan. The answer is refused if the ' +
        'question changed since you read it, so an answer never lands on a different question.',
      schema: z
        .object({
          projectId,
          taskId,
          interactionId: z.uuid(),
          expectedVersion: z.number().int().positive().describe('Version of the question you read.'),
          decision: chatDecisionSchema,
        })
        .strict(),
      action: 'interactions:answer',
      annotations: { readOnlyHint: false, idempotentHint: true },
      run: async (input, context) =>
        answerDelegationQuestion(pool, scopeOf(context, input.projectId), {
          taskId: input.taskId,
          interactionId: input.interactionId,
          expectedVersion: input.expectedVersion,
          decision: input.decision,
        }),
    }),
  ]
}
