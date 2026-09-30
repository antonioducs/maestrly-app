// A person's face in the viewer: initials on a color of their own, a spark for the owner's agent.
import { avatarTone, initials } from './comments-model.js'
import type { CommentAuthorKind } from './contract.js'
import { h } from './dom.js'
import { icon } from './icons.js'

export function avatar(kind: CommentAuthorKind, name: string, size = 24): HTMLElement {
  const face = h('span', { class: `avatar is-${kind} tone-${avatarTone(kind, name)}`, 'aria-hidden': 'true' })
  face.style.setProperty('--size', `${size}px`)
  if (kind === 'agent') face.append(icon('spark', Math.round(size * 0.56)))
  else {
    const letters = initials(name)
    if (letters) face.textContent = letters
    else face.append(icon('user', Math.round(size * 0.56)))
  }
  return face
}
