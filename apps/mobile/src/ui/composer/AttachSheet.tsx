import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { Platform } from 'react-native'
import { classifyAttachment, type OutboxAttachment } from '../../fleet/attachments'
import { useI18n } from '../../i18n'
import { Cell } from '../primitives/Cell'
import { Group } from '../primitives/Group'
import { Sheet } from '../primitives/Sheet'

const fromImage = (asset: ImagePicker.ImagePickerAsset): OutboxAttachment => {
  const name = asset.fileName ?? asset.uri.split('/').pop() ?? 'photo.jpg'
  const mediaType = asset.mimeType ?? (/\.png$/i.test(name) ? 'image/png' : 'image/jpeg')
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
}: {
  open: boolean
  onClose: () => void
  filesEnabled: boolean
  onPicked: (attachments: OutboxAttachment[]) => void
}) {
  const { t } = useI18n()
  const imageOptions: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, allowsMultipleSelection: true }

  async function camera() {
    onClose()
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) return
    const result = await ImagePicker.launchCameraAsync({ ...imageOptions, allowsMultipleSelection: false })
    if (!result.canceled) onPicked(result.assets.map(fromImage))
  }
  async function photos() {
    onClose()
    const result = await ImagePicker.launchImageLibraryAsync(imageOptions)
    if (!result.canceled) onPicked(result.assets.map(fromImage))
  }
  async function file() {
    onClose()
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
    <Sheet open={open} title={t('attach.title')} onClose={onClose}>
      <Group>
        {Platform.OS === 'web' ? null : <Cell icon="camera" label={t('attach.takePhoto')} onPress={() => void camera()} />}
        <Cell icon="image" label={t('attach.choosePhotos')} onPress={() => void photos()} />
        {filesEnabled ? <Cell icon="file" label={t('attach.chooseFile')} onPress={() => void file()} /> : null}
      </Group>
    </Sheet>
  )
}
