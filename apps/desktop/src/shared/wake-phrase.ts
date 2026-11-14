/**
 * The wake phrase as the assistant compares it: words without case, accents or punctuation, matched at the start of
 * what was heard with a tolerance for recognition errors.
 */
export const WAKE_PHRASE_MIN = 2
export const WAKE_PHRASE_MAX = 40
/**
 * Each word heard against the phrase's word in the same place, so a close word passes ("maestra") and a neighbour that
 * shares most letters with the whole phrase does not ("Oi mestre", "O maestro regeu").
 */
const WORD_MATCH = 0.75
/** The phrase with its words run together or split differently by the recognizer ("Oimaestro"). */
const JOINED_MATCH = 0.9
/** Everything heard is the phrase, or nearly: Whisper often writes "Oi Maestro" said alone as "O Maestro.". */
const ALONE_MATCH = 0.85
/** Words that may come before the phrase ("é, oi Maestro"). */
const LEADING_WORDS = 1
const DEFAULTS: Record<string, string> = { 'pt-BR': 'Oi Maestro', en: 'Hey Maestro' }

export function defaultWakePhrase(locale: string): string {
  return DEFAULTS[locale] ?? DEFAULTS.en
}

export function normalizeSpeech(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** 1 minus the edit distance over the longer length. */
function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length)
}

/** Whisper hears a short clip far better when told what to expect: the phrase is the prompt. */
export function wakePrompt(phrase: string): string {
  return `${phrase.trim().replace(/[\s.,;:!?…]+$/u, '')}.`
}

/**
 * The best similarity between the phrase and the first words heard, with windows one word shorter or longer. Only for
 * logs: the decision is matchesWakePhrase.
 */
export function wakeScore(transcript: string, phrase: string): number {
  const want = normalizeSpeech(phrase)
  const heard = normalizeSpeech(transcript)
  if (!want.length || !heard.length) return 0
  const target = want.join(' ')
  let best = 0
  for (let skip = 0; skip <= LEADING_WORDS; skip++) {
    for (let size = Math.max(1, want.length - 1); size <= want.length + 1; size++) {
      if (skip + size > heard.length) continue
      best = Math.max(best, similarity(heard.slice(skip, skip + size).join(' '), target))
    }
  }
  return best
}

export function matchesWakePhrase(transcript: string, phrase: string): boolean {
  const want = normalizeSpeech(phrase)
  const heard = normalizeSpeech(transcript)
  if (!want.length || !heard.length) return false
  const joined = want.join('')
  for (let skip = 0; skip <= LEADING_WORDS; skip++) {
    const aligned = heard.slice(skip, skip + want.length)
    if (aligned.length === want.length && aligned.every((word, i) => similarity(word, want[i]) >= WORD_MATCH)) {
      return true
    }
    for (let size = Math.max(1, want.length - 1); size <= want.length + 1; size++) {
      const part = heard.slice(skip, skip + size)
      if (part.length === size && similarity(part.join(''), joined) >= JOINED_MATCH) return true
    }
  }
  return heard.length <= want.length + 1 && similarity(heard.join(''), joined) >= ALONE_MATCH
}
