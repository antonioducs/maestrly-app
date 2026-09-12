/**
 * ask_question presents one or more questions with clickable options and free text, then waits for an answer.
 * Conceptually adapted from opencode question / Claude Code AskUserQuestion, without Effect; uses our
 * QuestionBroker through ctx.askQuestion. Questions travel in tool-call input for renderer cards;
 * answers return through the broker as the model-visible tool result.
 */
import { z } from 'zod'
import { defineTool } from './util'
import type { ChatQuestion } from '../../../shared/chat'

const optionSchema = z.object({
  label: z.string().describe('Option text displayed for the user to select (1-5 words).'),
  description: z.string().optional().describe('Short explanation of the option (tradeoffs/implications).'),
})

const questionSchema = z.object({
  header: z.string().describe('Very short chip label (up to about 12 characters), e.g. "Approach", "Library".'),
  question: z.string().describe('The complete, clear question ending with "?".'),
  multiSelect: z.boolean().optional().describe('true allows selecting multiple options.'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe('2-4 distinct options. Do not include "Other" — the card already offers free text.'),
})

const parameters = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe(
      '1-4 questions displayed in order. Put the recommended option first and append "(Recommended)" to its label.'
    ),
})

export const questionTool = defineTool<typeof parameters, { answers: string[][] }>({
  name: 'ask_question',
  description:
    'Ask the user during execution with clickable options and free text. Use this when you need a ' +
    'decision or preference that affects your work and cannot be resolved with reasonable judgment, not to ' +
    'confirm the obvious or request action approval (which has its own flow). The card always adds a ' +
    '"Write your own answer" option; do not include "Other". Answers return as labels; multiSelect allows multiple answers.',
  parameters,
  execute: async (args, ctx) => {
    const answers = await ctx.askQuestion(args.questions as ChatQuestion[])
    return { answers }
  },
  toModelText: (args, result) => {
    const anyAnswered = result.answers.some((a) => a.length > 0)
    if (!anyAnswered) return 'The user dismissed the questions without answering. Continue with your best judgment.'
    const lines = args.questions.map((q, i) => {
      const a = result.answers[i]
      return `- ${q.question} → ${a?.length ? a.join(', ') : '(no answer)'}`
    })
    return 'The user answered:\n' + lines.join('\n') + '\nContinue with these answers in mind.'
  },
})
