import type {
  FleetQuestion,
  FleetTodo,
  MobileChatItem,
  MobileChatMode,
  MobileExperience,
  MobilePermMode,
} from '@maestrly/bot-fleet-protocol'

/*
 * The demo server's chats and workspaces, from the approved prototype (prototypes/mobile-app/data.js). Every chat,
 * workspace and reply is fictional server content, so none of it is in the app's translation catalogs.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A chat item before the demo gives it an id and a time. */
export type DemoItem = DistributiveOmit<MobileChatItem, 'id' | 'at'>

export type DemoSetup = {
  providerId: string | null
  modelId: string | null
  reasoning: string
  fastMode: boolean
  mode: MobileChatMode
  permMode: MobilePermMode
}

export type DemoChat = {
  id: string
  name: string
  workspaceId: string | null
  branch: string | null
  minutesAgo: number
  experience: MobileExperience
  setup: DemoSetup
  usedTokens: number
  sourceConversationId?: string
  items: DemoItem[]
}

export type DemoWorkspace = { id: string; name: string; defaultBranch: string }

export type ChatStep =
  | { think: number }
  | { tool: { name: string; target: string; output?: string | null }; ms?: number; fail?: boolean }
  | { todos: FleetTodo[] }
  | { say: string }
  | { permission: { title: string; target: string; detail: string; allow: ChatStep[]; deny: ChatStep[] } }
  | { question: { questions: FleetQuestion[]; next: (answer: string) => ChatStep[] } }
  /** Ends the turn with a plan to approve, as Plan mode does. */
  | { plan: { title: string; text: string; build: ChatStep[] } }
  /** Starts a chat in a workspace with this plan, as an agent's start_conversations does. */
  | { dispatch: { workspaceId: string; title: string; plan: string } }

export const DEMO_SKILLS = [
  { name: 'frontend-design', description: 'Distinctive, intentional visual design for new UI.', on: true },
  { name: 'systematic-debugging', description: 'Find the cause of a bug before proposing fixes.', on: true },
  { name: 'writing-plans', description: 'Prepare a reviewed plan before touching code.', on: true },
  { name: 'verification-before-completion', description: 'Run the checks before saying work is done.', on: true },
  { name: 'webapp-testing', description: 'Test local web apps with Playwright.', on: false },
  { name: 'security-best-practices', description: 'Security reviews for Python, JavaScript and Go.', on: false },
]
export const DEMO_MCP = [
  { id: 'github', name: 'GitHub', on: true },
  { id: 'linear', name: 'Linear', on: true },
  { id: 'sentry', name: 'Sentry', on: false },
]
/** Context windows of the demo's models; `native` marks the provider's own Ultra. */
export const DEMO_MODEL_INFO: Record<string, { window: number; ultra: 'native' | 'maestrly' }> = {
  'claude::claude-opus-5-5': { window: 200_000, ultra: 'maestrly' },
  'claude::claude-sonnet-5': { window: 200_000, ultra: 'maestrly' },
  'claude::claude-haiku-5': { window: 200_000, ultra: 'maestrly' },
  'openai::gpt-5.5': { window: 272_000, ultra: 'maestrly' },
  'openai::gpt-5.5-codex': { window: 272_000, ultra: 'native' },
  'openai::gpt-5.5-mini': { window: 272_000, ultra: 'maestrly' },
  'google::gemini-3-pro': { window: 1_000_000, ultra: 'maestrly' },
  'google::gemini-3-flash': { window: 1_000_000, ultra: 'maestrly' },
}
export const DEMO_DEFAULTS = { providerId: 'claude', modelId: 'claude-opus-5-5', reasoning: 'high', fastMode: false }

export const DEMO_WORKSPACES: DemoWorkspace[] = [
  { id: 'maestrly', name: 'maestrly', defaultBranch: 'main' },
  { id: 'landing', name: 'landing-site', defaultBranch: 'redesign' },
  { id: 'docs', name: 'docs-site', defaultBranch: 'main' },
]

const HOUR = 60
const DAY = 24 * HOUR
const sonnetAsk: DemoSetup = {
  providerId: 'claude',
  modelId: 'claude-sonnet-5',
  reasoning: 'medium',
  fastMode: false,
  mode: 'ask',
  permMode: 'ask',
}
const codexAgent: DemoSetup = {
  providerId: 'openai',
  modelId: 'gpt-5.5-codex',
  reasoning: 'high',
  fastMode: true,
  mode: 'agent',
  permMode: 'auto',
}

