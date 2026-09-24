import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { desktopCapturer, screen } from 'electron'
import { z } from 'zod'
import type { McpToolContext } from './context'
import { err, ok } from './context'

const keyPattern = /^[A-Za-z0-9_+ -]{1,64}$/
const coordinate = z.number().int().nonnegative()
const description =
  'Use for desktop apps outside the Maestrly browser. Prefer browser_* for websites. Coordinates are screen pixels from the last computer_screenshot.'
let xdotoolAvailable: boolean | null = null
let screenActionGeneration = 0
const runningActions = new Set<ChildProcess>()
const interrupted = 'interrupted: the owner took over / paused.'

export function abortScreenActions(): void {
  screenActionGeneration++
  for (const child of runningActions) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (runningActions.has(child)) child.kill('SIGKILL')
    }, 250)
    timer.unref()
  }
}

function checkScreenAction(generation: number): void {
  if (generation !== screenActionGeneration) throw new Error(interrupted)
}

export function canUseComputer(platform = process.platform, display = process.env.DISPLAY): boolean {
  if (platform !== 'linux' || !display) return false
  if (xdotoolAvailable === null) {
    const result = spawnSync('xdotool', ['--version'], { timeout: 2_000, stdio: 'ignore' })
    xdotoolAvailable = !result.error && result.status === 0
  }
  return xdotoolAvailable
}

function dimensions(): { width: number; height: number } {
  const { width, height } = screen.getPrimaryDisplay().size
  if (width < 1 || height < 1) throw new Error('The primary screen has invalid dimensions.')
  return { width, height }
}

export function computerArguments(
  action: 'click' | 'move' | 'drag' | 'scroll' | 'type' | 'key',
  input: Record<string, unknown>,
  size: { width: number; height: number }
): string[][] {
  const point = (x: unknown, y: unknown): [string, string] => {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      (x as number) < 0 ||
      (y as number) < 0 ||
      (x as number) >= size.width ||
      (y as number) >= size.height
    )
      throw new Error(`Coordinates must be integer screen pixels within 0..${size.width - 1}, 0..${size.height - 1}.`)
    return [String(x), String(y)]
  }
  if (action === 'move') return [['mousemove', '--sync', ...point(input.x, input.y)]]
  if (action === 'click') {
    const button = { left: '1', middle: '2', right: '3' }[String(input.button ?? 'left')]
    if (!button) throw new Error('Button must be left, middle, or right.')
    return [
      ['mousemove', '--sync', ...point(input.x, input.y)],
      ['click', ...(input.double ? ['--repeat', '2'] : []), button],
    ]
  }
  if (action === 'drag')
    return [
      ['mousemove', '--sync', ...point(input.fromX, input.fromY)],
      ['mousedown', '1'],
      ['mousemove', '--sync', ...point(input.toX, input.toY)],
      ['mouseup', '1'],
    ]
  if (action === 'scroll') {
    const direction = { up: '4', down: '5', left: '6', right: '7' }[String(input.direction)]
    const amount = input.amount ?? 1
    if (!direction || !Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > 20)
      throw new Error('Scroll requires a direction and an amount from 1 to 20.')
    return [
      ['mousemove', '--sync', ...point(input.x, input.y)],
      ['click', '--repeat', String(amount), direction],
    ]
  }
  if (action === 'type') {
    if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 4_000)
      throw new Error('Text must contain 1–4000 characters.')
    return Array.from({ length: Math.ceil(input.text.length / 200) }, (_, index) => [
      'type',
      '--delay',
      '12',
      '--',
      (input.text as string).slice(index * 200, (index + 1) * 200),
    ])
  }
  if (typeof input.keys !== 'string' || !keyPattern.test(input.keys) || !input.keys.trim())
    throw new Error(
      'Keys must use xdotool keysyms (letters, digits, underscore, plus, hyphen, or spaces; at most 64 characters).'
    )
  return [['key', '--clearmodifiers', '--', ...input.keys.trim().split(/ +/)]]
}

export async function runXdotool(
  args: string[],
  signal?: AbortSignal,
  generation = screenActionGeneration
): Promise<void> {
  checkScreenAction(generation)
  await new Promise<void>((resolve, reject) => {
    const child = spawn('xdotool', args, { stdio: ['ignore', 'ignore', 'pipe'], signal })
    runningActions.add(child)
    let stderr = ''
    let processError: Error | null = null
    const timer = setTimeout(() => child.kill(), 5_000)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 300)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      processError = error
      if (child.pid === undefined) {
        runningActions.delete(child)
        reject(error)
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      runningActions.delete(child)
      if (processError) reject(processError)
      else if (code === 0) resolve()
      else
        reject(
          new Error(
            code === null
              ? 'xdotool timed out or was interrupted.'
              : `xdotool exited with code ${code}: ${stderr.trim() || 'no details'}`
          )
        )
    })
  })
  checkScreenAction(generation)
}

export function registerComputerTools(ctx: McpToolContext): void {
  const { server } = ctx
  server.registerTool(
    'computer_screenshot',
    {
      description: `Capture the whole primary desktop screen as PNG. ${description}`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const { width, height } = dimensions()
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
        const source =
          sources.find((candidate) => candidate.display_id === String(screen.getPrimaryDisplay().id)) ?? sources[0]
        if (!source || source.thumbnail.isEmpty())
          return err('Could not capture the primary screen. Check DISPLAY and screen permissions.')
        return {
          content: [
            { type: 'image' as const, data: source.thumbnail.toPNG().toString('base64'), mimeType: 'image/png' },
            {
              type: 'text' as const,
              text: `Screen: ${width} × ${height} pixels. Coordinates for computer_* are screen pixels from this screenshot.`,
            },
          ],
        }
      } catch (error) {
        return err(`Screen capture failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  )

  const action = <T extends Record<string, unknown>>(
    name: 'click' | 'move' | 'drag' | 'scroll' | 'type' | 'key',
    schema: Record<string, z.ZodType>,
    summary: string
  ): void => {
    server.registerTool(
      `computer_${name}`,
      {
        description: `${summary} ${description}`,
        inputSchema: schema,
        annotations: { readOnlyHint: false },
      },
      async (args, extra) => {
        let buttonDown = false
        const generation = screenActionGeneration
        try {
          const commands = computerArguments(name, args as T, dimensions())
          const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(5_000)])
          for (const command of commands) {
            checkScreenAction(generation)
            if (command[0] === 'mousedown') buttonDown = true
            await runXdotool(command, signal, generation)
            if (command[0] === 'mouseup') buttonDown = false
          }
          await new Promise((resolve) => setTimeout(resolve, 150))
          checkScreenAction(generation)
          return ok(`Desktop ${name} completed.`)
        } catch (error) {
          if (buttonDown) await runXdotool(['mouseup', '1']).catch(() => undefined)
          return err(
            `Desktop ${name} failed: ${generation !== screenActionGeneration ? interrupted : error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    )
  }
  action(
    'click',
    {
      x: coordinate,
      y: coordinate,
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional(),
    },
    'Click the desktop at a screen coordinate.'
  )
  action('move', { x: coordinate, y: coordinate }, 'Move the desktop pointer.')
  action(
    'drag',
    { fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate },
    'Drag with the left mouse button.'
  )
  action(
    'scroll',
    {
      x: coordinate,
      y: coordinate,
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(20).optional(),
    },
    'Scroll the desktop.'
  )
  action('type', { text: z.string().min(1).max(4_000) }, 'Type text into the focused desktop app.')
  action('key', { keys: z.string().regex(keyPattern) }, 'Press xdotool keysyms such as ctrl+s or Return.')
}
