import { describe, expect, it } from 'vitest'
import { imageLabel, interfaceLink, safeLink } from '../src/ui/links'

describe('links in replies', () => {
  it('opens only web pages and email', () => {
    expect(safeLink('https://example.dev/a?b=1#c')).toBe('https://example.dev/a?b=1#c')
    expect(safeLink(' http://example.dev ')).toBe('http://example.dev/')
    expect(safeLink('mailto:team@example.dev')).toBe('mailto:team@example.dev')
    for (const href of [
      'maestrly://pair?server=https://evil.example&code=ABCD-EFGH',
      'tel:+15550100',
      'sms:+15550100',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,hi',
      '/relative/path',
      'https://user:secret@example.dev',
      '',
    ])
      expect(safeLink(href)).toBeNull()
  })

  it('names an image by its description, else by its host', () => {
    expect(imageLabel('https://cdn.example.dev/a.png', 'Chart')).toBe('Chart')
    expect(imageLabel('https://cdn.example.dev/a.png', '', 'Title')).toBe('Title')
    expect(imageLabel('https://cdn.example.dev/a.png')).toBe('cdn.example.dev')
    expect(imageLabel('not a url')).toBe('not a url')
  })

  it('opens from an interactive answer only plain web addresses, naming the host they really reach', () => {
    expect(interfaceLink('https://example.com/pricing?plan=team#faq')).toEqual({
      url: 'https://example.com/pricing?plan=team#faq',
      host: 'example.com',
    })
    expect(interfaceLink('http://Docs.Example.com:8080')).toEqual({
      url: 'http://Docs.Example.com:8080',
      host: 'docs.example.com:8080',
    })
    // React Native's URL reads these hosts differently from a browser, so the phone refuses them outright.
    for (const url of [
      'https://evil.example?@good.example/',
      'https://good.example#@evil.example',
      'https://user:pass@example.com/',
      'https://evil.example\\.good.example/',
      'https://exa mple.com/',
      'javascript:alert(1)',
      'maestrly://chat/c1',
      'tel:+15550100',
      'https://',
    ])
      expect(interfaceLink(url)).toBeNull()
  })
})
