import { Image, type ImageStyle } from 'expo-image'
import { useEffect, useState } from 'react'
import type { StyleProp } from 'react-native'
import { useConversation, type ImageSourceValue } from './CueCard'

const isPromise = (value: unknown): value is Promise<ImageSourceValue> =>
  typeof (value as { then?: unknown } | null)?.then === 'function'

/** An image a conversation shows: served by the gateway for a bot, read through the bridge for a chat. */
export function TranscriptImage({
  imageId,
  label,
  style,
}: {
  imageId: string
  label: string
  style: StyleProp<ImageStyle>
}) {
  const { imageSource } = useConversation()
  const [source, setSource] = useState<ImageSourceValue | null>(() => {
    const value = imageSource(imageId)
    return isPromise(value) ? null : value
  })
  useEffect(() => {
    const value = imageSource(imageId)
    if (!isPromise(value)) {
      setSource(value)
      return
    }
    let alive = true
    value.then((loaded) => alive && setSource(loaded)).catch(() => {})
    return () => {
      alive = false
    }
  }, [imageId, imageSource])
  return (
    <Image source={source ?? undefined} accessibilityLabel={label} contentFit="cover" style={style} transition={120} />
  )
}
