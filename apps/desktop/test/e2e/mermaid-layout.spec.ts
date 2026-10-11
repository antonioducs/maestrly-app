import { expect, test } from '@playwright/test'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { createServer, type ViteDevServer } from 'vite'

let server: ViteDevServer
let origin: string

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    optimizeDeps: { entries: ['lib/mermaid.ts'], include: ['mermaid'] },
    root: fileURLToPath(new URL('../../src/renderer', import.meta.url)),
    plugins: [tailwindcss()],
    server: { host: '127.0.0.1', port: 0 },
  })
  server.middlewares.use('/mermaid-test', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<html><head><script type="module">import "/styles.css"</script></head><body></body></html>')
  })
  await server.listen()
  origin = server.resolvedUrls!.local[0]
})

test.afterAll(async () => {
  await server?.close()
})

test('Mermaid labels retain their measured size in chat and zoom', async ({ page }) => {
  await page.goto(`${origin}mermaid-test`)
  await page.waitForFunction(() => getComputedStyle(document.body).fontFamily.includes('SF Pro Text'))
  const results = await page.evaluate(async () => {
    const modulePath = '/lib/mermaid.ts'
    const { renderMermaid } = await import(/* @vite-ignore */ modulePath)
    const html = await renderMermaid(`flowchart TD
      A["1. Generate the PDFs for each type<br/>and publish to the shared drive<br/>evidence/type/municipality/"]
      B["3. hydrate-report-evidence.js<br/>download only the PDF for the<br/>correct date + guide"]
      C["\`**Check every PDF** exists before proceeding with the remaining workflow steps\`"]
      A --> B --> C`)
    const outer = document.createElement('div')
    const inner = document.createElement('div')
    inner.innerHTML = html
    outer.append(inner)
    document.body.append(outer)
    const labels = () =>
      [...inner.querySelectorAll('.node foreignObject')].map((label) => {
        const box = label.getBoundingClientRect()
        const content = label.firstElementChild!.getBoundingClientRect()
        return {
          height: Number(label.getAttribute('height')),
          contentHeight: (content.height / box.height) * Number(label.getAttribute('height')),
          paragraphs: [...label.querySelectorAll('p')].map((p) => ({
            lineHeight: getComputedStyle(p).lineHeight,
            marginTop: getComputedStyle(p).marginTop,
            marginBottom: getComputedStyle(p).marginBottom,
            fontFamily: getComputedStyle(p).fontFamily,
          })),
        }
      })
    const baseline = labels()
    const contexts = []
    for (const className of ['dark-glass-prose', 'dark-glass-prose mermaid-zoom-stage']) {
      for (const fontSize of [12, 22]) {
        outer.className = 'chat-msgs'
        outer.style.setProperty('--chat-font', `${fontSize}px`)
        inner.className = className
        for (const width of [360, 960]) {
          outer.style.width = `${width}px`
          contexts.push({ className, fontSize, width, labels: labels() })
        }
      }
    }
    inner.className = 'dark-glass-prose'
    const prose = document.createElement('p')
    prose.textContent = 'Ordinary chat paragraphs keep the configured line spacing.'
    inner.append(prose)
    const style = getComputedStyle(prose)
    const proseLineHeight = Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize)
    return { baseline, contexts, proseLineHeight }
  })
  expect(results.baseline.length).toBeGreaterThan(0)
  expect(results.proseLineHeight).toBeCloseTo(1.65)
  for (const context of results.contexts) {
    for (const [index, label] of context.labels.entries()) {
      expect(label.paragraphs, JSON.stringify(context)).toEqual(results.baseline[index].paragraphs)
      expect(label.contentHeight).toBeLessThanOrEqual(label.height + 1)
    }
  }
})
