import type { BotMessage } from '@maestrly/host-protocol'
export type Attachment = BotMessage['attachments'][number]
export function canPreview(file: Attachment) {
  return file.size <= 256 * 1024 && /\.(txt|md|json|csv|log|py|ts|tsx|js|css|yaml|yml|toml|sh)$/i.test(file.name)
}
export async function downloadBytes(botId: string, file: Attachment) {
  let transfer = await window.bot.bot({
    method: 'bot.files.transferBegin',
    params: { botId, direction: 'download', path: file.path },
  })
  const chunks: string[] = []
  try {
    while (!transfer.done) {
      const offset = transfer.offset
      transfer = await window.bot.bot({
        method: 'bot.files.transferChunk',
        params: { transferId: transfer.transferId, offset },
      })
      if (transfer.offset <= offset && !transfer.done) throw new Error('Transfer stopped progressing')
      if (transfer.dataBase64) chunks.push(atob(transfer.dataBase64))
    }
    await window.bot.bot({ method: 'bot.files.transferFinish', params: { transferId: transfer.transferId } })
    return chunks.join('')
  } catch (error) {
    await window.bot
      .bot({ method: 'bot.files.transferAbort', params: { transferId: transfer.transferId } })
      .catch(() => undefined)
    throw error
  }
}
export async function uploadFile(
  botId: string,
  file: { name: string; size: number; dataBase64: string },
  overwrite = false
): Promise<Attachment> {
  const path = `uploads/${file.name}`
  let transfer = await window.bot.bot({
    method: 'bot.files.transferBegin',
    params: { botId, direction: 'upload', path, size: file.size, overwrite },
  })
  const bytes = atob(file.dataBase64)
  try {
    do {
      const offset = transfer.offset
      transfer = await window.bot.bot({
        method: 'bot.files.transferChunk',
        params: {
          transferId: transfer.transferId,
          offset,
          dataBase64: btoa(bytes.slice(offset, offset + transfer.chunkBytes)),
        },
      })
      if (transfer.offset <= offset && !transfer.done) throw new Error('Transfer stopped progressing')
    } while (!transfer.done)
    await window.bot.bot({ method: 'bot.files.transferFinish', params: { transferId: transfer.transferId } })
    return { path, name: file.name, size: file.size }
  } catch (error) {
    await window.bot
      .bot({ method: 'bot.files.transferAbort', params: { transferId: transfer.transferId } })
      .catch(() => undefined)
    throw error
  }
}
