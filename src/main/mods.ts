import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ModInfo, ModSettingField, Settings } from '../shared/types'
import { HIGH_MOD_RISKS } from '../shared/types'
import { webFetchPage, webSearch } from './net'
import { gateToolCall } from './approvals'
import { getModSettingsWithDefaults, registerModSettings, setModSettingsValue } from './mod-settings'
import { emit } from './bus'
import { MODS_DIR } from './paths'
import { loadSettings, log } from './store'

interface ModManifest {
  id?: string
  name?: string
  version?: string
  kind?: string
  api?: string
  description?: string
  author?: string
  permissions?: string[]
}

// Static capability scan. A report, not a sandbox: it shows what the source
// references so the user can decide before enabling a mod.
const RISK_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'fs', re: /require\s*\(\s*['"](?:node:)?fs|from\s+['"](?:node:)?fs|readFileSync|writeFileSync|mkdirSync/ },
  { id: 'process', re: /\bprocess\s*\.|\bglobalThis\b/ },
  { id: 'child_process', re: /child_process|execSync|spawnSync|\bspawn\s*\(/ },
  { id: 'net', re: /\bfetch\s*\(|XMLHttpRequest|https?:\/\// },
  { id: 'eval', re: /\beval\s*\(|new Function/ },
  { id: 'storage', re: /\blocalStorage\b|\bsessionStorage\b/ }
]

/** Risks that require an explicit confirmation before enabling. */
export const HIGH_RISK = HIGH_MOD_RISKS

function scanRisks(kind: ModInfo['kind'], dir: string): string[] {
  const files = kind === 'theme' ? ['theme.css'] : ['index.js']
  const found = new Set<string>()
  for (const file of files) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    let content = ''
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const pattern of RISK_PATTERNS) {
      if (pattern.re.test(content)) found.add(pattern.id)
    }
  }
  return [...found]
}

const loadErrors = new Map<string, string>()
const activated = new Set<string>()

// ------------------------------------------------------- core mod plumbing

interface OwnedTool {
  modId: string
  tool: ToolDefinition<any, any, any>
}

const customTools: OwnedTool[] = []
const pendingAsks = new Map<string, (value: string) => void>()
const coreLists = new Map<string, string>() // listId -> modId
let askSeq = 0

/** Shows a question in the renderer and resolves with the user's answer. */
export function askUser(question: string, options: string[]): Promise<string> {
  const id = `ask-${++askSeq}`
  return new Promise((resolve) => {
    pendingAsks.set(id, resolve)
    emit({ kind: 'ask', id, question, options })
  })
}

export function resolveAsk(id: string, value: string): boolean {
  const resolve = pendingAsks.get(id)
  if (!resolve) return false
  pendingAsks.delete(id)
  resolve(value)
  return true
}

function showList(modId: string, listId: string, title: string, items: { text: string; status: string }[]): void {
  coreLists.set(listId, modId)
  emit({ kind: 'ui-list', modId, listId, title, items })
}

function hideList(modId: string, listId: string): void {
  if (coreLists.get(listId) !== modId) return
  coreLists.delete(listId)
  emit({ kind: 'ui-list', modId, listId, title: '', items: null })
}

/** Drops every list a mod owns, called when the mod is switched off. */
export function hideListsFor(modId: string): void {
  for (const [listId, owner] of [...coreLists.entries()]) {
    if (owner === modId) hideList(modId, listId)
  }
}

export function removeToolsFor(modId: string): void {
  for (let index = customTools.length - 1; index >= 0; index--) {
    if (customTools[index].modId === modId) customTools.splice(index, 1)
  }
}

export function getCustomTools(): ToolDefinition<any, any, any>[] {
  return customTools.map((entry) => entry.tool)
}

/**
 * ask_user / update_task_list / web_search / web_fetch are part of Alpha
 * itself: always on, never listed as mods. Retired mod copies of them are
 * hidden by RETIRED_BUILTIN_MODS below.
 */
const RETIRED_BUILTIN_MODS = ['ask-user', 'task-list', 'web-search']
let builtinToolsRegistered = false

export function registerBuiltinTools(): void {
  if (builtinToolsRegistered) return
  builtinToolsRegistered = true

  customTools.push({
    modId: 'builtin',
    tool: {
      name: 'ask_user',
      label: 'Ask the user',
      description:
        'Ask the user a question and wait for one of the given answer options or a free-text answer. ' +
        'Use it when the task has several valid directions and the user decides which one to take. ' +
        'Returns the text of the answer.',
      promptSnippet: 'ask the user a question with answer options',
      promptGuidelines: [
        'Use ask_user when a decision changes the result of the task and the user is the only source for it.',
        'Do not ask questions you can answer from the repository or the conversation.',
        'Offer 2 to 5 short options. The user can also type a free answer.'
      ],
      parameters: Type.Object({
        question: Type.String({ description: 'The question, one short paragraph.' }),
        options: Type.Array(Type.String(), { description: '2 to 5 short answer options.' })
      }),
      async execute(_toolCallId, raw) {
        const params = raw as { question: string; options?: string[] }
        const answer = await askUser(String(params.question), (params.options ?? []).map(String))
        return { content: [{ type: 'text', text: answer || 'No answer' }], details: null }
      }
    }
  })

  customTools.push({
    modId: 'builtin',
    tool: {
      name: 'update_task_list',
      label: 'Task list',
      description:
        'Show or update the task list panel for the user. Send the complete list on every call. ' +
        'Each item has a short text and a status: todo, doing or done.',
      promptSnippet: 'update the visible task list',
      promptGuidelines: [
        'Call this tool right after you plan a task with more than two steps.',
        'Mark an item done as soon as it is finished, and mark the current one doing.',
        'Send the full list on every call, not a diff.'
      ],
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            text: Type.String({ description: 'Short task label' }),
            status: Type.String({ enum: ['todo', 'doing', 'done'], description: 'Task state' })
          }),
          { description: 'The full task list' }
        )
      }),
      async execute(_toolCallId, raw) {
        const params = raw as { items: { text: string; status: string }[] }
        showList('builtin', 'tasks', 'Задачи', params.items)
        return { content: [{ type: 'text', text: `Task list updated: ${params.items.length}` }], details: null }
      }
    }
  })

  customTools.push({
    modId: 'builtin',
    tool: {
      name: 'web_search',
      label: 'Web search',
      description:
        'Search the web and return top results with titles, URLs and snippets. ' +
        'Uses an isolated local SearXNG instance first, then free public sources. No API key needed.',
      promptSnippet: 'search the web for current information',
      promptGuidelines: [
        'Use web_search when the task needs current data, documentation or a source you cannot read locally.',
        'When you use a result, keep its URL in the answer.'
      ],
      parameters: Type.Object({
        query: Type.String({ description: 'Search query in plain text.' }),
        max_results: Type.Number({ description: 'How many results, 1 to 10. Default 8.' })
      }),
      async execute(_toolCallId, raw) {
        const params = raw as { query?: string; max_results?: number }
        const hits = await webSearch(String(params.query ?? ''), Number(params.max_results) || 8)
        if (!hits.length) return { content: [{ type: 'text', text: 'No results for that query.' }], details: null }
        const text = hits
          .map((hit, index) => `${index + 1}. ${hit.title}\n${hit.url}${hit.snippet ? `\n${hit.snippet}` : ''}`)
          .join('\n\n')
        return { content: [{ type: 'text', text }], details: hits }
      }
    }
  })

  customTools.push({
    modId: 'builtin',
    tool: {
      name: 'web_fetch',
      label: 'Web fetch',
      description: 'Download a web page and return its readable text, truncated to a few thousand characters.',
      promptSnippet: 'read a web page as plain text',
      parameters: Type.Object({
        url: Type.String({ description: 'Absolute http or https URL.' })
      }),
      async execute(_toolCallId, raw) {
        const params = raw as { url?: string }
        const text = await webFetchPage(String(params.url))
        return { content: [{ type: 'text', text }], details: null }
      }
    }
  })

  log('info', 'built-in tools registered: ask_user, update_task_list, web_search, web_fetch')
}

