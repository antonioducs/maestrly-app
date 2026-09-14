import { generateKeyPairSync, createPublicKey, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { privateDirectory, readPrivate, writePrivate } from './private-files.js'
export type PeerKeys = { publicKey: string; privateKey: string; certificate: string; tlsKey: string }
export async function peerKeys(directory: string, hostId: string): Promise<PeerKeys> {
  await privateDirectory(directory)
  const file = join(directory, 'identity.json')
  try {
    const value = JSON.parse(await readPrivate(file, 16384)) as PeerKeys
    if (createPublicKey(value.privateKey).export({ format: 'pem', type: 'spki' }) !== value.publicKey || createPublicKey(value.publicKey).asymmetricKeyType !== 'ed25519') throw new Error('Invalid peer identity')
    if (new X509Certificate(value.certificate).publicKey.export({ format: 'pem', type: 'spki' }) !== createPublicKey(value.tlsKey).export({ format: 'pem', type: 'spki' })) throw new Error('Invalid TLS identity')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const signing = generateKeyPairSync('ed25519', { privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
  const temporary = await mkdtemp(join(directory, 'certificate-'))
  await chmod(temporary, 0o700)
  try {
    const key = join(temporary, 'key.pem'), certificate = join(temporary, 'cert.pem')
    await promisify(execFile)('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', key, '-out', certificate, '-subj', `/CN=maestrly-accounts-${hostId}`], { timeout: 30000, maxBuffer: 16384, env: { PATH: '/usr/bin:/bin' } })
    await chmod(key, 0o600); await chmod(certificate, 0o600)
    const value: PeerKeys = { ...signing, certificate: await readPrivate(certificate, 8192), tlsKey: await readPrivate(key, 8192) }
    await writePrivate(file, JSON.stringify(value))
    return value
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
