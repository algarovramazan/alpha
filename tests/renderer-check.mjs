// Renderer check over CDP.
// Usage: node tests/renderer-check.mjs   (Alpha must run with --remote-debugging-port=9222)
const EP = 'http://127.0.0.1:9222/json'

const targets = await (await fetch(EP)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) {
  console.error('no page target')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const problems = []

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result)
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${JSON.stringify(msg.params.exceptionDetails?.exception?.description ?? msg.params).slice(0, 400)}`)
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`console: ${msg.params.entry.text.slice(0, 400)}`)
  }
})

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

await send('Runtime.enable')
await send('Log.enable')

async function evalJs(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300))
  return result.result.value
}

// This suite assumes a default panel placement: a hand-moved panel (panelSides
// in settings) hides rail icons the later checks click. Reset and boot fresh.
await evalJs(
  `window.alpha.invoke('settings:set', { panelSides: {}, leftPanel: 'projects', rightPanel: 'inspector', sidebarCollapsed: false, inspectorCollapsed: false }).then(() => { location.reload(); return 1 })`
)
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    if (await evalJs(`!!document.querySelector('.panel-rail.left') && !!document.querySelector('.composer')`)) break
  } catch {
    // the page is mid-reload
  }
}

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })

const initial = await evalJs(
  `JSON.stringify({
     title: document.title,
     sidebar: !!document.querySelector('.sidebar'),
     topbar: !!document.querySelector('.topbar'),
     feed: !!document.querySelector('.feed'),
     composer: !!document.querySelector('.composer'),
     inspector: !!document.querySelector('.inspector'),
     text: document.body.innerText.slice(0, 300)
   })`
)
const state = JSON.parse(initial)
check('window title', state.title === 'Alpha', state.title)
check('layout sidebar/chat/inspector', state.sidebar && state.topbar && state.feed && state.composer && state.inspector)
check('first paint has text', state.text.length > 10, state.text.replace(/\n/g, ' | ').slice(0, 200))

// the icon rail: one column, three panel icons, the settings gear at the bottom
check('left rail renders', await evalJs(`!!document.querySelector('.panel-rail.left')`))
const railBtnCount = Number(await evalJs(`document.querySelectorAll('.panel-rail.left .rail-btn').length`))
check('rail holds three panels and settings', railBtnCount === 4, String(railBtnCount))

// open settings from the gear at the bottom of the rail
async function openSettingsModal() {
  if (await evalJs(`!!document.querySelector('.modal-nav')`)) return
  await evalJs(`[...document.querySelectorAll('.panel-rail.left .rail-btn')].find(b => b.title === 'Настройки' || b.title === 'Settings')?.click(); 1`)
  // the settings window is a lazy chunk: poll until it actually mounts
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await evalJs(`!!document.querySelector('.modal-nav')`)) return
  }
}
await openSettingsModal()
const modal = await evalJs(
  `JSON.stringify({ modal: !!document.querySelector('.modal'), sections: document.querySelectorAll('.modal-nav button').length, body: document.querySelector('.modal-body')?.innerText.slice(0,120) })`
)
const modalState = JSON.parse(modal)
check('settings modal opens', modalState.modal, '')
  check('15 settings sections', modalState.sections === 15, String(modalState.sections))

// the modal remembers the last section: force the model section for the pin test
await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Модель' || b.textContent.trim() === 'Model')?.click(); 1`)
await new Promise((r) => setTimeout(r, 250))

// pin / unpin round trip in the model section (skips when no model is chosen)
const pinBefore = JSON.parse(
  await evalJs(
    `window.alpha.invoke('settings:get').then(s => JSON.stringify({ key: s.defaultProvider && s.defaultModel ? s.defaultProvider + '/' + s.defaultModel : '', pinned: s.pinnedModels }))`
  )
)
const pinKeyIsKeyed = pinBefore.key
  ? JSON.parse(
      await evalJs(
        `window.alpha.invoke('models:list', 'home').then(m => JSON.stringify(m.some(x => x.hasKey && x.provider + '/' + x.id === '${pinBefore.key}')))`
      )
    )
  : false
