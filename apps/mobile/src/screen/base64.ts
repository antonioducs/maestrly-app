const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Bytes as base64, in plain JavaScript: Hermes has no Buffer, and a frame does not fit btoa's binary string well. */
export function base64Of(bytes: Uint8Array): string {
  const parts: string[] = []
  const whole = bytes.length - (bytes.length % 3)
  let chunk = ''
  for (let i = 0; i < whole; i += 3) {
    const value = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    chunk +=
      ALPHABET[(value >> 18) & 63] + ALPHABET[(value >> 12) & 63] + ALPHABET[(value >> 6) & 63] + ALPHABET[value & 63]
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  const rest = bytes.length - whole
  if (rest === 1) {
    const value = bytes[whole] << 16
    chunk += ALPHABET[(value >> 18) & 63] + ALPHABET[(value >> 12) & 63] + '=='
  } else if (rest === 2) {
    const value = (bytes[whole] << 16) | (bytes[whole + 1] << 8)
    chunk += ALPHABET[(value >> 18) & 63] + ALPHABET[(value >> 12) & 63] + ALPHABET[(value >> 6) & 63] + '='
  }
  parts.push(chunk)
  return parts.join('')
}
