/**
 * The wake phrase as the assistant compares it: words without case, accents or punctuation, matched at the start of
 * what was heard with a tolerance for recognition errors.
 */
export const WAKE_PHRASE_MIN = 2
export const WAKE_PHRASE_MAX = 40
export const WAKE_MATCH_THRESHOLD = 0.8
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

/** The best similarity between the phrase and the first words heard, with windows one word shorter or longer. */
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
  return wakeScore(transcript, phrase) >= WAKE_MATCH_THRESHOLD
}
