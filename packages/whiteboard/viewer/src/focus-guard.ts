// Excalidraw ends the interaction in progress when its window gains the focus, assuming it missed a pointer-up. In a
// frame, the press that gives the frame the focus is that interaction, so the first drag after clicking anywhere
// outside the canvas did nothing. While a button is down, the focus event stays away from Excalidraw. Registered
// before Excalidraw mounts, so this listener runs first.
let pressed = false

addEventListener('pointerdown', () => (pressed = true), true)
for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => (pressed = false), true)
addEventListener(
  'focus',
  (event) => {
    if (pressed && event.target === window) event.stopImmediatePropagation()
  },
  true
)

export {}
