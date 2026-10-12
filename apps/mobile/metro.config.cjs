const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const config = getDefaultConfig(projectRoot)
// Web and desktop use another React. React Native's renderer must load the React this app pins,
// wherever npm hoisted react-native, or it fails with "Incompatible React versions".
const PINNED = new Set(['react', 'react-dom'])
const fromApp = path.join(projectRoot, 'package.json')
const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest
  const pinned = PINNED.has(moduleName.split('/')[0])
  return resolve(pinned ? { ...context, originModulePath: fromApp } : context, moduleName, platform)
}
module.exports = config
module.exports.pinnedResolver = config.resolver.resolveRequest