const user = (text: string): DemoItem => ({
  kind: 'user',
  text,
  source: 'owner',
  queued: false,
  memories: [],
  images: [],
})
const answer = (text: string): DemoItem => ({ kind: 'assistant', text, streaming: false })
const tool = (name: string, target: string, state: 'done' | 'error', output: string | null): DemoItem => ({
  kind: 'tool',
  name,
  target,
  state,
  output,
  images: [],
})

function quick(
  id: string,
  name: string,
  minutesAgo: number,
  setup: DemoSetup,
  question: string,
  reply: string,
  workspace: { id: string; branch: string } | null = null
): DemoChat {
  return {
    id,
    name,
    workspaceId: workspace?.id ?? null,
    branch: workspace?.branch ?? null,
    minutesAgo,
    experience: 'standard',
    setup,
    usedTokens: 4_000 + name.length * 300,
    items: [user(question), answer(reply)],
  }
}

export const DEMO_CHATS: DemoChat[] = [
  {
    id: 'c-relay',
    name: 'Expo Push or our own relay?',
    workspaceId: null,
    branch: null,
    minutesAgo: HOUR,
    experience: 'standard',
    setup: {
      providerId: 'claude',
      modelId: 'claude-opus-5-5',
      reasoning: 'high',
      fastMode: false,
      mode: 'ask',
      permMode: 'ask',
    },
    usedTokens: 12_000,
    items: [
      user('For a self-hosted app, should push notifications go through Expo or through a relay we run?'),
      answer(
        "Either way, Apple's and Google's push keys belong to whoever publishes the app, so every notification passes through one central service. The question is who runs it.\n\n- **Expo Push:** no servers to run and a single API call from your server. Less control over abuse, and Expo sits in the middle.\n- **Your own relay:** full control and nothing in between, but it becomes a service you must keep online and secure.\n\nIf you start with Expo, keep the payload to IDs and a name, and register the native token too. Moving to a relay later then needs no app update."
      ),
    ],
  },
  {
    id: 'c-mvp',
    name: 'Mobile app MVP scope',
    workspaceId: null,
    branch: null,
    minutesAgo: DAY + 2 * HOUR,
    experience: 'standard',
    setup: {
      providerId: 'openai',
      modelId: 'gpt-5.5',
      reasoning: 'medium',
      fastMode: true,
      mode: 'ask',
      permMode: 'ask',
    },
    usedTokens: 21_000,
    items: [
      user('What should the first version of the mobile app include?'),
      answer(
        'Keep it to what you need away from your desk:\n\n1. **Pairing** with a code or a QR code\n2. **Chats, workspaces and bots** with streamed replies\n3. **Approvals and questions** as cards in the conversation\n4. **Push notifications** when something waits on you\n\nLeave bot creation, accounts and skill installs to the desktop for now.'
      ),
      user('Good. Send the push part to the maestrly workspace.'),
      {
        kind: 'dispatch',
        state: 'done',
        conversations: [
          {
            conversationId: 'c-push',
            title: 'Expo push sender interface',
            status: 'started',
            workspaceName: 'maestrly',
            error: null,
          },
        ],
      },
      answer(
        'Started **Expo push sender interface** in `maestrly`. It runs there in Agent mode; this chat stays read-only.'
      ),
      {
        kind: 'user',
        text: 'Done on feat/push-sender: the gateway sends through PushSender, and all 146 gateway tests pass.',
        source: 'owner',
        queued: false,
        memories: [],
        images: [],
        fromConversation: { conversationId: 'c-push', name: 'Expo push sender interface', purpose: 'report' },
      },
      answer(
        'The push sender is ready on `feat/push-sender`. Open its conversation from the report to review the diff.'
      ),
    ],
  },
  {
    id: 'c-invite',
    name: 'Beta invite email',
    workspaceId: null,
    branch: null,
    minutesAgo: 4 * DAY,
    experience: 'standard',
    setup: {
      providerId: 'claude',
      modelId: 'claude-sonnet-5',
      reasoning: 'off',
      fastMode: false,
      mode: 'agent',
      permMode: 'ask',
    },
    usedTokens: 6_000,
    items: [
      user('Write a short invite for the mobile beta.'),
      answer(
        "**Subject:** Your bots, now in your pocket\n\nYou're invited to the Maestrly mobile beta. Pair your phone with your server, keep an eye on your bots and workspaces, and approve what they do next from anywhere.\n\nInstall the beta from the link below, then open Maestrly on your computer and choose Pair a phone."
      ),
    ],
  },
  quick(
    'c-cron',
    'Cron syntax for weekday routines',
    3 * HOUR,
    sonnetAsk,
    'What is the cron expression for 08:30 on weekdays?',
    '`30 8 * * 1-5` runs at 08:30 Monday to Friday, in the server’s time zone. Routines in Maestrly use a weekly schedule instead, so you pick the days and the time without writing cron.'
  ),
  quick(
    'c-pricing',
    'Pricing tiers for teams',
    9 * DAY,
    sonnetAsk,
    'Suggest pricing tiers for a team plan.',
    '- **Starter:** 3 seats, community support\n- **Team:** 10 seats, shared environments, email support\n- **Business:** unlimited seats, SSO and an uptime commitment'
  ),
  quick(
    'c-docker',
    'Docker memory limits for bots',
    45 * DAY,
    sonnetAsk,
    'How much memory should a bot environment get?',
    'Start with 4 GB for an environment with up to 3 bots that use a browser. Each extra browsing bot needs about 1 GB more. Watch the memory chart for a week before going lower.'
  ),
  {
    id: 'c-flaky',
    name: 'Fix flaky gateway reconnect test',
    workspaceId: 'maestrly',
    branch: 'chat/fix-flaky-reconnect',
    minutesAgo: 2 * HOUR,
    experience: 'standard',
    setup: codexAgent,
    usedTokens: 88_000,
    items: [
      user('The reconnect test in bot-gateway fails about 1 in 20 runs. Find out why.'),
      tool('bash', 'npm test -- reconnect --repeat 50', 'error', '3 failed, 47 passed (50 runs)'),
      tool('read', 'apps/bot-gateway/test/reconnect.test.ts', 'done', null),
      tool('edit', 'apps/bot-gateway/test/reconnect.test.ts', 'done', null),
      tool('bash', 'npm test -- reconnect --repeat 50', 'done', '50 passed (50 runs)'),
      answer(
        'The test waited a fixed 200 ms for the socket to close. On a busy runner the `close` event can land later, so the assertion ran too early. I replaced the sleep with a wait on the event itself. 50 of 50 runs pass now.\n\nWant me to open a PR?'
      ),
    ],
  },
  {
    id: 'c-push',
    name: 'Expo push sender interface',
    workspaceId: 'maestrly',
    branch: 'task/expo-push-sender',
    minutesAgo: DAY,
    experience: 'standard',
    setup: {
      providerId: 'openai',
      modelId: 'gpt-5.5',
      reasoning: 'medium',
      fastMode: true,
      mode: 'agent',
      permMode: 'ask',
    },
    usedTokens: 54_000,
    sourceConversationId: 'c-mvp',
    items: [
      user(
        'Sketch a PushSender interface for the gateway so we can start with Expo and switch to our own relay later.'
      ),
      tool('grep', '"notify|push" apps/bot-gateway/src', 'done', null),
      tool('read', 'apps/bot-gateway/src/events.ts', 'done', null),
      answer(
        "Keep the gateway unaware of who delivers the push. One interface, two implementations:\n\n```ts\nexport interface PushSender {\n  send(device: PushTarget, push: PushMessage): Promise<PushResult>\n}\n\nexport type PushMessage = {\n  kind: 'waiting' | 'reply' | 'error'\n  title: string // bot or chat name only\n  ref: { botId?: string; chatId?: string }\n}\n```\n\n- `ExpoPushSender` posts to Expo's push API.\n- A later `RelayPushSender` posts to our own relay with the native APNs/FCM token.\n\nPhones register both tokens when they pair, so switching needs no app update."
      ),
    ],
  },
  {
    id: 'c-changelog',
    name: 'Changelog for 0.16',
    workspaceId: 'maestrly',
    branch: 'chat/changelog-0-16',
    minutesAgo: 3 * DAY,
    experience: 'standard',
    setup: { ...sonnetAsk },
    usedTokens: 19_000,
    items: [
      user('Draft the changelog for 0.16 from the merged PRs.'),
      answer(
        "Here's the draft, grouped by area:\n\n**Bots**\n\n- Bots can publish artifacts (#152)\n- Environments share accounts and skills (#147)\n\n**Desktop**\n\n- Remote workspaces through the gateway (#149)\n\nI left out dependency bumps. Should I include them?"
      ),
    ],
  },
  quick(
    'c-ats',
    'iOS ATS and self-signed certificates',
    5 * DAY,
    codexAgent,
    'Can the iOS app reach a gateway that uses a self-signed certificate?',
    'Not by default: App Transport Security rejects it. The practical options are a certificate from a public CA (Let’s Encrypt works with a domain) or a tunnel that terminates TLS for you. Turning ATS off would weaken every connection the app makes.',
    { id: 'maestrly', branch: 'chat/ios-ats' }
  ),
  quick(
    'c-qr',
    'Pair a phone with a QR code',
    8 * DAY,
    codexAgent,
    'Add a Pair a phone screen to the desktop that shows a QR code.',
    'Added **Settings → Bot server → Pair a phone**. It asks the gateway for a pairing code and shows it as a QR code that encodes the server address and the code, with the code in text below it. The code expires after 10 minutes.',
    { id: 'maestrly', branch: 'chat/pair-phone-qr' }
  ),
  quick(
    'c-i18n',
    'pt-BR strings for the bot screen',
    20 * DAY,
    codexAgent,
    'Translate the new bot screen strings to pt-BR.',
    'Translated 38 strings in `pt-BR/fleet.ts`. Two need your review because the English is ambiguous: “Release” (takeover) and “Ceiling”.',
    { id: 'maestrly', branch: 'chat/bot-screen-pt-br' }
  ),
  {
    id: 'c-hero',
    name: 'Hero copy variants',
    workspaceId: 'landing',
    branch: 'chat/hero-copy',
    minutesAgo: 9 * DAY,
    experience: 'standard',
    setup: {
      providerId: 'claude',
      modelId: 'claude-sonnet-5',
      reasoning: 'off',
      fastMode: false,
      mode: 'design',
      permMode: 'ask',
    },
    usedTokens: 7_000,
    items: [
      user('Give me three hero headline options for the redesign.'),
      answer(
        "- **Run your agents like a team.** Direct, review and ship from one place.\n- **Self-hosted agents that check in.** They ask before acting and report when they're done.\n- **Every agent's work in one place.** Chats, plans and approvals, on your own server."
      ),
    ],
  },
  quick(
    'c-faq',
    'Pricing FAQ section',
    11 * DAY,
    { ...codexAgent, mode: 'design' },
    'Add an FAQ section under the pricing plans.',
    'Added six questions under the plans, collapsed by default. The prototype is in `prototypes/pricing-faq/`; nothing in the site changed yet.',
    { id: 'landing', branch: 'chat/pricing-faq' }
  ),
  {
    ...quick(
      'c-remote-guide',
      'Remote workspaces guide',
      15 * DAY,
      sonnetAsk,
      'Outline a guide for remote workspaces.',
      '1. What a remote workspace is\n2. Connecting a host through the bot server\n3. Files, terminals and previews\n4. What stays on your computer',
      { id: 'docs', branch: 'chat/remote-guide' }
    ),
    experience: 'maestro',
  },
]

