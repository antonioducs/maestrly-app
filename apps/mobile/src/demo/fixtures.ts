import type {
  FleetBot,
  FleetEnvironment,
  FleetQuestion,
  FleetRoutine,
  FleetSelectionOption,
  FleetTodo,
  FleetTranscriptItem,
} from '@maestrly/bot-fleet-protocol'
import { botRecord, environmentRecord } from '../fleet/factories'

/*
 * The demo server's content, from the approved prototype (prototypes/mobile-app/data.js). Every server, bot and reply
 * is fictional. Bot replies are server content, like a real bot's, so they are not in the app's translation catalogs.
 */

export type ScriptName =
  | 'junoNightly'
  | 'junoHelped'
  | 'atlasDeploy'
  | 'atlasDenied'
  | 'questionDismissed'
  | 'atlasReply'
  | 'junoReply'
  | 'pixelReply'
  | 'ledgerReply'
  | 'scoutReply'
  | 'routine'

export type AskSpec =
  | {
      kind: 'permission'
      title: string
      detail: string | null
      tool: { name: string; target: string }
      then: { allow: ScriptName; deny: ScriptName }
    }
  | { kind: 'question'; questions: FleetQuestion[]; then: (answer: string) => Step[] }
  | { kind: 'help'; reason: string; then: ScriptName }

export type Step =
  | { think: number }
  | { tool: { name: string; target: string | null; output?: string | null }; ms?: number; fail?: boolean }
  /** Finishes the tool already running when the turn resumed. */
  | { complete: { output: string }; ms?: number; fail?: boolean }
  | { todos: FleetTodo[] }
  | { say: string }
  | { ask: AskSpec }
  | { summary: string }

const option = (
  providerId: string,
  providerLabel: string,
  modelId: string,
  modelLabel: string,
  efforts: string[],
  fastMode: boolean
): FleetSelectionOption => ({
  id: `${providerId}::${modelId}`,
  providerId,
  providerLabel,
  modelId,
  modelLabel,
  efforts,
  fastMode,
})

export const DEMO_OPTIONS: FleetSelectionOption[] = [
  option('claude', 'Claude', 'claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max'], true),
  option('claude', 'Claude', 'claude-sonnet-5', 'Claude Sonnet 5', ['low', 'medium', 'high'], false),
  option('claude', 'Claude', 'claude-haiku-5', 'Claude Haiku 5', [], false),
  option('openai', 'OpenAI', 'gpt-5.5', 'GPT-5.5', ['minimal', 'low', 'medium', 'high', 'xhigh'], true),
  option('openai', 'OpenAI', 'gpt-5.5-codex', 'GPT-5.5 Codex', ['low', 'medium', 'high', 'xhigh'], true),
  option('openai', 'OpenAI', 'gpt-5.5-mini', 'GPT-5.5 mini', ['low', 'medium', 'high'], false),
  option('google', 'Gemini', 'gemini-3-pro', 'Gemini 3 Pro', ['low', 'high'], false),
  option('google', 'Gemini', 'gemini-3-flash', 'Gemini 3 Flash', ['low', 'high'], false),
]

const iso = (ms: number) => new Date(ms).toISOString()
const MINUTE = 60_000

export type DemoWorld = {
  environments: FleetEnvironment[]
  bots: FleetBot[]
  transcripts: Record<string, FleetTranscriptItem[]>
  routines: Record<string, FleetRoutine[]>
}

