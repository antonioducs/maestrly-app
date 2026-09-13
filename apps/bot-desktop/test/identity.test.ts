import { expect, it } from 'vitest'
import { identity } from '../src/main/identity'
import { readFileSync } from 'node:fs'
it('separates dev, lab and fixture data from the existing desktop', () => {
  const values = [identity('/data', false), identity('/data', true), identity('/data', false, true)]
  expect(new Set(values.map((v) => v.userData)).size).toBe(3)
  expect(values.every((v) => v.id === 'io.github.antonioducs.maestrly.bot')).toBe(true)
})
it('builds a CommonJS preload for sandboxed Electron', () => {
  expect(readFileSync('electron.vite.config.ts', 'utf8')).toContain("format: 'cjs'")
  expect(readFileSync('src/main/index.ts', 'utf8')).toContain('../preload/index.cjs')
})