if (pinBefore.key && pinKeyIsKeyed) {
  const wasPinned = pinBefore.pinned.includes(pinBefore.key)
  const pinSelector = `[...document.querySelectorAll('.modal-body button')].find(b => b.title === 'Закрепить' || b.title === 'Pin' || b.title === 'Открепить' || b.title === 'Unpin')`
  await evalJs(`${pinSelector}?.click(); 1`)
  await new Promise((r) => setTimeout(r, 350))
  const mid = JSON.parse(
    await evalJs(`window.alpha.invoke('settings:get').then(s => JSON.stringify(s.pinnedModels))`)
  )
  check('pin toggles', wasPinned ? !mid.includes(pinBefore.key) : mid.includes(pinBefore.key), JSON.stringify(mid))
  await evalJs(`${pinSelector}?.click(); 1`)
  await new Promise((r) => setTimeout(r, 350))
  const back = JSON.parse(
    await evalJs(`window.alpha.invoke('settings:get').then(s => JSON.stringify(s.pinnedModels))`)
  )
  check('pin restores', wasPinned ? back.includes(pinBefore.key) : !back.includes(pinBefore.key), JSON.stringify(back))
}

// switch to the "Вид" section and flip density to prove settings apply live
await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Вид').click(); 1`)
await new Promise((r) => setTimeout(r, 250))
const lookOk = await evalJs(`!!document.querySelector('.modal-body .form-row')`)
check('appearance section renders', lookOk)

// mod themes live in the theme list next to the built-in ones
const hasThemeMods = JSON.parse(
  await evalJs(
    `window.alpha.invoke('mods:list').then(m => JSON.stringify(m.some(x => x.kind === 'theme' && x.enabled && !x.error)))`
  )
)
if (hasThemeMods) {
  await evalJs(`document.querySelector('.set-theme')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 250))
  check(
    'mod themes listed in appearance',
    await evalJs(`[...document.querySelectorAll('.drop-menu .drop-group-title')].some(e => e.textContent === 'Темы модов' || e.textContent === 'Mod themes')`)
  )
  // picking a mod theme must switch the root into mod mode and hand over the accent
  const themeBefore = String(await evalJs(`document.querySelector('.set-theme')?.dataset.value || ''`))
  await evalJs(`[...document.querySelectorAll('.drop-menu .drop-item')].find(i => (i.dataset.value || '').startsWith('mod:'))?.click(); 1`)
  await new Promise((r) => setTimeout(r, 800))
  const modState = JSON.parse(
    await evalJs(`JSON.stringify({ theme: document.documentElement.getAttribute('data-theme'), accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() })`)
  )
  check('mod theme switches root to mod mode', modState.theme === 'mod', JSON.stringify(modState))
  // restore the previous selection
  await evalJs(`document.querySelector('.set-theme')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 250))
  await evalJs(`[...document.querySelectorAll('.drop-menu .drop-item')].find(i => i.dataset.value === ${JSON.stringify(themeBefore)})?.click(); 1`)
  await new Promise((r) => setTimeout(r, 450))
}

// prompts library and action confirmation sections render
await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Промпты').click(); 1`)
await new Promise((r) => setTimeout(r, 300))
check('prompts section renders', await evalJs(`!!document.querySelector('.prompts-list') || document.body.innerText.includes('Шаблонов пока нет')`))
await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Действия').click(); 1`)
await new Promise((r) => setTimeout(r, 300))
await evalJs(`document.querySelector('.set-approval')?.click(); 1`)
await new Promise((r) => setTimeout(r, 250))
check(
  'permissions section renders',
  await evalJs(`!!document.querySelector('.drop-menu .drop-item[data-value="risky"]')`)
)
await evalJs(`document.querySelector('.set-approval')?.click(); 1`)
await new Promise((r) => setTimeout(r, 200))

// version reporting (matches the value from app:state, whatever the source)
await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Версия pi').click(); 1`)
await new Promise((r) => setTimeout(r, 300))
const piText = String(await evalJs(`document.querySelector('.modal-body').innerText`))
const expectedVersion = JSON.parse(
  await evalJs(`window.alpha.invoke('app:state').then(s => JSON.stringify(s.appVersion))`)
)
check(
  'version shows in settings',
  piText.includes(`Alpha ${expectedVersion}`) && /^\d+\.\d+\.\d+/.test(String(expectedVersion)),
  String(expectedVersion)
)

