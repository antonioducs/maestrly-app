// Protótipo — estado em memória, dados fictícios. Nenhuma chamada de rede.
const $ = (s) => document.querySelector(s)

// --- catálogo fictício de runners/modelos --------------------------------
const RUNNERS = {
  r1: { name: 'MacBook do Jorge', personal: true, online: true, maestro: true, subagents: true, preCommands: false,
    models: [
      { provider: 'maestrly', id: 'claude-sonnet-4', label: 'Claude · claude-sonnet-4', efforts: ['low', 'medium', 'high'], fast: true },
      { provider: 'maestrly', id: 'gpt-5', label: 'Codex · gpt-5', efforts: ['low', 'medium', 'high'], fast: false },
      { provider: 'maestrly', id: 'gpt-5-mini', label: 'Codex · gpt-5-mini', efforts: [], fast: false },
    ] },
  r2: { name: 'ci-runner-01', personal: false, online: true, maestro: false, subagents: false, preCommands: true,
    models: [
      { provider: 'codex', id: 'gpt-5', label: 'gpt-5', efforts: ['low', 'medium', 'high'], fast: false },
      { provider: 'codex', id: 'gpt-5-codex', label: 'gpt-5-codex', efforts: ['medium', 'high'], fast: false },
      { provider: 'claude', id: 'claude-sonnet-4', label: 'claude-sonnet-4', efforts: [], fast: false },
    ] },
  r3: { name: 'build-box', personal: false, online: false, maestro: true, subagents: true, preCommands: true,
    models: [{ provider: 'claude', id: 'claude-opus-4', label: 'claude-opus-4', efforts: [], fast: false }] },
  r4: { name: 'desk-team-02 · Maestrly', personal: false, online: true, maestro: true, subagents: true, preCommands: false,
    models: [
      { provider: 'maestrly', id: 'claude-sonnet-4', label: 'Claude · claude-sonnet-4', efforts: ['low', 'medium', 'high'], fast: true },
      { provider: 'maestrly', id: 'gpt-5', label: 'Codex · gpt-5', efforts: ['low', 'medium', 'high'], fast: false },
    ] },
}
const CARDS = {
  c1: { id: 'a1f3c9d2-6b40-4e1a-9f7c-2d5e8b1c0a44', title: 'Alertas de gasto recorrente', criteria: ['Usuário recebe alerta quando um gasto recorrente sobe >10%', 'Alerta pode ser silenciado por 30 dias'], body: 'Detectar assinaturas e cobranças recorrentes e avisar variações relevantes.' },
  c2: { id: '7b2e0f11-8c3d-4a6e-b2f9-0d1c3e5a7b99', title: 'Importar OFX do Nubank', criteria: ['Arquivo OFX é lido sem erro', 'Transações duplicadas são ignoradas'], body: 'Suportar importação manual de extratos OFX exportados do app do Nubank.' },
}
const state = { mode: 'standard', dirty: false, shift: 0 }

// --- helpers --------------------------------------------------------------
function selectedRunners() {
  const dest = $('#dest').value, target = $('#runner').value
  if (dest === 'runner' && target) return [RUNNERS[target]]
  return Object.values(RUNNERS)
}
function models() {
  const provider = $('#provider').value
  const all = selectedRunners().flatMap((r) => r.models.map((m) => ({ ...m, personal: r.personal })))
  const map = new Map()
  for (const m of all) if (m.provider === provider) {
    const prev = map.get(m.id)
    map.set(m.id, prev ? { ...prev, efforts: [...new Set([...prev.efforts, ...m.efforts])], fast: prev.fast || m.fast, personal: prev.personal && m.personal } : m)
  }
  return [...map.values()]
}
function fill(select, options, keep) {
  const prev = keep ? select.value : ''
  select.innerHTML = ''
  for (const o of options) { const el = document.createElement('option'); el.value = o.value; el.textContent = o.label; select.append(el) }
  select.value = options.some((o) => o.value === prev) ? prev : (options[0]?.value ?? '')
}
function hint(id, text, kind) {
  const el = $('#' + id); el.textContent = text || ''; el.className = 'hint-slot' + (kind ? ' ' + kind : '')
}
function status(text, kind) { const s = $('#foot-status'); s.className = 'foot-status ' + (kind || ''); s.querySelector('span').textContent = text }

