import { describe, expect, it } from 'vitest'
import { run } from '../src/main.js'

describe('gateway CLI skeleton', () => {
  it('reports the shared protocol version', () => {
    const output: string[] = []
    expect(run(['--version'], (line) => output.push(line))).toBe(0)
    expect(output).toEqual(['0.1.0 (protocol 1)'])
  })

  it('accepts the planned commands without starting a service', () => {
    for (const command of ['serve', 'pair', 'devices', 'doctor']) {
      const output: string[] = []
      expect(run([command], (line) => output.push(line))).toBe(0)
      expect(output).toEqual(['not implemented'])
    }
  })
})
