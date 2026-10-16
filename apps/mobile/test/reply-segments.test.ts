import { describe, expect, it } from 'vitest'
import { replySegments } from '../src/ui/conversation/reply-segments'

describe('reply segments', () => {
  it('keeps a reply without interfaces as one piece of Markdown', () => {
    expect(replySegments('Plain **reply**.')).toEqual([{ kind: 'markdown', text: 'Plain **reply**.' }])
  })

  it('takes each interface out of the Markdown around it, in order', () => {
    const text = [
      'Here is the chart:',
      '',
      '```inline-html',
      '<canvas id="c"></canvas>',
      '<script>draw()</script>',
      '```',
      '',
      'And a second one:',
      '~~~~inline-html',
      '<p>Two</p>',
      '~~~~',
    ].join('\n')
    expect(replySegments(text)).toEqual([
      { kind: 'markdown', text: 'Here is the chart:\n' },
      { kind: 'interface', html: '<canvas id="c"></canvas>\n<script>draw()</script>', complete: true },
      { kind: 'markdown', text: '\nAnd a second one:' },
      { kind: 'interface', html: '<p>Two</p>', complete: true },
    ])
  })

  it('shows an interface still being written as incomplete', () => {
    expect(replySegments('Building it:\n```inline-html\n<div>')).toEqual([
      { kind: 'markdown', text: 'Building it:' },
      { kind: 'interface', html: '<div>', complete: false },
    ])
  })

  it('leaves a fence inside another code block, and other languages, as Markdown', () => {
    const quoted = '````markdown\n```inline-html\n<p>x</p>\n```\n````'
    expect(replySegments(quoted)).toEqual([{ kind: 'markdown', text: quoted }])
    const html = 'Source:\n```html\n<p>inline-html</p>\n```'
    expect(replySegments(html)).toEqual([{ kind: 'markdown', text: html }])
  })

  it('needs a closing fence of the same kind and at least the same length', () => {
    expect(replySegments('````inline-html\n<p>a</p>\n```\n<p>b</p>\n````')).toEqual([
      { kind: 'interface', html: '<p>a</p>\n```\n<p>b</p>', complete: true },
    ])
  })
})
