// Protótipo — estado em memória, dados fictícios. Nada é enviado para lugar nenhum.
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)]
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), 2200) }

// --- autosave simulado ----------------------------------------------------
let saveTimer
function touched() {
  const el = $('#autosave'); el.className = 'autosave saving'; el.textContent = 'Salvando…'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { el.className = 'autosave'; el.textContent = 'Salvo automaticamente · ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); $('dd:nth-of-type(3)').textContent = 'agora' }, 700)
}
$('#card-title').addEventListener('input', touched)
$('#description').addEventListener('input', touched)
$('#card-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur() } })

// --- tabs -----------------------------------------------------------------
function showTab(name) {
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)))
  $$('[role=tabpanel]').forEach((p) => (p.hidden = p.dataset.panel !== name))
  $('.main').scrollTop = 0
}
$$('.tabs [role=tab]').forEach((b, i, all) => {
  b.addEventListener('click', () => showTab(b.dataset.tab))
  b.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length
    all[next].focus(); showTab(all[next].dataset.tab)
  })
})
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)))

// --- critérios de aceite --------------------------------------------------
function countCriteria() {
  const all = $$('#criteria input[type=checkbox]'), done = all.filter((c) => c.checked).length
  $('#criteria-count').textContent = done + '/' + all.length
}
$('#criteria').addEventListener('change', () => { countCriteria(); touched() })
$('#add-criterion').addEventListener('click', () => {
  const li = document.createElement('li'); li.className = 'editing'
  li.innerHTML = '<label><input type="checkbox" disabled /><input type="text" placeholder="Novo critério…" aria-label="Novo critério" /></label>'
  $('#criteria').append(li); const inp = li.querySelector('input[type=text]'); inp.focus()
  const commit = () => {
    if (!inp.value.trim()) { li.remove(); return }
    li.className = ''; li.innerHTML = '<label><input type="checkbox" /><span></span></label>'; li.querySelector('span').textContent = inp.value.trim()
    countCriteria(); touched()
  }
  inp.addEventListener('blur', commit); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = ''; inp.blur() } })
})

// --- subtarefas (navegação aninhada com breadcrumb de volta) --------------
const stack = []
function openSubtask(title) {
  stack.push({ title: $('#card-title').textContent, id: $('#card-id code').textContent })
  $('#card-title').textContent = title; $('#card-id code').textContent = '#' + Math.random().toString(16).slice(2, 6)
  $('#crumb-back').hidden = false; $('#chip-exec').hidden = true
  $('#agent-panel').querySelector('.agent-line').innerHTML = '<i class="dot"></i><b>Nunca executado</b>'
  $('#agent-panel').querySelector('.agent-warn').hidden = true
  showTab('details'); toast('Abriu subtarefa (demo). Use ← para voltar.')
}
$$('.subtask').forEach((b) => b.addEventListener('click', () => openSubtask(b.dataset.title)))
$('#crumb-back').addEventListener('click', () => {
  const prev = stack.pop(); if (!prev) return
  $('#card-title').textContent = prev.title; $('#card-id code').textContent = prev.id
  if (!stack.length) { $('#crumb-back').hidden = true; $('#chip-exec').hidden = false; $('#agent-panel').querySelector('.agent-line').innerHTML = '<i class="dot fail"></i><b>Falhou</b> · tentativa 2 · há 2 h'; $('#agent-panel').querySelector('.agent-warn').hidden = false }
})
$('#add-subtask').addEventListener('click', () => {
  const title = prompt('Título da subtarefa'); if (!title) return
  const li = document.createElement('li')
  li.innerHTML = '<button type="button" class="subtask"><code>#' + Math.random().toString(16).slice(2, 6) + '</code><span></span><em class="pill muted">Backlog</em></button>'
  li.querySelector('span').textContent = title; li.querySelector('button').dataset.title = title
  li.querySelector('button').addEventListener('click', () => openSubtask(title))
  $('#subtasks').append(li)
  const n = $$('#subtasks li').length; $('#subtask-count').textContent = '1/' + n; $('#subtask-bar').style.width = Math.round(100 / n) + '%'
  touched()
})
$('#card-id').addEventListener('click', () => { navigator.clipboard?.writeText('a1f3c9d2-6b40-4e1a-9f7c-2d5e8b1c0a44'); toast('ID copiado') })

