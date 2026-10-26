// The response of the person viewing the page, saved by the viewer. The page asks through the bridge; the viewer
// checks what it sends, asks a guest without a name for one, saves it with its own session and says so. The page gets
// back that person's own response only: never a name, and never anyone else's response.
import { type ArtifactApi, bodyOf } from './api.js'
import type {
  BridgeMessage,
  ResponseData,
  ResponseError,
  ResponseSnapshot,
  ShellMessage,
  ViewerState,
} from './contract.js'
import { h, toast } from './dom.js'
import type { Translate } from './i18n.js'
import { readSnapshot, responseError } from './responses-model.js'

const MAX_NAME_CHARS = 60

type Request = Extract<BridgeMessage, { type: 'response-get' | 'response-submit' }>
type Result = { ok: true; response: ResponseSnapshot | null } | { ok: false; error: ResponseError }

export interface ResponsesController {
  handle(message: Request): void
}

export interface ResponsesOptions {
  api: ArtifactApi
  t: Translate
  state: ViewerState
  frame: HTMLIFrameElement
  /** The thumbnail capture: nothing is read or saved. */
  preview: boolean
  /** The version on screen, which a response is sent from. */
  version: () => number
  /** The guest just named themselves; the comments read the name from `state.identity`. */
  onIdentity: () => void
}

export function createResponses(options: ResponsesOptions): ResponsesController {
  const { api, t, state, frame } = options
  // One request at a time, so a page that sends twice cannot ask a guest for their name twice.
  let queue: Promise<void> = Promise.resolve()

  function reply(requestId: string, result: Result): void {
    const message: ShellMessage = { type: 'response-result', requestId, ...result }
    // The frame's origin is opaque, so the message cannot be addressed to a specific one.
    frame.contentWindow?.postMessage({ source: 'maestrly-shell', ...message }, '*')
  }

  async function refusal(response: Response | null): Promise<ResponseError> {
    if (!response) return 'failed'
    return responseError(response.status, (await bodyOf(response)).error)
  }

  async function snapshotOf(response: Response): Promise<Result> {
    const snapshot = readSnapshot(await bodyOf(response))
    return snapshot === undefined ? { ok: false, error: 'failed' } : { ok: true, response: snapshot }
  }

  /** A name typed in the viewer, never in the page; null when the person would rather not send. */
  function askName(): Promise<string | null> {
    return new Promise((resolve) => {
      let answer: string | null = null
      const input = h('input', {
        class: 'input',
        maxlength: String(MAX_NAME_CHARS),
        placeholder: t('yourName'),
        'aria-label': t('yourName'),
        autocomplete: 'name',
      })
      const send = h('button', { type: 'submit', class: 'button primary', disabled: true }, t('responseNameSend'))
      const dialog = h(
        'dialog',
        { class: 'name-dialog', 'aria-labelledby': 'name-dialog-title' },
        h(
          'form',
          {
            novalidate: true,
            onsubmit: (event: SubmitEvent) => {
              event.preventDefault()
              const name = input.value.trim()
              if (!name) return
              answer = name
              dialog.close()
            },
          },
          h('h2', { id: 'name-dialog-title' }, t('responseNameTitle')),
          h(
            'p',
            {},
            state.ownerName ? t('responseNameDetail', { owner: state.ownerName }) : t('responseNameDetailNoOwner')
          ),
          input,
          h(
            'div',
            { class: 'actions' },
            h('button', { type: 'button', class: 'button', onclick: () => dialog.close() }, t('cancel')),
            send
          )
        )
      )
      input.addEventListener('input', () => {
        send.disabled = !input.value.trim()
      })
      // Escape and Cancel close it without an answer.
      dialog.addEventListener('close', () => {
        dialog.remove()
        resolve(answer)
      })
      document.body.append(dialog)
      dialog.showModal()
      input.focus()
    })
  }

  async function read(): Promise<Result> {
    if (options.preview) return { ok: false, error: 'unavailable' }
    const response = await api.read('responses/mine').catch(() => null)
    if (response?.status === 200) return snapshotOf(response)
    return { ok: false, error: await refusal(response) }
  }

  async function save(data: ResponseData | null): Promise<Result> {
    if (options.preview) return { ok: false, error: 'unavailable' }
    if (data === null) return { ok: false, error: 'invalid' }
    if (!state.can.respond) return { ok: false, error: 'closed' }
    if (state.identity.kind === 'guest' && !state.identity.name) {
      const name = await askName()
      if (name === null) return { ok: false, error: 'cancelled' }
      const named = await api.write('session/name', 'PUT', { name }).catch(() => null)
      if (named?.status !== 204) return { ok: false, error: 'failed' }
      state.identity = { kind: 'guest', name }
      options.onIdentity()
    }
    const response = await api.write('responses/mine', 'PUT', { version: options.version(), data }).catch(() => null)
    if (response?.status === 200) return snapshotOf(response)
    return { ok: false, error: await refusal(response) }
  }

  /** Whatever the page does with the answer, the person learns whether their response was sent. */
  function announce(result: Result): void {
    if (result.ok) {
      if (state.identity.kind === 'owner') toast(t('responseSavedOwner'))
      else toast(state.ownerName ? t('responseSent', { owner: state.ownerName }) : t('responseSentNoOwner'))
    } else if (result.error === 'closed') toast(t('responsesClosed'))
    else if (result.error === 'full') toast(t('responsesFull'))
    else if (result.error !== 'cancelled') toast(t('responseFailed'))
  }

  return {
    handle(message) {
      queue = queue
        .then(async () => {
          const result = message.type === 'response-get' ? await read() : await save(message.data)
          if (message.type === 'response-submit' && !options.preview) announce(result)
          reply(message.requestId, result)
        })
        .catch(() => reply(message.requestId, { ok: false, error: 'failed' }))
    },
  }
}
