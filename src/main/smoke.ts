// Smoke check: runs the main-process logic without a model or API key.
// Start with: ALPHA_SMOKE=1 electron out/main/index.js
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listMods, runBeforeSend, themeCss, activateCoreMods, uiModSources, getCustomTools, askUser, resolveAsk, fsList, fsRead, fsWrite, runShell } from './mods'
import { getModSettingsWithDefaults, listRegisteredModSettings, registerModSettings, setModSettingsValue } from './mod-settings'
import { setEmitter } from './bus'
import type { AlphaEvent } from '../shared/types'
import { closeChat, contextSnapshot, deleteChat, forkChatAt, listChats, listModels, openChat, searchChats, sendPrompt, setApiKey } from './pi'
import { gateToolCall, resetApprovals, resolveApproval } from './approvals'
import { createPrompt, deletePrompt, listPrompts, readPrompt, savePrompt } from './prompts'
import { chatsDirFor, MODS_DIR, RUNTIME_DIR } from './paths'
import { listSkills } from './skills'
import { loadProjects, loadSettings, saveSettings } from './store'
import { usageRange, usageToday } from './usage'
import { localSearchStatus, webFetchPage, webSearch } from './net'
import { modeDecision, setChatMode, modePrefix, DEFAULT_PREFIX } from './modes'
import {
  buildContextBlock,
  contextFingerprint,
  getMemory,
  kbDelete,
  kbList,
  kbNew,
  kbRead,
  memoryFile,
  projectMapFileFor,
  saveProjectMap,
  setMemory
} from './context'
import { listCheckpoints, reviewStatus } from './review'

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const checks: Check[] = []

function check(name: string, ok: boolean, detail?: string): void {
  checks.push({ name, ok, detail })
}

