import { GENUI_WIDGET_CDN_SOURCES } from '../../shared/genui-widget-frame'
import { GENUI_WIDGET_THEME_KEYS } from '../../shared/genui-widget'
import type { PromptOptions } from './lang'
import { genUiLibrary } from './library'

// The system prompt section about interactive answers. It is generated into src/main/chat/harness/genui-prompt.ts,
// and the genui test fails while the two disagree (UPDATE_GENUI_PROMPT=1 rewrites it).

const FENCE = '```'

const OVERVIEW = `# Interactive answers

Besides Markdown, this chat renders two kinds of fenced blocks as live interfaces inside the answer:

- ${FENCE}openui-lang: native components in the app's own style (layout, text, figures, tables, bar and line charts, sliders, selects, toggles, text fields, buttons). Short to write and fast to show. Use it for calculators and estimates the person will vary, figures and comparisons to scan, and choices that should come back to you. It cannot show images.
- ${FENCE}inline-html: a self-contained HTML fragment with its own CSS and JavaScript, shown in an isolated frame. Use it when the native components cannot do the job: pictures (product photos, galleries, cards with images), custom visual layouts, SVG or canvas diagrams and simulations, animations, small games.

Use an interface only when interaction or visual structure clearly beats prose. Answer in plain Markdown otherwise: explanations, code, short answers, and Mermaid for flow diagrams.

- Mix them with Markdown freely: text, a block, more text, another block. Each block appears as soon as its closing fence arrives, while you keep writing. Use several blocks when the answer has distinct parts, and keep each one focused.
- Inside a fence write only that block's language.
- Prefer openui-lang when it can show what you need: it costs a fraction of the tokens of HTML.
- Interfaces cannot call tools, read files or fetch data. Put every value they show in the block, and never invent figures, links or image URLs you did not get from the conversation or your tools.
- You do not see what the person does in an interface. Only an explicit action sends you a message, as the person: @ToAssistant in openui-lang, maestrly.send(text) in inline-html. Put the values that matter in its text.
- Labels follow the person's language.`

const OPENUI_INTRO = `## openui-lang blocks

The language and the components available inside ${FENCE}openui-lang fences.`

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
  preamble: OPENUI_INTRO,
  examples: [SAVINGS_EXAMPLE, CHOICE_EXAMPLE],
  additionalRules: [
    'Keep each program short, usually under 25 statements, and whole in one fence: separate fences are separate programs that share no state.',
    'Derive changing figures with expressions over $state so they update live; never precompute them as literals.',
  ],
}

/** Example of the prompt: cards with pictures and a question back to the assistant, built from the frame's classes. */
export const LISTINGS_HTML_EXAMPLE = `<div class="ui-grid">
  <article class="ui-card">
    <img class="ui-media" src="https://images.example.com/listing-1.jpg" alt="Mac mini M4, 16 GB">
    <strong>Mac mini M4 · 16 GB · 256 GB</strong>
    <div class="ui-row"><span class="ui-stat-value">R$ 4,299</span><span class="ui-badge ui-success">Like new</span></div>
    <button class="ui-btn-primary" data-ask="Tell me more about the Mac mini M4 16 GB listing at R$ 4,299">Ask about this one</button>
  </article>
</div>
<script>
  document.querySelectorAll('[data-ask]').forEach((button) => button.addEventListener('click', () => maestrly.send(button.dataset.ask)))
</script>`

const CDN_HOSTS = GENUI_WIDGET_CDN_SOURCES.split(' ')
  .map((source) => source.replace('https://', ''))
  .join(', ')

const INLINE_HTML = `## inline-html blocks

Inside ${FENCE}inline-html write an HTML fragment: the content of <body>, with <style> and <script> elements as needed, never <html>, <head> or <body> tags. The frame:

- Is isolated from the app and has no network: fetch, XMLHttpRequest, WebSocket, forms and pop-ups do not work, and alert() does nothing. Images, video and audio load from any https URL. Scripts and stylesheets also load from ${CDN_HOSTS} (pin the version, e.g. https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js), fonts from fonts.googleapis.com.
- Is as wide as the chat column (about 700 px; keep the layout responsive down to 320 px) and as tall as its content. Never size the page with 100vh or height: 100%.
- Already styles headings, paragraphs, lists, tables, code, links, buttons and form fields with the app's fonts, colors and spacing, over its dark background.
- Runs your scripts once the block is complete; DOMContentLoaded and load still fire.
- Keeps nothing: storage lasts until the page reloads, and the block starts over each time the conversation shows.
- maestrly.send(text) sends text to you as the person, and maestrly.openLink(url) opens a page in their browser. Both work only in response to a click; links (<a href="https://...">) open in the browser too.
- Checks the block: an image that fails to load becomes a placeholder and a too-wide table scrolls; what it cannot fix (content wider than the answer, text cut off, layouts sized by the frame, script errors, blocked requests) is listed under the block for the person.

Lay out with these classes instead of writing CSS:

- ui-stack (column with 12 px gaps), ui-row (wrapping row), ui-grid (responsive columns of cards), ui-card (padded panel). Their children are spaced by gaps, not margins.
- ui-media: a cover image filling its card at 4:3; set aspect-ratio for another shape.
- Buttons are styled already; ui-btn-primary marks the main one, ui-btn makes a link look like a button.
- ui-badge, colored with ui-success, ui-warning or ui-danger (which also color any text).
- ui-stat holding ui-stat-label and ui-stat-value, for key figures.
- ui-muted and ui-small for secondary text, ui-num for right-aligned figures in tables, ui-scroll to scroll something wide sideways.

Write <style> only for what the classes do not cover, with the theme variables ${GENUI_WIDGET_THEME_KEYS.map((key) => `var(--ui-${key})`).join(', ')}. Do not restyle the page itself, and never give a box with text a fixed height its text could outgrow.

Keep fragments compact: no comments, unused styles or frameworks the job does not need. Use only image URLs you got from your tools or the conversation; with none, draw with CSS or SVG instead.

Example:

${FENCE}inline-html
${LISTINGS_HTML_EXAMPLE}
${FENCE}`

/** The whole section: when to use each kind of block, the openui-lang reference, then inline HTML. */
export function buildGenUiPrompt(): string {
  return [OVERVIEW, genUiLibrary.prompt(GENUI_PROMPT_OPTIONS), INLINE_HTML].join('\n\n')
}
