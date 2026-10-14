import { z } from 'zod'
import { cn } from '../lib/utils'
import { action, createLibrary, defineFunction, isActionPlan, reactive } from './lang'
import { defineGenUiComponent, type GenUiLibrary, useBinding, useGenUiAction, useGenUiLive } from './runtime'

// The catalog the model may compose in ```openui-lang blocks. Each schema's key order is the positional argument
// order the model writes, and each description is copied into the prompt: change them together with the prompt.

const TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
type Tone = (typeof TONES)[number]
const toneClass: Record<Tone, string> = {
  neutral: 'border-white/[0.1] bg-white/[0.04] text-foreground/80',
  info: 'border-sky-400/25 bg-sky-400/[0.08] text-sky-200',
  success: 'border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-200',
  warning: 'border-amber-400/25 bg-amber-400/[0.08] text-amber-200',
  danger: 'border-rose-400/25 bg-rose-400/[0.08] text-rose-200',
}
const gapClass = { s: 'gap-1.5', m: 'gap-3', l: 'gap-5' } as const

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
/** Text of a computed value; objects, which a program may produce by mistake, show as nothing. */
function display(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? numberFormat.format(value) : ''
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  return ''
}
const numbers = (values: unknown): number[] =>
  (Array.isArray(values) ? values : []).map((value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  )
const list = (values: unknown): unknown[] => (Array.isArray(values) ? values : [])

const Stack = defineGenUiComponent({
  name: 'Stack',
  description: 'Layout container; the root of every program. direction "column" (default) or "row"; gap "s"|"m"|"l".',
  props: z.object({
    children: z.array(z.any()),
    direction: z.enum(['column', 'row']).optional(),
    gap: z.enum(['s', 'm', 'l']).optional(),
  }),
  component: ({ props, renderNode }) => (
    <div
      className={cn(
        'flex min-w-0',
        props.direction === 'row' ? 'flex-row flex-wrap items-stretch [&>*]:min-w-[140px] [&>*]:flex-1' : 'flex-col',
        gapClass[props.gap ?? 'm']
      )}
    >
      {renderNode(props.children)}
    </div>
  ),
})

const Card = defineGenUiComponent({
  name: 'Card',
  description: 'Bordered panel grouping related content, with an optional title.',
  props: z.object({ children: z.array(z.any()), title: z.string().optional() }),
  component: ({ props, renderNode }) => (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
      {props.title && <h4 className="m-0 text-[13px] font-semibold text-foreground">{display(props.title)}</h4>}
      {renderNode(props.children)}
    </section>
  ),
})

const Text = defineGenUiComponent({
  name: 'Text',
  description:
    'Text. variant "body" (default), "heading", "muted" or "code". Use string concatenation for live values.',
  props: z.object({
    content: z.string(),
    variant: z.enum(['body', 'heading', 'muted', 'code']).optional(),
  }),
  component: ({ props }) => {
    const variant = props.variant ?? 'body'
    if (variant === 'code')
      return <code className="w-fit rounded bg-black/30 px-1.5 py-0.5 text-[12px]">{display(props.content)}</code>
    return (
      <p
        className={cn(
          'm-0 whitespace-pre-wrap',
          variant === 'heading' && 'text-[15px] font-semibold text-foreground',
          variant === 'muted' && 'text-[12px] text-muted-foreground',
          variant === 'body' && 'text-[13px] text-foreground/90'
        )}
      >
        {display(props.content)}
      </p>
    )
  },
})

const Badge = defineGenUiComponent({
  name: 'Badge',
  description: 'Small status label. tone "neutral" (default), "info", "success", "warning" or "danger".',
  props: z.object({ text: z.string(), tone: z.enum(TONES).optional() }),
  component: ({ props }) => (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
        toneClass[props.tone ?? 'neutral']
      )}
    >
      {display(props.text)}
    </span>
  ),
})

const Callout = defineGenUiComponent({
  name: 'Callout',
  description: 'Highlighted note, e.g. a caveat or a recommendation. tone as in Badge (default "info").',
  props: z.object({ content: z.string(), tone: z.enum(TONES).optional() }),
  component: ({ props }) => (
    <div className={cn('rounded-md border px-3 py-2 text-[13px]', toneClass[props.tone ?? 'info'])}>
      {display(props.content)}
    </div>
  ),
})