/** Standalone chats open with a few things to start with, as the prototype's new chat does. */
export const DEMO_SUGGESTIONS = [
  { label: 'Release notes', text: 'Draft release notes for 0.16 from what we shipped.' },
  { label: 'How push works', text: 'How does an Expo push reach a locked iPhone?' },
  { label: 'Plan and send', text: 'Plan the gateway push sender and send it to the maestrly workspace.' },
]

const pushPlan =
  '1. Add a `PushSender` interface with an Expo implementation.\n2. Store the Expo token and the native APNs/FCM token when a phone pairs.\n3. Send on `waiting`, `reply` and `error` events, with only IDs and a name.\n4. Cover it with tests.'

const pushBuild: ChatStep[] = [
  { think: 900 },
  {
    todos: [
      { content: 'Define the PushSender interface', status: 'in_progress' },
      { content: 'Add ExpoPushSender', status: 'pending' },
      { content: 'Register push tokens on pairing', status: 'pending' },
      { content: 'Add tests', status: 'pending' },
    ],
  },
  { tool: { name: 'read', target: 'apps/bot-gateway/src/auth.ts' }, ms: 1000 },
  { tool: { name: 'edit', target: 'apps/bot-gateway/src/push/sender.ts' }, ms: 1200 },
  {
    todos: [
      { content: 'Define the PushSender interface', status: 'completed' },
      { content: 'Add ExpoPushSender', status: 'in_progress' },
      { content: 'Register push tokens on pairing', status: 'pending' },
      { content: 'Add tests', status: 'pending' },
    ],
  },
  { tool: { name: 'edit', target: 'apps/bot-gateway/src/push/expo.ts' }, ms: 1300 },
  {
    tool: { name: 'bash', target: 'npm test --workspace @maestrly/bot-gateway', output: '146 passed in 18.4s' },
    ms: 2400,
  },
  {
    todos: [
      { content: 'Define the PushSender interface', status: 'completed' },
      { content: 'Add ExpoPushSender', status: 'completed' },
      { content: 'Register push tokens on pairing', status: 'completed' },
      { content: 'Add tests', status: 'completed' },
    ],
  },
  {
    say: "Done on a new branch, `feat/push-sender`:\n\n- `push/sender.ts` defines `PushSender`; the gateway only knows this interface.\n- `push/expo.ts` sends through Expo's push API, with only the bot or chat name in the payload.\n- Pairing now stores the Expo token **and** the native APNs/FCM token, so a future relay needs no app update.\n\nAll 146 gateway tests pass.",
  },
  {
    permission: {
      title: 'Run a command',
      target: 'git push -u origin feat/push-sender',
      detail: 'Publishes the new branch to GitHub',
      allow: [
        {
          tool: {
            name: 'bash',
            target: 'git push -u origin feat/push-sender',
            output: "branch 'feat/push-sender' set up to track 'origin/feat/push-sender'",
          },
          ms: 1800,
        },
        { say: 'Pushed `feat/push-sender`. You can open the PR from GitHub whenever you are ready.' },
      ],
      deny: [{ say: 'Okay. The branch stays local; nothing was pushed.' }],
    },
  },
]

