import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const app = path.resolve(import.meta.dirname, '..')

describe('React for the native renderer', () => {
  it('installs the React version Expo SDK 57 renders with', () => {
    const bundled = require(require.resolve('expo/bundledNativeModules.json', { paths: [app] }))
    const react = require(require.resolve('react/package.json', { paths: [app] }))
    expect(react.version).toBe(bundled.react)
  })
  it('resolves react from the app wherever react-native was hoisted', () => {
    const { pinnedResolver } = require(path.join(app, 'metro.config.cjs'))
    const seen: string[] = []
    const context = {
      originModulePath: path.join(app, '../../node_modules/react-native/index.js'),
      resolveRequest: (ctx: { originModulePath: string }, name: string) => {
        seen.push(`${name}@${ctx.originModulePath}`)
        return { type: 'empty' }
      },
    }
    pinnedResolver(context, 'react/jsx-runtime', 'ios')
    pinnedResolver(context, 'react-native-svg', 'ios')
    expect(seen).toEqual([
      `react/jsx-runtime@${path.join(app, 'package.json')}`,
      `react-native-svg@${context.originModulePath}`,
    ])
  })
})
