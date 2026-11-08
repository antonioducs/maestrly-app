import { describe, expect, it } from 'vitest'
import { SentenceChunker, toSpeakable } from '../../src/shared/speakable'

describe('toSpeakable', () => {
  it.each([
    ['Veja:\n\n```ts\nconst a = 1\n```\n\nPronto.', 'Veja:\n\n(código no chat)\n\nPronto.'],
    ['```mermaid\nflowchart LR\n  A --> B\n```', '(diagrama no chat)'],
    ['```inline-html\n<div>x</div>\n```', '(diagrama no chat)'],
    ['| a | b |\n|---|:-:|\n| 1 | 2 |\n\nDepois.', '(tabela no chat)\n\nDepois.'],
    ['Leia [a documentação](https://docs.example.com/a_(b)).', 'Leia a documentação.'],
    ['Abra https://example.com/x?y=1. Depois volte.', 'Abra (link no chat). Depois volte.'],
    [
      '## Resumo\n\n- **Feito**: o _login_\n- `npm test` passou\n\n> Nota ~~velha~~ nova',
      'Resumo\n\nFeito: o login\n\nnpm test passou\n\nNota velha nova',
    ],
    ['🎙 Tudo certo 🎉👍🏽 por aqui ✅', 'Tudo certo por aqui'],
    [
      'O erro está em `src/main/index.ts:12` e em apps/desktop/a.b.ts:7.',
      'O erro está em src/main/index.ts:12 e em apps/desktop/a.b.ts:7.',
    ],
  ])('reads %j as %j', (markdown, spoken) => {
    expect(toSpeakable(markdown, 'pt-BR')).toBe(spoken)
  })

  it('speaks the placeholders in English, once for blocks that follow each other', () => {
    expect(toSpeakable('```js\na\n```\n```py\nb\n```\n\nSee https://x.dev', 'en')).toBe(
      '(code in the chat)\n\nSee (link in the chat)'
    )
  })

  it('treats an unclosed fence of a streaming answer as code to its end', () => {
    expect(toSpeakable('Aqui:\n```bash\nnpm i\nnpm t', 'en')).toBe('Aqui:\n\n(code in the chat)')
  })

  it('keeps snake_case and paths as they are', () => {
    expect(toSpeakable('Use my_var_name in file_a.ts', 'en')).toBe('Use my_var_name in file_a.ts')
  })
})

/** Feeds `text` in slices of `size`, cutting words in the middle. */
function chunked(text: string, size: number, chunker = new SentenceChunker()): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(...chunker.push(text.slice(i, i + size)))
  return [...out, ...chunker.flush()]
}

describe('SentenceChunker', () => {
  it('returns whole sentences from deltas cut in the middle of words', () => {
    const text =
      'O build passou sem erros. Os testes também passaram! Quer que eu abra a PR? Posso esperar…\n\nOutro parágrafo sem ponto'
    const expected = [
      'O build passou sem erros.',
      'Os testes também passaram!',
      'Quer que eu abra a PR?',
      'Posso esperar…',
      'Outro parágrafo sem ponto',
    ]
    for (const size of [1, 3, 7, 50]) expect(chunked(text, size)).toEqual(expected)
  })

  it('does not cut at abbreviations, numbers, versions or paths', () => {
    const text =
      'O Dr. Silva e a Sra. Souza revisaram, por ex. o login, etc. e mais. ' +
      'Subiu de 1.5 para v0.33.0 hoje. Mudei apps/a.b.ts e o README.md agora. Use e.g. this one vs. that one now.'
    expect(chunked(text, 4)).toEqual([
      'O Dr. Silva e a Sra. Souza revisaram, por ex. o login, etc. e mais.',
      'Subiu de 1.5 para v0.33.0 hoje.',
      'Mudei apps/a.b.ts e o README.md agora.',
      'Use e.g. this one vs. that one now.',
    ])
  })

  it('waits for what follows the period before closing a sentence', () => {
    const chunker = new SentenceChunker()
    expect(chunker.push('Versão 1.')).toEqual([])
    expect(chunker.push('5 publicada. ')).toEqual(['Versão 1.5 publicada.'])
  })

  it('joins sentences shorter than minChars with the next', () => {
    expect(chunked('Ok. Vou rodar os testes agora. Sim.', 5)).toEqual(['Ok. Vou rodar os testes agora.', 'Sim.'])
  })

  it('cuts a sentence longer than maxChars at the comma nearest the limit', () => {
    const chunker = new SentenceChunker({ maxChars: 40 })
    const sentence = 'Primeiro rodei o build completo, depois os testes de unidade, e por fim o lint.'
    expect(chunked(sentence, 6, chunker)).toEqual([
      'Primeiro rodei o build completo,',
      'depois os testes de unidade,',
      'e por fim o lint.',
    ])
  })

  it('flushes what is left and starts over', () => {
    const chunker = new SentenceChunker()
    expect(chunker.push('Sem ponto final ainda')).toEqual([])
    expect(chunker.flush()).toEqual(['Sem ponto final ainda'])
    expect(chunker.flush()).toEqual([])
  })
})
