import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { ChatUiProvider, QuickUsageTargets, UsagePanel, usagePeriodRange, type UsagePanelRow } from '../src'
import { labels } from './labels'

function Wrap({ children }: { children: ReactNode }) {
  return <ChatUiProvider value={{ labels, openExternal: () => {}, locale: 'en' }}>{children}</ChatUiProvider>
}
const rows: UsagePanelRow[] = [
  { key: 'a', modelId: 'gpt-5', sub: 'OpenAI · 3 turns', turns: 3, input: 300_000, output: 20_000, cacheRead: 100_000, cacheCreate: 0, cost: 1.5 },
  { key: 'b', modelId: 'mystery', turns: 1, input: 1000, output: 10, cacheRead: 0, cacheCreate: 0, cost: null },
]
const base = { period: '30d' as const, onPeriodChange: () => {}, custom: { from: '', to: '' }, onCustomChange: () => {}, minCustomDay: '2026-06-01', onRefresh: () => {} }

describe('UsagePanel', () => {
  it('lays out the rows the caller priced, with a total that names what it could not price', () => {
    const html = renderToStaticMarkup(<Wrap><UsagePanel {...base} rows={rows} turns={4} loading={false} /></Wrap>)
    expect(html).toContain('data-usage-row="gpt-5"')
    expect(html).toContain('OpenAI · 3 turns')
    expect(html).toContain('~$1.50')
    // The unpriced model shows a dash and the note the caller injected, and is left out of the total.
    expect(html).toContain(labels.usage.noPricing)
    expect(html).toContain(labels.usage.unpriced(1))
    expect(html).toContain('420k') // 300k + 20k + 100k on the first row
    expect(html).toContain('>4<') // turns come from the ledger count, not the row count
    expect(html).toContain('aria-pressed="true"')
  })
  it('shows the loading and the empty state without rows', () => {
    expect(renderToStaticMarkup(<Wrap><UsagePanel {...base} rows={[]} turns={0} loading /></Wrap>)).toContain(labels.usage.loading)
    expect(renderToStaticMarkup(<Wrap><UsagePanel {...base} rows={[]} turns={0} loading={false} /></Wrap>)).toContain(labels.usage.empty)
  })
  it('opens the two date fields only for a custom period', () => {
    expect(renderToStaticMarkup(<Wrap><UsagePanel {...base} period="custom" rows={[]} turns={0} loading={false} /></Wrap>)).toContain('type="date"')
    expect(renderToStaticMarkup(<Wrap><UsagePanel {...base} rows={[]} turns={0} loading={false} /></Wrap>)).not.toContain('type="date"')
  })
  it('turns a period into a window bounded by the ledger', () => {
    const now = Date.UTC(2026, 8, 17, 12)
    expect(usagePeriodRange('7d', { from: '', to: '' }, 90, now)).toEqual({ since: now - 7 * 86_400_000 })
    expect(usagePeriodRange('90d', { from: '', to: '' }, 90, now)).toEqual({ since: now - 90 * 86_400_000 })
    const custom = usagePeriodRange('custom', { from: '2026-09-01', to: '2026-09-02' }, 90, now)
    expect(custom.since).toBe(new Date('2026-09-01T00:00:00').getTime())
    expect(custom.until).toBe(new Date('2026-09-02T23:59:59.999').getTime())
    expect(usagePeriodRange('custom', { from: '', to: '' }, 90, now)).toEqual({ since: undefined, until: undefined })
  })
})

describe('QuickUsageTargets', () => {
  it('renders one section per target with the attributes an application asked for', () => {
    const html = renderToStaticMarkup(
      <Wrap>
        <QuickUsageTargets
          targets={[
            { key: 'a', label: 'ChatGPT', accountLabel: 'ana@example.test', data: { 'quick-usage-provider': 'codex-subscription' } },
            { key: 'b', label: 'Bot Ana (ana@example.test)', accountLabel: 'ana@example.test' },
          ]}
          render={(target) => <span>body of {target.key}</span>}
        />
      </Wrap>
    )
    expect(html).toContain('data-testid="quick-usage-list"')
    expect(html).toContain('data-quick-usage-provider="codex-subscription"')
    expect(html).toContain('body of a')
    // The account line appears only when the label does not already carry it.
    expect(html.match(/ana@example\.test/g)).toHaveLength(2)
  })
})
