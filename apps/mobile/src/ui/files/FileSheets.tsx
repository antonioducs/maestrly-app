import type { FleetBot, FleetFilesUsage, FleetPublishedFile } from '@maestrly/bot-fleet-protocol'
import { ScrollView } from 'react-native'
import { FILE_QUOTA_OPTIONS_GB, FILE_SORTS, formatSpace, quotaChoice, type FileSort } from '../../fleet/files'
import { formatWhen } from '../../fleet/format'
import { useI18n } from '../../i18n'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { Sheet } from '../primitives/Sheet'
import { AppText } from '../primitives/Text'

/** iOS presents nothing over a sheet that is still closing: an action waits for it, as the run actions do. */
const AFTER_CLOSE_MS = 350

/** Where the bot shared a file, as its actions and its row say it. */
export function fileWhere(file: FleetPublishedFile, t: ReturnType<typeof useI18n>['t']): string {
  const origin = file.origin
  const place =
    origin.kind === 'primary'
      ? t('files.where.primary')
      : origin.kind === 'routine'
        ? t('files.origin.routine', { title: origin.title })
        : origin.kind === 'thread'
          ? t('files.origin.thread', { title: origin.title })
          : t('files.origin.unknown')
  return file.originGone ? `${place} · ${t('files.origin.gone')}` : place
}

/** What can be done with one file: download it, show it where it was shared, or delete it. */
export function FileActionsSheet({
  file,
  open,
  now,
  onClose,
  onDownload,
  onShow,
  onDelete,
}: {
  file: FleetPublishedFile | null
  open: boolean
  now: number
  onClose: () => void
  onDownload: (file: FleetPublishedFile) => void
  onShow: (file: FleetPublishedFile) => void
  onDelete: (file: FleetPublishedFile) => void
}) {
  const { t, locale } = useI18n()
  if (!file) return null
  const later = (run: (file: FleetPublishedFile) => void) => () => {
    onClose()
    setTimeout(() => run(file), AFTER_CLOSE_MS)
  }
  const origin = file.origin
  return (
    <Sheet open={open} title={file.name} onClose={onClose}>
      <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4, marginTop: -6 }}>
        {[formatSpace(file.byteSize, locale), formatWhen(file.sharedAt, locale, now), fileWhere(file, t)].join(' · ')}
      </AppText>
      <Group>
        <Cell icon="arrow-down" label={t('files.download')} onPress={later(onDownload)} />
        {origin.kind === 'primary' ? (
          <Cell icon="message" label={t('files.actions.show')} onPress={later(onShow)} />
        ) : null}
        {origin.kind === 'routine' && !file.originGone ? (
          <Cell icon="history" label={t('files.actions.openRun')} onPress={later(onShow)} />
        ) : null}
        {origin.kind === 'thread' && !file.originGone ? (
          <Cell icon="swap" label={t('files.actions.openThread')} onPress={later(onShow)} />
        ) : null}
      </Group>
      <Group>
        <Cell icon="trash" tone="brick" label={t('files.delete')} onPress={later(onDelete)} />
      </Group>
    </Sheet>
  )
}

/** The order of the Files sheet's list. */
export function SortSheet({
  open,
  value,
  onChange,
  onClose,
}: {
  open: boolean
  value: FileSort
  onChange: (sort: FileSort) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <Sheet open={open} title={t('files.sort.label')} onClose={onClose}>
      <Group>
        {FILE_SORTS.map((sort) => (
          <Cell
            key={sort}
            role="radio"
            label={t(`files.sort.${sort}`)}
            checked={sort === value}
            onPress={() => {
              onChange(sort)
              onClose()
            }}
          />
        ))}
      </Group>
    </Sheet>
  )
}

/** How much the bot can keep: never less than its files take, nor more than the bot server has free. */
export function QuotaSheet({
  open,
  bot,
  usage,
  diskFreeBytes,
  onChoose,
  onClose,
}: {
  open: boolean
  bot: FleetBot
  usage: FleetFilesUsage
  diskFreeBytes: number | null
  onChoose: (gb: number) => void
  onClose: () => void
}) {
  const { t, locale } = useI18n()
  return (
    <Sheet open={open} title={t('files.limits.quota')} onClose={onClose}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: 8 }}>
        <AppText variant="sub" tone="muted" style={{ marginHorizontal: 4, marginTop: -6 }}>
          {t('files.limits.quotaSub', { name: bot.name })}
        </AppText>
        <Group
          foot={
            diskFreeBytes === null ? undefined : t('files.limits.disk', { size: formatSpace(diskFreeBytes, locale) })
          }
        >
          {FILE_QUOTA_OPTIONS_GB.map((gb) => {
            const choice = quotaChoice(gb, usage, diskFreeBytes)
            const unavailable = choice === 'tooSmall' || choice === 'tooLarge'
            return (
              <Cell
                key={gb}
                role="radio"
                label={`${gb} GB`}
                sub={
                  choice === 'tooSmall'
                    ? t('files.limits.tooSmall')
                    : choice === 'tooLarge'
                      ? t('files.limits.tooLarge')
                      : null
                }
                checked={choice === 'current'}
                disabled={unavailable}
                onPress={() => {
                  onClose()
                  if (choice === 'ok') onChoose(gb)
                }}
              />
            )
          })}
        </Group>
      </ScrollView>
    </Sheet>
  )
}
