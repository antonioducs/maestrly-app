// Crumb: a small wholesale bakery app that follows the Maestrly prototype contract. Every screen and state is reached
// by its URL alone (a hash route with an optional `?state=`), read on load and on `hashchange`. The data is fixed so
// every capture is the same.
;(() => {
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
    offline:
      '<path d="M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.1-1.6M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5M12 20h.01"/>',
    bread:
      '<path d="M5 11a4 4 0 0 1 1-7.9C7.5 3 9 3 12 3s4.5 0 6 .1A4 4 0 0 1 19 11v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  }
  const icon = (name, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`

  const ORDERS = [
    {
      id: 1042,
      customer: 'Lindenhof Café',
      initials: 'LC',
      items: '24 sourdough · 60 croissants',
      due: '7:40',
      total: '$486.00',
      status: 'transit',
    },
    {
      id: 1041,
      customer: 'Barra Bistro',
      initials: 'BB',
      items: '18 baguettes · 12 focaccia',
      due: '7:15',
      total: '$212.40',
      status: 'delivered',
    },
    {
      id: 1040,
      customer: 'Juniper & Co.',
      initials: 'JC',
      items: '40 brioche buns',
      due: '8:00',
      total: '$148.00',
      status: 'baking',
    },
    {
      id: 1039,
      customer: 'Northside School',
      initials: 'NS',
      items: '120 rolls · 30 loaves',
      due: '8:30',
      total: '$392.00',
      status: 'late',
    },
    {
      id: 1038,
      customer: 'Hotel Aurora',
      initials: 'HA',
      items: '90 croissants · 40 pains au chocolat',
      due: '6:50',
      total: '$618.50',
      status: 'delivered',
    },
    {
      id: 1037,
      customer: 'Tide Kitchen',
      initials: 'TK',
      items: '16 rye loaves',
      due: '9:00',
      total: '$104.00',
      status: 'baking',
    },
    {
      id: 1036,
      customer: 'Oak Street Deli',
      initials: 'OD',
      items: '36 bagels · 12 ciabatta',
      due: '9:20',
      total: '$156.00',
      status: 'baking',
    },
    {
      id: 1035,
      customer: 'Pequeno Mercado',
      initials: 'PM',
      items: '20 country loaves',
      due: '10:00',
      total: '$170.00',
      status: 'delivered',
    },
  ]
  const STATUS = {
    transit: { tone: 'warning', label: 'Out for delivery' },
    delivered: { tone: 'success', label: 'Delivered' },
    baking: { tone: 'neutral', label: 'In the oven' },
    late: { tone: 'danger', label: 'Running late' },
  }

  const props = (pairs) =>
    Object.entries(pairs)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')

  const button = (label, variant = 'primary', options = {}) => {
    const size = options.size ?? 'md'
    const classes = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', options.block ? 'btn-block' : '']
      .filter(Boolean)
      .join(' ')
    return `<button type="button" class="${classes}" data-ds="Button" data-ds-props="${props({ variant, size })}">${
      options.icon ? icon(options.icon, size === 'sm' ? 14 : 16) : ''
    }${label}</button>`
  }

  const badge = (status) => {
    const { tone, label } = STATUS[status]
    return `<span class="badge badge-${tone}" data-ds="Badge" data-ds-props="tone=${tone}">${label}</span>`
  }

  const avatar = (initials, size = 'md') =>
    `<span class="avatar${size === 'sm' ? ' avatar-sm' : ''}" data-ds="Avatar" data-ds-props="size=${size}">${initials}</span>`

  const navItem = (name, label, route, current, count) =>
    `<a class="nav-item" href="#${route}" data-ds="NavItem" data-ds-props="active=${current}"${
      current ? ' aria-current="page"' : ''
    }>${icon(name)}<span>${label}</span>${count === undefined ? '' : `<span class="nav-count">${count}</span>`}</a>`

  const sidebar = (active, orderCount = 38) => `
    <aside class="sidebar" data-ds="Sidebar">
      <div class="brand"><span class="brand-mark">${icon('bread', 16)}</span>Crumb</div>
      <nav class="nav" aria-label="Main">
        ${navItem('home', 'Today', '/dashboard', active === 'dashboard')}
        ${navItem('list', 'Orders', '/orders', active === 'orders', orderCount)}
        ${navItem('users', 'Customers', '/dashboard', false)}
        ${navItem('box', 'Products', '/dashboard', false)}
        ${navItem('gear', 'Settings', '/dashboard', false)}
      </nav>
      <div class="sidebar-foot">${avatar('RC', 'sm')}<div><b>Rafa Costa</b><span>Crumb Bakehouse</span></div></div>
    </aside>`

  const stat = (label, value, trend, note) =>
    `<div class="stat stat-${trend}" data-ds="StatCard" data-ds-props="trend=${trend}">
      <span class="stat-label">${label}</span><span class="stat-value">${value}</span><span class="stat-trend">${note}</span>
    </div>`

  const orderRow = (order, wide = false) =>
    wide
      ? `<a class="order-row order-wide" href="#/orders/${order.id}" data-ds="OrderRow" data-ds-props="layout=table">
          ${avatar(order.initials, 'sm')}
          <span class="order-main"><b>${order.customer}</b><span>#${order.id} · ${order.items}</span></span>
          <span class="order-cell">Thu, Nov 19</span><span class="order-cell">${order.due}</span>
          ${badge(order.status)}<span class="order-total">${order.total}</span>
        </a>`
      : `<a class="order-row" href="#/orders/${order.id}" data-ds="OrderRow" data-ds-props="layout=compact">
          ${avatar(order.initials, 'sm')}
          <span class="order-main"><b>${order.customer}</b><span>#${order.id} · Due ${order.due}</span></span>
          ${badge(order.status)}<span class="order-total">${order.total}</span>
        </a>`

  const step = (state, title, note) =>
    `<li class="step step-${state}" data-ds="TimelineStep" data-ds-props="state=${state}">
      <span class="step-dot"></span><span class="step-text"><b>${title}</b><span>${note}</span></span>
    </li>`

  const tab = (label, selected) =>
    `<button type="button" class="tab" role="tab" aria-selected="${selected}" data-ds="Tab" data-ds-props="selected=${selected}">${label}</button>`

  const search = (value = '') =>
    `<label class="search" data-ds="SearchField">${icon('search', 16)}<input type="search" placeholder="Search orders" value="${value}" aria-label="Search orders"></label>`

  const empty = (tone, mark, title, text, actions) =>
    `<div class="empty${tone === 'danger' ? ' empty-danger' : ''}" data-ds="EmptyState" data-ds-props="tone=${tone}">
      <span class="empty-mark">${icon(mark, 24)}</span>
      <h2 class="empty-title">${title}</h2><p class="empty-text">${text}</p>
      <div class="page-actions">${actions}</div>
    </div>`

  const banner = (tone, mark, text) =>
    `<div class="banner banner-${tone}" role="${tone === 'danger' ? 'alert' : 'status'}" data-ds="Banner" data-ds-props="tone=${tone}">${icon(mark, 16)}<span>${text}</span></div>`

  // --- Screens.

  const dashboard = () => `
    <div class="app">${sidebar('dashboard')}
      <main class="main"><div class="main-inner">
        <header class="page-head">
          <div><p class="page-kicker">Thursday, November 19</p><h1 class="page-title">Good morning, Crumb Bakehouse</h1></div>
          <div class="page-actions">${button('Export', 'secondary', { icon: 'download' })}${button('New order', 'primary', { icon: 'plus' })}</div>
        </header>
        <section class="grid-4" aria-label="Today in numbers">
          ${stat('Orders today', '38', 'up', '▲ 12% vs last Thursday')}
          ${stat('Loaves to bake', '412', 'up', '▲ 36 vs yesterday')}
          ${stat('On-time delivery', '96%', 'up', '▲ 2 pts this week')}
          ${stat('Late deliveries', '2', 'down', '▲ 1 vs yesterday')}
        </section>
        <div class="split">
          <section class="panel">
            <header class="panel-head"><h2 class="panel-title">Due this morning</h2>${button('View all', 'ghost', { size: 'sm' })}</header>
            <ul class="orders">${ORDERS.slice(0, 5)
              .map((order) => `<li>${orderRow(order)}</li>`)
              .join('')}</ul>
          </section>
          <section class="panel">
            <header class="panel-head"><h2 class="panel-title">Bake schedule</h2></header>
            <div class="panel-body"><ol class="timeline">
              ${step('done', 'Mix and shape', '4:00 · 412 loaves')}
              ${step('done', 'Oven 1 · sourdough', '5:30 · 180 loaves')}
              ${step('current', 'Oven 2 · croissants', '6:45 · 220 pieces')}
              ${step('next', 'First deliveries', '7:15 · 14 stops')}
            </ol></div>
          </section>
        </div>
      </div></main>
    </div>`

  const orders = (state) => {
    const isEmpty = state === 'empty'
    const list = isEmpty
      ? empty(
          'neutral',
          'list',
          'No orders yet',
          'Orders your customers place show up here. Add one yourself, or import last week’s orders to get started.',
          `${button('Import CSV', 'secondary', { icon: 'download' })}${button('New order', 'primary', { icon: 'plus' })}`
        )
      : `<div class="table-head"><span></span><span>Customer</span><span>Date</span><span>Due</span><span>Status</span><span>Total</span></div>
         <ul class="orders">${ORDERS.map((order) => `<li>${orderRow(order, true)}</li>`).join('')}</ul>`
    return `
    <div class="app">${sidebar('orders', isEmpty ? 0 : 38)}
      <main class="main"><div class="main-inner">
        <header class="page-head">
          <div><p class="page-kicker">${isEmpty ? 'No orders' : '38 orders this week'}</p><h1 class="page-title">Orders</h1></div>
          <div class="page-actions">${button('Export', 'secondary', { icon: 'download' })}${button('New order', 'primary', { icon: 'plus' })}</div>
        </header>
        <div class="toolbar">
          <div class="tabs" role="tablist">${tab('All', true)}${tab('Due today', false)}${tab('Late', false)}${tab('Delivered', false)}</div>
          ${search()}
        </div>
        <section class="panel">${list}</section>
      </div></main>
    </div>`
  }

  const detail = () => {
    const order = ORDERS[0]
    return `
    <div class="app">${sidebar('orders')}
      <main class="main"><div class="main-inner">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/orders">Orders</a><span>/</span><span>#${order.id}</span></nav>
        <header class="page-head">
          <div><p class="page-kicker">${badge(order.status)}</p><h1 class="page-title">Order #${order.id}</h1></div>
          <div class="page-actions">${button('Print label', 'secondary')}${button('Mark delivered', 'primary')}</div>
        </header>
        <div class="split">
          <div class="stack">
            <section class="panel">
              <header class="panel-head"><h2 class="panel-title">Items</h2><span class="muted">3 products</span></header>
              <div class="panel-body">
                <ul class="lines">
                  <li class="line"><span class="line-qty">24</span><span>Country sourdough, 900 g</span><span class="line-total">$168.00</span></li>
                  <li class="line"><span class="line-qty">60</span><span>Butter croissant</span><span class="line-total">$252.00</span></li>
                  <li class="line"><span class="line-qty">12</span><span>Rye baguette</span><span class="line-total">$66.00</span></li>
                </ul>
                <div class="sum"><span>Total</span><b>${order.total}</b></div>
              </div>
            </section>
            <section class="panel">
              <header class="panel-head"><h2 class="panel-title">Delivery</h2>${button('Track', 'ghost', { size: 'sm', icon: 'truck' })}</header>
              <div class="panel-body"><ol class="timeline">
                ${step('done', 'Order confirmed', 'Wed, Nov 18 · 16:20')}
                ${step('done', 'Baked and packed', 'Thu, Nov 19 · 6:55')}
                ${step('current', 'Out for delivery', 'Driver: Joana · arriving 7:40')}
                ${step('next', 'Delivered', 'Signature on arrival')}
              </ol></div>
            </section>
          </div>
          <div class="stack">
            <section class="panel"><div class="panel-body">
              <div class="customer">${avatar(order.initials)}<div><b>${order.customer}</b><span class="muted">Customer since 2023</span></div></div>
              <dl class="facts">
                <div><dt>Contact</dt><dd>Mira Hoffmann</dd></div>
                <div><dt>Address</dt><dd>14 Linden Street</dd></div>
                <div><dt>Window</dt><dd>7:00 to 8:00</dd></div>
                <div><dt>Payment</dt><dd>Invoice, 14 days</dd></div>
              </dl>
            </div></section>
            ${banner('info', 'alert', 'Leave at the back door before 8:00. Ring twice.')}
          </div>
        </div>
      </div></main>
    </div>`
  }

  const phoneOrder = () => `
    <div class="phone">
      <header class="phone-head"><a class="back" href="#/m/orders" aria-label="Back">${icon('back', 18)}</a><h1>Order #1042</h1>${avatar('LC', 'sm')}</header>
      <main class="phone-body">
        <section class="phone-hero">
          <span>${badge('transit')}</span>
          <h2 class="page-title">Arriving at 7:40</h2>
          <p class="muted">Lindenhof Café · 14 Linden Street</p>
        </section>
        <section class="panel"><div class="panel-body"><ol class="timeline">
          ${step('done', 'Order confirmed', 'Wed · 16:20')}
          ${step('done', 'Baked and packed', 'Thu · 6:55')}
          ${step('current', 'Out for delivery', 'Driver: Joana')}
          ${step('next', 'Delivered', 'Signature on arrival')}
        </ol></div></section>
        <section class="panel"><div class="panel-body"><ul class="lines">
          <li class="line"><span class="line-qty">24</span><span>Country sourdough</span><span class="line-total">$168.00</span></li>
          <li class="line"><span class="line-qty">60</span><span>Butter croissant</span><span class="line-total">$252.00</span></li>
          <li class="line"><span class="line-qty">12</span><span>Rye baguette</span><span class="line-total">$66.00</span></li>
        </ul></div></section>
      </main>
      <footer class="phone-foot">${button('Call the driver', 'primary', { block: true })}</footer>
    </div>`

  const phoneOrders = (state) =>
    state === 'error'
      ? phoneError()
      : `
    <div class="phone">
      <header class="phone-head"><span class="back">${icon('bread', 18)}</span><h1>Orders</h1>${avatar('RC', 'sm')}</header>
      <main class="phone-body">
        <section class="panel"><ul class="orders">${ORDERS.slice(0, 6)
          .map((order) => `<li>${orderRow(order)}</li>`)
          .join('')}</ul></section>
      </main>
    </div>`

  const phoneError = () => `
    <div class="phone">
      <header class="phone-head"><span class="back">${icon('bread', 18)}</span><h1>Orders</h1>${avatar('RC', 'sm')}</header>
      <main class="phone-body">
        ${banner('danger', 'offline', 'You are offline. Changes sync when you reconnect.')}
        <section class="panel">
          ${empty(
            'danger',
            'alert',
            'Orders could not load',
            'Check your connection and try again. The last sync was at 6:12.',
            `${button('View saved', 'secondary')}${button('Try again', 'primary')}`
          )}
        </section>
      </main>
    </div>`

  const ROUTES = [
    { pattern: /^\/dashboard$/, render: dashboard, title: 'Today' },
    { pattern: /^\/orders$/, render: orders, title: 'Orders' },
    { pattern: /^\/orders\/\d+$/, render: detail, title: 'Order #1042' },
    { pattern: /^\/m\/orders\/\d+$/, render: phoneOrder, title: 'Order #1042' },
    { pattern: /^\/m\/orders$/, render: phoneOrders, title: 'Orders' },
  ]

  function render() {
    const hash = location.hash.replace(/^#/, '') || '/dashboard'
    const [path, query = ''] = hash.split('?')
    const state = new URLSearchParams(query).get('state')
    const route = ROUTES.find((item) => item.pattern.test(path)) ?? ROUTES[0]
    document.getElementById('root').innerHTML = route.render(state)
    document.title = `${route.title} · Crumb`
    window.scrollTo(0, 0)
  }

  window.addEventListener('hashchange', render)
  render()
})()
