// npm.cmd cannot be spawned with shell:false on Windows. Invoke its JS entry
// through the current Node executable, preserving arguments and paths with spaces.
export function nodeCommand(command, args, env = process.env) {
  if (command === 'npm' && env.npm_execpath) {
    return { command: process.execPath, args: [env.npm_execpath, ...args] }
  }
  if (command === 'npm' && process.platform === 'win32') {
    throw new Error('Run this script through npm so npm_execpath is available.')
  }
  return { command: command === 'node' ? process.execPath : command, args }
}
