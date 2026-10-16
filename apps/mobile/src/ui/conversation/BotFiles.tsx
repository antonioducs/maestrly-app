import { FLEET_FILE_LIMITS, type FleetFileRef } from '@maestrly/bot-fleet-protocol'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
import { cachedFilePath, fileKind } from '../../fleet/bot-files'
import { formatBytes } from '../../fleet/format'
import { GatewayError } from '../../gateway/client'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { useConversation } from './CueCard'

type Issue = 'gone' | 'offline' | 'tooLarge' | 'demo' | 'unavailable'
type Phase =
  | { phase: 'idle' }
  | { phase: 'downloading'; share: number | null }
  | { phase: 'playing'; uri: string }
  | { phase: 'failed'; issue: Issue }

class FileIssue extends Error {
  constructor(readonly issue: Issue) {
    super(issue)
  }
}

/** A video downloaded to the phone, playing in the conversation with the system's controls and full screen. */
function InlineVideo({ uri, label }: { uri: string; label: string }) {
  const { palette } = useTheme()
  const player = useVideoPlayer(uri, (created) => {
    created.play()
  })
  return (
    <VideoView
      player={player}
      accessibilityLabel={label}
      nativeControls
      fullscreenOptions={{ enable: true }}
      contentFit="contain"
      style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 12, backgroundColor: palette.codeBg }}
    />
  )
}

function BotFileCard({ file }: { file: FleetFileRef }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { files } = useConversation()
  const kind = fileKind(file, Platform.OS)
  const [state, setState] = useState<Phase>({ phase: 'idle' })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  /** The file in the app's cache, downloaded once: the gateway serves whole files, so a video cannot stream. */
  async function fetchFile(): Promise<File> {
    if (!files) throw new FileIssue('unavailable')
    if (files.demo) throw new FileIssue('demo')
    if (file.byteSize > FLEET_FILE_LIMITS.downloadMaxBytes) throw new FileIssue('tooLarge')
    const target = new File(Paths.cache, cachedFilePath(files.serverId, files.botId, file.id, file.name))
    if (target.exists && target.size === file.byteSize) return target
    try {
      await files.check(file.id)
    } catch (error) {
      throw new FileIssue(error instanceof GatewayError && error.code === 'NOT_FOUND' ? 'gone' : 'offline')
    }
    const controller = new AbortController()
    abort.current = controller
    try {
      target.parentDirectory.create({ intermediates: true, idempotent: true })
      const { uri, headers } = files.source(file.id)
      return await File.downloadFileAsync(uri, target, {
        headers,
        idempotent: true,
        signal: controller.signal,
        onProgress: ({ bytesWritten, totalBytes }) => {
          const total = totalBytes > 0 ? totalBytes : file.byteSize
          setState({ phase: 'downloading', share: total > 0 ? Math.min(1, bytesWritten / total) : null })
        },
      })
    } catch {
      throw new FileIssue('offline')
    }
  }

  async function open() {
    setState({ phase: 'downloading', share: null })
    try {
      const saved = await fetchFile()
      if (kind === 'video') return setState({ phase: 'playing', uri: saved.uri })
      setState({ phase: 'idle' })
      await Sharing.shareAsync(saved.uri, { mimeType: file.mediaType, dialogTitle: file.name })
    } catch (error) {
      setState({ phase: 'failed', issue: error instanceof FileIssue ? error.issue : 'offline' })
    }
  }

  const downloading = state.phase === 'downloading'
  const progress = state.phase === 'downloading' && state.share !== null ? ` · ${Math.round(state.share * 100)}%` : ''
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.surface,
          }}
        >
          <Icon
            name={kind === 'video' ? 'play' : kind === 'image' ? 'image' : 'file'}
            size={18}
            color={palette.muted}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText numberOfLines={2} style={{ fontSize: 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>
            {file.name}
          </AppText>
          <AppText variant="small" tone="muted" accessibilityLiveRegion="polite">
            {downloading ? `${t('botFiles.downloading')}${progress}` : formatBytes(file.byteSize)}
          </AppText>
        </View>
        {state.phase === 'playing' ? null : downloading ? (
          <ActivityIndicator color={palette.muted} accessibilityLabel={t('botFiles.downloading')} />
        ) : (
          <Button
            label={kind === 'video' ? t('botFiles.play') : t('botFiles.download')}
            accessibilityLabel={t(kind === 'video' ? 'botFiles.playNamed' : 'botFiles.downloadNamed', {
              name: file.name,
            })}
            size="sm"
            variant="secondary"
            onPress={() => void open()}
          />
        )}
      </View>
      {state.phase === 'playing' ? <InlineVideo uri={state.uri} label={file.name} /> : null}
      {state.phase === 'failed' ? (
        <AppText
          accessibilityRole="alert"
          variant="small"
          style={{ color: state.issue === 'demo' ? palette.muted : palette.brick }}
        >
          {t(`botFiles.error.${state.issue}`)}
        </AppText>
      ) : null}
    </View>
  )
}

/** The files a bot shared in a tool call: each video plays in the conversation, any other file opens to save. */
export function BotFiles({ files }: { files: FleetFileRef[] }) {
  return (
    <View style={{ gap: 8 }}>
      {files.map((file) => (
        <BotFileCard key={file.id} file={file} />
      ))}
    </View>
  )
}
