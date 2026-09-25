/**
 * Absolute relevance for memory recall and search. Retrieval ranks by reciprocal rank, which cannot say "nothing is
 * relevant"; these scores can, so the host injects memory only above a floor.
 */
export const MEMORY_RELEVANCE = {
  recallMin: 0.6,
  searchMin: 0.34,
  titleBonus: 0.1,
  unknownPenalty: 0.25,
  maxStems: 16,
  minStemLength: 4,
} as const

const STOPWORDS = new Set(
  (
    'a o as os um uma uns umas de do da dos das em no na nos nas por para pra pro com sem sobre entre ate desde ' +
    'e ou mas que se ja nao sim muito mais menos como quando onde qual quais quem porque pois entao tambem so ' +
    'isso isto esse essa esses essas este esta estes estas aquele aquela ele ela eles elas eu voce voces nos ' +
    'me te lhe meu minha meus minhas seu sua seus suas nosso nossa ser estar ter haver fazer foi era sao ' +
    'estao tem tinha vai vou pode posso deve cada todo toda todos todas algum alguma nenhum outro outra ' +
    'aqui ali agora hoje ontem amanha depois antes ainda sempre nunca bem mal oi ola obrigado obrigada ' +
    'the an and or but if then else of to in on at by for with without from into onto over under about as is are ' +
    'was were be been being have has had do does did can could should would will shall may might must not no yes ' +
    'this that these those it its you he she we they me my your his her our their them what which who whom why ' +
    'how when where there here all any some each every other such only also just very more most less than too so ' +
    'please thanks thank hi hello ok okay'
  ).split(/\s+/)
)
const SUFFIXES = [
  'mente',
  'coes',
  'cao',
  'ando',
  'endo',
  'indo',
  'ados',
  'adas',
  'idos',
  'idas',
  'ings',
  'ing',
  'tions',
  'tion',
  'ado',
  'ada',
  'ido',
  'ida',
  'ar',
  'er',
  'ir',
  'es',
  'ed',
  's',
  'e',
] as const

export function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

export function searchTokens(text: string): string[] {
  return normalizeForSearch(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

export function stemToken(token: string): string {
  for (const suffix of SUFFIXES)
    if (token.endsWith(suffix) && token.length - suffix.length >= MEMORY_RELEVANCE.minStemLength)
      return token.slice(0, -suffix.length)
  return token
}

export function queryStems(text: string): string[] {
  const stems: string[] = []
  for (const token of searchTokens(text)) {
    if (STOPWORDS.has(token)) continue
    if (token.length < 3 && !/^\d{2,}$/.test(token)) continue
    const stem = stemToken(token)
    if (!stems.includes(stem)) stems.push(stem)
    if (stems.length >= MEMORY_RELEVANCE.maxStems) break
  }
  return stems
}

/** FTS5 prefix query over stems; matches the index's `unicode61 remove_diacritics 2` tokens. */
export function ftsPrefixQuery(stems: readonly string[]): string {
  return stems.map((stem) => `"${stem.replaceAll('"', '""')}"*`).join(' OR ')
}

export interface LexicalMatch {
  relevance: number
  matched: string[]
  titleMatched: number
}

export function inverseDocumentFrequency(total: number, frequency: number): number {
  return Math.log(1 + total / (frequency + 0.5))
}

/**
 * IDF-weighted coverage of the stems the space knows, times a mild penalty for words no memory contains (a long
 * message full of new words is less likely to be about this memory), plus a bonus for a title match.
 */
export function lexicalRelevance(
  stems: readonly string[],
  df: ReadonlyMap<string, number>,
  total: number,
  doc: { title: string; content: string; tags: readonly string[] }
): LexicalMatch {
  const title = searchTokens(doc.title)
  const body = searchTokens(`${doc.content}\n${doc.tags.join(' ')}`)
  let known = 0
  let found = 0
  let unknown = 0
  let titleMatched = 0
  const matched: string[] = []
  for (const stem of stems) {
    const inTitle = title.some((token) => token.startsWith(stem))
    const hit = inTitle || body.some((token) => token.startsWith(stem))
    const frequency = df.get(stem) ?? 0
    if (frequency === 0 && !hit) {
      unknown += 1
      continue
    }
    const weight = inverseDocumentFrequency(total, Math.max(frequency, 1))
    known += weight
    if (hit) {
      found += weight
      matched.push(stem)
    }
    if (inTitle) titleMatched += 1
  }
  if (known === 0 || stems.length === 0) return { relevance: 0, matched, titleMatched }
  const coverage = (found / known) * (1 - MEMORY_RELEVANCE.unknownPenalty * (unknown / stems.length))
  return {
    relevance: Math.min(1, coverage + (titleMatched > 0 ? MEMORY_RELEVANCE.titleBonus : 0)),
    matched,
    titleMatched,
  }
}

/** sqlite-vec returns L2 distances; MiniLM vectors are unit-normalized, so cosine = 1 - d²/2. */
export function cosineFromL2(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - (distance * distance) / 2))
}

export function calibratedVectorRelevance(cosine: number): number {
  return Math.max(0, Math.min(1, (cosine - 0.3) / 0.35))
}

export function passesRecallFloor(match: LexicalMatch, stemCount: number, vector = 0): boolean {
  if (vector >= MEMORY_RELEVANCE.recallMin) return true
  if (match.relevance < MEMORY_RELEVANCE.recallMin) return false
  if (match.matched.length >= 2) return true
  return stemCount === 1 && match.matched.length === 1 && match.titleMatched === 1
}

export function passesSearchFloor(match: LexicalMatch, vector = 0): boolean {
  return (
    vector >= MEMORY_RELEVANCE.searchMin || (match.relevance >= MEMORY_RELEVANCE.searchMin && match.matched.length > 0)
  )
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function memorySnippet(content: string, stems: readonly string[], maxChars: number): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const normalized = normalizeForSearch(flat)
  const positions = stems
    .map((stem) => normalized.search(new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(stem)}`, 'u')))
    .filter((index) => index >= 0)
  const hit = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, Math.min(hit - Math.floor(maxChars / 4), flat.length - maxChars + 2))
  const end = Math.min(flat.length, start + maxChars - 2)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}
