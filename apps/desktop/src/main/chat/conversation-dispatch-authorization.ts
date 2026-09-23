/**
 * Authorization for starting persistent conversations from a chat turn.
 *
 * Two independent facts must hold:
 * 1. Provenance: the running turn was admitted from text the person typed in this conversation (recorded by the
 *    chat service at admission). Internal plan execution, seeded child tasks, review loops, bot, remote and
 *    unattended turns never register an origin here, so a transcript message with role `user` is not enough.
 * 2. Intent: that text contains a positive, operational request to open/create/start other conversations.
 *    The detector is deliberately conservative: quoted/code content, negation, questions about capability,
 *    hypotheticals, examples and feature descriptions do not authorize anything. Uncertainty is rejected with a
 *    reason the agent relays so the person can state the request explicitly.
 *
 * A grant is bound to the admitted turn and its message; it expires when the turn ends and is never inherited
 * by the conversations it creates.
 */

export interface HumanTurnOrigin {
  /** Identity of the admitted run; a later turn in the same conversation is a different token. */
  token: object
  conversationId: string
  /** Persisted id of the human message that started the turn. */
  messageId: string
  /** Exactly what the person typed (attachments and hidden mention content excluded). */
  text: string
  signal: AbortSignal
}

const origins = new Map<string, HumanTurnOrigin>()

/** The admission options that decide provenance (a structural subset of the chat service's send options). */
export interface TurnAdmissionShape {
  internal?: boolean
  internalLoop?: unknown
  botAdmission?: unknown
  remoteAdmission?: boolean
  runnerAdmission?: unknown
  runnerSignal?: unknown
  dispatchSeed?: unknown
  hiddenParts?: readonly unknown[]
}

/**
 * Only text a person typed into this conversation (chat:send / edit-and-resend) is a human origin. Every host path
 * (plans, review loops, bots, remote/web, unattended executors, dispatch seeds, guard continuations) passes
 * options that exclude it.
 */
export function isHumanTurnAdmission(opts: TurnAdmissionShape | undefined): boolean {
  return (
    !opts?.internal &&
    !opts?.internalLoop &&
    !opts?.botAdmission &&
    !opts?.remoteAdmission &&
    !opts?.runnerAdmission &&
    !opts?.runnerSignal &&
    !opts?.dispatchSeed &&
    !opts?.hiddenParts?.length
  )
}

export function recordHumanTurnOrigin(origin: HumanTurnOrigin): void {
  origins.set(origin.conversationId, origin)
}

export function clearHumanTurnOrigin(conversationId: string, token: object): void {
  if (origins.get(conversationId)?.token === token) origins.delete(conversationId)
}

export function currentHumanTurnOrigin(conversationId: string): HumanTurnOrigin | null {
  const origin = origins.get(conversationId)
  return origin && !origin.signal.aborted ? origin : null
}

export type ConversationDispatchDenial =
  | 'no-human-turn'
  | 'turn-ended'
  | 'not-requested'
  | 'negated'
  | 'question'
  | 'hypothetical'
  | 'count-exceeded'

export interface ConversationDispatchIntent {
  explicit: boolean
  /** Upper bound stated by the person ("open 3 conversations"); null when scoped per item or unbounded. */
  maxConversations: number | null
  reason?: Exclude<ConversationDispatchDenial, 'no-human-turn' | 'turn-ended' | 'count-exceeded'>
}

export interface ConversationDispatchGrant {
  conversationId: string
  messageId: string
  /** Durable origin key shared by every record created under this grant. */
  originKey: string
  maxConversations: number | null
  token: object
  signal: AbortSignal
}

export class ConversationDispatchDeniedError extends Error {
  readonly code: ConversationDispatchDenial
  constructor(code: ConversationDispatchDenial, message: string) {
    super(message)
    this.name = 'ConversationDispatchDeniedError'
    this.code = code
  }
}

