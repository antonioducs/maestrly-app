interface SearchMatchCollection<T> {
  readonly length: number
  readonly [index: number]: T
}

interface SearchScrollTarget {
  scrollIntoView(options: { block: 'center'; behavior: 'auto' }): void
}

export function scrollChatSearchResult<T extends SearchScrollTarget>(
  currentMatches: SearchMatchCollection<T>,
  matches: SearchMatchCollection<T>,
  fallback: T,
  isRevealed: (match: T) => boolean
): T {
  let target: T | undefined
  for (let i = 0; i < currentMatches.length; i++) {
    const match = currentMatches[i]
    if (isRevealed(match)) {
      target = match
      break
    }
  }
  if (!target) {
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]
      if (isRevealed(match)) {
        target = match
        break
      }
    }
  }
  target ??= fallback
  target.scrollIntoView({ block: 'center', behavior: 'auto' })
  return target
}
