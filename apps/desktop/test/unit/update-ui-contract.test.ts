import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import en from '../../src/shared/i18n/en/ui'
import ptBR from '../../src/shared/i18n/pt-BR/ui'

const source = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

describe('update UI contract', () => {
  it('translates every update key in both languages', () => {
    const keys = (o: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v ? keys(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]
      )
    expect(keys(en.update as Record<string, unknown>).sort()).toEqual(
      keys(ptBR.update as Record<string, unknown>).sort()
    )
    expect(en.settings.nav).toHaveProperty('updates')
    expect(ptBR.settings.nav).toHaveProperty('updates')
  })
  it('renders the card only in actionable phases and never auto-downloads', () => {
    const card = source('src/renderer/components/sidebar/UpdateCard.tsx')
    expect(card).toContain("phase !== 'available' && phase !== 'downloading' && phase !== 'downloaded'")
    expect(card).toContain("t('update.card.download')")
    expect(card).toContain("t('update.card.restart')")
    expect(card).toContain("t('update.card.skip')")
    expect(card).toContain("mode === 'notify'")
    expect(card).not.toContain('useEffect(() => { void download()')
    const footer = source('src/renderer/components/sidebar/SidebarFooter.tsx')
    expect(footer).toContain('<UpdateCard />')
  })
  it('exposes the settings section and provider', () => {
    expect(source('src/renderer/components/settings/nav.tsx')).toContain("labelKey: 'settings.nav.updates'")
    expect(source('src/renderer/components/SettingsView.tsx')).toContain(
      "section === 'updates' && <UpdatesSection t={t} />"
    )
    expect(source('src/renderer/DesktopApp.tsx')).toContain('<UpdateProvider>')
    const section = source('src/renderer/components/settings/UpdatesSection.tsx')
    expect(section).toContain('check(true)')
    expect(section).toContain("t('update.settings.modeNotify')")
  })
})