export async function runSmoke(): Promise<void> {
  const settings = loadSettings()
  check('settings load', typeof settings.theme === 'string' && settings.fontSize > 0)

  const skills = listSkills(undefined, [], [])
  check('skills list runs', Array.isArray(skills), `${skills.length} skills`)

  // theme mod: install a folder, read its css
  const themeDir = join(MODS_DIR, 'smoke-theme')
  mkdirSync(themeDir, { recursive: true })
  writeFileSync(join(themeDir, 'mod.json'), JSON.stringify({ id: 'smoke-theme', name: 'Smoke', kind: 'theme', api: '1.0', version: '1.0.0' }))
  writeFileSync(join(themeDir, 'theme.css'), ':root{--accent:#123456}')
  const mods = listMods()
  check('mod discovered', mods.some((m) => m.id === 'smoke-theme'), `${mods.length} mods`)
  check('theme css read', themeCss('smoke-theme') === ':root{--accent:#123456}')

  // ui mod source
  const uiDir = join(MODS_DIR, 'smoke-ui')
  mkdirSync(uiDir, { recursive: true })
  writeFileSync(join(uiDir, 'mod.json'), JSON.stringify({ id: 'smoke-ui', name: 'UI', kind: 'ui', api: '1.0', version: '1.0.0' }))
  writeFileSync(join(uiDir, 'index.js'), 'export default function (api) { api.ui.registerPanel({ id: "p", title: "P", render() {} }) }')
  const sources = uiModSources()
  check('ui mod source', sources.some((s) => s.id === 'smoke-ui'), `${sources.length} sources`)

  // core mod: mutate the outgoing prompt
  const coreDir = join(MODS_DIR, 'smoke-core')
  mkdirSync(coreDir, { recursive: true })
  writeFileSync(
    join(coreDir, 'mod.json'),
    JSON.stringify({ id: 'smoke-core', name: 'Core', kind: 'core', api: '1.0', version: '1.0.0' })
  )
  writeFileSync(
    join(coreDir, 'index.js'),
    'export default function (api) { api.on("session:before-send", (ctx) => { ctx.prompt = "X" + ctx.prompt }) }'
  )
  const errors = await activateCoreMods()
  check('core mod activates', errors.length === 0, JSON.stringify(errors))
  const transformed = runBeforeSend({ prompt: 'hi', projectId: 'home', cwd: homedir() })
  // Only smoke-core is asserted: the user's own core mods may rewrite the
  // prompt too (short-prompts, token-saver), so keep the check indifferent.
  check(
    'core mod hook runs',
    transformed.includes('X') && transformed.endsWith('hi'),
    JSON.stringify(transformed)
  )

  // tools registered by the builtin core mods
  const toolNames = getCustomTools().map((tool) => tool.name)
  check(
    'core mods register pi tools',
    toolNames.includes('ask_user') && toolNames.includes('update_task_list') && toolNames.includes('web_search'),
    toolNames.join(',')
  )

  // ask round trip: event out, answer back, promise resolves
  const captured: AlphaEvent[] = []
  const previousEmitter = setEmitter((event) => captured.push(event))
  const answerPromise = askUser('Что делаем?', ['Вариант А', 'Вариант Б'])
  await new Promise((resolve) => setTimeout(resolve, 50))
  const askEvent = captured.find((event) => event.kind === 'ask')
  check('ask event reaches renderer bus', Boolean(askEvent), JSON.stringify(askEvent))
  if (askEvent && askEvent.kind === 'ask') {
    const accepted = resolveAsk(askEvent.id, 'Вариант А')
    const answer = await answerPromise
    check('ask resolves with the chosen option', accepted && answer === 'Вариант А', answer)
  } else {
    check('ask resolves with the chosen option', false, 'no ask event')
  }
  if (previousEmitter) setEmitter(previousEmitter)

  // approvals: dangerous bash asks, safe bash passes, allow-all sticks, reset works
  // (the user may have switched the mode off — force risky, then restore)
  const approvalSettingsBefore = loadSettings()
  saveSettings({ ...approvalSettingsBefore, approvalMode: 'risky' })
  const approvalEvents: AlphaEvent[] = []
  const beforeApprovals = setEmitter((event) => approvalEvents.push(event))
  const approvalCount = (): number => approvalEvents.filter((event) => event.kind === 'approval').length

  const riskyPromise = gateToolCall('bash', { command: 'rm -rf build/' }, '/tmp/proj')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('dangerous bash requests approval', approvalCount() === 1, `${approvalCount()} requests`)
  const firstApproval = approvalEvents.find((event) => event.kind === 'approval')
  if (firstApproval && firstApproval.kind === 'approval') {
    resolveApproval(firstApproval.id, false, false)
    const decision = await riskyPromise
    check('declined action is blocked', decision?.block === true, JSON.stringify(decision))
  } else {
    check('declined action is blocked', false, 'no approval event')
  }

  const safeDecision = await gateToolCall('bash', { command: 'ls -la' }, '/tmp/proj')
  check('safe bash passes silently', safeDecision === undefined)

  const allowAllPromise = gateToolCall('bash', { command: 'sudo reboot' }, '/tmp/proj')
  await new Promise((resolve) => setTimeout(resolve, 60))
  const secondApproval = approvalEvents.filter((event) => event.kind === 'approval')[1]
  if (secondApproval && secondApproval.kind === 'approval') {
    resolveApproval(secondApproval.id, false, true)
    check('allow all accepts the action', (await allowAllPromise) === undefined)
    const afterAllowAll = await gateToolCall('bash', { command: 'git push --force' }, '/tmp/proj')
    check(
      'allow all skips further prompts',
      afterAllowAll === undefined && approvalCount() === 2,
      `${approvalCount()} requests`
    )
  } else {
    check('allow all accepts the action', false, 'no second approval event')
    check('allow all skips further prompts', false, 'no second approval event')
  }

  resetApprovals()
  const afterReset = gateToolCall('bash', { command: 'sudo reboot' }, '/tmp/proj')
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('reset asks again', approvalCount() === 3, `${approvalCount()} requests`)
  const thirdApproval = approvalEvents.filter((event) => event.kind === 'approval')[2]
  if (thirdApproval && thirdApproval.kind === 'approval') resolveApproval(thirdApproval.id, true, false)
  await afterReset

  // alpha.exec: a gated dangerous command waits for approval, a decline throws
  const gatedExec = runShell('rm -rf /tmp/alpha-smoke-vanish')
  await new Promise((resolve) => setTimeout(resolve, 80))
  const fourthApproval = approvalEvents.filter((event) => event.kind === 'approval')[3]
  if (fourthApproval && fourthApproval.kind === 'approval') {
    resolveApproval(fourthApproval.id, true, false)
    const result = await gatedExec
    check('exec approval allows the command', typeof result.code === 'number', `code=${result.code}`)
  } else {
    check('exec approval allows the command', false, 'no approval event')
  }
  const deniedExec = runShell('sudo reboot').then(
    () => 'allowed',
    () => 'denied'
  )
  await new Promise((resolve) => setTimeout(resolve, 80))
  const fifthApproval = approvalEvents.filter((event) => event.kind === 'approval')[4]
  if (fifthApproval && fifthApproval.kind === 'approval') resolveApproval(fifthApproval.id, false, false)
  check('declined exec is blocked', (await deniedExec) === 'denied', String(await deniedExec))

  if (beforeApprovals) setEmitter(beforeApprovals)
  saveSettings({ ...loadSettings(), approvalMode: approvalSettingsBefore.approvalMode })

  // prompt library: create, list, read, write, delete, path guard
  const promptPath = createPrompt('smoke-tpl')
  check('prompt created', existsSync(promptPath), promptPath)
  check('prompt listed', listPrompts().some((item) => item.name === 'smoke-tpl'))
  savePrompt(promptPath, 'hello $ARGUMENTS')
  check('prompt roundtrip', readPrompt(promptPath) === 'hello $ARGUMENTS')
  deletePrompt(promptPath)
  check('prompt deleted', !existsSync(promptPath))
  let guarded = false
  try {
    readPrompt('/etc/passwd')
  } catch {
    guarded = true
  }
  check('prompt path guard', guarded)

  // alpha.fs: write, read, list (inside the home root, so no approval needed)
  const fsDir = join(RUNTIME_DIR, 'smoke-fs')
  await fsWrite(join(fsDir, 'a.txt'), 'alpha-fs')
  check('mod fs roundtrip', fsRead(join(fsDir, 'a.txt')) === 'alpha-fs')
  check('mod fs list', fsList(fsDir).includes('a.txt'))
  rmSync(fsDir, { recursive: true, force: true })

  // alpha.exec: a safe command runs without asking
  const echo = await runShell('echo alpha-exec')
  check('mod exec runs', echo.code === 0 && echo.stdout.trim() === 'alpha-exec', echo.stdout.trim())

  // alpha.modSettings: defaults, overrides, registration
  registerModSettings('smoke-mod', [{ key: 'greet', label: 'Greeting', type: 'text', default: 'hi' }])
  check('mod settings registered', listRegisteredModSettings().some((entry) => entry.modId === 'smoke-mod'))
  setModSettingsValue('smoke-mod', 'greet', 'alpha')
  check('mod settings value wins over default', getModSettingsWithDefaults('smoke-mod').greet === 'alpha')
  setModSettingsValue('smoke-mod', 'greet', 'hi')

  // web search engine: live search first, then local SearXNG status
  try {
    const hits = await webSearch('linux kernel', 5)
    check(
      'web search returns results',
      hits.length > 0 && hits.every((hit) => Boolean(hit.title) && Boolean(hit.url)),
      `${hits.length} hits via ${[...new Set(hits.map((hit) => hit.via))].join(',')}`
    )
  } catch (error) {
    check('web search returns results', false, String(error))
  }
  const localStatus = localSearchStatus()
  check('local search status answers', typeof localStatus.url === 'string', `${localStatus.url} healthy=${localStatus.healthy}`)
  try {
    const page = await webFetchPage('https://example.com')
    check('web fetch reads a page', page.includes('Example Domain'), page.slice(0, 40))
  } catch (error) {
    check('web fetch reads a page', false, String(error))
  }

  // live model test: runs only when ALPHA_OPENROUTER_KEY is provided
  const liveKey = process.env.ALPHA_OPENROUTER_KEY
  if (liveKey) {
    const settingsBefore = loadSettings()
    try {
      await setApiKey(homedir(), 'openrouter', liveKey)
      const models = await listModels(homedir())
      const openrouter = models.filter((model) => model.provider === 'openrouter' && model.hasKey)
      check('openrouter key accepted', openrouter.length > 0, `${openrouter.length} models`)
      const chosen =
        openrouter.find((model) => model.id.includes(':free')) ??
        openrouter.find((model) => /free/.test(model.id)) ??
        openrouter[0]
      if (chosen) {
        saveSettings({ ...settingsBefore, defaultProvider: 'openrouter', defaultModel: chosen.id })
        const liveEvents: AlphaEvent[] = []
        const previousLive = setEmitter((event) => liveEvents.push(event))
        try {
          const opened = await openChat('home', homedir(), undefined)
          await sendPrompt('Ответь ровно одним словом: ок')
          const text = liveEvents
            .filter((event): event is Extract<AlphaEvent, { kind: 'session' }> => event.kind === 'session')
            .map((event) => (event.event.type === 'text' ? event.event.delta : ''))
            .join('')
          const doneEvent = liveEvents.find(
            (event) => event.kind === 'session' && event.event.type === 'done'
          )
          check(
            'live model answered',
            text.trim().length > 0,
            `${chosen.id}: ${text.trim().slice(0, 60)}`
          )
          let liveUsage: { tokens: number } | undefined
          let doneCount = 0
          for (const event of liveEvents) {
            if (event.kind !== 'session' || event.event.type !== 'done') continue
            doneCount++
            if (event.event.usage && event.event.usage.tokens > 0) liveUsage = event.event.usage
          }
          check(
            'live run reported usage',
            Boolean(liveUsage),
            `${liveUsage?.tokens ?? 0} tok across ${doneCount} done events`
          )
          await closeChat()
          await deleteChat('home', opened.chatId)
        } finally {
          if (previousLive) setEmitter(previousLive)
        }
      } else {
        check('live model answered', false, 'no openrouter models')
      }
    } catch (error) {
      check('live model answered', false, String(error))
    } finally {
      saveSettings(settingsBefore)
    }
  }

  // chats: list, create session, search, close
  const chats = await listChats('home', homedir())
  check('chats list runs', Array.isArray(chats), `${chats.length} chats`)
  try {
    const opened = await openChat('home', homedir())
    check('session opens', typeof opened.chatId === 'string' && opened.chatId.length > 0, opened.chatId)
    check('history converts', Array.isArray(opened.messages), `${opened.messages.length} messages`)
    await closeChat()
    check('session closes', true)
  } catch (error) {
    check('session opens', false, String(error))
  }
  try {
    const hits = await searchChats('home', 'zzz-no-such-text')
    check('search runs', Array.isArray(hits))
  } catch (error) {
    check('search runs', false, String(error))
  }

  check('projects list runs', Array.isArray(loadProjects()))

  // mode gate: agent passes, plan blocks mutations and allows read-only work
  check('mode off lets tools through', modeDecision('write', { path: '/tmp/x' }, undefined, homedir()) === undefined)
  setChatMode('smoke-plan-chat', 'plan')
  const planBlocked = modeDecision('write', { path: '/tmp/x' }, 'smoke-plan-chat', homedir())
  const planRead = modeDecision('read', { path: '/tmp/x' }, 'smoke-plan-chat', homedir())
  const planBashWrite = modeDecision('bash', { command: 'rm -rf build' }, 'smoke-plan-chat', homedir())
  const planBashRead = modeDecision('bash', { command: 'git status' }, 'smoke-plan-chat', homedir())
  check('plan mode blocks writes', planBlocked?.block === true, JSON.stringify(planBlocked))
  check('plan mode allows reads', planRead === undefined && planBashRead === undefined)
  check('plan mode blocks mutating bash', planBashWrite?.block === true)
  setChatMode('smoke-plan-chat', 'agent')
  check('plan mode turns off', modeDecision('write', { path: '/tmp/x' }, 'smoke-plan-chat', homedir()) === undefined)

  // assist (readonly policy): same whitelist, different reason
  setChatMode('smoke-assist-chat', 'assist')
  const assistBlocked = modeDecision('write', { path: '/tmp/x' }, 'smoke-assist-chat', homedir())
  const assistRead = modeDecision('grep', { pattern: 'x' }, 'smoke-assist-chat', homedir())
  check('assist blocks writes with read-only reason', assistBlocked?.block === true && assistBlocked.reason.includes('READ-ONLY'), JSON.stringify(assistBlocked))
  check('assist allows reads', assistRead === undefined)
  setChatMode('smoke-assist-chat', 'agent')

  // mode prefixes: built-in by default, custom setting wins
  const settingsBeforeModes = loadSettings()
  check('plan prefix is built in', modePrefix('plan', settingsBeforeModes) === DEFAULT_PREFIX.plan)
  check('agent mode has no prefix', modePrefix('agent', settingsBeforeModes) === '')
  saveSettings({ ...settingsBeforeModes, modePrefixes: { ...settingsBeforeModes.modePrefixes, debug: 'CUSTOM DEBUG' } })
  check('custom mode prefix overrides built-in', modePrefix('debug', loadSettings()) === 'CUSTOM DEBUG')
  saveSettings({ ...settingsBeforeModes, modePrefixes: { ...settingsBeforeModes.modePrefixes, debug: '' } })
  check('empty prefix falls back to built-in', modePrefix('debug', loadSettings()) === DEFAULT_PREFIX.debug)
  saveSettings(settingsBeforeModes)

  // project memory and knowledge injection
  setMemory('smoke-project', '- smoke fact\n')
  check('memory roundtrip', getMemory('smoke-project').includes('smoke fact'), memoryFile('smoke-project'))
  const memBlock = buildContextBlock('smoke-project', homedir()).block
  check('context block carries memory', memBlock.includes('smoke fact'), memBlock.slice(0, 80))
  const kbPath = kbNew('home', homedir(), 'smoke-note')
  check('knowledge file created', kbList('home', homedir()).some((item) => item.name === 'smoke-note.md'), kbPath)
  const kbBlock = buildContextBlock('home', homedir()).block
  check('context block carries knowledge', kbBlock.includes('smoke-note'), kbBlock.slice(0, 120))
  const fingerprint = contextFingerprint('home', homedir())
  check('context fingerprint is stable', contextFingerprint('home', homedir()) === fingerprint)
  check('knowledge read roundtrip', kbRead('home', homedir(), 'smoke-note').startsWith('# smoke-note'))
  kbDelete('home', homedir(), 'smoke-note')
  setMemory('smoke-project', '')
  rmSync(memoryFile('smoke-project'), { force: true })

  // the codebase map: one knowledge entry, routed to the project root
  const mapProj = join(RUNTIME_DIR, 'smoke-map-proj')
  mkdirSync(join(mapProj, '.alpha', 'knowledge'), { recursive: true })
  writeFileSync(join(mapProj, '.alpha', 'knowledge', 'PROJECT.md'), 'folder copy')
  saveProjectMap(projectMapFileFor('smoke-map', mapProj), '# карта проекта')
  const mapItems = kbList('smoke-map', mapProj)
  const mapEntry = mapItems.find((item) => item.name === 'PROJECT.md')
  check('map listed in the knowledge base', mapEntry?.map === true, JSON.stringify(mapItems))
  check(
    'folder copy of PROJECT.md is not listed twice',
    mapItems.filter((item) => item.name === 'PROJECT.md').length === 1
  )
  check('map reads from the project root', kbRead('smoke-map', mapProj, 'PROJECT.md').includes('карта проекта'))
  let mapNameReserved = false
  try {
    kbNew('smoke-map', mapProj, 'PROJECT.md')
  } catch {
    mapNameReserved = true
  }
  check('map name is reserved for new documents', mapNameReserved)
  const mapBlock = buildContextBlock('smoke-map', mapProj).block
  check(
    'context block carries exactly one map section',
    mapBlock.includes('## Codebase map (PROJECT.md)') && !mapBlock.includes('## Knowledge: PROJECT.md'),
    mapBlock.slice(0, 120)
  )
  rmSync(mapProj, { recursive: true, force: true })

  // context snapshot tells the UI whether injection is pending
  try {
    const openedCtx = await openChat('home', homedir())
    const snap = contextSnapshot(openedCtx.chatId)
    check(
      'context snapshot exposes pending flag',
      Boolean(snap) && typeof snap?.pending === 'boolean',
      JSON.stringify(snap ? { pending: snap.pending } : null)
    )
    await closeChat()
    await deleteChat('home', openedCtx.chatId)
  } catch (error) {
    check('context snapshot exposes pending flag', false, String(error))
  }

  // review and checkpoints answer for unknown targets
  const review = reviewStatus('home', homedir())
  check('review status shape', typeof review.git === 'boolean' && Array.isArray(review.files), `git=${review.git} files=${review.files.length}`)
  check('checkpoint list is empty for unknown chat', listCheckpoints('smoke-no-such-chat').length === 0)

  // fork at a message: hand-built session file, fork from the first entry
  const testDir = chatsDirFor('home')
  mkdirSync(testDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const testPath = join(testDir, `${stamp}_smoke-fork.jsonl`)
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'smoke-fork',
    timestamp: new Date().toISOString(),
    cwd: homedir()
  })
  const entry1 = JSON.stringify({
    type: 'message',
    id: 'e1',
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'первое сообщение', timestamp: Date.now() }
  })
  const entry2 = JSON.stringify({
    type: 'message',
    id: 'e2',
    parentId: 'e1',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'второе сообщение', timestamp: Date.now() }
  })
  writeFileSync(testPath, `${header}\n${entry1}\n${entry2}\n`)
  // history order: after a reload the user message must come first
  const orderPath = join(testDir, `${stamp}_smoke-order.jsonl`)
  writeFileSync(
    orderPath,
    [
      header,
      JSON.stringify({
        type: 'message',
        id: 'o1',
        parentId: null,
        timestamp: new Date(1000).toISOString(),
        message: { role: 'user', content: 'вопрос', timestamp: 1000 }
      }),
      JSON.stringify({
        type: 'message',
        id: 'o2',
        parentId: 'o1',
        timestamp: new Date(2000).toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ответ' }],
          api: 'chat',
          provider: 'openrouter',
          model: 'm',
          timestamp: 2000,
          stopReason: 'stop'
        }
      })
    ].join('\n') + '\n'
  )
  try {
    const restored = await openChat('home', homedir(), orderPath)
    check(
      'history renders user before assistant',
      restored.messages.length >= 2 &&
        restored.messages[0].kind === 'user' &&
        restored.messages[1].kind === 'assistant',
      restored.messages.map((m) => m.kind).join(',')
    )
  } catch (error) {
    check('history renders user before assistant', false, String(error))
  } finally {
    await closeChat()
    rmSync(orderPath, { force: true })
  }

  try {
    const forkedPath = await forkChatAt('home', homedir(), testPath, 'e1')
    const forked = existsSync(forkedPath) ? readFileSync(forkedPath, 'utf8') : ''
    check(
      'fork at message keeps the branch point',
      forkedPath !== testPath && forked.includes('"parentId":"e1"'),
      forkedPath
    )
  } catch (error) {
    check('fork at message keeps the branch point', false, String(error))
  } finally {
    rmSync(testPath, { force: true })
    for (const file of readdirSync(testDir).filter((name) => name.includes('smoke-fork'))) {
      rmSync(join(testDir, file), { force: true })
    }
  }

  // usage counters read back
  const today = usageToday()
  const range = usageRange(14)
  check('usage counters respond', typeof today.t === 'number' && range.length === 14, `${today.t} tok`)

  // cleanup smoke fixtures
  rmSync(themeDir, { recursive: true, force: true })
  rmSync(uiDir, { recursive: true, force: true })
  rmSync(coreDir, { recursive: true, force: true })

  const failed = checks.filter((c) => !c.ok)
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  }
  console.log(failed.length === 0 ? `SMOKE OK (${checks.length} checks)` : `SMOKE FAILED (${failed.length}/${checks.length})`)
}