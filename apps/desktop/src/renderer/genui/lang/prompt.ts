// Adapted from OpenUI lang-core (packages/lang-core/src/parser/prompt.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt. Only the variant this app uses is kept: $state bindings and expressions on,
// no Query/Mutation, tools, forms, edit or inline mode. The section texts are upstream's for that variant, one heading
// level down: they sit under the app's own section about interactive answers.

import { BUILTIN_STEPS, BUILTINS } from './builtins'
import { schemaSignature } from './signature'

export interface ComponentPromptSpec {
  /** Pre-built, e.g. "Card(children: any[], title?: string)". */
  signature: string
  description?: string
}

export interface PromptOptions {
  /** Opening section: what the interfaces are for and when to use them. */
  preamble: string
  examples?: string[]
  additionalRules?: string[]
}

export interface PromptSpec extends PromptOptions {
  root: string
  components: Record<string, ComponentPromptSpec>
  componentGroups?: { name: string; components: string[]; notes?: string[] }[]
  functions?: Record<string, ComponentPromptSpec>
}

function syntaxRules(rootName: string): string {
  return [
    '### Syntax Rules',
    '',
    '1. Each statement is on its own line: `identifier = Expression`',
    `2. \`root\` is the entry point — every program must define \`root = ${rootName}(...)\``,
    '3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)',
    '4. Use references for readability: define `name = ...` on one line, then use `name` later',
    "5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.",
    '6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks',
    '7. Optional arguments can be omitted from the end',
    '8. Declare mutable state with `$varName = defaultValue`. Components marked with `$binding` can read/write these. Undeclared $variables are auto-created with null default.',
    '9. String concatenation: `"text" + $var + "more"`',
    '10. Dot member access: `query.field` reads a field; on arrays it extracts that field from every element',
    '11. Index access: `arr[0]`, `data[index]`',
    '12. Arithmetic operators: +, -, *, /, % (work on numbers; + is string concat when either side is a string)',
    '13. Comparison: ==, !=, >, <, >=, <=',
    '14. Logical: &&, ||, ! (prefix)',
    '15. Ternary: `condition ? valueIfTrue : valueIfFalse`',
    '16. Parentheses for grouping: `(a + b) * c`',
    '- Strings use double quotes with backslash escaping',
  ].join('\n')
}

function functionLine(f: { signature: string; description?: string }): string {
  return f.description ? `@${f.signature} — ${f.description}` : `@${f.signature}`
}

function builtinFunctionsSection(custom: string[]): string {
  const lines = [
    ...Object.values(BUILTINS).map((b) =>
      functionLine({ ...b, signature: schemaSignature(b.name, b.params, b.returns) })
    ),
    ...custom,
  ].join('\n')

  return `### Built-in Functions

Data functions prefixed with \`@\` to distinguish from components. These are the ONLY functions available — do NOT invent new ones.
Use @-prefixed built-in functions (@Count, @Sum, @Avg, @Min, @Max, @Round) on data. Do NOT hardcode computed values.

${lines}

Builtins compose — output of one is input to the next:
\`@Count(@Filter(data.rows, "field", "==", "val"))\` for KPIs/chart values, \`@Round(@Avg(data.rows.score), 1)\`, \`@Each(data.rows, "item", Comp(item.field))\` for per-item rendering.
Array pluck: \`data.rows.field\` extracts a field from every row → use with @Sum, @Avg, charts, tables.

IMPORTANT @Each rule: The loop variable (e.g. "item") is ONLY available inside the @Each template expression. Always inline the template — do NOT extract it to a separate statement.
CORRECT: \`list = @Each(rows, "t", Comp(t.name))\`
WRONG: \`item = Comp(t.name)\` then \`list = @Each(rows, "t", item)\`, because t does not exist outside the template.`
}

