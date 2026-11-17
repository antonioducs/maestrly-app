import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { FLEET_BOT_AVATAR_LIMITS, FLEET_BOT_AVATARS_FEATURE, type FleetBot } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { fleetErrorMessage } from '@/lib/fleet/errors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { BotAvatar } from './BotAvatar'

type AvatarUpload = { mediaType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }

/**
 * Crops the middle square of a picture and scales it to the size the server keeps, as WebP, or PNG when WebP comes
 * out too large. Throws when the file is no image the window can draw.
 */
export async function avatarFromFile(file: Blob): Promise<AvatarUpload> {
  const bitmap = await createImageBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    const size = Math.min(FLEET_BOT_AVATAR_LIMITS.sizePx, side)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No canvas')
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    for (const [mediaType, quality] of [
      ['image/webp', 0.9],
      ['image/webp', 0.7],
      ['image/png', undefined],
    ] as const) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mediaType, quality))
      // A window that cannot encode WebP gives PNG instead: the type is what came out.
      if (!blob || blob.size > FLEET_BOT_AVATAR_LIMITS.maxBytes) continue
      const type = blob.type as AvatarUpload['mediaType']
      if (type !== 'image/webp' && type !== 'image/png') continue
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      return { mediaType: type, data: btoa(binary) }
    }
    throw new Error('Picture too large')
  } finally {
    bitmap.close()
  }
}

/** The bot's picture in its settings: saved as soon as the owner picks or removes it, apart from the other fields. */
export function BotAvatarField({ fleet, bot }: { fleet: FleetController; bot: FleetBot }) {
  const { t } = useTranslation('fleet')
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const supported = fleet.state.connection.features.includes(FLEET_BOT_AVATARS_FEATURE)
  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (cause) {
      setError(fleetErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const pick = (file: File) =>
    run(async () => {
      let avatar: AvatarUpload
      try {
        avatar = await avatarFromFile(file)
      } catch {
        throw new Error(t('botSettings.avatar.unreadable'))
      }
      await fleet.setBotAvatar(bot.id, avatar)
    })
  return (
    <div className="flex items-center gap-4">
      <BotAvatar bot={bot} className="size-14 rounded-xl text-xl" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('botSettings.avatar.label')}</p>
        <p id="fleet-settings-avatar-hint" className="mt-0.5 text-xs text-muted-foreground">
          {supported ? t('botSettings.avatar.hint') : t('botSettings.avatar.updateServer')}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      {supported && (
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void pick(file)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-describedby="fleet-settings-avatar-hint"
            onClick={() => input.current?.click()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ImagePlus className="size-3.5" />}
            {busy
              ? t('botSettings.avatar.saving')
              : bot.avatar
                ? t('botSettings.avatar.replace')
                : t('botSettings.avatar.choose')}
          </Button>
          {bot.avatar && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => fleet.setBotAvatar(bot.id, null))}
            >
              <Trash2 className="size-3.5" />
              {t('botSettings.avatar.remove')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