// --- medição de layout shift (evidência p/ a barra do protótipo) ----------
// Posições relativas ao conteúdo rolável: rolar a lista não é layout shift.
const probes = () => { const s = $('#body').scrollTop; return [...document.querySelectorAll('#body .sec, #save')].map((el) => el.getBoundingClientRect().top + (el.id === 'save' ? 0 : s)) }
let before = probes()
function measureShift() {
  const after = probes()
  const delta = after.reduce((sum, top, i) => sum + Math.abs(top - (before[i] ?? top)), 0)
  before = after
  if (delta > 0.5) {
    state.shift += delta
    const m = $('#shift-metric'); m.querySelector('b').textContent = Math.round(state.shift) + 'px'; m.classList.toggle('bad', state.shift > 0)
  }
}

// --- render ---------------------------------------------------------------
function render() {
  const dest = $('#dest').value, runnerSel = $('#runner'), target = runnerSel.value
  const enabled = $('#enabled').checked, provider = $('#provider').value
  const noReserve = document.body.classList.contains('no-reserve')

  // ② Onde roda
  runnerSel.disabled = dest !== 'runner'
  runnerSel.closest('.field').classList.toggle('hidden-when-off', dest !== 'runner')
  if (dest !== 'runner') { runnerSel.value = ''; hint('hint-runner', 'Qualquer runner do pool com modelo e repositório compatíveis.') }
  else if (!target) hint('hint-runner', 'Selecione um runner.', 'warn')
  else hint('hint-runner', RUNNERS[target].online ? 'Online · reporta guardiao-api (main, develop)' : 'Offline há 2 dias — jobs ficarão na fila.', RUNNERS[target].online ? 'good' : 'warn')
  hint('hint-dest', dest === 'pool' ? '3 runners compatíveis agora.' : 'Só este runner poderá assumir os jobs.')
  hint('hint-repo', $('#repo').value ? 'Clonado do checkout local em workspace isolado.' : 'Padrão do projeto. Sem repositório, o workspace é vazio.')
  hint('hint-branch', $('#branch').value ? 'A branch precisa existir no checkout do runner.' : 'Usa a branch base do repositório (main).')

  // ③ Modelo
  const list = models()
  fill($('#model'), list.length ? list.map((m) => ({ value: m.id, label: m.label })) : [{ value: '', label: 'Nenhum modelo disponível' }], true)
  $('#model').disabled = !list.length
  const m = list.find((x) => x.id === $('#model').value)
  const providerLabel = { maestrly: 'Executor Maestrly (contas do desktop)', codex: 'Codex CLI no runner', claude: 'Claude Agent SDK no runner' }[provider]
  hint('hint-provider', providerLabel)
  hint('hint-model', !list.length ? 'Os runners selecionados não reportam modelos deste provedor.' : m?.personal ? 'Disponível só no seu computador — use "Rodar no meu computador" no card.' : 'Disponível no pool compartilhado.', !list.length ? 'warn' : m?.personal ? '' : 'good')
  const effortSel = $('#effort')
  const efforts = m?.efforts ?? []
  fill(effortSel, [{ value: '', label: efforts.length ? 'Padrão do modelo' : 'Não suportado por este modelo' }, ...efforts.map((e) => ({ value: e, label: e }))], true)
  effortSel.disabled = !efforts.length
  effortSel.closest('.field').classList.toggle('hidden-when-off', !efforts.length)
  hint('hint-effort', efforts.length ? 'Mais esforço = mais lento e mais caro.' : 'Este modelo não expõe níveis de esforço.')
  $('#fast').disabled = !m?.fast
  if (!m?.fast) $('#fast').checked = false
  $('#fast-row').closest('.field').classList.toggle('hidden-when-off', !m?.fast)
  hint('hint-fast', m?.fast ? 'Tier prioritário do provedor; custo maior.' : 'Fast mode não disponível para este modelo.')

  // ④ Modo
  const canMaestro = selectedRunners().some((r) => r.maestro), canSub = selectedRunners().some((r) => r.subagents)
  const maestroBtn = document.querySelector('[data-mode="maestro"]')
  maestroBtn.disabled = !canMaestro
  if (!canMaestro && state.mode === 'maestro') state.mode = 'standard'
  document.querySelectorAll('.seg [role=radio]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)))
  hint('hint-mode', canMaestro ? (state.mode === 'maestro' ? 'Maestro planeja, delega a subagentes e revisa.' : 'Um agente executa o card do início ao fim.') : 'Maestro indisponível nos runners selecionados.', canMaestro ? '' : 'warn')
  $('#strategy').disabled = state.mode !== 'maestro'
  $('#strategy').closest('.field').classList.toggle('hidden-when-off', state.mode !== 'maestro')
  hint('hint-strategy', state.mode === 'maestro' ? 'Balanceada: 3 delegações, 1 revisão, 1 correção.' : 'Só se aplica ao modo Maestro.')
  const sub = $('#subagents')
  sub.disabled = !canSub || state.mode === 'maestro'
  if (state.mode === 'maestro') sub.checked = true
  sub.closest('.field').classList.toggle('hidden-when-off', !canSub)
  hint('hint-subagents', !canSub ? 'Nenhum runner selecionado suporta subagentes.' : state.mode === 'maestro' ? 'Obrigatório no Maestro.' : 'Delegação opcional para tarefas paralelas.', !canSub ? 'warn' : '')

  // ⑥ Avançado
  const canCmd = selectedRunners().some((r) => r.preCommands)
  $('#precmd').disabled = !canCmd
  hint('hint-precmd', canCmd ? 'Um por linha. Rodam na imagem isolada, sem credenciais nem rede.' : 'Nenhum runner tem imagem de sandbox aprovada.', canCmd ? '' : 'warn')

  // ① Ativação + footer
  const modelValid = !!m
  $('#enabled').disabled = !enabled && !modelValid
  $('#autorun').disabled = !enabled || (m?.personal ?? true)
  if ($('#autorun').disabled) $('#autorun').checked = false
  $('#approval').disabled = provider === 'maestrly'
  if (provider === 'maestrly') $('#approval').checked = false
  hint('hint-activation', provider === 'maestrly' ? 'O executor Maestrly usa as permissões configuradas no desktop; aprovação prévia não se aplica.' : !enabled ? 'Rascunho salvo sem executar nada.' : $('#autorun').disabled ? 'Rodar ao entrar exige um modelo no pool compartilhado.' : '')
  const save = $('#save')
  save.disabled = enabled && !modelValid
  if (enabled && !modelValid) status('Selecione provedor, modelo e esforço suportados antes de habilitar.', 'error')
  else if (state.dirty) status('Alterações não salvas. Valem para jobs futuros; snapshots existentes são preservados.', 'warn')
  else status('Alterações valem para jobs futuros; snapshots existentes são preservados.', '')
  $('#dirty-pill').classList.toggle('dirty', state.dirty)
  $('#dirty-pill span').textContent = state.dirty ? 'Alterações não salvas' : 'Configuração salva'

  if (!$('#preview-body').hidden) renderPreview()
  requestAnimationFrame(measureShift)
  void noReserve
}

function renderPreview() {
  const c = CARDS[$('#preview-card').value]
  const repo = $('#repo').value || 'g1'
  const branch = $('#branch').value || 'main'
  const esc = (s) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch])
  const ws = repo ? `- Workspace: isolated clone of the linked repository, branch \`${esc(branch)}\` (changes are delivered as a patch for review)` : `<span class="warn">- Workspace: EMPTY — no Git repository is linked to this project/column…</span>`
  const template = $('#prompt').value.trim() || 'Complete the task described in the card above.'
  const rendered = template.replace(/\{(task_number|task_title|task_body|column_name)\}/g, (_, k) => ({ task_number: c.id.slice(0, 8), task_title: c.title, task_body: c.body, column_name: 'Refinamento Técnico' })[k])
  $('#preview-body').innerHTML = `<span class="k">## Task context</span>
- Card ID: ${c.id} (use this exact id with the board tools)
- Task #${c.id.slice(0, 8)}: ${esc(c.title)}
- Column: Refinamento Técnico
- Board ID: 3c0d1e2f-…  ·  Project ID: 9a8b7c6d-…
${ws}

<span class="k">### Acceptance criteria</span>
${c.criteria.map((x) => '- ' + esc(x)).join('\n')}

<span class="k">### Description</span>
${esc(c.body)}

<span class="k">## Instructions</span>
${esc(rendered)}`
}