const Stat = defineGenUiComponent({
  name: 'Stat',
  description: 'A key figure: label, value (number or text) and an optional hint below it.',
  props: z.object({
    label: z.string(),
    value: z.union([z.number(), z.string()]),
    hint: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{display(props.label)}</span>
      <span className="text-xl font-semibold tabular-nums text-foreground">{display(props.value)}</span>
      {props.hint && <span className="text-[11px] text-muted-foreground">{display(props.hint)}</span>}
    </div>
  ),
})

const Table = defineGenUiComponent({
  name: 'Table',
  description: 'Table: column headers and rows, each row an array of cell values in column order.',
  props: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.any())),
  }),
  component: ({ props }) => (
    <div className="min-w-0 overflow-x-auto rounded-md border border-white/[0.08]">
      <table className="m-0 w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {list(props.columns).map((column, i) => (
              <th
                key={i}
                className="border-b border-white/[0.08] px-2 py-1.5 text-left font-medium text-muted-foreground"
              >
                {display(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list(props.rows).map((row, r) => (
            <tr key={r} className="border-b border-white/[0.04] last:border-0">
              {list(row).map((cell, c) => (
                <td key={c} className={cn('px-2 py-1.5', typeof cell === 'number' && 'text-right tabular-nums')}>
                  {display(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
})

// Each component owns its props schema: the library names a schema after the component that defined it.
const chartProps = () =>
  z.object({
    labels: z.array(z.string()),
    values: z.array(z.number()),
    unit: z.string().optional(),
  })

const BarChart = defineGenUiComponent({
  name: 'BarChart',
  description: 'Vertical bar chart: one label per value. Values may be computed from $state.',
  props: chartProps(),
  component: ({ props }) => {
    const values = numbers(props.values)
    const labels = list(props.labels)
    const max = Math.max(0, ...values) || 1
    return (
      <div className="flex h-40 min-w-0 items-end gap-1.5 pt-4" role="img" aria-label={labels.map(display).join(', ')}>
        {values.map((value, i) => (
          <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {display(value)}
              {props.unit ? ` ${display(props.unit)}` : ''}
            </span>
            <div
              className="w-full max-w-10 rounded-t bg-primary/70 transition-[height] duration-300"
              style={{ height: `${Math.max(2, (Math.max(0, value) / max) * 100)}%` }}
            />
            <span className="w-full truncate text-center text-[10px] text-muted-foreground">{display(labels[i])}</span>
          </div>
        ))}
      </div>
    )
  },
})

const LineChart = defineGenUiComponent({
  name: 'LineChart',
  description: 'Line chart over ordered labels (e.g. years). Values may be computed from $state.',
  props: chartProps(),
  component: ({ props }) => {
    const values = numbers(props.values)
    const labels = list(props.labels)
    if (values.length === 0) return null
    const min = Math.min(0, ...values)
    const span = Math.max(...values) - min || 1
    const x = (i: number) => (values.length === 1 ? 50 : (i / (values.length - 1)) * 100)
    const y = (value: number) => 100 - ((value - min) / span) * 100
    return (
      <figure className="m-0 flex min-w-0 flex-col gap-1">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-36 w-full overflow-visible" role="img">
          <polyline
            points={values.map((value, i) => `${x(i)},${y(value)}`).join(' ')}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            className="text-primary"
          />
        </svg>
        <figcaption className="flex justify-between text-[10px] text-muted-foreground">
          <span>{display(labels[0])}</span>
          <span className="tabular-nums text-foreground/80">
            {display(values[values.length - 1])}
            {props.unit ? ` ${display(props.unit)}` : ''}
          </span>
          <span>{display(labels[labels.length - 1])}</span>
        </figcaption>
      </figure>
    )
  },
})

const fieldClass = 'flex min-w-0 flex-col gap-1 text-[12px] text-muted-foreground'

const Slider = defineGenUiComponent({
  name: 'Slider',
  description: 'Numeric slider bound to a $state number: Slider($years, 1, 40, 1, "Years").',
  props: z.object({
    value: reactive(z.number()),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    label: z.string().optional(),
  }),
  component: ({ props }) => {
    const live = useGenUiLive()
    const [value, setValue] = useBinding<number>(props.value, props.min)
    return (
      <label className={fieldClass}>
        <span className="flex justify-between">
          <span>{display(props.label)}</span>
          <span className="tabular-nums text-foreground">{display(value)}</span>
        </span>
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={typeof value === 'number' ? value : props.min}
          disabled={live}
          onChange={(event) => setValue(Number(event.target.value))}
          className="w-full accent-primary"
        />
      </label>
    )
  },
})

const Select = defineGenUiComponent({
  name: 'Select',
  description: 'Dropdown bound to a $state string: Select($plan, ["Free", "Pro"], "Plan").',
  props: z.object({
    value: reactive(z.string()),
    options: z.array(z.string()),
    label: z.string().optional(),
  }),
  component: ({ props }) => {
    const live = useGenUiLive()
    const [value, setValue] = useBinding<string>(props.value, '')
    const options = list(props.options).map(display)
    return (
      <label className={fieldClass}>
        {display(props.label)}
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={live}
          onChange={(event) => setValue(event.target.value)}
          className="h-8 rounded-md border border-input bg-black/20 px-2 text-[13px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {options.map((option, i) => (
            <option key={i} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    )
  },
})

const Toggle = defineGenUiComponent({
  name: 'Toggle',
  description: 'Checkbox bound to a $state boolean: Toggle($tips, "Include tips").',
  props: z.object({
    value: reactive(z.boolean()),
    label: z.string(),
  }),
  component: ({ props }) => {
    const live = useGenUiLive()
    const [value, setValue] = useBinding<boolean>(props.value, false)
    return (
      <label className="flex w-fit items-center gap-2 text-[13px] text-foreground/90">
        <input
          type="checkbox"
          checked={value === true}
          disabled={live}
          onChange={(event) => setValue(event.target.checked)}
          className="accent-primary"
        />
        {display(props.label)}
      </label>
    )
  },
})

const TextInput = defineGenUiComponent({
  name: 'TextInput',
  description: 'Single-line text field bound to a $state string: TextInput($name, "Name", "Placeholder").',
  props: z.object({
    value: reactive(z.string()),
    label: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  component: ({ props }) => {
    const live = useGenUiLive()
    const [value, setValue] = useBinding<string>(props.value, '')
    return (
      <label className={fieldClass}>
        {display(props.label)}
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          placeholder={display(props.placeholder)}
          disabled={live}
          onChange={(event) => setValue(event.target.value)}
          className="h-8 rounded-md border border-input bg-black/20 px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>
    )
  },
})

const Button = defineGenUiComponent({
  name: 'Button',
  description:
    'Button. Without an action it sends its label to the assistant as the user. variant "primary" (default) or "secondary".',
  props: z.object({
    label: z.string(),
    action: action().optional(),
    variant: z.enum(['primary', 'secondary']).optional(),
  }),
  component: ({ props }) => {
    const live = useGenUiLive()
    const { run, canSend } = useGenUiAction()
    const label = display(props.label)
    const plan = isActionPlan(props.action) ? props.action : null
    const sends = props.action == null || !!plan?.steps.some((step) => step.type === 'continue_conversation')
    // The address a button opens shows on hover, like a link's
    const url = plan?.steps.find((step) => step.type === 'open_url')?.url
    return (
      <button
        type="button"
        disabled={live || (sends && !canSend)}
        title={url}
        onClick={() => run(label, props.action)}
        className={cn(
          'inline-flex h-8 w-fit items-center rounded-md px-3 text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
          props.variant === 'secondary'
            ? 'border border-input bg-transparent text-foreground hover:bg-accent'
            : 'bg-primary text-primary-foreground hover:bg-primary/90'
        )}
      >
        {label}
      </button>
    )
  },
})

// The language has arithmetic but no exponent or sequences, which every growth calculator needs.
const MAX_RANGE = 200

const Pow = defineFunction({
  name: 'Pow',
  description: 'base raised to exponent, e.g. @Pow(1 + $rate / 100, $years)',
  params: z.object({ base: z.number(), exponent: z.number() }),
  returns: z.number(),
  fn: ({ base, exponent }) => base ** exponent,
})

const Range = defineFunction({
  name: 'Range',
  description: `Numbers from start to end inclusive (at most ${MAX_RANGE}), e.g. @Range(1, $years) for chart labels or @Each`,
  params: z.object({ start: z.number(), end: z.number(), step: z.number().optional() }),
  returns: z.array(z.number()),
  fn: ({ start, end, step }) => {
    const by = step && step > 0 ? step : 1
    const out: number[] = []
    for (let n = start; n <= end && out.length < MAX_RANGE; n += by) out.push(n)
    return out
  },
})

export const genUiLibrary: GenUiLibrary = createLibrary({
  root: 'Stack',
  functions: [Pow, Range],
  components: [
    Stack,
    Card,
    Text,
    Badge,
    Callout,
    Stat,
    Table,
    BarChart,
    LineChart,
    Slider,
    Select,
    Toggle,
    TextInput,
    Button,
  ],
  componentGroups: [
    { name: 'Layout', components: ['Stack', 'Card'] },
    { name: 'Content', components: ['Text', 'Badge', 'Callout', 'Stat', 'Table'] },
    { name: 'Charts', components: ['BarChart', 'LineChart'] },
    { name: 'Inputs', components: ['Slider', 'Select', 'Toggle', 'TextInput', 'Button'] },
  ],
})
