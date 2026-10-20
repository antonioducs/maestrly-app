import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { releaseNotesToText } from '../../src/shared/release-notes'

// The shape electron-updater's GitHub provider hands over for a release: the Atom feed's HTML body.
const GITHUB_NOTES =
  '<h2>What&#39;s Changed</h2>\n' +
  '<ul>\n' +
  '<li>fix(chat): keep the draft when switching conversations by <a class="user-mention notranslate" data-hovercard-type="user" data-hovercard-url="/users/antonioducs/hovercard" data-octo-click="hovercard-link-click" data-octo-dimensions="link_type:self" href="https://github.com/antonioducs">@antonioducs</a> in <a class="issue-link js-issue-link" data-error-text="Failed to load title" data-id="123" data-permission-text="Title is private" data-url="https://github.com/antonioducs/maestrly-app/issues/263" data-hovercard-type="pull_request" data-hovercard-url="/antonioducs/maestrly-app/pull/263/hovercard" href="https://github.com/antonioducs/maestrly-app/pull/263">#263</a></li>\n' +
  '<li>feat(desktop): add Gemini harness profiles &amp; project context by <a class="user-mention notranslate" href="https://github.com/antonioducs">@antonioducs</a> in <a class="issue-link js-issue-link" href="https://github.com/antonioducs/maestrly-app/pull/273">#273</a></li>\n' +
  '</ul>\n' +
  '<p><strong>Full Changelog</strong>: <a href="https://github.com/antonioducs/maestrly-app/compare/v0.22.0...v0.23.0">v0.22.0...v0.23.0</a></p>'

describe('releaseNotesToText', () => {
  it('turns a GitHub release body into readable lines without tags or attributes', () => {
    expect(releaseNotesToText(GITHUB_NOTES)).toBe(
      [
        "What's Changed",
        '• fix(chat): keep the draft when switching conversations by @antonioducs in #263',
        '• feat(desktop): add Gemini harness profiles & project context by @antonioducs in #273',
        '',
        'Full Changelog: v0.22.0...v0.23.0',
      ].join('\n')
    )
  })

  it('shows no markup or attributes from the real fragment', () => {
    const text = releaseNotesToText(GITHUB_NOTES)
    expect(text).not.toMatch(/<|>|class=|href=|data-|&amp;|&#39;/)
  })

  it('breaks lines on <br>, </p>, headings and list items, and bullets list items', () => {
    expect(releaseNotesToText('<h1>One</h1><p>Two<br>three<br/>four</p><ol><li>five</li><li>six</li></ol>')).toBe(
      'One\nTwo\nthree\nfour\n• five\n• six'
    )
  })

  it('decodes named and numeric entities once, and never turns decoded text back into markup', () => {
    expect(releaseNotesToText('a &amp; b &lt; c &gt; d &quot;e&quot; f&#39;s &#x27;g&#x27; &#8212; h&nbsp;i')).toBe(
      "a & b < c > d \"e\" f's 'g' — h i"
    )
    expect(releaseNotesToText('&lt;b&gt;bold&lt;/b&gt; and &amp;lt;')).toBe('<b>bold</b> and &lt;')
    expect(releaseNotesToText('bad &#99999999; &#xD800; &unknown; entities')).toBe(
      'bad &#99999999; &#xD800; &unknown; entities'
    )
  })

  it('collapses runs of spaces, drops source formatting around blocks, keeps at most one blank line and trims the ends', () => {
    expect(releaseNotesToText('\n  <p>  one   two  </p>\n\n\n\n<p>three</p>  \n')).toBe('one two\nthree')
    expect(releaseNotesToText('a<br><br><br><br>b  <br> c')).toBe('a\n\nb\nc')
  })

  it('keeps tags inside quoted attributes from ending the tag early', () => {
    expect(releaseNotesToText('<a title="a > b" href="x">link</a> text')).toBe('link text')
  })

  it('leaves plain text exactly as it came, including comparisons, indentation and autolinks', () => {
    const plain = 'Fixes\n\n- faster when x < y and y > z\n  - nested item\n- see <https://example.com/notes>\n\n\nDone'
    expect(releaseNotesToText(plain)).toBe(plain)
    expect(releaseNotesToText('Fixture release notes')).toBe('Fixture release notes')
    expect(releaseNotesToText('')).toBe('')
  })
})

describe('Settings → Updates release notes', () => {
  it('shows the converted text and never renders remote HTML', () => {
    const section = readFileSync(
      new URL('../../src/renderer/components/settings/UpdatesSection.tsx', import.meta.url),
      'utf8'
    )
    expect(section).toContain('releaseNotesToText(state.releaseNotes)')
    expect(section).not.toContain('dangerouslySetInnerHTML')
  })
})
