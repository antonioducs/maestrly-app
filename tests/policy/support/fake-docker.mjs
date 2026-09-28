// A stand-in for the Docker CLI in policy tests. Containers, volumes and networks live in the JSON file named by
// FAKE_DOCKER_STATE, and every call is appended to that file + '.calls'. It models only the commands the fleet dev
// helper uses, with Docker's refusals (a volume in use, a network with running endpoints); anything else fails.
import { appendFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs'

const file = process.env.FAKE_DOCKER_STATE
if (!file) {
  process.stderr.write('FAKE_DOCKER_STATE is not set\n')
  process.exit(125)
}
const state = JSON.parse(readFileSync(file, 'utf8'))
const args = process.argv.slice(2)
appendFileSync(file + '.calls', JSON.stringify(args) + '\n')
const errors = []
function finish(output = '') {
  writeFileSync(file, JSON.stringify(state, null, 2))
  if (output) process.stdout.write(output + '\n')
  if (errors.length) process.stderr.write(errors.join('\n') + '\n')
  process.exit(errors.length ? 1 : 0)
}
function unsupported() {
  process.stderr.write('fake docker: unsupported call: ' + args.join(' ') + '\n')
  process.exit(125)
}
/** Splits flags, the values of the flags that take one, and positional arguments. */
function parse(list, valued = []) {
  const flags = new Set(),
    values = {},
    positional = []
  for (let index = 0; index < list.length; index++) {
    const arg = list[index]
    if (valued.includes(arg)) (values[arg] ??= []).push(list[++index])
    else if (arg.startsWith('-')) flags.add(arg)
    else positional.push(arg)
  }
  return { flags, values, positional }
}
function labelled(labels, filters = []) {
  return filters.every((filter) => {
    const [kind, key, ...value] = filter.split('=')
    if (kind !== 'label') unsupported()
    return value.length ? labels?.[key] === value.join('=') : Object.hasOwn(labels ?? {}, key)
  })
}
const container = (ref) => state.containers.find((item) => item.id === ref || item.name === ref)
const volume = (name) => state.volumes.find((item) => item.name === name)
const network = (name) => state.networks.find((item) => item.name === name)
const users = (name) => state.containers.filter((item) => item.mounts.some((mount) => mount.Name === name))
const endpoints = (name) => state.containers.filter((item) => item.running && item.networks.includes(name))
const injected = (call) => state.failures?.[call]
function removeContainer(item) {
  state.containers = state.containers.filter((other) => other !== item)
}
function removeVolume(name, force = false) {
  const item = volume(name)
  if (injected('volume rm ' + name)) return errors.push(injected('volume rm ' + name))
  if (!item) return force || errors.push(`Error response from daemon: get ${name}: no such volume`)
  if (users(name).length)
    return errors.push(
      `Error response from daemon: remove ${name}: volume is in use - [${users(name)
        .map((user) => user.id)
        .join(', ')}]`
    )
  state.volumes = state.volumes.filter((other) => other !== item)
}
function removeNetwork(name) {
  const item = network(name)
  if (!item) return errors.push(`Error response from daemon: network ${name} not found`)
  if (endpoints(name).length)
    return errors.push(`Error response from daemon: error while removing network: network ${name} has active endpoints`)
  state.networks = state.networks.filter((other) => other !== item)
}
const inspectContainer = (item) => ({
  Id: item.id,
  Name: '/' + item.name,
  State: { Running: item.running, Status: item.running ? 'running' : 'exited' },
  Config: { Labels: item.labels },
  HostConfig: { NetworkMode: item.networkMode },
  NetworkSettings: { Networks: Object.fromEntries(item.networks.map((name) => [name, {}])) },
  Mounts: item.mounts,
})

const [command, ...rest] = args
if (state.unavailable) {
  process.stderr.write(
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'
  )
  process.exit(1)
}
if (command === 'info') finish('29.4.0')
if (command === 'ps') {
  const { flags, values } = parse(rest, ['--filter', '--format'])
  if (!flags.has('-q') && values['--format']?.[0] !== '{{.ID}}') unsupported()
  const found = state.containers.filter(
    (item) => (flags.has('-a') || item.running) && labelled(item.labels, values['--filter'])
  )
  finish(found.map((item) => item.id).join('\n'))
}
if (command === 'inspect' || (command === 'container' && rest[0] === 'inspect')) {
  const { values, positional } = parse(command === 'inspect' ? rest : rest.slice(1), ['--type'])
  if (command === 'inspect' && values['--type']?.[0] !== 'container') unsupported()
  const found = []
  for (const ref of positional) {
    const item = container(ref)
    if (item) found.push(inspectContainer(item))
    else errors.push('Error response from daemon: No such container: ' + ref)
  }
  finish(JSON.stringify(found, null, 4))
}
if (command === 'volume') {
  const [action, ...list] = rest
  const { flags, values, positional } = parse(list, ['--filter', '--format'])
  if (action === 'inspect') {
    const found = []
    for (const name of positional) {
      const item = volume(name)
      if (item) found.push({ Name: item.name, Driver: 'local', Labels: item.labels, CreatedAt: item.createdAt })
      else errors.push(`Error response from daemon: get ${name}: no such volume`)
    }
    finish(JSON.stringify(found, null, 4))
  }
  if (action === 'ls' && flags.has('-q'))
    finish(
      state.volumes
        .filter((item) => labelled(item.labels, values['--filter']))
        .map((item) => item.name)
        .join('\n')
    )
  if (action === 'rm') {
    for (const name of positional) removeVolume(name, flags.has('-f'))
    finish(positional.filter((name) => !volume(name)).join('\n'))
  }
  unsupported()
}
if (command === 'network') {
  const [action, ...names] = rest
  if (action === 'inspect') {
    const found = names.map(network).filter(Boolean)
    for (const name of names) if (!network(name)) errors.push(`Error response from daemon: network ${name} not found`)
    finish(JSON.stringify(found.map((item) => ({ Name: item.name, Labels: item.labels }))))
  }
  if (action === 'rm') {
    for (const name of names) removeNetwork(name)
    finish(names.filter((name) => !network(name)).join('\n'))
  }
  unsupported()
}
if (command === 'rm') {
  const { flags, positional } = parse(rest)
  for (const ref of positional) {
    const item = container(ref)
    if (injected('rm ' + ref)) errors.push(injected('rm ' + ref))
    else if (!item) errors.push('Error response from daemon: No such container: ' + ref)
    else if (item.running && !flags.has('-f'))
      errors.push(`Error response from daemon: cannot remove container "${ref}": container is running`)
    else removeContainer(item)
  }
  finish(positional.filter((ref) => !container(ref)).join('\n'))
}
if (command === 'stop') {
  for (const ref of rest) {
    const item = container(ref)
    if (item) item.running = false
    else errors.push('Error response from daemon: No such container: ' + ref)
  }
  finish(rest.join('\n'))
}
if (command === 'cp') {
  const [source, target] = rest
  const [ref, from] = source.split(':')
  const item = container(ref)
  if (from !== '/data/.' || !target) unsupported()
  if (!item) errors.push('Error response from daemon: No such container: ' + ref)
  else if (!item.data) errors.push(`Error response from daemon: Could not find the file /data in container ${ref}`)
  else cpSync(item.data, target, { recursive: true })
  finish()
}
if (command === 'compose') {
  const { flags, values, positional } = parse(rest, ['-p', '-f'])
  const project = values['-p']?.[0]
  const owned = (item) => item.labels?.['com.docker.compose.project'] === project
  if (!project || positional[0] !== 'down') unsupported()
  for (const item of state.containers.filter(owned)) removeContainer(item)
  for (const item of state.networks.filter(owned)) removeNetwork(item.name)
  if (flags.has('-v')) for (const item of state.volumes.filter(owned)) removeVolume(item.name)
  finish()
}
unsupported()
