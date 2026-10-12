import { Image } from 'expo-image'
import { memo, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { useFleetController } from '../../fleet/react'
import { toolHeadline, toolSummary, type ToolItem } from '../../fleet/transcript-rows'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { formatElapsed, useNow } from '../useNow'
import { useConversation } from './CueCard'

function ToolImages({ tool }: { tool: ToolItem }) {
  const { palette } = useTheme()
  const controller = useFleetController()
  const { bot } = useConversation()
  if (!tool.images.length) return null
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {tool.images.map((image) => (
        <Image
          key={image.id}
          source={controller.source.imageSource(bot.id, image.id)}
          accessibilityLabel={image.name ?? tool.target ?? tool.name}
          contentFit="cover"
          style={{ width: 160, height: 100, borderRadius: 10, backgroundColor: palette.surface }}
        />
      ))}
    </View>
  )
}

/** Tools in a row, folded into one line; a running one shows what it does and for how long. */
export const ToolGroup = memo(function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const { palette } = useTheme()
  const { t, plural } = useI18n()
  const [open, setOpen] = useState(false)
  const running = tools.find((tool) => tool.state === 'running') ?? null
  const now = useNow(running !== null)
  const failed = tools.filter((tool) => tool.state === 'error').length
  const stopped = tools.some((tool) => tool.state === 'interrupted')
  const headline = running ? toolHeadline(running, t) : null
  const summary = toolSummary(tools, plural)
  const extras = [failed ? t('tool.failed', { count: failed }) : null, stopped ? t('tool.stopped') : null].filter(Boolean)
  // Images a bot shared show in the conversation; the others only in the tool's details.
  const shared = tools.filter((tool) => tool.images.length && tool.shared !== false)

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={t('tool.toggle', {
          summary: headline ? `${headline.verb} ${headline.target ?? ''}`.trim() : [summary, ...extras].join(', '),
        })}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}
      >
        {headline ? (
          <>
            <ActivityIndicator size="small" color={palette.muted} />
            <AppText variant="sub" tone="muted" style={{ fontSize: 14 }}>
              {headline.verb}
            </AppText>
            {headline.target ? (
              <AppText numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.mono, fontSize: 12.5, color: palette.ink }}>
                {headline.target}
              </AppText>
            ) : null}
            <AppText style={{ fontFamily: fonts.mono, fontSize: 12, color: palette.faint }}>
              {formatElapsed(now - Date.parse(running?.at ?? ''))}
            </AppText>
          </>
        ) : (
          <>
            <Icon name="tools" size={16} color={palette.muted} />
            <AppText variant="sub" tone="muted" numberOfLines={1} style={{ fontSize: 14, flexShrink: 1 }}>
              {summary}
              {extras.length ? <AppText style={{ color: palette.brick, fontSize: 14 }}>{` · ${extras.join(' · ')}`}</AppText> : null}
            </AppText>
          </>
        )}
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="chev-right" size={14} color={palette.faint} />
        </View>
      </Pressable>
      {open ? (
        <View style={{ gap: 8, marginTop: 6, marginLeft: 6, paddingLeft: 13, borderLeftWidth: 1.5, borderLeftColor: palette.line }}>
          {tools.map((tool) => (
            <View key={tool.id} style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ width: 16, paddingTop: 2 }}>
                {tool.state === 'running' ? (
                  <ActivityIndicator size="small" color={palette.muted} />
                ) : (
                  <Icon
                    name={tool.state === 'done' ? 'check' : 'x'}
                    size={15}
                    color={tool.state === 'done' ? palette.moss : palette.brick}
                  />
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText style={{ fontFamily: fonts.mono, fontSize: 12, lineHeight: 18 }} selectable>
                  <AppText style={{ fontFamily: fonts.mono, fontSize: 12, color: palette.faint }}>{tool.name} </AppText>
                  {tool.target ?? ''}
                </AppText>
                {tool.output ? (
                  <View style={{ marginTop: 4, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: palette.surface }}>
                    <AppText selectable style={{ fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, color: palette.muted }}>
                      {tool.output}
                    </AppText>
                  </View>
                ) : null}
                <ToolImages tool={tool} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        shared.map((tool) => <ToolImages key={tool.id} tool={tool} />)
      )}
    </View>
  )
})
