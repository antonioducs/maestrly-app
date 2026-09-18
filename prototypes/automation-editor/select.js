// Select customizado — espelha apps/web/src/components/Select.tsx (trigger + listbox popover, teclado, aria).
// Regra do projeto: nunca usar <select> nativo. Cada <select> do markup vira um combobox custom;
// o elemento original fica oculto e continua sendo a fonte de verdade (.value, evento change, disabled, options).
(() => {
  const chevron = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
  const check = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
  let seq = 0

  function enhance(native) {
    const listId = 'sel-' + ++seq
    const label = native.closest('.field')?.querySelector('label')?.textContent?.trim() || native.getAttribute('aria-label') || ''
    const trigger = document.createElement('button')
    trigger.type = 'button'; trigger.className = 'select-trigger'; trigger.setAttribute('role', 'combobox')
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-controls', listId); trigger.setAttribute('aria-expanded', 'false')
    trigger.setAttribute('aria-label', label); trigger.innerHTML = '<span></span>' + chevron
    if (native.id) { trigger.id = native.id + '-trigger'; native.closest('.field')?.querySelector('label[for="' + native.id + '"]')?.setAttribute('for', trigger.id) }
    const menu = document.createElement('div')
    menu.id = listId; menu.className = 'select-menu'; menu.setAttribute('popover', 'auto'); menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', label)
    native.hidden = true; native.setAttribute('aria-hidden', 'true'); native.tabIndex = -1
    native.after(trigger); document.body.append(menu)

    let open = false, active = 0, search = { text: '', time: 0 }
    const options = () => [...native.options]
    const render = () => {
      const opts = options(), selected = opts.find((o) => o.value === native.value)
      trigger.firstElementChild.textContent = selected?.label ?? label
      trigger.disabled = native.disabled
      menu.innerHTML = ''
      opts.forEach((o, i) => {
        const el = document.createElement('div')
        el.id = listId + '-' + i; el.className = 'select-option' + (i === active ? ' highlighted' : ''); el.setAttribute('role', 'option')
        el.setAttribute('aria-selected', String(o.value === native.value))
        el.innerHTML = '<span></span>' + (o.value === native.value ? check : ''); el.firstElementChild.textContent = o.label
        el.addEventListener('pointermove', () => { if (active !== i) { active = i; highlight() } })
        el.addEventListener('mousedown', (e) => e.preventDefault())
        el.addEventListener('click', () => choose(i))
        menu.append(el)
      })
    }
    const highlight = () => { [...menu.children].forEach((el, i) => el.classList.toggle('highlighted', i === active)); menu.children[active]?.scrollIntoView({ block: 'nearest' }) }
    const position = () => {
      const rect = trigger.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 210), innerWidth - 16)
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12
      const height = Math.max(0, Math.min(288, Math.max(below, above)))
      menu.style.width = width + 'px'; menu.style.maxHeight = height + 'px'
      menu.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px'
      menu.style.top = (below >= Math.min(288, menu.scrollHeight) || below >= above ? rect.bottom + 6 : Math.max(8, rect.top - Math.min(height, menu.scrollHeight) - 6)) + 'px'
    }
    const show = () => {
      if (native.disabled || !native.options.length) return
      active = Math.max(0, options().findIndex((o) => o.value === native.value)); render()
      menu.showPopover(); open = true; trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-activedescendant', listId + '-' + active)
      position(); highlight()
      addEventListener('resize', position); addEventListener('scroll', position, true)
    }
    const close = () => {
      if (open) menu.hidePopover()
      open = false; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant')
      removeEventListener('resize', position); removeEventListener('scroll', position, true)
    }
    const choose = (i) => {
      const o = options()[i]; if (!o || native.disabled) return
      close(); trigger.focus()
      if (native.value !== o.value) { native.value = o.value; native.dispatchEvent(new Event('change', { bubbles: true })) }
      render()
    }
    menu.addEventListener('toggle', (e) => { if (e.newState === 'closed') close() })
    trigger.addEventListener('click', () => (open ? close() : show()))
    trigger.addEventListener('keydown', (e) => {
      const n = native.options.length
      if (e.key === 'Tab') { close(); return }
      if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); close() } return }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        if (!open) { show(); return }
        if (e.key === 'Enter' || e.key === ' ') { choose(active); return }
        active = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n
        trigger.setAttribute('aria-activedescendant', listId + '-' + active); highlight()
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); if (!open) show()
        const now = Date.now(), text = (now - search.time < 700 ? search.text : '') + e.key
        search = { text, time: now }
        const i = options().findIndex((o) => o.label.toLocaleLowerCase().startsWith(text.toLocaleLowerCase()))
        if (i >= 0) { active = i; highlight() }
      }
    })
    // O app.js troca options/value/disabled direto no <select>; observar e re-renderizar o trigger.
    new MutationObserver(render).observe(native, { attributes: true, childList: true, subtree: true, attributeFilter: ['disabled', 'value'] })
    native.addEventListener('change', render)
    // value/disabled refletem no trigger de forma síncrona (o observer cobre mudanças de options).
    for (const prop of ['value', 'disabled']) {
      const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop)
      Object.defineProperty(native, prop, { get() { return desc.get.call(this) }, set(v) { desc.set.call(this, v); render() } })
    }
    render()
  }
  document.querySelectorAll('select').forEach(enhance)
})()