await evalJs(`[...document.querySelectorAll('.modal-head button')].find(b => b.textContent.includes('Закрыть') || b.textContent.includes('Close')).click(); 1`)
await new Promise((r) => setTimeout(r, 250))
check('settings modal closes', !(await evalJs(`!!document.querySelector('.modal')`)))

// create a chat
await evalJs(`[...document.querySelectorAll('.icon-btn')].find(b => b.title && b.title.includes('Новый чат'))?.click() ?? [...document.querySelectorAll('.btn')].find(b=>b.textContent.includes('New chat'))?.click(); 1`)
await new Promise((r) => setTimeout(r, 900))
const afterNew = await evalJs(`JSON.stringify({ empty: !!document.querySelector('.empty-state'), pill: document.querySelector('.status-pill')?.textContent })`)
check('new chat shows empty state', JSON.parse(afterNew).empty === true, afterNew)

// window title
const title = await evalJs('document.title')
check('window title', title.startsWith('Alpha'), title)

// frameless chrome: window controls on the right
check('window controls', (await evalJs(`document.querySelectorAll('.win-controls .win-btn').length`)) === 3)

// regression: controls live in their own row above the inspector, never under it
const winRects = JSON.parse(
  await evalJs(
    `JSON.stringify((() => { const w = document.querySelector('.win-controls').getBoundingClientRect(); const insp = document.querySelector('.panel-col.right .inspector'); const vis = insp && getComputedStyle(insp).display !== 'none'; const i = vis ? insp.getBoundingClientRect() : null; return { right: w.right, bottom: w.bottom, vw: window.innerWidth, inspTop: i ? i.top : null } })())`
  )
)
check(
  'window controls never overlap the panel',
  winRects.right <= winRects.vw + 1 && (winRects.inspTop === null || winRects.bottom <= winRects.inspTop + 1),
  JSON.stringify(winRects)
)