function readManifest(dir: string): { info: ModInfo; error?: string } | null {
  const manifestPath = join(dir, 'mod.json')
  if (!existsSync(manifestPath)) return null
  let manifest: ModManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    const id = dir.split('/').pop() ?? dir
    return {
      info: { id, name: id, version: '0.0.0', kind: 'ui', api: '1.0', description: '', enabled: false, risks: [], declared: [] },
      error: `mod.json: ${String(error)}`
    }
  }
  const id = manifest.id || dir.split('/').pop() || 'unknown'
  const kind = manifest.kind === 'theme' || manifest.kind === 'core' ? manifest.kind : 'ui'
  return {
    info: {
      id,
      name: manifest.name ?? id,
      version: manifest.version ?? '0.0.0',
      kind,
      api: manifest.api ?? '1.0',
      description: manifest.description ?? '',
      author: manifest.author,
      enabled: true,
      risks: [],
      declared: Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : []
    }
  }
}

export function listMods(): ModInfo[] {
  if (!existsSync(MODS_DIR)) return []
  const settings = loadSettings()
  const mods: ModInfo[] = []
  for (const entry of readdirSync(MODS_DIR)) {
    const dir = join(MODS_DIR, entry)
    const parsed = readManifest(dir)
    if (!parsed) continue
    // Retired copies: these features are built into Alpha now (see registerBuiltinTools).
    if (RETIRED_BUILTIN_MODS.includes(parsed.info.id)) continue
    const error = loadErrors.get(parsed.info.id) ?? parsed.error
    mods.push({
      ...parsed.info,
      enabled: !settings.disabledMods.includes(parsed.info.id),
      error,
      risks: scanRisks(parsed.info.kind, dir)
    })
  }
  return mods.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
}

