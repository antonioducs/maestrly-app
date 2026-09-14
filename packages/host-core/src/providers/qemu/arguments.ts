import type { Vm } from '@maestrly/host-protocol'
import type { Runtime } from './provider.js'
import { botChannelArgs, type BotChannelPaths } from '../../guest/profile.js'
export interface VmPaths {
  directory: string
  disk: string
  seed: string
  qmp: string
  qga: string
  firmwareVars: string
  log: string
}
export interface LaunchProfile {
  /** Present only for VMs bound to a bot: adds the private control/egress virtio ports. */
  botChannels?: BotChannelPaths
}
/** No shell interpolation and explicitly no network or default devices. */
export function buildQemuArgs(vm: Vm, runtime: Runtime, paths: VmPaths, profile: LaunchProfile = {}): string[] {
  const args = [
    '-name',
    `maestrly-${vm.id}`,
    '-uuid',
    vm.identity,
    '-machine',
    runtime.arch === 'arm64' ? 'virt,accel=hvf' : 'q35,accel=hvf',
    '-cpu',
    'host',
    '-smp',
    String(vm.cpus),
    '-m',
    String(vm.memoryMiB),
    '-nodefaults',
    '-no-user-config',
    '-display',
    'none',
    '-nic',
    'none',
    '-monitor',
    'none',
    '-chardev',
    'ringbuf,id=console0,size=65536',
    '-serial',
    'chardev:console0',
    '-qmp',
    `unix:${paths.qmp},server=on,wait=off`,
    '-chardev',
    `socket,path=${paths.qga},server=on,wait=off,id=qga0`,
    '-device',
    'virtio-serial-pci',
    '-device',
    'virtserialport,chardev=qga0,name=org.qemu.guest_agent.0',
    '-blockdev',
    JSON.stringify({
      driver: 'file',
      filename: paths.disk,
      'node-name': 'disk-file',
    }),
    '-blockdev',
    JSON.stringify({ driver: 'qcow2', file: 'disk-file', 'node-name': 'disk' }),
    '-device',
    'virtio-blk-pci,drive=disk',
    '-blockdev',
    JSON.stringify({
      driver: 'file',
      filename: paths.seed,
      'node-name': 'seed-file',
      'read-only': true,
    }),
    '-blockdev',
    JSON.stringify({
      driver: 'raw',
      file: 'seed-file',
      'node-name': 'seed',
      'read-only': true,
    }),
    '-device',
    'virtio-blk-pci,drive=seed',
  ]
  if (runtime.firmware) {
    args.push('-drive', `if=pflash,format=raw,readonly=on,file=${runtime.firmware.path}`)
  }
  if (runtime.firmwareVars) {
    args.push('-drive', `if=pflash,format=raw,file=${paths.firmwareVars}`)
  }
  if (profile.botChannels) args.push(...botChannelArgs(profile.botChannels))
  return args
}