// --- atividade ------------------------------------------------------------
$$('.activity-filter [role=radio]').forEach((b) => b.addEventListener('click', () => {
  $$('.activity-filter [role=radio]').forEach((x) => x.setAttribute('aria-checked', String(x === b)))
  $$('#feed li').forEach((li) => (li.hidden = b.dataset.filter !== 'all' && li.dataset.kind !== b.dataset.filter))
}))
function submitComment() {
  const ta = $('#comment-input'); if (!ta.value.trim()) return
  const li = document.createElement('li'); li.dataset.kind = 'comment'
  li.innerHTML = '<i class="av">JC</i><div><p><b>Jorge Cunha</b> comentou</p><blockquote></blockquote><time>agora</time></div>'
  li.querySelector('blockquote').textContent = ta.value.trim(); $('#feed').prepend(li); ta.value = ''
  const badge = $('[data-tab=activity] small'); badge.textContent = String(Number(badge.textContent) + 1)
}
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); submitComment() })
$('#comment-input').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitComment() })
$$('.seg-mini[aria-label="Modo do editor"] [role=radio]').forEach((b, _, all) => b.addEventListener('click', () => { all.forEach((x) => x.setAttribute('aria-checked', String(x === b))); if (b.textContent !== 'Rich text') toast(b.textContent + ' (demo: mesmo conteúdo)') }))

// --- execuções ------------------------------------------------------------
function startRun() {
  const hero = $('.exec-hero'), chip = $('#chip-exec'), line = $('#agent-panel .agent-line')
  hero.className = 'exec-hero running'; hero.querySelector('.exec-title').innerHTML = '<i class="dot"></i>Tentativa 3 · em execução'
  chip.className = 'chip chip-exec running'; chip.innerHTML = '<i class="dot"></i>Execução em andamento · tentativa 3'
  line.innerHTML = '<i class="dot run"></i><b>Em execução</b> · tentativa 3 · agora'
  $('#run-agent').disabled = true; $('#rerun').disabled = true
  const badge = $('[data-tab=executions] small'); badge.textContent = '3'
  toast('Execução solicitada (simulada)')
  setTimeout(() => {
    hero.className = 'exec-hero'; hero.style.borderLeftColor = 'var(--moss)'; hero.style.background = 'color-mix(in srgb, var(--moss) 6%, var(--surface-raised))'
    hero.querySelector('.exec-title').innerHTML = '<i class="dot ok"></i>Tentativa 3 · sucesso'; hero.querySelector('.dot').style.background = 'var(--moss)'
    $('.exec-summary p').innerHTML = '<b>Resultado:</b> refinamento concluído com 4 critérios de aceite sugeridos e 1 risco listado (versionamento de documentos).'
    chip.className = 'chip chip-exec'; chip.innerHTML = '<i class="dot"></i>Última execução: sucesso · agora'
    line.innerHTML = '<i class="dot ok"></i><b>Sucesso</b> · tentativa 3 · agora'
    $('#run-agent').disabled = false; $('#rerun').disabled = false
  }, 4000)
}
$('#run-agent').addEventListener('click', startRun); $('#rerun').addEventListener('click', startRun)
$('#override').addEventListener('click', () => toast('Abre o override de modelo do card (demo)'))