function actionSection(): string {
  const steps = Object.values(BUILTIN_STEPS).map(
    (s) => `- ${functionLine({ ...s, signature: schemaSignature(s.name, s.params) })}`
  )
  return `### Action — Button Behavior

An action wires a button click to operations. Pass one @-prefixed step bare, e.g. Button("Ask", @ToAssistant("Tell me more")). Put several steps in Action([...]), e.g. Button("Read", Action([@OpenUrl("https://example.com"), @ToAssistant("Summarize this page")])). Steps execute in order.
Buttons without an action automatically send their label to the assistant (equivalent to @ToAssistant(label)).

Available steps:
${steps.join('\n')}

Example — simple nav:
\`\`\`
viewBtn = Button("View", @OpenUrl("https://example.com"))
\`\`\`

- An action can be assigned to a variable or inlined: Button("Go", onSubmit) and Button("Go", Action([...])) both work`
}

function streamingRules(rootName: string): string {
  return `### Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. \`root = ${rootName}(...)\` — UI shell appears immediately
2. $variable declarations — state ready for bindings
3. Component definitions — fill in with data already available
4. Data values — leaf content last

Always write the root = ${rootName}(...) statement first so the UI shell appears immediately, even before child data has streamed in.`
}

function importantRules(rootName: string): string {
  return `### Important Rules
- Choose components that best represent the content (tables for comparisons, charts for trends, forms for input, etc.)

### Final Verification
Before finishing, walk your output and verify:
1. root = ${rootName}(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.
3. Every $binding appears in at least one component or expression.`
}

const RESTRICTED_SLOT = /[:|] @[A-Z]/

function componentSignatures(spec: PromptSpec): string {
  const lines = [
    '### Component Signatures',
    '',
    'Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.',
  ]
  const usesActions = Object.values(spec.components).some(
    (c) => c.signature.includes('ActionExpression') || RESTRICTED_SLOT.test(c.signature)
  )
  if (usesActions) {
    const steps = Object.keys(BUILTIN_STEPS).map((name) => `@${name}`)
    lines.push(
      `Props typed \`ActionExpression\` accept one @step, or Action([@steps...]) for several. See the Action section for available steps (${steps.join(', ')}).`
    )
  }
  lines.push('Props marked `$binding<type>` accept a `$variable` reference for two-way binding.')

  const formatSig = (comp: ComponentPromptSpec) =>
    comp.description ? `${comp.signature} — ${comp.description}` : comp.signature
  const grouped = new Set<string>()
  for (const group of spec.componentGroups ?? []) {
    lines.push('', `#### ${group.name}`)
    for (const name of group.components) {
      const comp = spec.components[name]
      if (grouped.has(name) || !comp) continue
      grouped.add(name)
      lines.push(formatSig(comp))
    }
    for (const note of group.notes ?? []) lines.push(note)
  }
  const ungrouped = Object.keys(spec.components).filter((name) => !grouped.has(name))
  if (ungrouped.length) {
    lines.push('', ...(spec.componentGroups?.length ? ['#### Other'] : []))
    for (const name of ungrouped) lines.push(formatSig(spec.components[name]))
  }
  return lines.join('\n')
}

/** The system prompt section that teaches a model the language and this library's components. */
export function generatePrompt(spec: PromptSpec): string {
  const parts: string[] = [
    spec.preamble,
    '',
    syntaxRules(spec.root),
    '',
    componentSignatures(spec),
    '',
    builtinFunctionsSection(Object.values(spec.functions ?? {}).map(functionLine)),
    '',
    actionSection(),
    '',
    streamingRules(spec.root),
  ]
  if (spec.examples?.length) {
    parts.push('', '### Examples', '')
    for (const example of spec.examples) parts.push(example, '')
  }
  parts.push(importantRules(spec.root))
  if (spec.additionalRules?.length) {
    parts.push('')
    for (const rule of spec.additionalRules) parts.push(`- ${rule}`)
  }
  return parts.join('\n')
}