function enabledMods(kind: ModInfo['kind']): ModInfo[] {
  const settings = loadSettings()
  return listMods().filter((m) => m.kind === kind && m.enabled && !m.error)
}

export function themeCss(activeThemeMod: string): string {
  if (!activeThemeMod) return ''
  const file = join(MODS_DIR, activeThemeMod, 'theme.css')
  if (!existsSync(file)) {
    loadErrors.set(activeThemeMod, 'theme.css not found')
    return ''
  }
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    loadErrors.set(activeThemeMod, String(error))
    return ''
  }
}

export function uiModSources(): { id: string; code: string }[] {
  const out: { id: string; code: string }[] = []
  for (const mod of enabledMods('ui')) {
    const file = join(MODS_DIR, mod.id, 'index.js')
    if (!existsSync(file)) {
      loadErrors.set(mod.id, 'index.js not found')
      continue
    }
    try {
      out.push({ id: mod.id, code: readFileSync(file, 'utf8') })
    } catch (error) {
      loadErrors.set(mod.id, String(error))
    }
  }
  return out
}

// ---------------------------------------------------------------- core hooks

type BeforeSendHook = (ctx: { prompt: string; projectId: string; cwd: string }) => void
type EventHook = (event: unknown) => void
type DoneHook = () => void
export type ToolCallHookResult = { block?: boolean; reason?: string }
type ToolCallHook = (
  ctx: { tool: string; input: unknown; cwd: string; chatId?: string }
) => ToolCallHookResult | void | Promise<ToolCallHookResult | void>

const beforeSendHooks: BeforeSendHook[] = []
const eventHooks: EventHook[] = []
const doneHooks: DoneHook[] = []
const toolCallHooks: ToolCallHook[] = []

/** New hook (API 1.1): lets a core mod inspect or block a tool call before
 *  the approval gate. The first hook that returns { block: true } wins. */