// --- histórico ------------------------------------------------------------
$$('#versions button').forEach((b) => b.addEventListener('click', () => {
  $$('#versions button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
  $('#restore').disabled = !!b.querySelector('em')
}))
$('#restore').addEventListener('click', () => toast('Restaurado como nova versão v5 (simulado)'))

// --- sidebar --------------------------------------------------------------
const prioColor = { urgent: 'var(--brick)', high: 'var(--cue)', medium: 'var(--brass)', low: 'var(--moss)', none: 'var(--line-strong)' }
const paintPriority = () => $('#priority-trigger').style.setProperty('--prio', prioColor[$('#priority').value])
$('#priority').addEventListener('change', () => { paintPriority(); touched() })
$('#column').addEventListener('change', () => { $('#crumb-column').textContent = $('#column').value; touched(); toast('Card movido para ' + $('#column').value + ' (demo)') })
$('#labels').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { e.target.parentElement.remove(); touched() } })
$('#label-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ',') return
  e.preventDefault(); const v = e.target.value.trim().replace(/,$/, ''); if (!v) return
  const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = v
  const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remover ' + v); tag.append(x)
  e.target.before(tag); e.target.value = ''; touched()
})
// --- responsáveis: multi-select com busca (popover custom, nunca <select> nativo) ---------------
const MEMBERS = [
  ['jc', 'Jorge Cunha', 'jorge@guardiao.app', 'maintainer'], ['mp', 'Marina Prado', 'marina@guardiao.app', 'contributor'],
  ['ra', 'Rafael Assis', 'rafael@guardiao.app', 'contributor'], ['lb', 'Luana Barros', 'luana@guardiao.app', 'contributor'],
  ['tf', 'Thiago Ferreira', 'thiago@guardiao.app', 'viewer'], ['cs', 'Camila Souza', 'camila@guardiao.app', 'contributor'],
  ['pm', 'Pedro Martins', 'pedro@guardiao.app', 'contributor'], ['an', 'Ana Nogueira', 'ana@guardiao.app', 'maintainer'],
  ['gl', 'Gustavo Lima', 'gustavo@guardiao.app', 'contributor'], ['bs', 'Beatriz Santos', 'bia@guardiao.app', 'viewer'],
  ['fo', 'Felipe Oliveira', 'felipe@guardiao.app', 'contributor'], ['dr', 'Daniela Rocha', 'dani@guardiao.app', 'contributor'],
].map(([id, name, email, role]) => ({ id, name, email, role, initials: name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase() }))
const assigned = new Set(['jc'])
const picker = $('#assignee-picker'), search = $('#assignee-search'), list = $('#assignee-list'), trigger = $('#assignee-trigger')
let pickerOpen = false, active = 0
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
function mark(text, q) {
  if (!q) return esc(text)
  const i = norm(text).indexOf(norm(q)); if (i < 0) return esc(text)
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length))
}
function renderAssignees() {
  const ul = $('#assignees'); ul.innerHTML = ''
  const people = MEMBERS.filter((m) => assigned.has(m.id))
  if (!people.length) ul.innerHTML = '<li class="empty">Ninguém atribuído</li>'
  for (const m of people) {
    const li = document.createElement('li')
    li.innerHTML = '<i class="av"></i><span></span><button type="button" aria-label="Remover ' + esc(m.name) + '">×</button>'
    li.querySelector('.av').textContent = m.initials; li.querySelector('span').textContent = m.name
    li.querySelector('button').addEventListener('click', () => { assigned.delete(m.id); renderAssignees(); renderList(); touched() })
    ul.append(li)
  }
  $('#assignee-count').textContent = assigned.size + (assigned.size === 1 ? ' selecionado' : ' selecionados')
}
function filtered() { const q = norm(search.value.trim()); return MEMBERS.filter((m) => !q || norm(m.name).includes(q) || norm(m.email).includes(q)) }
function renderList() {
  const q = search.value.trim(), rows = filtered()
  list.innerHTML = ''; $('#assignee-empty').hidden = !!rows.length
  active = Math.min(active, Math.max(0, rows.length - 1))
  rows.forEach((m, i) => {
    const li = document.createElement('li'); li.id = 'member-' + m.id; li.setAttribute('role', 'option')
    li.setAttribute('aria-selected', String(assigned.has(m.id))); li.className = i === active ? 'highlighted' : ''
    li.innerHTML = '<i class="av">' + m.initials + '</i><div><b>' + mark(m.name, q) + '</b><small>' + mark(m.email, q) + ' · ' + m.role + '</small></div><span class="tick" aria-hidden="true">✓</span>'
    li.addEventListener('pointermove', () => { if (active !== i) { active = i; highlight() } })
    li.addEventListener('mousedown', (e) => e.preventDefault())
    li.addEventListener('click', () => toggle(m.id))
    list.append(li)
  })
  search.setAttribute('aria-activedescendant', rows[active] ? 'member-' + rows[active].id : '')
}
function highlight() { [...list.children].forEach((el, i) => el.classList.toggle('highlighted', i === active)); list.children[active]?.scrollIntoView({ block: 'nearest' }); search.setAttribute('aria-activedescendant', list.children[active]?.id ?? '') }
function toggle(id) { assigned.has(id) ? assigned.delete(id) : assigned.add(id); renderAssignees(); renderList(); touched() }
function positionPicker() {
  const r = trigger.getBoundingClientRect(), w = 300
  picker.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px'
  const below = innerHeight - r.bottom - 12, h = Math.min(380, picker.offsetHeight || 380)
  picker.style.top = (below >= h || below >= r.top ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px'
}
function openPicker() { pickerOpen = true; picker.hidden = false; trigger.setAttribute('aria-expanded', 'true'); search.value = ''; active = 0; renderList(); positionPicker(); search.focus(); addEventListener('resize', positionPicker) }
function closePicker(focusTrigger = true) { if (!pickerOpen) return; pickerOpen = false; picker.hidden = true; trigger.setAttribute('aria-expanded', 'false'); removeEventListener('resize', positionPicker); if (focusTrigger) trigger.focus() }
trigger.addEventListener('click', () => (pickerOpen ? closePicker() : openPicker()))
$('#assignee-done').addEventListener('click', () => closePicker())
search.addEventListener('input', () => { active = 0; renderList() })
search.addEventListener('keydown', (e) => {
  const n = list.children.length
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); return }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!n) return; active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; highlight() }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); active = e.key === 'Home' ? 0 : n - 1; highlight() }
  else if (e.key === 'Enter') { e.preventDefault(); const m = filtered()[active]; if (m) toggle(m.id) }
  else if (e.key === 'Tab') closePicker(false)
})
document.addEventListener('pointerdown', (e) => { if (pickerOpen && !picker.contains(e.target) && e.target !== trigger) closePicker(false) })
$('.side').addEventListener('scroll', () => { if (pickerOpen) positionPicker() })
renderAssignees()

