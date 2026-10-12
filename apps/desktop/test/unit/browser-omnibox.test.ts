import { describe, expect, it } from 'vitest'
import {
  browserHistoryKey,
  buildOmniboxSuggestions,
  classifyBrowserInput,
  displayUrl,
  inlineCompletionFor,
  isSearchSuggestEligible,
  matchesTypedAddress,
  normalizeBrowserInput,
  omniboxFillText,
  scoreHistoryEntry,
  searchQueryFromUrl,
  type OmniboxHistoryItem,
} from '../../src/shared/browser-omnibox'

const NOW = Date.UTC(2026, 9, 12, 12)
const DAY = 86_400_000

function entry(url: string, overrides: Partial<OmniboxHistoryItem> = {}): OmniboxHistoryItem {
  return { url, title: '', visitCount: 1, typedCount: 0, lastVisitAt: NOW - DAY, ...overrides }
}

describe('classifyBrowserInput', () => {
  it('keeps explicit schemes and adds https to host-looking text', () => {
    expect(classifyBrowserInput('https://example.com/a')).toEqual({ kind: 'url', url: 'https://example.com/a' })
    expect(classifyBrowserInput('about:blank')).toEqual({ kind: 'url', url: 'about:blank' })
    expect(classifyBrowserInput('  example.com/docs ')).toEqual({ kind: 'url', url: 'https://example.com/docs' })
  })

  it('opens local development hosts over http instead of searching them', () => {
    expect(normalizeBrowserInput('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeBrowserInput('localhost')).toBe('http://localhost')
    expect(normalizeBrowserInput('127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health')
    expect(normalizeBrowserInput('app.localhost:5173')).toBe('http://app.localhost:5173')
  })

  it('searches Google for anything else', () => {
    expect(classifyBrowserInput('olivia rodrigo')).toEqual({
      kind: 'search',
      url: 'https://www.google.com/search?q=olivia%20rodrigo',
    })
    expect(classifyBrowserInput('you').kind).toBe('search')
  })
})

describe('address helpers', () => {
  it('keys history by web URL without the fragment', () => {
    expect(browserHistoryKey('https://Example.com/a#section')).toBe('https://example.com/a')
    expect(browserHistoryKey('file:///etc/hosts')).toBeNull()
    expect(browserHistoryKey('about:blank')).toBeNull()
    expect(browserHistoryKey('not a url')).toBeNull()
  })

  it('reads queries only from Google results pages', () => {
    expect(searchQueryFromUrl('https://www.google.com/search?q=olivia+rodrigo&sca_esv=1')).toBe('olivia rodrigo')
    expect(searchQueryFromUrl('https://www.google.com.br/search?q=chuva')).toBe('chuva')
    expect(searchQueryFromUrl('https://www.google.com/maps?q=x')).toBeNull()
    expect(searchQueryFromUrl('https://evil.example/search?q=x')).toBeNull()
    expect(searchQueryFromUrl('https://www.google.com/search?q=')).toBeNull()
  })

  it('shows compact addresses', () => {
    expect(displayUrl('https://www.youtube.com/')).toBe('youtube.com')
    expect(displayUrl('http://localhost:3000/a?b=1')).toBe('localhost:3000/a?b=1')
    expect(displayUrl('https://pt.wikipedia.org/wiki/S%C3%A3o_Paulo')).toBe('pt.wikipedia.org/wiki/São_Paulo')
    expect(displayUrl('about:blank')).toBe('about:blank')
  })

  it('never sends URLs, local hosts, or IPs to the suggestion service', () => {
    expect(isSearchSuggestEligible('olivia')).toBe(true)
    expect(isSearchSuggestEligible('github.com')).toBe(true)
    expect(isSearchSuggestEligible('https://intranet.example/secret')).toBe(false)
    expect(isSearchSuggestEligible('localhost:3000')).toBe(false)
    expect(isSearchSuggestEligible('10.0.0.5:8080/admin')).toBe(false)
    expect(isSearchSuggestEligible('   ')).toBe(false)
    expect(isSearchSuggestEligible('x'.repeat(201))).toBe(false)
  })
})

describe('scoreHistoryEntry', () => {
  it('ranks host prefixes above word starts above substrings', () => {
    const host = scoreHistoryEntry('git', entry('https://github.com/'), NOW)
    const word = scoreHistoryEntry('git', entry('https://docs.example.com/', { title: 'Git basics' }), NOW)
    const substring = scoreHistoryEntry('git', entry('https://example.com/', { title: 'Digital' }), NOW)
    expect(host).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(0)
  })

  it('requires every word to match and accepts only prefixes for very short input', () => {
    expect(scoreHistoryEntry('react docs', entry('https://react.dev/', { title: 'React docs' }), NOW)).toBeGreaterThan(0)
    expect(scoreHistoryEntry('react vue', entry('https://react.dev/', { title: 'React docs' }), NOW)).toBe(0)
    expect(scoreHistoryEntry('ub', entry('https://www.youtube.com/'), NOW)).toBe(0)
    expect(scoreHistoryEntry('yo', entry('https://www.youtube.com/'), NOW)).toBeGreaterThan(0)
  })

  it('weighs typed, frequent, and recent visits higher', () => {
    const base = entry('https://example.com/a')
    const typed = scoreHistoryEntry('example', { ...base, typedCount: 2 }, NOW)
    const plain = scoreHistoryEntry('example', base, NOW)
    const old = scoreHistoryEntry('example', { ...base, lastVisitAt: NOW - 200 * DAY }, NOW)
    expect(typed).toBeGreaterThan(plain)
    expect(plain).toBeGreaterThan(old)
  })

  it('matches a site root typed with its trailing slash', () => {
    expect(scoreHistoryEntry('127.0.0.1:5173/', entry('http://127.0.0.1:5173/'), NOW)).toBeGreaterThan(0)
    expect(scoreHistoryEntry('youtube.com/', entry('https://www.youtube.com/'), NOW)).toBeGreaterThan(0)
    expect(scoreHistoryEntry('youtube.com/x', entry('https://www.youtube.com/'), NOW)).toBe(0)
  })

  it('matches searches by their query, ignoring accents', () => {
    const search = entry('https://www.google.com/search?q=S%C3%A3o+Paulo+clima')
    expect(scoreHistoryEntry('sao paulo', search, NOW)).toBeGreaterThan(0)
    expect(scoreHistoryEntry('google', search, NOW)).toBe(0)
  })
})

describe('matchesTypedAddress', () => {
  it('ignores scheme, case, www, and a root trailing slash', () => {
    expect(matchesTypedAddress('YouTube.com', 'https://www.youtube.com/watch?v=1')).toBe(true)
    expect(matchesTypedAddress('youtube.com/', 'https://www.youtube.com/')).toBe(true)
    expect(matchesTypedAddress('www.youtube.com/', 'https://www.youtube.com/')).toBe(true)
    expect(matchesTypedAddress('youtube.com/watch?v=1', 'https://www.youtube.com/watch?v=1')).toBe(true)
    expect(matchesTypedAddress('youtube.com/', 'https://www.youtube.com/watch?v=1')).toBe(false)
    expect(matchesTypedAddress('youtube.co', 'https://www.youtube.com/')).toBe(false)
    expect(matchesTypedAddress('', 'https://www.youtube.com/')).toBe(false)
  })
})

describe('inlineCompletionFor', () => {
  const history = [
    entry('https://www.youtube.com/watch?v=1', { visitCount: 3, title: 'Video' }),
    entry('https://www.youtube.com/', { visitCount: 2, typedCount: 1, title: 'YouTube' }),
    entry('https://yourbank.example/', { visitCount: 1 }),
  ]

  it('completes the most used host and keeps the typed case', () => {
    expect(inlineCompletionFor('You', history, NOW)).toEqual({
      text: 'Youtube.com',
      url: 'https://www.youtube.com/',
      title: 'YouTube',
    })
  })

  it('ignores single stray visits, searches, and text with spaces', () => {
    expect(inlineCompletionFor('yourb', history, NOW)).toBeNull()
    expect(inlineCompletionFor('you tube', history, NOW)).toBeNull()
    expect(
      inlineCompletionFor('goo', [entry('https://www.google.com/search?q=x', { visitCount: 9 })], NOW)
    ).toBeNull()
  })

  it('never completes past an address that was visited exactly as typed', () => {
    const visited = [
      entry('http://127.0.0.1:5173/', { visitCount: 1 }),
      entry('http://127.0.0.1:5173/second', { visitCount: 5, typedCount: 2 }),
      entry('https://youtube.com.br/', { visitCount: 5 }),
      entry('https://youtube.com/', { visitCount: 1 }),
    ]
    expect(inlineCompletionFor('127.0.0.1:5173/', visited, NOW)).toBeNull()
    expect(inlineCompletionFor('127.0.0.1:5173/s', visited, NOW)?.text).toBe('127.0.0.1:5173/second')
    expect(inlineCompletionFor('youtube.com', visited, NOW)).toBeNull()
  })

  it('completes full addresses once the text has a path, and the www form when typed', () => {
    expect(inlineCompletionFor('youtube.com/wa', history, NOW)?.text).toBe('youtube.com/watch?v=1')
    expect(inlineCompletionFor('www.you', history, NOW)?.text).toBe('www.youtube.com')
    expect(inlineCompletionFor('youtube.com', history, NOW)).toBeNull()
  })
})

describe('buildOmniboxSuggestions', () => {
  const tabs = [
    { id: 'active', url: 'https://github.com/a', title: 'GitHub A' },
    { id: 'other', url: 'https://github.com/b', title: 'GitHub B' },
  ]

  it('orders typed text, open tabs, history, and suggestions without duplicates', () => {
    const result = buildOmniboxSuggestions({
      input: 'git',
      history: [
        entry('https://github.com/b', { title: 'GitHub B', visitCount: 5 }),
        entry('https://gitlab.com/', { title: 'GitLab', visitCount: 2 }),
        entry('https://www.google.com/search?q=git+rebase'),
      ],
      tabs,
      activeTabId: 'active',
      searchSuggestions: ['git rebase', 'git', 'github copilot'],
      now: NOW,
    })
    expect(result.inlineCompletion).toBeNull()
    expect(result.suggestions.map((row) => row.id)).toEqual([
      'input',
      'tab:other',
      'history:https://gitlab.com/',
      'history:https://www.google.com/search?q=git+rebase',
      'suggest:github copilot',
    ])
    expect(result.suggestions[0]).toMatchObject({ kind: 'search', query: 'git', source: 'input' })
  })

  it('opens URL-looking text directly', () => {
    const result = buildOmniboxSuggestions({
      input: 'localhost:5173',
      history: [],
      tabs: [],
      searchSuggestions: [],
      now: NOW,
    })
    expect(result.suggestions).toEqual([
      { kind: 'url', id: 'input', url: 'http://localhost:5173', title: '', source: 'input', removable: false },
    ])
  })

  it('makes the inline completion the default row and keeps the typed search available', () => {
    const result = buildOmniboxSuggestions({
      input: 'you',
      history: [entry('https://www.youtube.com/', { visitCount: 4, title: 'YouTube' })],
      tabs: [],
      searchSuggestions: ['youtube music'],
      now: NOW,
      allowInline: true,
    })
    expect(result.inlineCompletion).toBe('youtube.com')
    expect(result.suggestions.map((row) => row.id)).toEqual(['input', 'suggest:you', 'suggest:youtube music'])
    expect(result.suggestions[0]).toMatchObject({ kind: 'url', url: 'https://www.youtube.com/', title: 'YouTube' })
  })

  it('caps rows at the limit and leaves room for search suggestions', () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      entry(`https://example${index}.com/`, { title: `Example ${index}`, visitCount: 12 - index })
    )
    const result = buildOmniboxSuggestions({
      input: 'example',
      history,
      tabs: [],
      searchSuggestions: ['example one', 'example two', 'example three', 'example four', 'example five'],
      now: NOW,
    })
    expect(result.suggestions).toHaveLength(8)
    expect(result.suggestions.filter((row) => row.kind === 'search' && row.source === 'suggest')).toHaveLength(4)
    expect(buildOmniboxSuggestions({ input: '  ', history, tabs: [], searchSuggestions: [], now: NOW })).toEqual({
      suggestions: [],
      inlineCompletion: null,
    })
  })

  it('fills the address bar with the selected row', () => {
    const { suggestions } = buildOmniboxSuggestions({
      input: 'git',
      history: [entry('https://gitlab.com/', { title: 'GitLab' })],
      tabs: [],
      searchSuggestions: ['github'],
      now: NOW,
    })
    expect(suggestions.map(omniboxFillText)).toEqual(['git', 'gitlab.com', 'github'])
  })
})