const genericBuild = (workspace: string): ChatStep[] => [
  { think: 900 },
  { tool: { name: 'grep', target: `"TODO" ${workspace}/src`, output: '7 matches in 4 files' }, ms: 1200 },
  { tool: { name: 'read', target: 'README.md' }, ms: 900 },
  {
    say: `I read through \`${workspace}\` and here's how I'd approach it:\n\n- Start with the smallest change that proves the idea.\n- Keep it behind a flag until it's reviewed.\n- Add a test for the main path before polishing.\n\nWant me to start on the first step?`,
  },
]

/** A workspace chat's reply, by its mode: Ask only reads, Plan proposes and waits, Design builds a mock prototype. */
export function workspaceReply(
  workspace: string,
  mode: MobileChatMode,
  experience: MobileExperience,
  text: string
): ChatStep[] {
  const push = /push/i.test(text)
  if (experience === 'maestro')
    return [
      { think: 900 },
      {
        tool: {
          name: 'agent',
          target: `Explorer · map the push path in ${workspace}`,
          output: 'Found 3 places that emit owner events',
        },
        ms: 1500,
      },
      {
        tool: {
          name: 'agent',
          target: 'Implementer · add PushSender and ExpoPushSender',
          output: '2 files added, 1 changed',
        },
        ms: 1900,
      },
      {
        tool: { name: 'agent', target: 'Reviewer · check the change against the plan', output: 'No blocking issues' },
        ms: 1400,
      },
      {
        say: 'Maestro split the work across three agents from your Agent Pool: one mapped the code, one made the change and one reviewed it. The review found no blocking issues.',
      },
    ]
  if (mode === 'ask')
    return [
      { think: 800 },
      {
        tool: { name: 'grep', target: `"push" ${workspace}/apps/bot-gateway/src`, output: '4 matches in 2 files' },
        ms: 1100,
      },
      { tool: { name: 'read', target: 'apps/bot-gateway/src/events.ts' }, ms: 900 },
      {
        say: 'The gateway has no push code yet. Events leave through `events.ts` as WebSocket messages only, so a phone hears about them only while the app is open.\n\nThis chat is in **Ask** mode, so I only read files and changed nothing.',
      },
    ]
  if (mode === 'plan')
    return [
      { think: 900 },
      { tool: { name: 'read', target: 'apps/bot-gateway/src/auth.ts' }, ms: 1000 },
      {
        tool: { name: 'grep', target: `"emit(" ${workspace}/apps/bot-gateway/src`, output: '11 matches in 3 files' },
        ms: 1100,
      },
      {
        plan: {
          title: push ? 'Push sender for the gateway' : `Change in ${workspace}`,
          text: push
            ? `${pushPlan}\n\nNothing changes until you approve it.`
            : '1. Reproduce the problem with a focused test.\n2. Make the smallest fix that passes it.\n3. Run the workspace checks.\n\nNothing changes until you approve it.',
          build: push ? pushBuild : genericBuild(workspace),
        },
      },
    ]
  if (mode === 'design')
    return [
      { think: 800 },
      { tool: { name: 'edit', target: `prototypes/${workspace}/index.html` }, ms: 1300 },
      { tool: { name: 'edit', target: `prototypes/${workspace}/styles.css` }, ms: 1100 },
      { tool: { name: 'browser', target: 'localhost:4180', output: 'Captured 390px and 1440px' }, ms: 1500 },
      {
        say: 'The prototype is ready, with mock data only. I checked it on a phone-sized and a desktop-sized screen. Nothing outside `prototypes/` changed.',
      },
    ]
  return push ? pushBuild : genericBuild(workspace)
}