export function demoWorld(now: number): DemoWorld {
  const at = (minutesAgo: number, offset = 0) => iso(now - minutesAgo * MINUTE + offset)
  const usage = (used: number, window: number, cost: number) => ({
    contextUsedTokens: used,
    contextWindowTokens: window,
    contextQuality: 'measured' as const,
    costUsd: cost,
    updatedAt: at(1),
  })
  const environments = [
    environmentRecord({ id: 'studio', name: 'studio', botIds: ['juno', 'atlas', 'pixel'] }),
    environmentRecord({ id: 'research', name: 'research', botIds: ['ledger', 'scout'] }),
  ]
  const bots = [
    botRecord({
      id: 'juno',
      name: 'Juno',
      role: 'QA tester',
      tint: '#3c8c68',
      environmentId: 'studio',
      ceiling: 'auto',
      status: 'working',
      activity: { kind: 'tool', tool: 'bash', target: 'npx playwright test --project=chromium' },
      selection: { providerId: 'openai', modelId: 'gpt-5.5', reasoning: 'medium', fastMode: false },
      usage: usage(64_000, 272_000, 0.92),
    }),
    botRecord({
      id: 'atlas',
      name: 'Atlas',
      role: 'Release engineer',
      tint: '#4f7cac',
      environmentId: 'studio',
      status: 'waiting',
      activity: { kind: 'permission', title: 'Run a command' },
      pendingCount: 1,
      selection: { providerId: 'claude', modelId: 'claude-opus-5-5', reasoning: 'high', fastMode: true },
      usage: usage(118_000, 200_000, 2.41),
    }),
    botRecord({
      id: 'pixel',
      name: 'Pixel',
      role: 'Design reviewer',
      tint: '#8a6fd0',
      environmentId: 'studio',
      status: 'waiting',
      activity: { kind: 'question' },
      pendingCount: 1,
      selection: { providerId: 'claude', modelId: 'claude-sonnet-5', reasoning: 'medium', fastMode: false },
      usage: usage(41_000, 200_000, 0.37),
    }),
    botRecord({
      id: 'ledger',
      name: 'Ledger',
      role: 'Cost analyst',
      tint: '#c0663f',
      environmentId: 'research',
      ceiling: 'auto',
      activity: { kind: 'idle', lastTurnSummary: 'Weekly cost report delivered', lastTurnAt: at(30) },
      usage: usage(22_000, 1_000_000, 0.08),
    }),
    botRecord({
      id: 'scout',
      name: 'Scout',
      role: 'Research assistant',
      tint: '#5f8794',
      environmentId: 'research',
      lifecycle: 'stopped',
      status: 'offline',
      selection: { providerId: 'claude', modelId: 'claude-sonnet-5', reasoning: 'high', fastMode: false },
      usage: usage(9_000, 200_000, 0),
    }),
  ]

  const nightly = { id: 'r-nightly', title: 'Nightly regression' }
  const weekly = { id: 'r-weekly', title: 'Weekly cost report' }
  const user = (id: string, time: string, text: string, routine?: { id: string; title: string }) =>
    ({
      id,
      at: time,
      kind: 'user',
      text,
      source: routine ? 'routine' : 'owner',
      ...(routine ? { routine } : {}),
      queued: false,
      memories: [],
      images: [],
    }) satisfies FleetTranscriptItem
  const said = (id: string, time: string, text: string) =>
    ({ id, at: time, kind: 'assistant', text, streaming: false }) satisfies FleetTranscriptItem
  const tool = (id: string, time: string, name: string, target: string | null, output: string | null) =>
    ({ id, at: time, kind: 'tool', name, target, state: 'done', output, images: [] }) satisfies FleetTranscriptItem

  // Ledger's weekly reports go back four months, so its conversation has an older page to scroll to.
  const ledgerHistory: FleetTranscriptItem[] = []
  for (let week = 25; week <= 40; week++) {
    const ago = (41 - week) * 7 * 24 * 60
    ledgerHistory.push(
      user(`ledger-w${week}-u`, at(ago), 'Summarize model spend for the week and flag anything unusual.', weekly),
      tool(`ledger-w${week}-t`, at(ago, 4_000), 'read', `usage/2026-w${week}.json`, null),
      said(
        `ledger-w${week}-a`,
        at(ago, 9_000),
        `Spend for week ${week} was **$${(38 + ((week * 7) % 19)).toFixed(2)}**. Nothing unusual: every bot stayed within its usual range.`
      )
    )
  }

  const transcripts: Record<string, FleetTranscriptItem[]> = {
    juno: [
      user('juno-1', at(3), 'Run the e2e suite against staging and report anything that fails.', nightly),
      {
        id: 'juno-2',
        at: at(3, 2_000),
        kind: 'tool',
        name: 'todo_write',
        target: null,
        state: 'done',
        output: null,
        images: [],
        todos: [
          { content: 'Run the Chromium suite', status: 'in_progress' },
          { content: 'Run the WebKit suite', status: 'pending' },
          { content: 'Summarize failures', status: 'pending' },
        ],
      },
      {
        id: 'juno-3',
        at: at(0.7),
        kind: 'tool',
        name: 'bash',
        target: 'npx playwright test --project=chromium',
        state: 'running',
        output: null,
        images: [],
      },
    ],
    atlas: [
      user('atlas-1', at(12), 'Ship rc.2 to staging once CI is green on main.'),
      tool('atlas-2', at(11), 'bash', 'gh run watch 4812', '✓ main · CI #4812 completed (success) in 11m 02s'),
      tool('atlas-3', at(2), 'bash', 'npm run build', 'web@0.16.0-rc.2 built in 48.2s'),
      said(
        'atlas-4',
        at(1.5),
        'CI is green on `main` (run #4812) and the build passed. The staging deploy is next. It needs your approval because it changes a shared environment.'
      ),
      {
        id: 'atlas-5',
        at: at(1),
        kind: 'permission',
        requestId: 'atlas-perm-1',
        title: 'Run a command',
        detail: 'Deploys web@0.16.0-rc.2 to staging.example.dev',
        tool: { name: 'bash', target: 'npm run deploy:staging' },
        state: 'pending',
        resolvedAt: null,
      },
    ],
    pixel: [
      user('pixel-1', at(20), 'Review the new pricing page on staging and pick the hero layout.'),
      tool('pixel-2', at(18), 'browser', 'staging.example.dev/pricing', 'Captured 3 layouts at 390px and 1440px'),
      said(
        'pixel-3',
        at(6),
        'I checked all three layouts on a phone and on a desktop. Two of them hold up well. Choosing between them is a product call, so I need your input.'
      ),
      {
        id: 'pixel-4',
        at: at(5),
        kind: 'question',
        toolCallId: 'pixel-ask-1',
        state: 'pending',
        answers: null,
        questions: [
          {
            header: 'Hero layout',
            question: 'Which hero layout should I ship?',
            multiSelect: false,
            options: [
              {
                label: 'Split',
                description: 'Copy on the left, plan cards on the right. Strongest on desktop; cards fall below the fold on phones.',
              },
              { label: 'Stacked', description: 'Copy above full-width plan cards. Consistent on every screen, a little less punch.' },
              { label: 'Keep the current hero', description: 'No layout change. I only fix the spacing.' },
            ],
          },
        ],
      },
    ],
    ledger: [
      ...ledgerHistory,
      user('ledger-1', at(32), 'Summarize model spend for the week and flag anything unusual.', weekly),
      tool('ledger-2', at(31), 'read', 'usage/2026-w41.json', null),
      said(
        'ledger-3',
        at(30),
        'Spend this week was **$48.20**, down 12% from last week.\n\n- Claude: $31.10\n- OpenAI: $12.40\n- Gemini: $4.70\n\nOne thing to watch: Atlas used 1.2M tokens of context during release prep, mostly re-reading CI logs. A short summary step before each retry would cut that roughly in half.'
      ),
    ],
    scout: [
      user('scout-1', at(2 * 24 * 60), 'Find recent work on speculative decoding for small models.'),
      said(
        'scout-2',
        at(2 * 24 * 60 - 5),
        'I found three papers from the last six months worth reading. The most practical one shows a 2.1× speedup on 3B models with a draft model one-tenth the size. I saved the list to `notes/spec-decoding.md`.'
      ),
    ],
  }

  const routine = (
    botId: string,
    id: string,
    title: string,
    schedule: FleetRoutine['schedule'],
    enabled = true
  ): FleetRoutine => ({
    id,
    botId,
    title,
    prompt: title,
    schedule,
    enabled,
    nextRunAt: enabled ? at(-60) : null,
    lastRunAt: at(60),
    lastOutcome: 'sent',
    createdBy: 'owner',
    createdAt: at(60 * 24 * 30),
    updatedAt: at(60 * 24 * 30),
  })
  const weeklyAt = (days: number[], time: string) => ({ kind: 'weekly' as const, days, time, timezone: 'UTC' })
  const routines: Record<string, FleetRoutine[]> = {
    juno: [routine('juno', 'r-nightly', 'Nightly regression', weeklyAt([1, 2, 3, 4, 5, 6, 7], '02:00'))],
    atlas: [routine('atlas', 'r-release', 'Release readiness check', weeklyAt([1, 2, 3, 4, 5], '08:30'))],
    pixel: [],
    ledger: [
      routine('ledger', 'r-weekly', 'Weekly cost report', weeklyAt([1], '07:00')),
      routine('ledger', 'r-anomaly', 'Spend anomaly check', { kind: 'interval', everyMinutes: 120 }, false),
    ],
    scout: [],
  }
  // Every demo bot takes PDFs and text files, as current bot images do.
  for (const bot of bots) bot.capabilities = ['files']
  return { environments, bots, transcripts, routines }
}

