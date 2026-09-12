export interface LocalFileReference {
  filePath: string
  startLine?: number
  endLine?: number
}

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:/
const GENERIC_EXTENSION_RE = /\.[A-Za-z][A-Za-z\d_-]{0,15}$/
const SPECIAL_FILE_RE =
  /^(?:Dockerfile|Containerfile|Makefile|Rakefile|Gemfile|Procfile|README|LICENSE|CHANGELOG|CODEOWNERS|\.env(?:\..+)?|\.[A-Za-z\d][A-Za-z\d._-]*)$/i

function positiveLine(value: string | undefined): number | undefined {
  if (!value) return undefined
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

function looksLikeLocalFilePath(filePath: string): boolean {
  if (!filePath || /[\0\r\n]/.test(filePath) || filePath.startsWith('#') || filePath.startsWith('?')) return false
  if (URI_SCHEME_RE.test(filePath) && !WINDOWS_ABSOLUTE_RE.test(filePath)) return false
  if (filePath.startsWith('//')) return false

  const basename = filePath.split(/[\\/]/).pop() ?? ''
  if (!basename || basename === '.' || basename === '..') return false
  if (GENERIC_EXTENSION_RE.test(basename) || SPECIAL_FILE_RE.test(basename)) return true

  return /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(filePath)
}

export function parseLocalFileReference(value: string): LocalFileReference | null {
  let raw = value.trim()
  if (!raw) return null
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim()

  try {
    raw = decodeURIComponent(raw)
  } catch {
    return null
  }

  let filePath = raw
  let startLine: number | undefined
  let endLine: number | undefined

  const hashLocation = filePath.match(/#L([1-9]\d*)(?:-L?([1-9]\d*))?$/i)
  if (hashLocation?.index != null) {
    filePath = filePath.slice(0, hashLocation.index)
    startLine = positiveLine(hashLocation[1])
    endLine = positiveLine(hashLocation[2])
  } else {
    const suffixLocation = filePath.match(/:L?([1-9]\d*)(?:-([1-9]\d*))?$/i)
    if (suffixLocation?.index != null) {
      filePath = filePath.slice(0, suffixLocation.index)
      startLine = positiveLine(suffixLocation[1])
      endLine = positiveLine(suffixLocation[2])
    }
  }

  filePath = filePath.trim()
  if (!looksLikeLocalFilePath(filePath)) return null
  if (endLine != null && (startLine == null || endLine < startLine)) return null

  return {
    filePath,
    ...(startLine != null ? { startLine } : {}),
    ...(endLine != null ? { endLine } : {}),
  }
}