// --- menu ⋯ ---------------------------------------------------------------
$('#more').addEventListener('click', () => { const m = $('#more-menu'); m.hidden = !m.hidden; $('#more').setAttribute('aria-expanded', String(!m.hidden)) })
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) { $('#more-menu').hidden = true; $('#more').setAttribute('aria-expanded', 'false') } })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#more-menu').hidden = true } })
$$('#more-menu [data-act]').forEach((b) => b.addEventListener('click', () => {
  $('#more-menu').hidden = true
  if (b.dataset.act === 'archive') { $('#chip-state').className = 'chip chip-state archived'; $('#chip-state').innerHTML = '<i class="dot"></i>Arquivado'; b.textContent = 'Restaurar card'; b.dataset.act = 'restore'; toast('Card arquivado (demo)') }
  else if (b.dataset.act === 'restore') { $('#chip-state').className = 'chip chip-state'; $('#chip-state').innerHTML = '<i class="dot"></i>Aberto'; b.textContent = 'Arquivar card'; b.dataset.act = 'archive'; toast('Card restaurado (demo)') }
  else toast(b.textContent + ' → abriria confirmação (demo)')
}))
$('#discuss').addEventListener('click', () => toast('Abre o chat do projeto com este card em contexto (demo)'))

// --- barra do protótipo + medição de shift --------------------------------
$('#theme-toggle').addEventListener('change', (e) => { document.documentElement.dataset.theme = e.target.checked ? 'dark' : 'light' })
$('#narrow-toggle').addEventListener('change', (e) => { document.body.classList.toggle('narrow', e.target.checked); before = probes() })
// Header/tabs são fixos; blocos da sidebar são medidos relativos ao próprio scroll dela. Rolar não é shift.
const probes = () => [...$$('.dialog-head, .tabs').map((el) => el.getBoundingClientRect().top), ...$$('.side-blk').map((el) => el.getBoundingClientRect().top + $('.side').scrollTop)]
let before = probes(), shift = 0
new MutationObserver(() => requestAnimationFrame(() => {
  const now = probes(); const d = now.reduce((a, t, i) => a + Math.abs(t - (before[i] ?? t)), 0); before = now
  if (d > .5) { shift += d; $('#shift-metric b').textContent = Math.round(shift) + 'px'; $('#shift-metric').classList.add('bad') }
})).observe($('#dialog'), { subtree: true, childList: true, attributes: true, characterData: true })
paintPriority(); countCriteria()
// A carga inicial (swap de fontes) não é CLS de interação: zera depois que as fontes assentarem.
const resetShift = () => { shift = 0; before = probes(); $('#shift-metric b').textContent = '0px'; $('#shift-metric').classList.remove('bad') }
document.fonts.ready.then(() => { setTimeout(resetShift, 1200); setTimeout(resetShift, 2500) })
