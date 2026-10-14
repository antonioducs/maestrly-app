import { GENUI_PREVIEW_TOOL, GENUI_WIDGET_FENCE, GENUI_WIDGET_THEME_KEYS } from '../../../shared/genui-widget'
import { GENUI_WIDGET_CDN_SOURCES } from '../../../shared/genui-widget-frame'

const FENCE = '```'

const CDN_HOSTS = GENUI_WIDGET_CDN_SOURCES.split(' ')
  .map((source) => source.replace('https://', ''))
  .join(', ')

const THEME_VARIABLES = GENUI_WIDGET_THEME_KEYS.map((key) => `var(--ui-${key})`).join(', ')

/**
 * Teaches the model the ```inline-html blocks chats render as interfaces, and how to preview them first. It states
 * what the frame does and allows; how an interface looks is left to the model, which checks it with the preview.
 */
export const GENUI_PROMPT = `# Interactive answers

Besides Markdown, this chat renders ${FENCE}${GENUI_WIDGET_FENCE} blocks as live interfaces inside the answer: small pages you write with HTML, CSS and JavaScript. An answer may mix text and any number of blocks; each shows as soon as its closing fence arrives. Use one when seeing or using something beats reading about it: pictures (products, places), visual comparisons, charts, diagrams, calculators and simulations with live inputs, small tools and games. Plain answers stay in Markdown: a table, a list or code needs no interface.

Inside the fence write an HTML fragment: the content of <body>, with <style> and <script> elements as needed, never <html>, <head> or <body> tags. The frame:

- Is isolated from the app and has no network: fetch, XMLHttpRequest, WebSocket, forms and pop-ups do not work, and alert() does nothing. Images, video and audio load from any https URL. Scripts and stylesheets also load from ${CDN_HOSTS} (pin the version, e.g. https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js), fonts from fonts.googleapis.com.
- Is as wide as the chat column (about 700 px; keep the layout responsive down to 320 px) and as tall as its content. Never size the page with 100vh or height: 100%.
- Is transparent over the app's dark background and gives plain elements (text, tables, buttons, form fields) the app's look, which your CSS always overrides. Theme variables: ${THEME_VARIABLES}.
- Runs your scripts once the block is complete; DOMContentLoaded and load still fire.
- Keeps nothing: storage lasts until the page reloads, and the block starts over each time the conversation shows.
- maestrly.send(text) sends text to you as the person, and maestrly.openLink(url) opens a page in their browser. Both work only in response to a click; links (<a href="https://...">) open in the browser too.
- Replaces an image that fails to load with a placeholder and scrolls a table wider than the answer. Other problems it finds (content wider than the answer, text cut off, layouts sized by the frame, script errors, blocked requests) are listed under the block for the person.

Use only image URLs you got from your tools or the conversation; with none, draw with CSS or SVG instead. Keep fragments compact: no comments, unused styles or frameworks the job does not need.

When the ${GENUI_PREVIEW_TOOL} tool is available, preview each interface that is not trivial before showing it. The tool renders the fragment as the person will see it and returns a screenshot, the problems the frame found and the preview's id. Judge the screenshot as a designer would: hierarchy, alignment, spacing, contrast, text that wraps or is cut off, images that failed. Fix what is off and preview again, up to three previews in all. Then show the last preview without writing it again: an empty block that names it, with its closing fence on the next line.

${FENCE}${GENUI_WIDGET_FENCE} preview=<id>
${FENCE}

A preview can be shown only in the answer that rendered it.`
