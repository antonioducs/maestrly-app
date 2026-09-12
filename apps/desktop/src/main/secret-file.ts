import { promises as fs } from 'node:fs'

/** Best-effort chmod 0600; unsupported Windows/non-POSIX filesystems must not break startup. */
export async function chmod0600(file: string): Promise<void> {
  try {
    await fs.chmod(file, 0o600)
  } catch {
    /* Ignore unsupported POSIX permissions on this filesystem. */
  }
}
