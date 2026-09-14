// Explicit separate output; this never changes a Host configuration or running VM.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildBotImage } from './build-bot-image-qemu.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (process.argv.length !== 3) {
  console.error('Usage: node scripts/build-bot-image.mjs /absolute/private/bot-image-config.json')
  process.exitCode = 1
} else {
  try {
    await buildBotImage(JSON.parse(await readFile(process.argv[2], 'utf8')), root)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