export async function runToolCallHook(
  ctx: { tool: string; input: unknown; cwd: string; chatId?: string }
): Promise<ToolCallHookResult | undefined> {
  for (const hook of toolCallHooks) {
    try {
      const result = await hook(ctx)
      if (result?.block) return result
    } catch (error) {
      log('warn', `core mod tool-call hook failed: ${String(error)}`)
    }
  }
  return undefined
}

export function runBeforeSend(ctx: { prompt: string; projectId: string; cwd: string }): string {
  for (const hook of beforeSendHooks) {
    try {
      hook(ctx)
    } catch (error) {
      log('warn', `core mod beforeSend failed: ${String(error)}`)
    }
  }
  return ctx.prompt
}

export function runSessionEvent(event: unknown): void {
  for (const hook of eventHooks) {
    try {
      hook(event)
    } catch (error) {
      log('warn', `core mod session event failed: ${String(error)}`)
    }
  }
  const type = (event as { type?: string })?.type
  if (type === 'agent_end' || type === 'agent_settled') {
    for (const hook of doneHooks) {
      try {
        hook()
      } catch (error) {
        log('warn', `core mod after-done failed: ${String(error)}`)
      }
    }
  }
}

function coreApi(id: string) {
  return {
    settings: { get: (): Settings => loadSettings() },
    log: (...args: unknown[]) => log('info', `[mod:${id}] ${args.map(String).join(' ')}`),
    pi: {
      /** TypeBox builder, the same one pi uses for tool schemas. */
      Type,
      /** Registers a tool the model can call. Visible in new sessions. */
      registerTool: (tool: ToolDefinition<any, any, any>): void => {
        customTools.push({ modId: id, tool })
      }
    },
    ui: {
      toast: (message: unknown) => emit({ kind: 'toast', level: 'info', message: String(message) }),
      /** Question dialog with answer options. Resolves with the chosen text. */
      ask: (input: { question: string; options?: string[] }): Promise<string> =>
        askUser(String(input.question), (input.options ?? []).map(String)),
      /** Pushes a titled list panel into the inspector. */
      showList: (listId: string, input: { title: string; items: { text: string; status: string }[] }): void =>
        showList(id, String(listId), String(input.title ?? ''), input.items ?? []),
      hideList: (listId: string): void => hideList(id, String(listId)),
      /** Settings fields rendered in Настройки → Моды. */
      registerSettings: (def: { fields: ModSettingField[] }): void => {
        registerModSettings(id, Array.isArray(def?.fields) ? def.fields : [])
      }
    },
    // Free keyless internet: isolated local SearXNG first, public APIs as fallback.
    net: {
      search: (query: string, max?: number): Promise<{ title: string; url: string; snippet: string; via: string }[]> =>
        webSearch(String(query ?? ''), Number(max) || 8),
      fetch: (url: string): Promise<string> => webFetchPage(String(url ?? ''))
    },
    // Filesystem with the same gate as the model's write tool.
    fs: {
      read: (path: string): Promise<string> => Promise.resolve(fsRead(String(path))),
      write: (path: string, content: string, cwd?: string): Promise<void> =>
        fsWrite(String(path), String(content ?? ''), cwd),
      list: (dir: string): Promise<string[]> => Promise.resolve(fsList(String(dir)))
    },
    // Shell access with the approval gate for dangerous commands.
    exec: (command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> =>
      runShell(String(command), options),
    // Per-mod settings stored in ~/.alpha/mods-settings.json.
    modSettings: {
      get: (): Record<string, unknown> => getModSettingsWithDefaults(id),
      set: (key: string, value: unknown): void => {
        setModSettingsValue(id, String(key), value)
      }
    },
    on(event: string, handler: (...args: any[]) => void) {
      if (event === 'session:before-send') beforeSendHooks.push(handler as BeforeSendHook)
      else if (event === 'session:event') eventHooks.push(handler as EventHook)
      else if (event === 'session:after-done') doneHooks.push(handler as DoneHook)
      else if (event === 'session:tool-call') toolCallHooks.push(handler as ToolCallHook)
      else log('warn', `[mod:${id}] unknown event "${event}"`)
    }
  }
}

/** Imports every enabled core mod and calls its default export once. */
export async function activateCoreMods(): Promise<{ id: string; error: string }[]> {
  registerBuiltinTools()
  const errors: { id: string; error: string }[] = []
  for (const mod of enabledMods('core')) {
    if (activated.has(mod.id)) continue
    const file = join(MODS_DIR, mod.id, 'index.js')
    if (!existsSync(file)) {
      loadErrors.set(mod.id, 'index.js not found')
      errors.push({ id: mod.id, error: 'index.js not found' })
      continue
    }
    try {
      const loaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
        default?: (api: unknown) => void
      }
      const activate = loaded.default
      if (typeof activate !== 'function') throw new Error('mod has no default export function')
      activate(coreApi(mod.id))
      activated.add(mod.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      loadErrors.set(mod.id, message)
      errors.push({ id: mod.id, error: message })
      log('error', `core mod ${mod.id}: ${message}`)
    }
  }
  return errors
}

/** Reads a UTF-8 file. Exposed to core mods as alpha.fs.read. */
export function fsRead(path: string): string {
  return readFileSync(String(path), 'utf8')
}

/** Writes a UTF-8 file. Gated like the write tool: outside the root asks first. */
export async function fsWrite(path: string, content: string, cwd?: string): Promise<void> {
  const target = String(path)
  const decision = await gateToolCall('write', { path: target }, String(cwd ?? homedir()))
  if (decision?.block) throw new Error(decision.reason ?? 'Действие отклонено')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, String(content ?? ''))
}

