import { writeFile } from 'node:fs/promises'

/** A deterministic 4 MiB FAT16 NoCloud disk (CIDATA); no host ISO tool needed. */
export function noCloudSeed(identity: string): Buffer {
  if (!/^[a-f0-9-]{36}$/i.test(identity)) throw new Error('Invalid instance identity')
  const disk = Buffer.alloc(4 * 1024 * 1024)
  const sector = 512
  const fatSectors = 32
  const rootSector = 65
  const dataSector = 97
  disk.set([0xeb, 0x3c, 0x90], 0)
  disk.write('MAESTRLY', 3, 'ascii')
  disk.writeUInt16LE(sector, 11)
  disk[13] = 1
  disk.writeUInt16LE(1, 14)
  disk[16] = 2
  disk.writeUInt16LE(512, 17)
  disk.writeUInt16LE(8192, 19)
  disk[21] = 0xf8
  disk.writeUInt16LE(fatSectors, 22)
  disk.writeUInt16LE(32, 24)
  disk.writeUInt16LE(64, 26)
  disk[36] = 0x80
  disk[38] = 0x29
  disk.writeUInt32LE(0x4d535452, 39)
  disk.write('CIDATA     ', 43, 'ascii')
  disk.write('FAT16   ', 54, 'ascii')
  disk[510] = 0x55
  disk[511] = 0xaa
  const fat = Buffer.alloc(fatSectors * sector)
  fat.writeUInt16LE(0xfff8, 0)
  fat.writeUInt16LE(0xffff, 2)
  disk.write('CIDATA     ', rootSector * sector, 'ascii')
  disk[rootSector * sector + 11] = 8
  const files = [
    ['META-DATA', `instance-id: ${identity}\nlocal-hostname: vm-${identity.slice(0, 8)}\n`],
    [
      'USER-DATA',
      `#cloud-config\nusers: []\ndisable_root: true\nssh_pwauth: false\nwrite_files:\n  - path: /var/lib/maestrly/identity\n    permissions: '0600'\n    content: ${identity}\nruncmd:\n  - [systemctl, enable, --now, qemu-guest-agent.service]\n  - [cp, /var/lib/maestrly/identity, /var/lib/maestrly/provisioned]\n  - [/usr/bin/sync]\n`,
    ],
  ]
  let cluster = 2
  files.forEach(([name, content], index) => {
    const bytes = Buffer.from(content)
    const count = Math.ceil(bytes.length / sector)
    const entry = rootSector * sector + (index * 2 + 2) * 32
    const shortName = (index === 0 ? 'METADA~1' : 'USERDA~1').padEnd(11, ' ')
    const longEntry = entry - 32
    disk.fill(0xff, longEntry, longEntry + 32)
    disk[longEntry] = 0x41
    disk[longEntry + 11] = 0x0f
    disk[longEntry + 12] = 0
    disk.writeUInt16LE(0, longEntry + 26)
    let checksum = 0
    for (const char of Buffer.from(shortName))
      checksum = (((checksum & 1) << 7) + (checksum >> 1) + char) & 255
    disk[longEntry + 13] = checksum
    const offsets = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
    offsets.forEach((offset, i) =>
      disk.writeUInt16LE(
        i < name.length ? name.toLowerCase().charCodeAt(i) : i === name.length ? 0 : 0xffff,
        longEntry + offset
      )
    )
    disk.write(shortName, entry, 'ascii')
    disk[entry + 11] = 0x20
    disk.writeUInt16LE(cluster, entry + 26)
    disk.writeUInt32LE(bytes.length, entry + 28)
    bytes.copy(disk, (dataSector + cluster - 2) * sector)
    for (let i = 0; i < count; i++)
      fat.writeUInt16LE(i === count - 1 ? 0xffff : cluster + i + 1, (cluster + i) * 2)
    cluster += count
  })
  fat.copy(disk, sector)
  fat.copy(disk, (1 + fatSectors) * sector)
  return disk
}
export async function writeNoCloudSeed(path: string, identity: string) {
  await writeFile(path, noCloudSeed(identity), { mode: 0o600, flag: 'wx' })
}
