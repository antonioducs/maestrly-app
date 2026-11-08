/**
 * Which option of a card a spoken answer picks: a yes or a no for a confirmation, or the option it names. Anything
 * unclear picks nothing, and the card waits for a click.
 */
import type { SupportedLocale } from './locale'

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const words = (text: string) => normalize(text).split(' ').filter(Boolean)

const STOPWORDS = new Set([
  'o',
  'a',
  'os',
  'as',
  'de',
  'do',
  'da',
  'e',
  'um',
  'uma',
  'por',
  'favor',
  'the',
  'to',
  'of',
  'and',
  'please',
])

const YES = new Set([
  'sim',
  'manda',
  'pode',
  'confirma',
  'confirmo',
  'ok',
  'okay',
  'beleza',
  'isso',
  'bora',
  'yes',
  'go',
  'send',
])
const NO = new Set(['nao', 'cancela', 'cancel', 'stop'])
/** "Para" and "deixa" also mean "for" and "let": they say no only when the answer starts with them. */
const NO_FIRST = new Set(['para', 'deixa'])
/** "No" is a Portuguese preposition ("no canal"); it says no only in English. */
const NO_EN = new Set(['no'])
const CANCEL_LABEL = new Set([
  'cancel',
  'cancelar',
  'cancela',
  'nao',
  'no',
  'stop',
  'parar',
  'deny',
  'negar',
  'recusar',
  'dismiss',
  'descartar',
  'discard',
  'dont',
])

const sameWord = (a: string, b: string) => a === b
/** "libera" and "liberar", "cancel" and "cancelar": one starts the other, long enough not to be chance. */
const stemWord = (a: string, b: string) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return short.length >= 4 && long.startsWith(short)
}
const within = (part: string[], whole: string[], same: (a: string, b: string) => boolean) =>
  part.length > 0 && part.every((word) => whole.some((other) => same(word, other)))

/** How well the answer names an option: 3 says exactly its label, 2 has its words, 1 their stems, 0 none. */
function score(answer: string[], label: string[]): number {
  if (!label.length || !answer.length) return 0
  if (answer.length === label.length && answer.every((word, i) => word === label[i])) return 3
  if (within(label, answer, sameWord) || within(answer, label, sameWord)) return 2
  if (within(label, answer, stemWord) || within(answer, label, stemWord)) return 1
  return 0
}

export function matchSpokenOption(
  transcript: string,
  options: readonly string[],
  locale: SupportedLocale
): number | null {
  const said = words(transcript)
  if (!said.length || !options.length) return null
  const yes = said.some((word) => YES.has(word))
  const no = said.some((word) => NO.has(word) || (locale === 'en' && NO_EN.has(word))) || NO_FIRST.has(said[0])
  // "Sim… não": the person changed their mind, or the transcript is wrong. Either way, the card decides.
  if (yes && no) return null

  const content = said.filter((word) => !STOPWORDS.has(word))
  // "Sim, libera o resto" names the option without its "sim".
  const named = content.filter((word) => !YES.has(word) && !NO.has(word) && !NO_FIRST.has(word) && !NO_EN.has(word))
  const labels = options.map((option) => words(option).filter((word) => !STOPWORDS.has(word)))
  const scores = labels.map((label) => Math.max(score(content, label), score(named, label)))
  const best = Math.max(...scores)
  if (best > 0) {
    const top = scores.flatMap((value, index) => (value === best ? [index] : []))
    return top.length === 1 ? top[0] : null
  }

  const cancel = labels.findIndex((label) => label.some((word) => CANCEL_LABEL.has(word)))
  if (no) return cancel >= 0 ? cancel : null
  // Yes picks the confirming option only on a confirmation: a card with a way to cancel, whose first option is not it.
  if (yes && cancel > 0) return 0
  return null
}
