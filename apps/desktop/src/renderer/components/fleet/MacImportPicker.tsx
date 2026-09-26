import { useTranslation } from 'react-i18next'
import type { MacInventory } from '../../../shared/fleet-provisioning'
import { Button } from '@/components/ui/button'
import { choiceClass } from '@/lib/fleet/choice'
import {
  accountHost,
  importGroups,
  type BotProvisioning,
  type ImportChoice,
  type ImportGroup,
} from '@/lib/fleet/provisioning'
import { ChoiceMark } from './ChoiceMark'

export function MacImportPicker({
  inventory,
  value,
  onChange,
  groups = importGroups,
  lists,
}: {
  inventory: MacInventory
  value: ImportChoice
  onChange: (value: ImportChoice) => void
  groups?: ImportGroup[]
  lists?: Pick<BotProvisioning, 'accounts' | 'skills' | 'mcpServers'>
}) {
  const { t, i18n } = useTranslation('fleet')
  type Item = {
    id: string
    field: keyof ImportChoice
    name: string
    detail: string
    warnings: string[]
    disabled?: boolean
    already?: boolean
  }
  const items: Record<ImportGroup, Item[]> = {
    accounts: [
      ...inventory.apiKeys.map(
        (item): Item => ({
          id: item.id,
          field: 'apiKeyIds',
          name: item.name,
          detail: item.host,
          warnings: item.localOnly ? [t('provisioning.warning.localOnly')] : [],
          already: lists?.accounts?.apiKeys.some(
            (key) =>
              key.name === item.name && key.kind === item.kind && accountHost(key.kind, key.baseURL) === item.host
          ),
        })
      ),
      ...inventory.copies.map(
        (item): Item => ({
          id: item.id,
          field: 'copyIds',
          name: item.label,
          detail: [
            t('provisioning.copyNote'),
            item.expiresAt
              ? t('provisioning.expires', { date: new Date(item.expiresAt).toLocaleDateString(i18n.language) })
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
          warnings: [],
        })
      ),
      ...inventory.logins.map(
        (item): Item => ({
          id: item.id,
          field: 'loginIds',
          name: item.label,
          detail: [t('provisioning.signInOnBot'), item.email ? t('provisioning.signInAs', { email: item.email }) : '']
            .filter(Boolean)
            .join(' · '),
          warnings: [],
        })
      ),
    ],
    skills: inventory.skills.map((item) => ({
      id: item.name,
      field: 'skillNames',
      name: item.name,
      detail: [
        item.description,
        t('provisioning.files', { count: item.files }),
        item.scripts ? t('provisioning.hasScripts') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      disabled: !!item.problem,
      warnings: item.problem ? [t(`provisioning.warning.${item.problem}`)] : [],
      already: lists?.skills?.some((skill) => skill.name === item.name),
    })),
    mcp: inventory.mcpServers.map((item) => ({
      id: item.id,
      field: 'mcpServerIds',
      name: item.name,
      detail: item.target,
      warnings: item.warnings.map((warning) => t(`provisioning.warning.${warning}`)),
      already: lists?.mcpServers?.some((server) => server.name === item.name),
    })),
  }
  function selectGroup(group: ImportGroup, selected: boolean) {
    const next = { ...value }
    for (const item of items[group]) {
      const ids = next[item.field].filter((id) => id !== item.id)
      next[item.field] = selected && !item.disabled ? [...ids, item.id] : ids
    }
    onChange(next)
  }
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <fieldset key={group} className="space-y-2">
          <legend className="text-sm font-semibold">{t(`provisioning.groups.${group}`)}</legend>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => selectGroup(group, true)}>
              {t('provisioning.selectAll')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => selectGroup(group, false)}>
              {t('provisioning.clear')}
            </Button>
          </div>
          {!items[group].length && <p className="text-xs text-muted-foreground">{t('provisioning.nothing')}</p>}
          {items[group].map((item) => {
            const selected = value[item.field].includes(item.id)
            return (
              <label
                key={`${item.field}:${item.id}`}
                className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${choiceClass(selected)} ${item.disabled ? 'opacity-60' : 'cursor-pointer'}`}
              >
                <input
                  type="checkbox"
                  aria-label={item.name}
                  disabled={item.disabled}
                  checked={selected}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      [item.field]: event.target.checked
                        ? [...value[item.field], item.id]
                        : value[item.field].filter((id) => id !== item.id),
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{item.name}</span>
                  {item.already && (
                    <span className="ml-2 rounded border border-border px-1 text-xs">
                      {t('provisioning.alreadyOnBot')}
                    </span>
                  )}
                  <span className="block break-words text-xs text-muted-foreground">{item.detail}</span>
                  {item.warnings.map((warning) => (
                    <span key={warning} className="block text-xs text-muted-foreground">
                      {warning}
                    </span>
                  ))}
                </span>
                <ChoiceMark selected={selected} />
              </label>
            )
          })}
        </fieldset>
      ))}
    </div>
  )
}