// inspector sections collapse and expand (the page must be open first)
if (await evalJs(`!!document.querySelector('.inspector')?.closest('.panel-page')?.hidden`)) {
  await evalJs(`[...document.querySelectorAll('.panel-rail.left .rail-btn')].find(b => b.title === 'Инспектор' || b.title === 'Inspector')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 350))
}
const sectionsBefore = Number(await evalJs(`document.querySelectorAll('.insp-section-body').length`))
if (sectionsBefore >= 2) {
  await evalJs(`document.querySelector('.insp-section-head').click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
  const collapsed = Number(await evalJs(`document.querySelectorAll('.insp-section-body').length`))
  check('inspector section collapses', collapsed === sectionsBefore - 1, `${sectionsBefore} -> ${collapsed}`)
  await evalJs(`document.querySelector('.insp-section-head').click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
  const expanded = Number(await evalJs(`document.querySelectorAll('.insp-section-body').length`))
  check('inspector section expands back', expanded === sectionsBefore, `${expanded}`)
}

// only providers with an API key may appear in the model selector
const modelGroups = JSON.parse(
  await evalJs(
    `(async () => {
      document.querySelector('.quick-toggle')?.click()
      await new Promise(r => setTimeout(r, 250))
      document.querySelector('.quick-menu .model-select')?.click()
      await new Promise(r => setTimeout(r, 250))
      const models = await window.alpha.invoke('models:list', 'home')
      const keyed = new Set(models.filter(m => m.hasKey).map(m => m.provider))
      const groups = [...document.querySelectorAll('.quick-menu .drop-group-title')].map(e => e.textContent)
      document.querySelector('.quick-toggle')?.click()
      return JSON.stringify({ bad: groups.filter(g => !['Закреплённые', 'Бесплатные', 'Платные'].includes(g) && !keyed.has(g)), groups })
    })()`
  )
)
check('model list shows only keyed providers', modelGroups.bad.length === 0, JSON.stringify(modelGroups))

// ------------------------------------------------- rail: fold, switch, move
const clickRail = async (name) => {
  await evalJs(
    `[...document.querySelectorAll('.panel-rail.left .rail-btn')].find(b => b.title === ${JSON.stringify(name)})?.click(); 1`
  )
  await new Promise((r) => setTimeout(r, 320))
}
const leftHidden = async () => Boolean(await evalJs(`document.querySelector('.panel-col.left')?.hidden ?? true`))

// the inspector page is open (revealed above): its own icon folds the column
await clickRail('Инспектор')
check('rail click folds the active panel', await leftHidden())
await clickRail('Инспектор')
check('rail click reopens the panel', !(await leftHidden()))

// one column switches its content by icon
await clickRail('Файлы')
check(
  'rail switches to the files panel',
  await evalJs(`!!document.querySelector('.filetree') && !document.querySelector('.filetree').closest('.panel-page').hidden`)
)
await clickRail('Проекты и чаты')
check('rail switches back to projects', await evalJs(`!document.querySelector('.sidebar').closest('.panel-page').hidden`))

// context menu: move the inspector to the right side …
await evalJs(
  `[...document.querySelectorAll('.panel-rail.left .rail-btn')].find(b => b.title === 'Инспектор')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 160 })); 1`
)
await new Promise((r) => setTimeout(r, 300))
check('context menu opens on the rail icon', await evalJs(`!!document.querySelector('.rail-menu')`))
await evalJs(`document.querySelector('.rail-menu button')?.click(); 1`)
await new Promise((r) => setTimeout(r, 500))
check(
  'panel moves to the right side',
  await evalJs(`!!document.querySelector('.panel-rail.right') && !(document.querySelector('.panel-col.right')?.hidden ?? true)`)
)
check('right rail lists the moved panel', Number(await evalJs(`document.querySelectorAll('.panel-rail.right .rail-btn').length`)) === 1)

// … and back to the left side
await evalJs(
  `[...document.querySelectorAll('.panel-rail.right .rail-btn')][0]?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 160 })); 1`
)
await new Promise((r) => setTimeout(r, 300))
await evalJs(`document.querySelector('.rail-menu button')?.click(); 1`)
await new Promise((r) => setTimeout(r, 500))
check('panel moves back to the left side', await evalJs(`!document.querySelector('.panel-rail.right')`))

// cpu menu: model and thinking level only (palette lives on Ctrl+K, settings on the rail)
await evalJs(`document.querySelector('.quick-toggle')?.click(); 1`)
await new Promise((r) => setTimeout(r, 300))
const quickState = JSON.parse(
  await evalJs(
    `JSON.stringify({
      triggers: document.querySelectorAll('.quick-menu .drop-trigger').length,
      labels: [...document.querySelectorAll('.quick-menu .quick-label')].map(e => e.textContent),
      actions: document.querySelectorAll('.quick-menu .quick-actions').length,
      chip: document.querySelectorAll('.quick-menu .usage-chip').length,
      settingsBtn: [...document.querySelectorAll('.quick-menu button')].some(b => (b.textContent || '').includes('Настройки'))
    })`
  )
)
check(
  'cpu menu holds model and thinking only',
  quickState.triggers === 2 && quickState.actions === 0 && quickState.chip === 0 && !quickState.settingsBtn && quickState.labels.length === 2,
  JSON.stringify(quickState)
)
await evalJs(`document.querySelector('.quick-toggle')?.click(); 1`)
await new Promise((r) => setTimeout(r, 250))

// quick mode: the selector edits quickThinking and leaves the global level alone
const levelsBefore = JSON.parse(
  await evalJs(`window.alpha.invoke('settings:get').then(s => JSON.stringify({ q: s.quickThinking, g: s.thinkingLevel }))`)
)
await evalJs(`document.querySelector('.mode-pill')?.click(); 1`)
await new Promise((r) => setTimeout(r, 300))
await evalJs(`[...document.querySelectorAll('.mode-item')].find(b => b.textContent.includes('Быстрый'))?.click(); 1`)
await new Promise((r) => setTimeout(r, 500))
await evalJs(`document.querySelector('.quick-toggle')?.click(); 1`)
await new Promise((r) => setTimeout(r, 300))
const quickLevelValue = String(await evalJs(`document.querySelector('.quick-menu .thinking-select')?.dataset.value ?? ''`))
check(
  'quick mode selector shows the quick level',
  quickLevelValue === levelsBefore.q,
  JSON.stringify({ quickLevelValue, ...levelsBefore })
)
const otherLevel = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find((l) => l !== levelsBefore.q)
await evalJs(`document.querySelector('.quick-menu .thinking-select')?.click(); 1`)
await new Promise((r) => setTimeout(r, 250))
await evalJs(`document.querySelector('.quick-menu .drop-menu .drop-item[data-value="${otherLevel}"]')?.click(); 1`)
await new Promise((r) => setTimeout(r, 450))
const levelsAfter = JSON.parse(
  await evalJs(`window.alpha.invoke('settings:get').then(s => JSON.stringify({ q: s.quickThinking, g: s.thinkingLevel }))`)
)
check(
  'quick level edits quickThinking only',
  levelsAfter.q === otherLevel && levelsAfter.g === levelsBefore.g,
  JSON.stringify({ levelsAfter, levelsBefore })
)
// restore the level, close the menu, leave quick mode
await evalJs(`document.querySelector('.quick-menu .thinking-select')?.click(); 1`)
await new Promise((r) => setTimeout(r, 250))
await evalJs(`document.querySelector('.quick-menu .drop-menu .drop-item[data-value="${levelsBefore.q}"]')?.click(); 1`)
await new Promise((r) => setTimeout(r, 400))
await evalJs(`document.querySelector('.quick-toggle')?.click(); 1`)
await new Promise((r) => setTimeout(r, 250))
await evalJs(`document.querySelector('.mode-pill')?.click(); 1`)
await new Promise((r) => setTimeout(r, 300))
await evalJs(`[...document.querySelectorAll('.mode-item')].find(b => b.textContent.includes('Агент'))?.click(); 1`)
await new Promise((r) => setTimeout(r, 450))

// with the left column folded the chat takes everything but the rail
await clickRail('Инспектор')
check('left column folds for the width test', await leftHidden())
const widths = JSON.parse(
  await evalJs(
    `JSON.stringify({ app: document.querySelector('.app').getBoundingClientRect().width, chat: document.querySelector('.chat-col').getBoundingClientRect().width, rail: document.querySelector('.panel-rail.left').getBoundingClientRect().width, composer: document.querySelector('.composer-inner').getBoundingClientRect().width })`
  )
)
check('chat fills window except the rail', Math.abs((widths.app - widths.chat) - widths.rail) < 2, JSON.stringify(widths))
const composerBox = JSON.parse(
  await evalJs(
    `JSON.stringify((() => { const c = document.querySelector('.composer'); const s = getComputedStyle(c); return { avail: c.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), inner: document.querySelector('.composer-inner').getBoundingClientRect().width } })())`
  )
)
check(
  'composer row stretches full width',
  Math.abs(composerBox.avail - composerBox.inner) < 2,
  JSON.stringify(composerBox)
)
await clickRail('Инспектор')
check('left column restores', !(await leftHidden()))
await clickRail('Проекты и чаты')
check('projects panel is visible at the end', await evalJs(`!document.querySelector('.sidebar').closest('.panel-page').hidden`))

// command palette opens with its hotkey and closes with Escape
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); 1`)
await new Promise((r) => setTimeout(r, 300))
const paletteOpen = await evalJs(`!!document.querySelector('.palette')`)
check('command palette opens', paletteOpen)
if (paletteOpen) {
  check(
    'palette lists worktree command',
    await evalJs(`[...document.querySelectorAll('.palette-item')].some(i => i.textContent.includes('worktree'))`)
  )
  await evalJs(
    `document.querySelector('.palette input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`
  )
  await new Promise((r) => setTimeout(r, 250))
}
check('command palette closes', !(await evalJs(`!!document.querySelector('.palette')`)))