export function conversationDispatchDenialMessage(code: ConversationDispatchDenial, limit?: number | null): string {
  switch (code) {
    case 'no-human-turn':
      return 'Starting conversations is only available in a turn started by a message the person typed in this conversation.'
    case 'turn-ended':
      return 'The turn that authorized this request is no longer active. Ask the person to request it again.'
    case 'negated':
      return 'The person asked NOT to open other conversations. Do not start any.'
    case 'question':
      return (
        'The person asked a question about opening conversations; that is not a request to open them. Answer the ' +
        'question, and start conversations only if they explicitly ask (for example: "Open one conversation for each card").'
      )
    case 'hypothetical':
      return (
        'The message describes an example, a hypothetical or a feature rather than requesting new conversations now. ' +
        'Do not start any. Ask the person to request it explicitly if that is what they want.'
      )
    case 'count-exceeded':
      return `The person asked for at most ${limit ?? 0} conversation(s) in this turn; this request would exceed it.`
    case 'not-requested':
      return (
        'The latest message does not explicitly ask to open/create/start other conversations. Do not start any. If it ' +
        'would help, suggest it and let the person ask explicitly (for example: "Open one conversation for each card").'
      )
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Explicit-intent detector (Portuguese and English)
// ---------------------------------------------------------------------------------------------------------------

/** Remove content the person quoted rather than said: code, block quotes, quoted strings and URLs. */
function stripNonRequestContent(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>.*$/gm, '')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/“[^”\n]*”/g, ' ')
    .replace(/«[^»\n]*»/g, ' ')
    .replace(/(^|[\s(])'[^'\n]{2,}'(?=[\s).,;:!?]|$)/g, '$1 ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

const NOUN_SRC = '(?:conversas?|chats?|conversations?)'
const NOUN = new RegExp(String.raw`\b${NOUN_SRC}\b`)

/** Verbs that create by themselves ("create a conversation"). */
const CREATE_VERBS = String.raw`(?:crie|criem|cria|criar|create|spawn|spin\s+up|dispare|disparem|dispara|disparar|dispatch|launch|lance|lancem|lanca|lancar|kick\s+off|fire\s+off|fire\s+up)`
/** Verbs that only create with a qualifier ("open a NEW conversation", "one conversation PER card"). */
const OPEN_VERBS = String.raw`(?:abra|abram|abre|abrir|open|inicie|iniciem|inicia|iniciar|start|comece|comecem|comeca|comecar|begin|set\s+up|monte|montar)`
/** Verbs that hand work over ("send the plan to a new conversation"); they need a target that is new. */
const SEND_VERBS = String.raw`(?:envie|enviem|envia|enviar|mande|mandem|manda|mandar|encaminhe|encaminha|encaminhar|delegue|delega|delegar|passe|passa|passar|mova|mover|send|forward|hand\s+off|hand\s+over|move|delegate|pass)`

const QUALIFIER =
  /\b(?:nova|novas|novo|novos|outra|outras|outro|outros|separad[ao]s?|propri[ao]s?|dedicad[ao]s?|diferentes?|new|another|other|separate|own|dedicated|different|fresh|\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|one|two|three|four|five|six|seven|eight|nine|ten|varias|varios|several|multiple)\b/
const NEW_TARGET = new RegExp(
  String.raw`\b(?:para|pra|to|into|in|em|numa|numas|num|nuns)\s+(?:(?:a|o|as|os|uma|um|umas|uns|the|an?)\s+)?(?:(?:nova|novas|novo|novos|outra|outras|outro|outros|separad[ao]s?|propri[ao]s?|dedicad[ao]s?|new|another|other|separate|own|dedicated|fresh)\s+${NOUN_SRC}|${NOUN_SRC}\s+(?:nova|novas|novo|novos|separad[ao]s?|propri[ao]s?|dedicad[ao]s?|diferentes?))\b`
)

const PREFIX_TOKEN = [
  String.raw`e|and|entao|depois|agora|primeiro|em\s+seguida|ok|okay|beleza|certo|sim|yes|now|then|next|first|so|tambem|also|finally|por\s+fim|por\s+favor|please|pf|pfv|pls|ai|ae|ja|already`,
  String.raw`(?:eu\s+)?(?:quero|queria|preciso|gostaria|vou\s+querer)(?:\s+(?:que|de))?(?:\s+(?:voce|vc|tu))?`,
  String.raw`(?:i|we)\s+(?:want|need|would\s+like|'d\s+like)(?:\s+you)?(?:\s+to)?`,
  String.raw`vamos|let's|lets|let\s+us`,
  String.raw`(?:(?:voce|vc|tu)\s+)?(?:pode|poderia|podes|podia)`,
  String.raw`(?:could|can|would|will)\s+you`,
  String.raw`go\s+ahead\s+and`,
].join('|')
/** Only these may precede the imperative verb in its segment. */
const PREFIX_OK = new RegExp(String.raw`^(?:${PREFIX_TOKEN})(?:\s+(?:${PREFIX_TOKEN}))*$`)

const POLITE_QUESTION = /(?:^|\s)(?:(?:voce|vc|tu)\s+)?(?:pode|poderia|podes|podia)(?:\s|$)|(?:^|\s)(?:could|can|would|will)\s+you(?:\s|$)/

const NEGATION =
  /\b(?:nao|nunca|jamais|nem|evite|evitar|pare\s+de|don't|dont|do\s+not|never|no\s+need|avoid|stop|instead\s+of|em\s+vez\s+de|rather\s+than)\b/

/** Courtesy conditionals that do not make a request hypothetical. */
const COURTESY = /\b(?:se\s+possivel|se\s+puder|quando\s+puder|if\s+possible|if\s+you\s+can|when\s+you\s+can)\b/g

/** Capability questions: never a request, even when phrased with a verb. */
const CAPABILITY =
  /\b(?:conseguimos|consigo|consegue|conseguem|da\s+pra|da\s+para|tem\s+como|e\s+possivel|seria\s+possivel|possivel|possible|is\s+there\s+a\s+way|can\s+we|can\s+i|could\s+we|could\s+i|hoje|today|does\s+it|do\s+we|como\s+(?:faco|faz|eu|funciona)|how\s+(?:do|does|can|would))\b/

/** Examples, hypotheticals about the person's own future actions, and feature descriptions. */
const HYPOTHETICAL =
  /\b(?:(?:quando|se|caso|when|whenever|if)\s+(?:eu|a\s+gente|nos|i|we|alguem|someone|o\s+usuario|um\s+usuario|the\s+user|a\s+user)|imagine|imagina|suponha|supondo|suppose|exemplo|example|e\.g|for\s+instance|poder|seria\s+(?:bom|legal|otimo)|would\s+be\s+(?:nice|great|good)|feature|features|funcionalidade|funcionalidades|recurso|capacidade|capability|ability|able\s+to|suporte\s+(?:a|para)|support\s+for|ideia|idea|proposta|proposal)\b/

const PER_ITEM = /\b(?:cada|each|per|por\s+(?:card|cards|task|tasks|tarefa|tarefas|ticket|tickets|item|itens|issue|issues|subtask|subtasks|subtarefa|subtarefas))\b/
const MORE = /\b(?:outra|outro|outras|outros|another|mais\s+uma|mais\s+um|one\s+more|also\s+one)\b/

const NUMBER_WORDS: Record<string, number> = {
  um: 1,
  uma: 1,
  a: 1,
  an: 1,
  one: 1,
  outra: 1,
  outro: 1,
  another: 1,
  dois: 2,
  duas: 2,
  two: 2,
  tres: 3,
  three: 3,
  quatro: 4,
  four: 4,
  cinco: 5,
  five: 5,
  seis: 6,
  six: 6,
  sete: 7,
  seven: 7,
  oito: 8,
  eight: 8,
  nove: 9,
  nine: 9,
  dez: 10,
  ten: 10,
}
const COUNT = new RegExp(
  String.raw`\b(\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})\s+(?:(?:nova|novas|novo|novos|new|separate|separad[ao]s?|dedicad[ao]s?|dedicated|fresh|other|outras|outros|different|diferentes)\s+)*${NOUN_SRC}\b`
)

type SegmentOutcome = { count: number | null } | NonNullable<ConversationDispatchIntent['reason']> | null

const VERB_GROUPS = [
  { re: new RegExp(String.raw`\b${CREATE_VERBS}\b`, 'g'), kind: 'create' as const },
  { re: new RegExp(String.raw`\b${OPEN_VERBS}\b`, 'g'), kind: 'open' as const },
  { re: new RegExp(String.raw`\b${SEND_VERBS}\b`, 'g'), kind: 'send' as const },
]

/** How many conversations the object phrase asks for; null = one per item or an unstated plural. */
function requestedCount(objectPhrase: string, noun: string, after: string): number | null {
  if (PER_ITEM.test(objectPhrase) || PER_ITEM.test(after)) return null
  const counted = COUNT.exec(objectPhrase)
  const value = counted ? Number(NUMBER_WORDS[counted[1]] ?? counted[1]) : Number.NaN
  if (Number.isFinite(value) && value > 1) return value
  if (/^(?:conversas|chats|conversations)$/.test(noun)) return null
  // "uma conversa para A e outra para B" asks for more than the leading article says.
  return MORE.test(after) ? null : 1
}

function segmentRequest(segment: string, sentenceBefore: string, isQuestion: boolean): SegmentOutcome {
  let denial: NonNullable<ConversationDispatchIntent['reason']> | null = null
  const deny = (reason: NonNullable<ConversationDispatchIntent['reason']>) => {
    if (!denial || reason === 'negated') denial = reason
  }
  for (const group of VERB_GROUPS) {
    for (const match of segment.matchAll(group.re)) {
      const index = match.index ?? 0
      const prefix = segment.slice(0, index).trim()
      const rest = segment.slice(index + match[0].length)
      const nounMatch = NOUN.exec(rest)
      if (!nounMatch) continue
      const between = rest.slice(0, nounMatch.index)
      // Keep the object phrase short: "abra uma nova conversa", not a noun mentioned much later.
      if (between.split(' ').filter(Boolean).length > 8) continue
      const noun = nounMatch[0]
      const objectPhrase = `${between}${noun}`
      const after = rest.slice(nounMatch.index + noun.length)
      if (group.kind === 'open') {
        const qualified =
          QUALIFIER.test(between) ||
          /^\s+(?:nova|novas|novo|novos|separad[ao]s?|diferentes?|dedicad[ao]s?|propri[ao]s?)\b/.test(after) ||
          PER_ITEM.test(rest) ||
          (/\ban?\b/.test(between) && /^(?:conversations?|chats?)$/.test(noun))
        if (!qualified) continue
      }
      if (group.kind === 'send' && !NEW_TARGET.test(`${objectPhrase}${after.slice(0, 40)}`)) continue
      if (NEGATION.test(prefix) || NEGATION.test(between)) {
        deny('negated')
        continue
      }
      const context = `${sentenceBefore} ${prefix}`
      if (HYPOTHETICAL.test(context)) {
        deny('hypothetical')
        continue
      }
      if (CAPABILITY.test(context) || CAPABILITY.test(between)) {
        deny(isQuestion ? 'question' : 'hypothetical')
        continue
      }
      if (prefix && !PREFIX_OK.test(prefix)) {
        deny(isQuestion ? 'question' : 'not-requested')
        continue
      }
      if (isQuestion && !POLITE_QUESTION.test(` ${prefix} `)) {
        deny('question')
        continue
      }
      return { count: requestedCount(objectPhrase, noun, after) }
    }
  }
  return denial
}

const DENIAL_RANK: Record<NonNullable<ConversationDispatchIntent['reason']>, number> = {
  'not-requested': 0,
  hypothetical: 1,
  question: 2,
  negated: 3,
}

/** Detect whether `text` explicitly asks to open/create/start other conversations now. */
export function detectConversationDispatchIntent(text: string): ConversationDispatchIntent {
  const cleaned = stripNonRequestContent(text ?? '')
  let explicit = false
  let unbounded = false
  let total = 0
  let denial: NonNullable<ConversationDispatchIntent['reason']> = 'not-requested'
  for (const match of cleaned.matchAll(/([^.!?;\n]+)([.!?;\n]*)/g)) {
    const isQuestion = match[2].includes('?')
    const sentence = normalize(match[1]).replace(COURTESY, ' ')
    if (!sentence.trim()) continue
    let before = ''
    // Segments: punctuation, dashes, and conjunctions that start a new action ("... e depois abra ...").
    const segments = sentence
      .split(/\s*[,:()]\s*|\s+[-–—]\s+/)
      .flatMap((part) =>
        part.split(
          new RegExp(
            String.raw`\s+(?=(?:e|and|mas|but|then|depois|entao)\s+(?:(?:depois|entao|then|also|tambem|agora|now)\s+)?(?:${CREATE_VERBS}|${OPEN_VERBS}|${SEND_VERBS})\b)`
          )
        )
      )
    for (const rawSegment of segments) {
      const segment = rawSegment.replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim()
      if (!segment) continue
      const outcome = segmentRequest(segment, before, isQuestion)
      before = `${before} ${segment}`
      if (!outcome) continue
      if (typeof outcome === 'string') {
        if (DENIAL_RANK[outcome] > DENIAL_RANK[denial]) denial = outcome
        continue
      }
      explicit = true
      if (outcome.count === null) unbounded = true
      else total += outcome.count
    }
  }
  if (!explicit) return { explicit: false, maxConversations: null, reason: denial }
  return { explicit: true, maxConversations: unbounded ? null : Math.max(1, total) }
}

/**
 * Evaluate the grant for the conversation's CURRENT human turn. The runner captures the origin when it builds the
 * tool surface; passing it here binds authorization to that exact admitted turn.
 */
export function evaluateConversationDispatchGrant(
  origin: HumanTurnOrigin | null
): { ok: true; grant: ConversationDispatchGrant } | { ok: false; code: ConversationDispatchDenial; message: string } {
  if (!origin) return { ok: false, code: 'no-human-turn', message: conversationDispatchDenialMessage('no-human-turn') }
  if (origin.signal.aborted || origins.get(origin.conversationId)?.token !== origin.token)
    return { ok: false, code: 'turn-ended', message: conversationDispatchDenialMessage('turn-ended') }
  const intent = detectConversationDispatchIntent(origin.text)
  if (!intent.explicit) {
    const code = intent.reason ?? 'not-requested'
    return { ok: false, code, message: conversationDispatchDenialMessage(code) }
  }
  return {
    ok: true,
    grant: {
      conversationId: origin.conversationId,
      messageId: origin.messageId,
      originKey: `message:${origin.messageId}`,
      maxConversations: intent.maxConversations,
      token: origin.token,
      signal: origin.signal,
    },
  }
}

/** Recheck immediately before a mutation: the admitted turn must still be the conversation's live turn. */
export function assertConversationDispatchGrantCurrent(grant: ConversationDispatchGrant): void {
  if (grant.signal.aborted || origins.get(grant.conversationId)?.token !== grant.token) {
    throw new ConversationDispatchDeniedError('turn-ended', conversationDispatchDenialMessage('turn-ended'))
  }
}