/** What each bot does on its own or after a request is answered; adapted from the prototype's scripts. */
export const DEMO_SCRIPTS: Record<ScriptName, Step[]> = {
  junoNightly: [
    { complete: { output: '41 passed, 3 failed (admin/*.spec.ts) in 1m 54s' }, ms: 6000, fail: true },
    {
      todos: [
        { content: 'Run the Chromium suite', status: 'completed' },
        { content: 'Run the WebKit suite', status: 'in_progress' },
        { content: 'Summarize failures', status: 'pending' },
      ],
    },
    {
      tool: {
        name: 'bash',
        target: 'npx playwright test --project=webkit',
        output: '41 passed, 3 failed (admin/*.spec.ts) in 2m 08s',
      },
      ms: 4200,
      fail: true,
    },
    {
      todos: [
        { content: 'Run the Chromium suite', status: 'completed' },
        { content: 'Run the WebKit suite', status: 'completed' },
        { content: 'Summarize failures', status: 'completed' },
      ],
    },
    {
      say: 'Both browsers fail the same 3 tests, all in `admin/`. Each one stops at the login screen with **Invalid credentials**, so this looks like a credentials problem, not a regression. Everything else passes (82 of 88).',
    },
    {
      ask: {
        kind: 'help',
        reason:
          "The staging admin password for the e2e account was rotated, so the 3 admin tests can't log in. Update the login in the studio environment, then mark this resolved and I'll re-run them.",
        then: 'junoHelped',
      },
    },
  ],
  junoHelped: [
    { think: 700 },
    { tool: { name: 'bash', target: 'npx playwright test admin/', output: '6 passed (chromium, webkit) in 41s' }, ms: 2600 },
    { say: 'Thanks. The admin tests pass on both browsers now. Final result for the night: **88 of 88 passed**.' },
    { summary: 'Nightly regression: 88 of 88 passed' },
  ],
  atlasDeploy: [
    {
      tool: {
        name: 'bash',
        target: 'npm run deploy:staging',
        output: 'Uploaded 214 files\nHealth check GET /v1/meta → 200\nDeployed web@0.16.0-rc.2 to staging.example.dev',
      },
      ms: 3200,
    },
    { tool: { name: 'bash', target: 'npm run test:smoke -- --env=staging', output: '18 passed in 52s' }, ms: 2000 },
    {
      say: 'Staging is on `web@0.16.0-rc.2`.\n\n- **Health check:** 200 on `/v1/meta`\n- **Smoke tests:** 18 passed\n\nWhen you are ready, I can promote the same build to production.',
    },
    { summary: 'rc.2 is live on staging' },
  ],
  atlasDenied: [
    { think: 500 },
    { say: "Okay, I won't run it. The build is ready whenever you want to deploy; just tell me." },
    { summary: 'Waiting for a go-ahead to deploy' },
  ],
  questionDismissed: [{ say: "Okay, I'll leave it as it is." }],
  atlasReply: [
    { think: 700 },
    {
      tool: {
        name: 'bash',
        target: 'git log --oneline origin/main -5',
        output: '9f2c1d0 Merge #152 bot artifacts\n41ab7e2 Merge #149 remote workspaces',
      },
      ms: 1300,
    },
    {
      say: 'Done. I re-checked the release against your note:\n\n1. **Version:** already `0.16.0-rc.2`\n2. **Changelog:** 3 entries under *Unreleased*\n3. **CI:** green on `main` (run #4812)\n\nNothing else is blocking the release.',
    },
  ],
  junoReply: [
    { think: 600 },
    {
      tool: { name: 'bash', target: 'npx playwright test --grep @smoke --project=webkit', output: '12 passed in 1m 08s' },
      ms: 2200,
    },
    { say: 'Smoke tests pass on WebKit: **12 passed** in 1m 08s. Nothing new to report.' },
  ],
  pixelReply: [
    { think: 700 },
    { tool: { name: 'browser', target: 'staging.example.dev/pricing', output: 'Captured 390px' }, ms: 1500 },
    {
      say: 'Checked on a 390px screen. Contrast passes AA everywhere except the muted footnote under the plans, which I bumped from 3.9:1 to 4.6:1.',
    },
  ],
  ledgerReply: [
    { think: 600 },
    { tool: { name: 'read', target: 'usage/2026-w41.json', output: null }, ms: 1100 },
    {
      say: "Atlas accounts for 64% of this week's spend, almost all of it during release prep on Thursday. The other bots are within their usual range.",
    },
  ],
  scoutReply: [{ think: 700 }, { say: 'Got it. I will take care of that and post here when it is done.' }],
  routine: [
    { think: 600 },
    { tool: { name: 'read', target: 'notes/checklist.md', output: null }, ms: 1200 },
    { say: 'Done. Everything on the checklist is in order; nothing needs your attention.' },
  ],
}

export const pixelAnswered = (choice: string): Step[] => [
  { think: 600 },
  { tool: { name: 'edit', target: 'src/pricing/PricingHero.tsx', output: null }, ms: 1600 },
  { tool: { name: 'browser', target: 'staging.example.dev/pricing', output: 'Captured 390px and 1440px' }, ms: 1800 },
  {
    say:
      choice === 'Keep the current hero'
        ? 'Kept the current hero and tightened the spacing: 24px less above the fold on phones. Screenshots for both sizes are in the PR.'
        : `Going with **${choice}**. I updated \`PricingHero.tsx\` and checked it at 390px and 1440px. Screenshots for both sizes are in the PR.`,
  },
  { summary: `Pricing hero: ${choice}` },
]

/** The reply a bot gives to anything the owner writes. */
export const REPLY_SCRIPT: Record<string, ScriptName> = {
  atlas: 'atlasReply',
  juno: 'junoReply',
  pixel: 'pixelReply',
  ledger: 'ledgerReply',
  scout: 'scoutReply',
}