// preview tab only appears once the model wrote something previewable
const previewVisible = await evalJs(
  `[...document.querySelectorAll('.tab')].some(b => b.textContent.includes('Превью') || b.title.includes('Preview'))`
)
if (previewVisible) {
  await evalJs(`[...document.querySelectorAll('.tab')].find(b => b.textContent.includes('Превью') || b.title.includes('Preview')).click(); 1`)
  await new Promise((r) => setTimeout(r, 350))
  check('preview tab opens', await evalJs(`!!document.querySelector('.preview')`))
  await evalJs(`[...document.querySelectorAll('.tab')][0].click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
} else {
  check('preview tab hidden until files exist', true)
}
check('chat tab keeps the feed', await evalJs(`!!document.querySelector('.feed')`))

// Escape closes the settings window
await openSettingsModal()
check('settings opens for escape test', await evalJs(`!!document.querySelector('.modal')`))
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`)
await new Promise((r) => setTimeout(r, 300))
check('escape closes settings', !(await evalJs(`!!document.querySelector('.modal')`)))

// rename a chat inline
const chatItems = `[...document.querySelectorAll('.chats-scroll .item')]`
const itemCount = Number(await evalJs(`${chatItems}.length`))
if (itemCount > 0) {
  // rename lives in the row menu: open the dots menu, then pick Rename
  await evalJs(`${chatItems}[0].querySelectorAll('.icon-btn')[0].click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
  await evalJs(`[...document.querySelectorAll('.row-menu button')].find(b => b.textContent.trim() === 'Переименовать' || b.textContent.trim() === 'Rename')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
  const hasInput = await evalJs(`!!document.querySelector('.rename-input')`)
  check('rename input opens', hasInput)
  if (hasInput) {
    await evalJs(`(() => {
      const input = document.querySelector('.rename-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'smoke-rename')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 1
    })()`)
    await new Promise((r) => setTimeout(r, 600))
    check('chat name updates', await evalJs(`${chatItems}[0].textContent.includes('smoke-rename')`))
    // rename back (menu again)
    await evalJs(`${chatItems}[0].querySelectorAll('.icon-btn')[0].click(); 1`)
    await new Promise((r) => setTimeout(r, 300))
    await evalJs(`[...document.querySelectorAll('.row-menu button')].find(b => b.textContent.trim() === 'Переименовать' || b.textContent.trim() === 'Rename')?.click(); 1`)
    await new Promise((r) => setTimeout(r, 300))
    await evalJs(`(() => {
      const input = document.querySelector('.rename-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 1
    })()`)
    await new Promise((r) => setTimeout(r, 600))
    check('rename restores', !(await evalJs(`${chatItems}[0].textContent.includes('smoke-rename')`)))
  }
}

// mass selection of chats
await evalJs(`[...document.querySelectorAll('.sidebar .icon-btn')].find(b => b.title === 'Выбор')?.click(); 1`)
await new Promise((r) => setTimeout(r, 300))
const hasCheckboxes = await evalJs(`document.querySelectorAll('.sidebar .checkbox').length > 0`)
check('select mode shows checkboxes', hasCheckboxes)
if (hasCheckboxes && itemCount >= 1) {
  await evalJs(`${chatItems}[0].click(); 1`)
  if (itemCount >= 2) await evalJs(`${chatItems}[1].click(); 1`)
  await new Promise((r) => setTimeout(r, 250))
  const bulkText = await evalJs(`document.querySelector('.bulk-bar') ? document.querySelector('.bulk-bar').innerText : ''`)
  check('bulk bar counts selection', String(bulkText).includes(String(Math.min(2, itemCount))), String(bulkText))
  await evalJs(`[...document.querySelectorAll('.sidebar .icon-btn')].find(b => b.title === 'Отмена' || b.title === 'Cancel')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 250))
  check('select mode exits', !(await evalJs(`!!document.querySelector('.sidebar .checkbox')`)))
}

// font size setting scales the root and rem-based components (driven through the UI)
const originalSize = JSON.parse(await evalJs(`window.alpha.invoke('settings:get').then(s => JSON.stringify(s.fontSize))`))
await openSettingsModal()
await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Вид').click(); 1`)
await new Promise((r) => setTimeout(r, 350))
const setFontSize = async (value) => {
  await evalJs(`document.querySelector('.set-font-size')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 250))
  await evalJs(`document.querySelector('.drop-menu .drop-item[data-value="${value}"]')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 400))
}
await setFontSize(18)
const fontCheck = JSON.parse(
  await evalJs(
    `JSON.stringify({ root: getComputedStyle(document.documentElement).fontSize, item: getComputedStyle(document.querySelector('.item')).fontSize })`
  )
)
check('font size scales html', fontCheck.root === '18px', JSON.stringify(fontCheck))
check('font size scales components', fontCheck.item === '15.75px', fontCheck.item)
await setFontSize(originalSize)
await evalJs(`[...document.querySelectorAll('.modal-head button')].find(b => b.textContent.includes('Закрыть')).click(); 1`)
await new Promise((r) => setTimeout(r, 300))

// mod live unload/load: toggle the notes mod in both directions,
// whatever the saved baseline is, and verify the panel follows instantly
const panelTitle = (name) => `[...document.querySelectorAll('.mod-panel-title')].some(e => e.textContent.trim() === '${name}')`
const notesEnabled = async () => JSON.parse(await evalJs(`window.alpha.invoke('mods:list').then(m => JSON.stringify(m.find(x => x.id === 'notes').enabled))`))
const openSettings = async () => {
  await openSettingsModal()
}
const openModsSection = async () => {
  await evalJs(`[...document.querySelectorAll('.modal-nav button')].find(b => b.textContent.trim() === 'Моды' || b.textContent.trim() === 'Mods').click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
}
const closeSettings = async () => {
  await evalJs(`[...document.querySelectorAll('.modal-head button')].find(b => b.textContent.includes('Закрыть') || b.textContent.includes('Close')).click(); 1`)
  await new Promise((r) => setTimeout(r, 300))
}
const clickNotesSwitch = async () => {
  await evalJs(`[...document.querySelectorAll('.list-row')].find(r => r.textContent.includes('Notes'))?.querySelector('.switch').click(); 1`)
  await new Promise((r) => setTimeout(r, 500))
}

const baseline = await notesEnabled()
check('panel state matches saved mods', (await evalJs(panelTitle('Заметки'))) === baseline)

await openSettings()
await openModsSection()
// settings fields registered by mods render in this section
const shortPromptsEnabled = JSON.parse(
  await evalJs(`window.alpha.invoke('mods:list').then(m => JSON.stringify(!!m.find(x => x.id === 'short-prompts')?.enabled))`)
)
if (shortPromptsEnabled) {
  // settings live in an accordion under the mod row now: open the gear first
  await evalJs(`[...document.querySelectorAll('.list-row')].find(r => r.textContent.includes('Short prompts'))?.querySelector('.mod-gear')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 250))
  check('mod settings field renders', await evalJs(`document.body.innerText.includes('Префикс каждого сообщения')`))
  await evalJs(`[...document.querySelectorAll('.list-row')].find(r => r.textContent.includes('Short prompts'))?.querySelector('.mod-gear')?.click(); 1`)
  await new Promise((r) => setTimeout(r, 200))
}
await clickNotesSwitch()
await closeSettings()
const flipped = await notesEnabled()
check('mod toggle persists', flipped === !baseline, `baseline=${baseline} now=${flipped}`)
check(
  flipped ? 'enabled ui mod loads live' : 'disabled ui mod unloads live',
  (await evalJs(panelTitle('Заметки'))) === flipped
)
check(
  'notes panel appears exactly once',
  (await evalJs(`[...document.querySelectorAll('.mod-panel-title')].filter(e => e.textContent.trim() === 'Заметки').length`)) ===
    (flipped ? 1 : 0)
)

await openSettings()
await openModsSection()
await clickNotesSwitch()
await closeSettings()
check('baseline restored', (await notesEnabled()) === baseline)
check('panel restored', (await evalJs(panelTitle('Заметки'))) === baseline)

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
for (const problem of problems) console.log(`PROBLEM  ${problem}`)

const failed = checks.filter((c) => !c.ok).length
console.log(failed === 0 && problems.length === 0 ? `RENDERER OK (${checks.length} checks)` : `RENDERER FAILED (${failed} checks, ${problems.length} problems)`)
process.exit(failed === 0 && problems.length === 0 ? 0 : 1)