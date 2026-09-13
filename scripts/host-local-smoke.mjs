#!/usr/bin/env node
// Explicit, bounded controller-only integration test; never an SSH target or
// substitute for launchd/Mac mini qualification. No NIC on either guest.
import { readFile, writeFile, mkdtemp, realpath, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateBuildConfig, verifyInput, sha256 } from './host-build-utils.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export async function localSmoke(config) {
  if (config.authorize !== true || config.authorizeDeleteTestData !== true)
    throw new Error('LOCAL_SMOKE_AUTHORIZATION: explicit local VM creation and test-data cleanup required')
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('LOCAL_SMOKE_PLATFORM: this candidate is native Arm64 macOS only')
  const build = validateBuildConfig(JSON.parse(await readFile(config.runtimeBuildConfig, 'utf8')))
  if (build.architecture !== process.arch || build.images?.length !== 1)
    throw new Error('LOCAL_SMOKE_CATALOGUE: one explicitly prepared image required')
  const asset = async (relative) => {
    const entry = build.files.find((file) => file.path === relative)
    if (!entry) throw new Error('LOCAL_SMOKE_ASSET: undeclared file')
    return { path: await verifyInput(build.inputDirectory, entry), sha256: entry.sha256 }
  }
  for (const file of build.files) await verifyInput(build.inputDirectory, file)
  const runtime = {
    id: 'candidate-local-arm64',
    arch: 'arm64',
    qemu: await asset('bin/qemu-system-aarch64'),
    qemuImg: await asset('bin/qemu-img'),
    firmware: await asset(build.firmware),
    firmwareVars: await asset(build.firmwareVars),
  }
  const image = build.images[0]
  const images = [
    {
      id: image.id,
      name: image.name,
      arch: image.architecture,
      asset: await asset(image.file),
      format: image.format,
      virtualSizeGiB: image.virtualSizeGiB,
      guestAgent: true,
    },
  ]
  if (image.virtualSizeGiB > 12) throw new Error('LOCAL_SMOKE_BUDGET: image exceeds 12 GiB per guest')
  const stateDirectory = await realpath(await mkdtemp('/private/tmp/mhl-'))
  const evidenceDirectory = path.join(root, '.host-lab', 'controller-smoke', randomUUID())
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  let coreModule = new URL('../packages/host-core/dist/index.js', import.meta.url).href
  if (config.hostPackageDirectory) {
    const manifestPath = path.join(config.hostPackageDirectory, 'manifest.json')
    if (
      !/^[a-f0-9]{64}$/.test(config.hostPackageManifestSha256 ?? '') ||
      (await sha256(manifestPath)) !== config.hostPackageManifestSha256
    )
      throw new Error('LOCAL_SMOKE_PACKAGE_INTEGRITY')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    for (const entry of manifest.files) await verifyInput(config.hostPackageDirectory, entry)
    if (!manifest.files.some((entry) => entry.path === 'app/host-core.mjs'))
      throw new Error('LOCAL_SMOKE_PACKAGED_CORE_REQUIRED')
    coreModule = pathToFileURL(path.join(config.hostPackageDirectory, 'app/host-core.mjs')).href
  }
  const { HostService } = await import(coreModule)
  const options = { stateDirectory, runtimes: [runtime], images, capacity: { cpus: 4, memoryMiB: 4096, diskGiB: 32 } }
  let service = new HostService(options)
  const events = []
  const owned = []
  const save = async () =>
    writeFile(
      path.join(evidenceDirectory, 'result.json'),
      JSON.stringify(
        {
          scope: 'controller only; no SSH, launchd installation or Mac mini qualification',
          core: config.hostPackageDirectory ? 'packaged' : 'workspace build',
          stateDirectory,
          resourceBudget: { guests: 2, cpusPerGuest: 1, memoryMiBPerGuest: 1024, diskGiBPerGuest: 12 },
          owned,
          events,
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
  const call = async (method, params = {}) => {
    const result = await service.dispatch({ version: 1, id: randomUUID(), method, params })
    if (result.error) throw new Error(`${method}: ${result.error.code}: ${result.error.message}`)
    return result.result
  }
  const operation = async (method, params) => {
    const idempotencyKey = randomUUID()
    events.push({ stage: 'intent', method, idempotencyKey, vmId: params.vmId, at: new Date().toISOString() })
    await save()
    const op = await call(method, { ...params, idempotencyKey })
    if (method === 'vm.create') owned.push({ id: op.vmId, name: params.name })
    events.push({ stage: 'accepted', method, id: op.id, vmId: op.vmId })
    await save()
    for (let index = 0; index < 180; index++) {
      const current = await call('operation.get', { operationId: op.id })
      if (current.status === 'succeeded') {
        events.push({ stage: 'completed', method, vmId: op.vmId })
        await save()
        return current
      }
      if (['failed', 'cancelled'].includes(current.status))
        throw new Error(`${method}: ${current.error?.code}: ${current.error?.message}`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`${method}: LOCAL_SMOKE_TIMEOUT`)
  }
  try {
    await service.ready()
    const host = await call('host.inspect')
    if (!host.supported) throw new Error('LOCAL_SMOKE_HVF: verified runtime unavailable')
    events.push({ stage: 'host', host })
    for (let index = 0; index < 2; index++) {
      console.log(`Creating local isolated test guest ${index + 1}/2`)
      await operation('vm.create', {
        name: `lab-controller-${randomUUID().slice(0, 8)}`,
        runtimeId: runtime.id,
        imageId: image.id,
        cpus: 1,
        memoryMiB: 1024,
        diskGiB: 12,
      })
    }
    const initial = await call('vm.list')
    if (initial.length !== 2 || initial.some((vm) => vm.state !== 'running') || initial[0].id === initial[1].id)
      throw new Error('LOCAL_SMOKE_CONCURRENT_GUESTS')
    const bootIds = new Map()
    for (const vm of initial) {
      const proof = await call('vm.verify', { vmId: vm.id, mode: 'write-marker' })
      if (!proof.ready || !proof.markerMatches || !proof.networkIsolated) throw new Error('LOCAL_SMOKE_GUEST_PROOF')
      bootIds.set(vm.id, proof.bootId)
      events.push({ stage: 'marker-written', vmId: vm.id, proof })
    }
    await save()
    await service.close()
    service = new HostService(options)
    await service.ready()
    const reopened = await call('vm.list')
    if (reopened.length !== 2 || reopened.some((vm) => vm.state !== 'running'))
      throw new Error('LOCAL_SMOKE_SERVICE_INDEPENDENCE')
    events.push({ stage: 'core-closed-reopened-guests-survived' })
    for (const owner of owned) {
      const vm = await call('vm.inspect', { vmId: owner.id })
      await operation('vm.restart', { vmId: vm.id, expectedRevision: vm.revision })
      const proof = await call('vm.verify', { vmId: vm.id, mode: 'read-marker' })
      if (!proof.ready || !proof.markerMatches || !proof.networkIsolated || proof.bootId === bootIds.get(vm.id))
        throw new Error('LOCAL_SMOKE_REBOOT_PERSISTENCE')
      events.push({ stage: 'reboot-marker-persisted', vmId: vm.id, proof })
      let current = await call('vm.inspect', { vmId: vm.id })
      await operation('vm.shutdown', { vmId: current.id, expectedRevision: current.revision })
      current = await call('vm.inspect', { vmId: current.id })
      if (current.state !== 'stopped') throw new Error('LOCAL_SMOKE_SHUTDOWN')
      await operation('vm.start', { vmId: current.id, expectedRevision: current.revision })
      const coldProof = await call('vm.verify', { vmId: current.id, mode: 'read-marker' })
      if (
        !coldProof.ready ||
        !coldProof.markerMatches ||
        !coldProof.networkIsolated ||
        coldProof.bootId === proof.bootId
      )
        throw new Error('LOCAL_SMOKE_COLD_START_PERSISTENCE')
      events.push({ stage: 'cold-start-marker-persisted', vmId: current.id, proof: coldProof })
    }
    const first = await call('vm.inspect', { vmId: owned[0].id })
    await operation('vm.shutdown', { vmId: first.id, expectedRevision: first.revision })
    const stopped = await call('vm.inspect', { vmId: first.id })
    await operation('vm.remove', { vmId: first.id, expectedRevision: stopped.revision, deleteData: false })
    const retained = await call('vm.inspect', { vmId: first.id })
    if (!retained.diskRetained) throw new Error('LOCAL_SMOKE_RETAINED_DISK')
    const otherProof = await call('vm.verify', { vmId: owned[1].id, mode: 'read-marker' })
    if (!otherProof.ready || !otherProof.markerMatches) throw new Error('LOCAL_SMOKE_OTHER_GUEST_MODIFIED')
    events.push({ stage: 'removal-retains-first-disk-second-guest-intact' })
    await save()
  } catch (error) {
    events.push({ stage: 'failed', message: error.message })
    await save()
    throw error
  } finally {
    // IDs and names came from this run. Uncertain state stays available for review;
    // no PID-based kill or deletion of foreign resources is attempted.
    for (const owner of owned) {
      try {
        let vm = await call('vm.inspect', { vmId: owner.id })
        if (vm.name !== owner.name) {
          events.push({ stage: 'cleanup-needs-review', vmId: owner.id, message: 'LOCAL_SMOKE_OWNERSHIP' })
          continue
        }
        if (vm.state === 'running') {
          await operation('vm.shutdown', { vmId: vm.id, expectedRevision: vm.revision })
          vm = await call('vm.inspect', { vmId: vm.id })
        }
        if (vm.state === 'stopped' || vm.state === 'removed')
          await operation('vm.remove', { vmId: vm.id, expectedRevision: vm.revision, deleteData: true })
        else events.push({ stage: 'cleanup-needs-review', vmId: vm.id, state: vm.state })
      } catch (error) {
        events.push({ stage: 'cleanup-needs-review', vmId: owner.id, message: error.message })
      }
    }
    await service.close()
    await save()
    console.log(`Controller-only evidence: ${evidenceDirectory}`)
  }
  if (events.some((event) => event.stage === 'cleanup-needs-review'))
    throw new Error('LOCAL_SMOKE_CLEANUP: retained resources need review; see evidence')
  events.push({ stage: 'passed', at: new Date().toISOString() })
  await save()
  return evidenceDirectory
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.MAESTRLY_HOST_LOCAL_SMOKE_CONFIG) {
    console.error('LOCAL_SMOKE_CONFIG_REQUIRED: set an explicit local candidate configuration')
    process.exitCode = 1
  } else
    localSmoke(JSON.parse(await readFile(process.env.MAESTRLY_HOST_LOCAL_SMOKE_CONFIG, 'utf8'))).catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
