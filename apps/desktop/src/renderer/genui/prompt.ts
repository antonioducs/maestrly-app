import type { PromptOptions } from './lang'

// Options of the catalog prompt. The prompt itself is generated into src/main/chat/harness/genui-prompt.ts, and the
// genui test fails while the two disagree (UPDATE_GENUI_PROMPT=1 rewrites it).

const PREAMBLE = `# Generated interfaces (openui-lang)

Besides Markdown, this chat renders small interactive interfaces written in openui-lang inside a \`\`\`openui-lang fenced block. Use one ONLY when interaction or visual structure clearly beats prose: a calculator or estimate whose inputs the person will vary, numbers that read better as a chart, figures or a comparison to scan, or a choice among options that should come back to you. Answer in plain Markdown otherwise: explanations, code, short answers, and diagrams (use Mermaid for those).

- At most one block per answer, introduced by a short Markdown sentence. Inside the fence write only openui-lang, as specified below.
- Interfaces run locally: they cannot call tools, fetch data or read files. Put every value they show in the program, and never invent figures you did not get from the conversation or your tools.
- You do not see what the person does in an interface. Only a button with @ToAssistant sends you a message, as the person: put the values that matter in its text.
- Labels follow the person's language.`

const SAVINGS_EXAMPLE = `root = Stack([title, inputs, figures, chart])
$monthly = 200
$rate = 5
$years = 20
title = Text("Savings projection", "heading")
inputs = Card([monthly, rate, years])
monthly = Slider($monthly, 50, 2000, 50, "Monthly deposit ($)")
rate = Slider($rate, 0, 12, 0.5, "Annual return (%)")
years = Slider($years, 1, 40, 1, "Years")
figures = Stack([balance, deposited], "row")
balance = Stat("Final balance", @Round($rate == 0 ? $monthly * 12 * $years : $monthly * 12 * (@Pow(1 + $rate / 100, $years) - 1) / ($rate / 100)), "Deposits compounded yearly")
deposited = Stat("Deposited", $monthly * 12 * $years)
chart = LineChart(@Each(@Range(1, $years), "y", "Year " + y), @Each(@Range(1, $years), "y", @Round($rate == 0 ? $monthly * 12 * y : $monthly * 12 * (@Pow(1 + $rate / 100, y) - 1) / ($rate / 100))), "$")`

const CHOICE_EXAMPLE = `root = Stack([question, approach, notes, go])
$approach = "Incremental migration"
question = Text("Which migration should I plan?", "heading")
approach = Select($approach, ["Incremental migration", "Big-bang rewrite", "Adapter layer"], "Approach")
notes = Callout("Incremental keeps the app shippable; big-bang is faster but blocks releases.", "info")
go = Button("Plan this approach", @ToAssistant("Plan the " + $approach))`

export const GENUI_PROMPT_OPTIONS: PromptOptions = {
  preamble: PREAMBLE,
  examples: [SAVINGS_EXAMPLE, CHOICE_EXAMPLE],
  additionalRules: [
    'Keep programs short, usually under 25 statements; split nothing across several fences.',
    'Derive changing figures with expressions over $state so they update live; never precompute them as literals.',
  ],
}
