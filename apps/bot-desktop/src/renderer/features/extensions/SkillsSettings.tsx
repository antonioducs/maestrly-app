import { useState } from 'react'
import { Button, Checkbox } from '../../ui'
import { useT } from '../../i18n'
import type { useExtensions } from './useExtensions'

/** Skills of one bot: installed from a folder the person chooses, listed by what the Host stored. */
export function SkillsSettings({ extensions, connected }: { extensions: ReturnType<typeof useExtensions>; connected: boolean }) {
  const t = useT()
  const { state, busy, change } = extensions
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const install = async () => {
    setPicking(true)
    setError('')
    try {
      const folder = await window.bot.pickFolder()
      if (!folder) return
      await change('extension.skill.install', { name: folder.name, files: folder.files })
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPicking(false)
    }
  }
  return (
    <section className="extension-section" aria-label={t('skills')}>
      <h3>{t('skills')}</h3>
      <p className="muted">{t('skillsHelp')}</p>
      <ul className="extension-list">
        {state.skills.map((skill) => (
          <li key={skill.name} className="extension-row">
            <div>
              <strong>{skill.name}</strong>
              <span className="muted"> — {skill.description}</span>
              <small className="muted">
                {' '}
                · {skill.files} {t('skillFiles')} · {Math.ceil(skill.bytes / 1024)} KiB
              </small>
            </div>
            <div className="actions">
              <label className="check">
                <Checkbox
                  aria-label={`${t('enabled')} ${skill.name}`}
                  checked={skill.enabled}
                  disabled={busy || !connected}
                  onChange={(event) => void change('extension.skill.setEnabled', { name: skill.name, enabled: event.target.checked })}
                />
                {t('enabled')}
              </label>
              <Button disabled={busy || !connected} onClick={() => void change('extension.skill.remove', { name: skill.name })}>
                {t('remove')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Button disabled={busy || picking || !connected} onClick={() => void install()}>
        {t('installSkill')}
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