/** A standalone chat's reply: the suggestions answer in full, a request to send work starts a workspace chat. */
export function chatReply(text: string, modelLabel: string): ChatStep[] {
  const lower = text.toLowerCase()
  const workspace = /\b(maestrly|landing-site|docs-site)\b/.exec(lower)?.[1]
  if (workspace && /\bsend\b|\bstart\b/.test(lower)) {
    const push = /push/.test(lower)
    const plan = push
      ? pushPlan
      : '1. Find where this lives in the code.\n2. Make the smallest change that does it.\n3. Run the workspace checks.'
    const title = push ? 'Gateway push sender' : 'Follow-up from chat'
    const id = workspace === 'landing-site' ? 'landing' : workspace === 'docs-site' ? 'docs' : 'maestrly'
    return [
      { think: 800 },
      { say: `Here's the plan I'll hand to \`${workspace}\`:\n\n${plan}` },
      { dispatch: { workspaceId: id, title, plan } },
      {
        say: `Started **${title}** in \`${workspace}\`. It works there in Agent mode with this chat's model; this chat doesn't change any files. Open it from the card, or from the menu.`,
      },
    ]
  }
  if (/release notes|changelog/.test(lower))
    return [
      { think: 700 },
      {
        say: '**Maestrly 0.16**\n\n- **Bots publish artifacts.** Reports and prototypes open from the conversation.\n- **Environments share setup.** Accounts, skills and MCP servers are set once for every bot in an environment.\n- **Remote workspaces.** Work in a workspace on another computer through your bot server.\n\nWant a shorter version for the app stores?',
      },
    ]
  if (/push/.test(lower))
    return [
      { think: 800 },
      {
        say: '1. **Your server** sees that a bot needs you and calls Expo with the phone’s push token, the bot’s name and an ID. Nothing else.\n2. **Expo** passes it to Apple’s push service (APNs) with the app’s key.\n3. **APNs** keeps one connection open to every iPhone, locked or not, and delivers it.\n4. **The phone** shows “Atlas · Needs your approval”. Tapping it opens the app, which loads the rest from your server.\n\nThe message itself never leaves your server.',
      },
    ]
  return [
    { think: 700 },
    {
      say: `**Simulated reply.** The demo server has no model behind it. On your server, ${modelLabel} answers here and streams its reply as it writes.\n\nTry a suggestion in a new chat to see a full answer, or ask this chat to send a plan to the maestrly workspace.`,
    },
  ]
}

export const PLAN_REVISE: ChatStep[] = [
  { think: 500 },
  { say: 'Okay. Tell me what to change and I will update the plan.' },
]
export const PLAN_DISCARD: ChatStep[] = [{ say: 'Okay, I dropped the plan. Nothing changed.' }]