// --- eventos --------------------------------------------------------------
const dirtyThen = () => { state.dirty = true; render() }
for (const id of ['#dest', '#runner', '#repo', '#branch', '#provider', '#model', '#effort', '#fast', '#enabled', '#autorun', '#approval', '#strategy', '#subagents', '#precmd', '#timeout', '#logs'])
  if (id !== '#provider') $(id).addEventListener(id === '#branch' || id === '#precmd' ? 'input' : 'change', dirtyThen)
// Trocar o provedor zera o modelo ANTES de renderizar, para o primeiro modelo do novo provedor ser selecionado.
$('#provider').addEventListener('change', () => { $('#model').value = ''; dirtyThen() })
$('#prompt').addEventListener('input', () => { state.dirty = true; render() })
document.querySelectorAll('.seg [role=radio]').forEach((b) => b.addEventListener('click', () => { if (b.disabled) return; state.mode = b.dataset.mode; dirtyThen() }))
document.querySelectorAll('.chips [data-var]').forEach((b) => b.addEventListener('click', () => {
  const ta = $('#prompt'), v = b.dataset.var, s = ta.selectionStart, e = ta.selectionEnd
  ta.setRangeText(v, s, e, 'end'); ta.focus(); state.dirty = true; render()
}))
$('#expand').addEventListener('click', () => {
  const ta = $('#prompt'), big = ta.rows > 7
  ta.rows = big ? 7 : 18; $('#expand').textContent = big ? 'Expandir' : 'Recolher'
  before = probes() // expansão intencional não conta como CLS
})
$('#preview-toggle').addEventListener('click', () => {
  const body = $('#preview-body'), open = body.hidden
  body.hidden = !open
  $('#preview-toggle').setAttribute('aria-expanded', String(open))
  $('#preview-toggle').textContent = open ? 'Ocultar prompt renderizado' : 'Mostrar prompt renderizado'
  if (open) renderPreview()
  before = probes()
})
$('#preview-card').addEventListener('change', () => { if (!$('#preview-body').hidden) renderPreview() })
$('#adv-toggle').addEventListener('click', () => {
  const open = $('#adv-body').hidden
  $('#adv-body').hidden = !open; $('#adv-toggle').setAttribute('aria-expanded', String(open))
  before = probes()
})
$('#save').addEventListener('click', () => {
  const b = $('#save'); b.classList.add('busy'); b.textContent = 'Salvando…'; status('Salvando…', '')
  setTimeout(() => {
    b.classList.remove('busy'); b.textContent = 'Salvar automação'; state.dirty = false
    $('.version').textContent = 'v' + (Number($('.version').textContent.slice(1)) + 1)
    render(); status('Automação salva para esta coluna (simulado).', 'ok')
  }, 700)
})
$('#refresh-runners').addEventListener('click', () => { status('Runners atualizados (simulado).', 'ok') })
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { $('#' + b.dataset.open).hidden = false; $('#' + b.dataset.open + ' button').focus() }))
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $('#' + b.dataset.close).hidden = true }))
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const h = $('#history'); if (!h.hidden) h.hidden = true } })
$('#theme-toggle').addEventListener('change', (e) => { document.documentElement.dataset.theme = e.target.checked ? 'dark' : 'light' })
$('#shift-toggle').addEventListener('change', (e) => {
  document.body.classList.toggle('no-reserve', !e.target.checked)
  state.shift = 0; $('#shift-metric b').textContent = '0px'; $('#shift-metric').classList.remove('bad')
  before = probes(); render()
})

$('#model').value = 'claude-sonnet-4'
render()
$('#model').value = 'claude-sonnet-4'; $('#effort').value = 'high'; render()
// A carga inicial (fontes, primeiro layout) não é CLS de interação: zera o contador depois que tudo assentou.
// 1,2s: cobre o swap tardio das fontes do Google Fonts em rede lenta.
document.fonts.ready.then(() => setTimeout(() => {
  state.shift = 0; before = probes(); $('#shift-metric b').textContent = '0px'; $('#shift-metric').classList.remove('bad')
}, 1200))
