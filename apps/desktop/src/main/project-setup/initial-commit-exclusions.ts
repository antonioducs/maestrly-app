/**
 * What the Initial commit of an existing folder leaves out, on top of what Git already ignores (`.gitignore`,
 * `.git/info/exclude` and the user's global excludes). The files stay in the folder, untouched and untracked.
 * This is the only place that lists them; the dialog text in the translation catalogs describes the same set.
 */

/** Directories of dependencies and build output, at any depth. Compared case-insensitively. */
export const INITIAL_COMMIT_EXCLUDED_DIRECTORIES: readonly string[] = ['node_modules', '.venv', 'venv', '__pycache__']

/** Machine-generated files nobody wants in a history. Compared case-insensitively, at any depth. */
const EXCLUDED_NOISE_FILE_NAMES: readonly string[] = ['.DS_Store', 'Thumbs.db']

/** Likely secrets, by file name: `.env`, `.env.*`, private keys and certificate bundles. */
const LIKELY_SECRET_FILE_NAME = /^(?:\.env(?:\..*)?|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|p12|pfx))$/i

/** Templates that carry no secret and are meant to be shared, so `.env.*` does not exclude them. */
const SECRET_FILE_NAME_EXCEPTIONS: readonly string[] = ['.env.example', '.env.sample', '.env.template']

/** A file this size or larger stays out. 50 MiB: GitHub starts warning there and rejects files of 100 MiB. */
export const INITIAL_COMMIT_MAX_FILE_BYTES = 50 * 1024 * 1024

const lowerCased = (names: readonly string[]) => new Set(names.map((name) => name.toLowerCase()))
const EXCLUDED_DIRECTORY_SET = lowerCased(INITIAL_COMMIT_EXCLUDED_DIRECTORIES)
const EXCLUDED_NOISE_SET = lowerCased(EXCLUDED_NOISE_FILE_NAMES)
const SECRET_EXCEPTION_SET = lowerCased(SECRET_FILE_NAME_EXCEPTIONS)

/**
 * Whether a file stays out of the Initial commit by its path alone. `relativePath` is relative to the folder and
 * uses `/`, as Git prints it. Nested repositories and file sizes are checked by the caller.
 */
export function isExcludedFromInitialCommit(relativePath: string): boolean {
  const segments = relativePath.split('/')
  const name = segments[segments.length - 1] ?? ''
  if (segments.slice(0, -1).some((directory) => EXCLUDED_DIRECTORY_SET.has(directory.toLowerCase()))) return true
  const lower = name.toLowerCase()
  if (EXCLUDED_NOISE_SET.has(lower)) return true
  return LIKELY_SECRET_FILE_NAME.test(name) && !SECRET_EXCEPTION_SET.has(lower)
}

/** Whether a file of this size stays out of the Initial commit. */
export function isTooLargeForInitialCommit(sizeBytes: number): boolean {
  return sizeBytes >= INITIAL_COMMIT_MAX_FILE_BYTES
}
