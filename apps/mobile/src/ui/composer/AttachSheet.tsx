import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { useRef } from 'react'
import { Platform } from 'react-native'
import { classifyAttachment, type OutboxAttachment } from '../../fleet/attachments'
import { useI18n } from '../../i18n'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { Sheet } from '../primitives/Sheet'

const fromImage = (asset: ImagePicker.ImagePickerAsset): OutboxAttachment => {
  const file = asset.uri.split('/').pop() ?? 'photo.jpg'
  const mediaType = asset.mimeType ?? (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg')
  // A photo taken as HEIC keeps its original name after it was re-encoded; name it for what it now is.
  const original = asset.fileName ?? file
  const name = mediaType === 'image/jpeg' ? original.replace(/\.(heic|heif)$/i, '.jpg') : original
  return { name, kind: 'image', mediaType, uri: asset.uri, byteSize: asset.fileSize ?? 0 }
}

/**
 * Where an attachment comes from: the camera, the photo library or, when the bot takes them, files. Images are
 * re-encoded as JPEG so photos in HEIC reach the bot in a format it reads.
 */
export function AttachSheet({
  open,
  onClose,
  filesEnabled,
  onPicked,
  onPaste,
}: {
  open: boolean
  onClose: () => void
  filesEnabled: boolean
  onPicked: (attachments: OutboxAttachment[]) => void
  /** Set while the clipboard holds an image. */
  onPaste?: () => Promise<void>
}) {
  const { t } = useI18n()
  const pending = useRef<(() => Promise<void>) | null>(null)
  const runPending = () => {
    const action = pending.current
    pending.current = null
    void action?.().catch(() => {})
  }
  // iOS presents nothing while the sheet is still sliding away: the picker opens once it has closed, or after the
  // longest slide should it never say so.
  const after = (action: () => Promise<void>) => () => {
    pending.current = action
    onClose()
    if (Platform.OS !== 'ios') runPending()
    else setTimeout(() => pending.current === action && runPending(), 800)
  }
  const imageOptions: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 0.8,
    allowsMultipleSelection: true,
    // iOS hands over a JPEG copy of HEIC photos, which every model reads.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  }

  async function camera() {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return
    const result = await ImagePicker.launchCameraAsync({ ...imageOptions, allowsMultipleSelection: false })
    if (!result.canceled) onPicked(result.assets.map(fromImage))
  }
  async function photos() {
    const result = await ImagePicker.launchImageLibraryAsync(imageOptions)
    if (!result.canceled) onPicked(result.assets.map(fromImage))
  }
  async function file() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'text/*', 'application/json'],
      multiple: true,
      copyToCacheDirectory: true,
    })
    if (result.canceled) return
    onPicked(
      result.assets.map((asset) => ({
        name: asset.name,
        kind: classifyAttachment(asset.name, asset.mimeType ?? null) ?? 'text',
        mediaType: asset.mimeType ?? 'application/octet-stream',
        uri: asset.uri,
        byteSize: asset.size ?? 0,
      }))
    )
  }

  return (
    <Sheet open={open} title={t('attach.title')} onClose={onClose} onDismissed={runPending}>
      <Group>
        {onPaste ? <Cell icon="clipboard" label={t('attach.pasteImage')} onPress={after(onPaste)} /> : null}
        {Platform.OS === 'web' ? null : <Cell icon="camera" label={t('attach.takePhoto')} onPress={after(camera)} />}
        <Cell icon="image" label={t('attach.choosePhotos')} onPress={after(photos)} />
        {filesEnabled ? <Cell icon="file" label={t('attach.chooseFile')} onPress={after(file)} /> : null}
      </Group>
    </Sheet>
  )
}