/** Lists names inside a directory. Exposed as alpha.fs.list. */
export function fsList(dir: string): string[] {
  return readdirSync(String(dir))
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs a shell command for a core mod. Passes through the approval gate:
 * dangerous commands wait for the user exactly like model bash calls.
 */
export async function runShell(
  command: string,
  options?: { cwd?: string; timeoutMs?: number }
): Promise<ExecResult> {
  const cwd = String(options?.cwd ?? homedir())
  const decision = await gateToolCall('bash', { command: String(command) }, cwd)
  if (decision?.block) throw new Error(decision.reason ?? 'Действие отклонено')
  const result = spawnSync(String(command), {
    shell: true,
    cwd,
    encoding: 'utf8',
    timeout: Math.min(Math.max(Number(options?.timeoutMs) || 30_000, 1_000), 120_000),
    maxBuffer: 8 * 1024 * 1024
  })
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? '').slice(0, 20_000),
    stderr: String(result.stderr ?? '').slice(0, 4_000)
  }
}

// ---------------------------------------------------------------- install

export interface InstallResult {
  ok: boolean
  message: string
}

/** Installs a mod from a folder or a .zip file into ~/.alpha/mods. */
export function installMod(source: string): InstallResult {
  try {
    mkdirSync(MODS_DIR, { recursive: true })
    if (source.endsWith('.zip')) {
      // ponytail: uses the system unzip binary, no zip library in the bundle
      const result = spawnSync('unzip', ['-o', '-q', source, '-d', MODS_DIR])
      if (result.status !== 0) {
        const err = (result.stderr ?? Buffer.alloc(0)).toString().trim()
        return { ok: false, message: err || `unzip exited with ${result.status}. Install unzip or use a folder.` }
      }
    } else {
      const name = source.split('/').filter(Boolean).pop() ?? 'mod'
      cpSync(source, join(MODS_DIR, name), { recursive: true })
    }
    const installed = listMods()
    if (installed.length === 0) return { ok: false, message: 'mod.json not found in the archive' }
    return { ok: true, message: `installed: ${installed.map((m) => m.name).join(', ')}` }
  } catch (error) {
    return { ok: false, message: String(error) }
  }
}