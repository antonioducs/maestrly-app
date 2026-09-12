/**
 * todo_write, adapted from Claude Code TodoWrite, maintains the current structured task list for agent
 * organization and user progress tracking. Every call replaces the full list. Tool-call input is streamed
 * and persisted; the renderer displays its latest version as a TodoCard. toModelText returns it to the model.
 */
import { z } from 'zod'
import { defineTool } from './util'

const todoSchema = z.object({
  content: z.string().min(1).describe('Short, outcome-focused task description.'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe('pending = not started; in_progress = ongoing (only ONE at a time); completed = done.'),
})

const parameters = z.object({
  todos: z
    .array(todoSchema)
    .describe('The FULL current task list — this call REPLACES the previous list (it is not incremental).'),
})

export const todoWriteTool = defineTool<typeof parameters, { count: number; done: number }>({
  name: 'todo_write',
  description:
    'Maintain a structured to-do list for the current multi-step task so you stay organized and the user can ' +
    'track progress. Call it with the FULL list each time (it REPLACES the previous one): keep exactly one item ' +
    'in_progress while you work on it and flip it to completed as soon as it is done, then start the next. Use it ' +
    'for non-trivial work (3+ steps or distinct parts); skip it for simple one-shot answers. Keep items short and ' +
    'outcome-focused. This does not run anything — it only records the plan.',
  parameters,
  execute: async (args) => ({
    count: args.todos.length,
    done: args.todos.filter((t) => t.status === 'completed').length,
  }),
  toModelText: (args) => {
    if (args.todos.length === 0) return 'To-do list cleared.'
    const mark = (s: string) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]')
    return 'To-do list (current):\n' + args.todos.map((t) => `${mark(t.status)} ${t.content}`).join('\n')
  },
})
