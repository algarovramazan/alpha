import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  AgentSession,
  AgentSessionServices,
  SessionEntry,
  SessionInfo,
  SessionManager as PiSessionManager
} from '@earendil-works/pi-coding-agent'
import type {
  AlphaEvent,
  ChatMeta,
  ModelInfo,
  SessionEvent,
  Settings,
  ThinkingLevel,
  UIMessage,
  UsageUI
} from '../shared/types'
import { emit } from './bus'
import { AGENT_DIR, AUTH_FILE, RUNTIME_DIR, chatsDirFor } from './paths'
import { loadProjects, loadSettings, log } from './store'
import { recordUsage } from './usage'
import { runBeforeSend, runSessionEvent, getCustomTools, runToolCallHook } from './mods'
import { gateToolCall, resetApprovals } from './approvals'
import {
  chatIdForManager,
  chatMode,
  desiredThinking,
  initialMode,
  modeDecision,
  modePrefix,
  registerSession,
  resolveDefaultMode,
  unregisterSession
} from './modes'
import { buildContextBlock, contextFingerprint, getMemory, setMemory } from './context'

type Pi = typeof import('@earendil-works/pi-coding-agent')

const runtimeEntry = join(RUNTIME_DIR, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')

let piCache: Pi | null = null

/** Loads pi from ~/.alpha/runtime when an updated copy exists, else the bundled one. */
async function loadPi(): Promise<Pi> {
  if (piCache) return piCache
  if (existsSync(runtimeEntry)) {
    try {
      piCache = (await import(/* @vite-ignore */ pathToFileURL(runtimeEntry).href)) as Pi
      return piCache
    } catch (error) {
      log('warn', `runtime pi load failed, using bundled: ${String(error)}`)
    }
  }
  piCache = await import('@earendil-works/pi-coding-agent')
  return piCache
}

export async function piVersion(): Promise<string> {
  try {
    const pi = await loadPi()
    const origin = existsSync(runtimeEntry) ? 'runtime' : 'bundled'
    return `${pi.VERSION} (${origin})`
  } catch (error) {
    log('warn', `pi version: ${String(error)}`)
  }
  return 'unknown'
}

// ---------------------------------------------------------------- services

const disabledSkills = new Set<string>()
const servicesCache = new Map<string, Promise<AgentSessionServices>>()

export function syncDisabledSkills(settings: Settings): void {
  disabledSkills.clear()
  for (const id of settings.disabledSkills) disabledSkills.add(id)
}

async function getServices(cwd: string): Promise<AgentSessionServices> {
  let pending = servicesCache.get(cwd)
  if (!pending) {
    pending = (async () => {
      const pi = await loadPi()
      return await pi.createAgentSessionServices({
        cwd,
        agentDir: AGENT_DIR,
        resourceLoaderOptions: {
          additionalSkillPaths: loadSettings().extraSkillPaths,
          skillsOverride: ({ skills, diagnostics }) => ({
            skills: skills.filter((s) => !disabledSkills.has(s.name)),
            diagnostics
          }),
          extensionFactories: [
            {
              name: 'alpha-approvals',
              factory: (api) => {
                api.on('tool_call', async (event, ctx) => {
                  const manager = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager
                  const chatId = chatIdForManager(manager)
                  // 1. mode policy (plan / assist read-only) blocks mutations first
                  const modeBlock = modeDecision(event.toolName, event.input, chatId, cwd)
                  if (modeBlock) return modeBlock
                  // 2. core mods may inspect or block the call (API 1.1)
                  const modBlock = await runToolCallHook({
                    tool: event.toolName,
                    input: event.input,
                    cwd,
                    chatId
                  })
                  if (modBlock?.block) return modBlock
                  // 3. the regular approval gate
                  return gateToolCall(event.toolName, event.input, cwd)
                })
              }
            }
          ]
        }
      })
    })()
    servicesCache.set(cwd, pending)
    pending.catch(() => servicesCache.delete(cwd))
  }
  return pending
}

/** Drop cached services so the next session picks up new settings/resources. */
export function invalidateServices(cwd?: string): void {
  if (cwd) servicesCache.delete(cwd)
  else servicesCache.clear()
  modelsCache = null
}

// Model list cache: a 60s cache keeps settings and the topbar selector snappy
// (optimization item 3).
let modelsCache: { cwd: string; at: number; models: ModelInfo[] } | null = null

export async function reloadResources(cwd: string): Promise<void> {
  const services = await getServices(cwd)
  await services.resourceLoader.reload()
}

export async function applyPiSettings(settings: Settings): Promise<void> {
  syncDisabledSkills(settings)
  for (const cwd of [...servicesCache.keys()]) {
    try {
      const services = await getServices(cwd)
      const sm = services.settingsManager
      if (settings.defaultProvider && settings.defaultModel) {
        sm.setDefaultModelAndProvider(settings.defaultProvider, settings.defaultModel)
      }
      sm.setDefaultThinkingLevel(settings.thinkingLevel as never)
      await sm.flush()
    } catch (error) {
      log('warn', `applyPiSettings(${cwd}): ${String(error)}`)
    }
  }
}

/**
 * Applies model and thinking level changes to the chat that is open right now.
 * A session captures both values when it is created, so without this call the
 * topbar selectors would only affect the next chat — the bug users noticed:
 * "started a chat with one model, switched to another, nothing changed".
 */
export async function applyToActiveSession(settings: Settings): Promise<void> {
  const chat = active
  if (!chat) return
  try {
    const services = await getServices(chat.cwd)
    if (settings.defaultProvider && settings.defaultModel) {
      const found = services.modelRuntime.getModel(settings.defaultProvider, settings.defaultModel)
      if (found && services.modelRuntime.hasConfiguredAuth(found.provider)) {
        const current = chat.session.model
        if (current?.id !== found.id || current.provider !== found.provider) {
          await chat.session.setModel(found, { persist: false })
          log('info', `active session model -> ${found.provider}/${found.id}`)
        }
      } else {
        log('warn', `active session model unchanged: no key for ${settings.defaultProvider}`)
      }
    }
    const desired = desiredThinking(
      chat.chatId,
      (loadProjectOverrides(chat.cwd).thinkingLevel ?? settings.thinkingLevel) as ThinkingLevel
    )
    if (chat.session.thinkingLevel !== desired) {
      chat.session.setThinkingLevel(desired, { persist: false })
      log('info', `active session thinking -> ${desired}`)
    }
  } catch (error) {
    log('warn', `applyToActiveSession: ${String(error)}`)
  }
}

// ---------------------------------------------------------------- sessions

interface ActiveChat {
  chatId: string
  chatPath: string
  projectId: string
  cwd: string
  session: AgentSession
  manager: PiSessionManager
  status: 'idle' | 'working' | 'waiting' | 'error'
  lastFocus: number
  running: number
  /** Fingerprint of the injected memory/knowledge block. */
  ctxHash: string
  /** Last tool/run error: quoted back to the model in debug mode. */
  lastError?: string
  /** Started at the current prompt: the run duration reported with done. */
  runStart?: number
  /** Usage of this run already recorded via message_end (avoids double count). */
  countedUsage?: boolean
  /** Titles of the context parts injected on the last prompt (inspector). */
  injected: string[]
}

/** Every open session, focused or background (feature: background tasks). */
const sessions = new Map<string, ActiveChat>()
/** The chat that owns the composer; others keep running in the background. */
let active: ActiveChat | null = null

function send(payload: AlphaEvent): void {
  emit(payload)
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function translate(ev: unknown): SessionEvent | null {
  const e = ev as Record<string, any>
  switch (e?.type) {
    case 'message_update': {
      const a = e.assistantMessageEvent
      if (a?.type === 'text_delta') return { type: 'text', delta: a.delta }
      if (a?.type === 'thinking_delta') return { type: 'thinking', delta: a.delta }
      return null
    }
    case 'tool_execution_start':
      return { type: 'tool.start', callId: e.toolCallId, name: e.toolName, args: safeJson(e.args) }
    case 'tool_execution_update':
      return { type: 'tool.update', callId: e.toolCallId, partial: safeJson(e.partialResult) }
    case 'tool_execution_end':
      return {
        type: 'tool.end',
        callId: e.toolCallId,
        ok: !e.isError,
        result: safeJson(e.result),
        error: e.isError ? safeJson(e.result) : undefined,
        durationMs: e.durationMs
      }
    case 'agent_start':
    case 'turn_start':
      return { type: 'status', phase: 'working' }
    case 'auto_retry_start':
      return { type: 'status', phase: 'waiting', message: e.errorMessage }
    case 'agent_end': {
      const messages: any[] = Array.isArray(e.messages) ? e.messages : []
      const last = [...messages].reverse().find((m) => m?.role === 'assistant')
      const usage: UsageUI | undefined = last?.usage
        ? { tokens: (last.usage.input ?? 0) + (last.usage.output ?? 0), cost: last.usage.cost?.total }
        : undefined
      return { type: 'done', usage }
    }
    case 'agent_settled':
      return { type: 'status', phase: 'idle' }
    case 'message_end': {
      if (e.message?.role !== 'assistant') return null
      // every assistant message carries its own usage: count each turn, not
      // only the last one of the run (the old accounting underreported)
      const u = e.message?.usage
      const usage: UsageUI | undefined = u
        ? { tokens: (u.input ?? 0) + (u.output ?? 0), cost: u.cost?.total }
        : undefined
      return { type: 'split', usage }
    }
    default:
      return null
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('')
  }
  return ''
}

function historyToUI(session: AgentSession, manager: PiSessionManager): UIMessage[] {
  interface SourceMessage {
    entryId?: string
    message: Record<string, any>
    sortTs: number
  }
  const source: SourceMessage[] = []
  // The session tree carries entry ids, which fork-from-message needs.
  for (const entry of [...manager.getBranch()].reverse()) {
    if (entry.type === 'message') {
      source.push({
        entryId: entry.id,
        message: entry.message as unknown as Record<string, any>,
        sortTs: Date.parse(entry.timestamp) || 0
      })
    }
  }
  if (source.length === 0) {
    const anySession = session as unknown as {
      messages?: unknown[]
      state?: { messages?: unknown[] }
    }
    const messages = anySession.messages ?? anySession.state?.messages ?? manager.buildSessionContext().messages
    for (const message of messages) {
      const record = message as Record<string, any>
      source.push({ message: record, sortTs: Number(record.timestamp ?? 0) })
    }
  }
  // Chronological order regardless of how the branch walk returned entries:
  // the AI answer must never render before the user's question.
  source.sort((a, b) => a.sortTs - b.sortTs)
  const out: UIMessage[] = []
  for (const item of source) {
    const m = item.message
    if (!m || typeof m !== 'object') continue
    if (m.role === 'user') {
      out.push({
        kind: 'user',
        id: `u-${out.length}`,
        text: textOfContent(m.content),
        time: m.timestamp ? new Date(m.timestamp).toISOString() : '',
        entryId: item.entryId
      })
    } else if (m.role === 'assistant') {
      let text = ''
      let thinking = ''
      const toolCalls: Extract<UIMessage, { kind: 'assistant' }>['toolCalls'] = []
      for (const block of m.content ?? []) {
        if (block?.type === 'text') text += block.text
        else if (block?.type === 'thinking') thinking += block.thinking
        else if (block?.type === 'toolCall') {
          toolCalls.push({
            callId: block.id,
            name: block.name,
            args: safeJson(block.arguments),
            running: true
          })
        }
      }
      out.push({
        kind: 'assistant',
        id: `a-${out.length}`,
        text,
        thinking,
        toolCalls,
        time: m.timestamp ? new Date(m.timestamp).toISOString() : '',
        model: m.model,
        entryId: item.entryId,
        usage: m.usage ? { tokens: (m.usage.input ?? 0) + (m.usage.output ?? 0), cost: m.usage.cost?.total } : undefined
      })
    } else if (m.role === 'toolResult') {
      const target = [...out].reverse().find((msg) => msg.kind === 'assistant') as Extract<
        UIMessage,
        { kind: 'assistant' }
      >
      if (!target) continue
      const call = target.toolCalls.find((c) => c.callId === m.toolCallId)
      if (call) {
        call.result = textOfContent(m.content) || safeJson(m.details)
        call.isError = Boolean(m.isError)
        call.durationMs = m.durationMs
        call.running = false
      }
    }
  }
  return out
}

export interface OpenChatResult {
  chatId: string
  chatPath: string
  messages: UIMessage[]
  model?: string
  thinkingLevel?: string
  cwd?: string
  context?: { tokens: number; percent: number; contextWindow: number }
}

/** Live state of an open session, used for both fresh and reused chats. */
function stateOf(chat: ActiveChat): OpenChatResult {
  const messages = historyToUI(chat.session, chat.manager)
  const sessionModel = (chat.session as unknown as { model?: { provider?: string; id?: string } }).model
  const openUsage = (
    chat.session as unknown as {
      getContextUsage?: () => { tokens: number | null; percent: number | null; contextWindow: number } | undefined
    }
  ).getContextUsage?.()
  return {
    chatId: chat.chatId,
    chatPath: chat.chatPath,
    messages,
    cwd: chat.cwd,
    model: sessionModel?.id,
    thinkingLevel: (chat.session as unknown as { thinkingLevel?: string }).thinkingLevel,
    context: openUsage
      ? { tokens: openUsage.tokens ?? 0, percent: openUsage.percent ?? 0, contextWindow: openUsage.contextWindow }
      : undefined
  }
}

function focusChat(chat: ActiveChat): void {
  if (active && active !== chat) active.lastFocus = active.lastFocus || Date.now()
  active = chat
  chat.lastFocus = Date.now()
}

export function disposeChat(chat: ActiveChat): void {
  try {
    chat.session.dispose()
  } catch (error) {
    log('warn', `dispose failed: ${String(error)}`)
  }
  sessions.delete(chat.chatId)
  unregisterSession(chat.chatId)
  if (active === chat) active = null
}

/** Keeps open sessions within the maxSessions budget: idle background chats
 *  go first, busy chats are never evicted. */
function enforceSessionLimit(): void {
  const max = Math.max(1, loadSettings().maxSessions)
  while (sessions.size > max) {
    const victim = [...sessions.values()]
      .filter((chat) => chat !== active && chat.status === 'idle' && chat.running === 0)
      .sort((a, b) => a.lastFocus - b.lastFocus)[0]
    if (!victim) {
      log('warn', `session limit ${max} exceeded, all sessions busy`)
      return
    }
    log('info', `evicting idle background session ${victim.chatId}`)
    disposeChat(victim)
  }
}

/** Called when the maxSessions budget changes. */
export function reconcileSessions(): void {
  enforceSessionLimit()
}

/** Context numbers for the inspector: tokens, window and system prompt size. */
export function contextSnapshot(
  chatId?: string
): { total: number; window: number; system: number; injected: string[]; pending: boolean } | null {
  const chat = (chatId ? sessions.get(chatId) : undefined) ?? active
  if (!chat) return null
  const usage = (
    chat.session as unknown as {
      getContextUsage?: () => { tokens: number | null; percent: number | null; contextWindow: number } | undefined
    }
  ).getContextUsage?.()
  const systemPrompt = (chat.session as unknown as { systemPrompt?: string }).systemPrompt ?? ''
  return {
    total: usage?.tokens ?? 0,
    window: usage?.contextWindow ?? 0,
    system: Math.round(systemPrompt.length / 4),
    injected: chat.injected,
    // memory, knowledge or the map changed since the last prompt: they will be injected next time
    pending: contextFingerprint(chat.projectId, chat.cwd) !== chat.ctxHash
  }
}

/** Subagent slots: bounded by the subagentConcurrency setting. */
let subRunning = 0

/** Durable project facts the model maintains through the project_memory tool. */
function memoryTool(projectId: string): ToolDefinition<any, any, any> {
  return {
    name: 'project_memory',
    label: 'Project memory',
    description:
      'Read or update the durable project memory: short facts worth remembering across chats ' +
      '(conventions, decisions, preferences). Stored outside the conversation.',
    promptSnippet: 'remember or forget a durable project fact',
    promptGuidelines: [
      'Call action "list" first to see what is already known.',
      'Add a fact only when it will matter in future chats; one short line per fact.',
      'Remove facts that became wrong. Never store secrets, keys or credentials.'
    ],
    parameters: Type.Object({
      action: Type.String({ enum: ['list', 'add', 'remove'], description: 'What to do' }),
      fact: Type.Optional(Type.String({ description: 'The fact line for add/remove' }))
    }),
    async execute(_toolCallId, raw) {
      const params = raw as { action: string; fact?: string }
      const fact = String(params.fact ?? '')
        .trim()
        .replace(/^[-*]\s*/, '')
      const lines = getMemory(projectId)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (params.action === 'list') {
        return { content: [{ type: 'text', text: lines.join('\n') || '(memory is empty)' }], details: null }
      }
      if (!fact) throw new Error('fact is required')
      if (params.action === 'add') {
        if (!lines.some((line) => line.replace(/^[-*]\s*/, '') === fact)) lines.push(`- ${fact}`)
      } else {
        for (let index = lines.length - 1; index >= 0; index--) {
          if (lines[index].replace(/^[-*]\s*/, '').includes(fact)) lines.splice(index, 1)
        }
      }
      setMemory(projectId, lines.length ? `${lines.join('\n')}\n` : '')
      return { content: [{ type: 'text', text: `memory ${params.action} done, ${lines.length} facts` }], details: null }
    }
  }
}

/** Default feature: an independent child session with its own context window. */
function subagentTool(
  services: AgentSessionServices,
  holder: { session: AgentSession | null }
): ToolDefinition<any, any, any> {
  return {
    name: 'subagent',
    label: 'Subagent',
    description:
      'Run an independent task in a separate background agent with its own context window. ' +
      'The subagent works with the same tools and model, then returns its final answer.',
    promptSnippet: 'delegate an independent task to a subagent',
    promptGuidelines: [
      'Delegate research, exploration or parallel work that would flood your own context.',
      'Give a self-contained task: goal, relevant paths, constraints and the expected output format.',
      'Stay responsible for the result: verify what the subagent returns before using it.',
      'Do not delegate a task that needs to ask the user questions.'
    ],
    parameters: Type.Object({
      task: Type.String({ description: 'Full self-contained instructions for the subagent.' }),
      context: Type.Optional(Type.String({ description: 'Optional extra context: file paths, constraints.' }))
    }),
    async execute(_toolCallId, raw) {
      const params = raw as { task: string; context?: string }
      const settings = loadSettings()
      const limit = Math.max(1, settings.subagentConcurrency)
      while (subRunning >= limit) await new Promise((resolve) => setTimeout(resolve, 150))
      subRunning++
      const started = Date.now()
      let guard: ReturnType<typeof setTimeout> | null = null
      try {
        const pi = await loadPi()
        const sub = await pi.createAgentSessionFromServices({
          services,
          sessionManager: pi.SessionManager.inMemory(),
          model: holder.session?.model,
          thinkingLevel: settings.thinkingLevel as ThinkingLevel
        })
        try {
          const prompt = params.context ? `${params.context}\n\n${params.task}` : params.task
          // A runaway subagent must not pin the parent turn forever.
          const timeout = new Promise<never>((_resolve, reject) => {
            guard = setTimeout(() => reject(new Error('Subagent timed out after 10 minutes')), 600_000)
          })
          await Promise.race([sub.session.prompt(prompt), timeout])
          const text = sub.session.getLastAssistantText() ?? ''
          log('info', `subagent finished in ${Date.now() - started}ms`)
          return { content: [{ type: 'text', text: text.slice(0, 40_000) || 'Subagent returned no text.' }], details: null }
        } finally {
          if (guard) clearTimeout(guard)
          sub.session.dispose()
        }
      } finally {
        subRunning--
      }
    }
  }
}

/** Tools that belong to one chat: project memory always, subagents by default.
 *  The subagent tool holds a late-bound reference to the session being built. */
function chatTools(
  projectId: string,
  services: AgentSessionServices,
  holder: { session: AgentSession | null }
): ToolDefinition<any, any, any>[] {
  const tools: ToolDefinition<any, any, any>[] = [memoryTool(projectId)]
  if (loadSettings().subagents) tools.push(subagentTool(services, holder))
  return tools
}

/** Short, model-facing record of the last failure. */
function trimError(text?: string): string | undefined {
  if (!text) return undefined
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean ? clean.slice(0, 2000) : undefined
}

/** Injects memory + knowledge + codebase map when they changed since last time. */
function injectContext(chat: ActiveChat, prompt: string): string {
  try {
    const { block, parts } = buildContextBlock(chat.projectId, chat.cwd)
    const fingerprint = contextFingerprint(chat.projectId, chat.cwd)
    if (!block) {
      chat.ctxHash = fingerprint
      chat.injected = []
      return prompt
    }
    if (fingerprint === chat.ctxHash) return prompt
    chat.ctxHash = fingerprint
    chat.injected = parts
    return `${block}\n\n${prompt}`
  } catch (error) {
    log('warn', `context injection: ${String(error)}`)
    return prompt
  }
}

function loadProjectOverrides(cwd: string): { provider?: string; model?: string; thinkingLevel?: string } {
  const file = join(cwd, '.alpha', 'settings.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function saveProjectOverrides(
  cwd: string,
  overrides: { provider?: string; model?: string; thinkingLevel?: string }
): void {
  const dir = join(cwd, '.alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(overrides, null, 2))
}

export async function openChat(
  projectId: string,
  cwd: string,
  chatPath?: string
): Promise<OpenChatResult> {
  // A session that is already alive is reused: switching to a background chat
  // must not recreate its session or lose the run in progress.
  if (chatPath) {
    const existing = [...sessions.values()].find((chat) => chat.chatPath === chatPath || chat.chatId === chatPath)
    if (existing) {
      focusChat(existing)
      return stateOf(existing)
    }
  }
  resetApprovals()
  const pi = await loadPi()
  const sessionDir = chatsDirFor(projectId)
  mkdirSync(sessionDir, { recursive: true })
  const manager = chatPath ? pi.SessionManager.open(chatPath, sessionDir) : pi.SessionManager.create(cwd, sessionDir)
  // Existing sessions carry their own cwd (a worktree chat keeps working in its worktree).
  const effectiveCwd = manager.getCwd() || cwd
  const chatId = manager.getSessionId()
  const already = sessions.get(chatId)
  if (already) {
    focusChat(already)
    return stateOf(already)
  }
  const services = await getServices(effectiveCwd)
  const settings = loadSettings()
  const overrides = loadProjectOverrides(cwd)
  let model: Parameters<typeof pi.createAgentSessionFromServices>[0]['model']
  const provider = overrides.provider ?? settings.defaultProvider
  const modelId = overrides.model ?? settings.defaultModel
  if (provider && modelId) {
    const found = services.modelRuntime.getModel(provider, modelId)
    if (found && services.modelRuntime.hasConfiguredAuth(found.provider)) model = found
  }
  const holder: { session: AgentSession | null } = { session: null }
  const mode = initialMode(projectId, chatId)
  const { session } = await pi.createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model,
    customTools: [...getCustomTools(), ...chatTools(projectId, services, holder)],
    thinkingLevel: (mode === 'quick'
      ? settings.quickThinking
      : (overrides.thinkingLevel ?? settings.thinkingLevel)) as ThinkingLevel
  })
  holder.session = session

  const chat: ActiveChat = {
    chatId,
    chatPath: manager.getSessionFile() ?? chatPath ?? chatId,
    projectId,
    cwd: effectiveCwd,
    session,
    manager,
    status: 'idle',
    lastFocus: Date.now(),
    running: 0,
    ctxHash: '',
    injected: []
  }
  sessions.set(chatId, chat)
  registerSession(chatId, manager, effectiveCwd, mode)

  // The subscription captures its own chat: background sessions keep streaming
  // events tagged with their chatId while another chat is focused.
  session.subscribe((event) => {
    runSessionEvent(event)
    const translated = translate(event)
    if (!translated) return
    if (translated.type === 'status') chat.status = translated.phase
    else if (translated.type === 'done') chat.status = 'idle'
    if (translated.type === 'tool.end' && !translated.ok) {
      chat.lastError = trimError(translated.error ?? translated.result)
    } else if (translated.type === 'status' && translated.phase === 'error' && translated.message) {
      chat.lastError = trimError(translated.message)
    }
    if (translated.type === 'split' && translated.usage) {
      recordUsage(translated.usage.tokens, translated.usage.cost ?? 0, (session as unknown as { model?: { id?: string } }).model?.id)
      chat.countedUsage = true
    }
    if (translated.type === 'done') {
      if (chat.runStart) {
        translated.durationMs = Date.now() - chat.runStart
        chat.runStart = undefined
      }
      // providers without message_end: fall back to the last-message usage
      if (translated.usage && !chat.countedUsage) {
        const doneModel = (session as unknown as { model?: { id?: string } }).model?.id
        recordUsage(translated.usage.tokens, translated.usage.cost ?? 0, doneModel)
      }
      chat.countedUsage = false
      // Context window fill for the composer meter (pi knows both numbers).
      const usage = (session as unknown as { getContextUsage?: () => { tokens: number | null; percent: number | null; contextWindow: number } | undefined }).getContextUsage?.()
      if (usage) {
        translated.context = {
          tokens: usage.tokens ?? 0,
          percent: usage.percent ?? 0,
          contextWindow: usage.contextWindow
        }
      }
    }
    send({ kind: 'session', chatPath: chat.chatId, event: translated })
  })

  enforceSessionLimit()
  focusChat(chat)
  return stateOf(chat)
}

/** Disposes every live session (shutdown and the smoke check). */
export async function closeChat(): Promise<void> {
  for (const chat of [...sessions.values()]) disposeChat(chat)
  active = null
}

export async function sendPrompt(text: string, queued = false, chatId?: string): Promise<void> {
  const target = (chatId ? sessions.get(chatId) : undefined) ?? active
  if (!target) throw new Error('no active chat')
  const id = target.chatId
  target.status = 'working'
  target.runStart = Date.now()
  target.countedUsage = false
  send({ kind: 'session', chatPath: id, event: { type: 'status', phase: 'working' } })
  let prompt = text
  try {
    prompt = runBeforeSend({ prompt, projectId: target.projectId, cwd: target.cwd })
    const settings = loadSettings()
    const mode = chatMode(target.chatId) ?? resolveDefaultMode(settings)
    const prefix = modePrefix(mode, settings)
    if (prefix) prompt = `${prefix}\n${prompt}`
    if (mode === 'debug' && target.lastError) {
      prompt = `Last error from the previous run:\n${target.lastError}\n\n${prompt}`
      target.lastError = undefined
    }
    prompt = injectContext(target, prompt)
    // The coming turn runs at the level the mode (and overrides) dictate.
    const desired = desiredThinking(
      target.chatId,
      (loadProjectOverrides(target.cwd).thinkingLevel ?? settings.thinkingLevel) as ThinkingLevel
    )
    if (target.session.thinkingLevel !== desired) {
      target.session.setThinkingLevel(desired, { persist: false })
    }
    autoName(target, text)
    const options = target.running > 0 || queued ? { streamingBehavior: 'followUp' as const } : undefined
    target.running++
    try {
      await target.session.prompt(prompt, options)
    } finally {
      target.running--
    }
    if (target.running === 0) notifyFinished(target)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', `prompt failed: ${message}`)
    target.status = 'error'
    send({ kind: 'session', chatPath: id, event: { type: 'status', phase: 'error', message } })
  }
}

/** Names the chat after its first user message, once. */
function autoName(chat: ActiveChat, text: string): void {
  try {
    if (chat.manager.getSessionName()) return
    const name = text.replace(/\s+/g, ' ').trim().slice(0, 48)
    if (name) chat.manager.appendSessionInfo(name)
  } catch (error) {
    log('warn', `auto name: ${String(error)}`)
  }
}

function notifyFinished(chat: ActiveChat): void {
  let summary = 'Готово'
  try {
    const anySession = chat.session as unknown as { messages?: unknown[]; state?: { messages?: unknown[] } }
    const messages = anySession.messages ?? anySession.state?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as Record<string, any>
      if (message?.role === 'assistant') {
        const text = textOfContent(message.content).replace(/\s+/g, ' ').trim()
        if (text) summary = text.slice(0, 120)
        break
      }
    }
  } catch {
    // keep the default summary
  }
  send({
    kind: 'finished',
    summary,
    chatId: chat.chatId,
    chatName: chat.manager.getSessionName() || undefined
  })
}

export async function abortPrompt(chatId?: string): Promise<void> {
  const target = (chatId ? sessions.get(chatId) : undefined) ?? active
  if (!target) return
  try {
    await target.session.abort()
  } catch (error) {
    log('warn', `abort failed: ${String(error)}`)
  }
}

/** All sessions of a project, including chats that run in a git worktree.
 *  pi's own list() matches cwd strictly, which would hide worktree chats. */
async function listProjectSessions(projectId: string, cwd: string): Promise<SessionInfo[]> {
  const pi = await loadPi()
  const sessionDir = chatsDirFor(projectId)
  if (!existsSync(sessionDir)) return []
  const all = await pi.SessionManager.listAll(sessionDir)
  const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
  return all.filter((session) => session.cwd && (session.cwd === cwd || session.cwd.startsWith(prefix)))
}

export async function listChats(projectId: string, cwd: string): Promise<ChatMeta[]> {
  const list = await listProjectSessions(projectId, cwd)
  return list
    .map((info) => ({
      id: info.id,
      path: info.path,
      name: info.name,
      cwd: info.cwd,
      mtime: (info as { timestamp?: string | number }).timestamp
        ? new Date((info as { timestamp?: string | number }).timestamp as string | number).getTime()
        : 0
    }))
    .sort((a, b) => b.mtime - a.mtime)
}

/** Accepts a session file path or a session id and returns the file path. */
async function resolveSessionPath(projectId: string, cwd: string, idOrPath: string): Promise<string | null> {
  if (existsSync(idOrPath)) return idOrPath
  const list = await listProjectSessions(projectId, cwd)
  return list.find((info) => info.id === idOrPath)?.path ?? null
}

export async function forkChat(projectId: string, cwd: string, chatRef: string): Promise<string> {
  const pi = await loadPi()
  const sessionDir = chatsDirFor(projectId)
  const sourcePath = await resolveSessionPath(projectId, cwd, chatRef)
  if (!sourcePath) throw new Error(`chat not found: ${chatRef}`)
  const manager = pi.SessionManager.forkFrom(sourcePath, cwd, sessionDir)
  return manager.getSessionFile() ?? sourcePath
}

/** Copies the chat and moves the copy's leaf to `entryId`, so the fork starts at that message. */
export async function forkChatAt(
  projectId: string,
  cwd: string,
  chatRef: string,
  entryId: string
): Promise<string> {
  const pi = await loadPi()
  const sessionDir = chatsDirFor(projectId)
  const sourcePath = await resolveSessionPath(projectId, cwd, chatRef)
  if (!sourcePath) throw new Error(`chat not found: ${chatRef}`)
  const manager = pi.SessionManager.forkFrom(sourcePath, cwd, sessionDir)
  manager.branch(entryId)
  // A child entry makes the branch point durable in the new file.
  manager.appendThinkingLevelChange(loadSettings().thinkingLevel)
  return manager.getSessionFile() ?? sourcePath
}

/** Sets a user-facing name for a chat (persisted as a session_info entry). */
export async function renameChat(projectId: string, chatId: string, name: string): Promise<void> {
  const pi = await loadPi()
  const path = await resolveSessionPath(projectId, cwdFor(projectId), chatId)
  if (!path) throw new Error(`chat not found: ${chatId}`)
  const manager = pi.SessionManager.open(path)
  manager.appendSessionInfo(name.slice(0, 60))
}

export function isGitRepo(path: string): boolean {
  const result = spawnSync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.trim() === 'true'
}

export async function deleteChat(projectId: string, chatId: string): Promise<void> {
  const live = sessions.get(chatId)
  if (live) disposeChat(live)
  const list = await listProjectSessions(projectId, cwdFor(projectId))
  const hit = list.find((info) => info.id === chatId)
  if (!hit) return
  const { rmSync } = await import('node:fs')
  rmSync(hit.path, { force: true })
}

function cwdFor(projectId: string): string {
  const project = loadProjects().find((p) => p.id === projectId)
  return project?.path ?? homedir()
}

/** Search session files for a query string. projectId '*' sweeps every project. */
export async function searchChats(
  projectId: string,
  query: string
): Promise<{ path: string; chatId: string; preview: string; projectId?: string; projectName?: string }[]> {
  const scopes: { projectId: string; cwd: string; projectName: string }[] =
    projectId === 'all'
      ? [
          { projectId: 'home', cwd: homedir(), projectName: '' },
          ...loadProjects().map((p) => ({ projectId: p.id, cwd: p.path, projectName: p.name }))
        ]
      : [{ projectId, cwd: cwdFor(projectId), projectName: '' }]
  const needle = query.toLowerCase()
  const hits: { path: string; chatId: string; preview: string; projectId?: string; projectName?: string }[] = []
  for (const scope of scopes) {
    const list = await listProjectSessions(scope.projectId, scope.cwd)
    for (const info of list) {
      try {
        const content = readFileSync(info.path, 'utf8')
        const line = content.split('\n').find((l) => l.toLowerCase().includes(needle))
        if (line) {
          const parsed = JSON.parse(line) as { message?: { content?: unknown } }
          hits.push({
            path: info.path,
            chatId: info.id,
            preview: previewOf(parsed.message?.content),
            projectId: scope.projectId,
            projectName: scope.projectName || undefined
          })
        }
      } catch {
        // unreadable session file, skip
      }
    }
  }
  return hits.slice(0, 60)
}

function previewOf(content: unknown): string {
  const text = textOfContent(content)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// ---------------------------------------------------------------- models

export async function listModels(cwd: string): Promise<ModelInfo[]> {
  if (modelsCache && modelsCache.cwd === cwd && Date.now() - modelsCache.at < 60_000) {
    return modelsCache.models
  }
  const services = await getServices(cwd)
  const models = services.modelRuntime.getModels()
  const result = models.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: (model as { name?: string }).name ?? model.id,
    hasKey: services.modelRuntime.hasConfiguredAuth(model.provider),
    contextWindow: (model as { contextWindow?: number }).contextWindow
  }))
  modelsCache = { cwd, at: Date.now(), models: result }
  return result
}

/** Starts service creation in the background so the first chat opens fast. */
export function prewarmServices(): void {
  const cwds = [homedir(), ...loadProjects().slice(0, 2).map((project) => project.path)]
  for (const cwd of cwds) {
    getServices(cwd).catch(() => undefined)
  }
}

export async function setApiKey(cwd: string, provider: string, key: string): Promise<void> {
  const services = await getServices(cwd)
  // 1. keep the current process working right away
  await services.modelRuntime.setRuntimeApiKey(provider, key)
  // 2. persist it: pi's runtime key is memory-only, so Alpha writes the
  //    documented auth.json entry itself ({provider:{type,key}}).
  try {
    mkdirSync(dirname(AUTH_FILE), { recursive: true })
    let data: Record<string, unknown> = {}
    if (existsSync(AUTH_FILE)) {
      try {
        data = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Record<string, unknown>
      } catch {
        data = {}
      }
    }
    data[provider] = { type: 'api_key', key }
    writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (error) {
    log('warn', `auth persist: ${String(error)}`)
  }
  // 3. new services must re-read the file
  invalidateServices(cwd)
  log('info', `api key stored for ${provider}`)
}

export async function removeApiKey(cwd: string, provider: string): Promise<void> {
  const services = await getServices(cwd)
  try {
    await services.modelRuntime.removeRuntimeApiKey(provider)
  } catch (error) {
    log('warn', `runtime key remove: ${String(error)}`)
  }
  try {
    await services.modelRuntime.logout(provider)
  } catch (error) {
    log('warn', `logout: ${String(error)}`)
  }
  try {
    if (existsSync(AUTH_FILE)) {
      const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Record<string, unknown>
      delete data[provider]
      writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
    }
  } catch (error) {
    log('warn', `auth cleanup: ${String(error)}`)
  }
  invalidateServices(cwd)
}

export async function testConnection(cwd: string): Promise<string> {
  const services = await getServices(cwd)
  const result = await services.modelRuntime.refresh({ allowNetwork: true })
  const errors = [...((result as { errors?: ReadonlyMap<string, Error> }).errors?.values() ?? [])].map(
    (error) => error.message
  )
  return errors.length ? errors.join('; ') : 'ok'
}

/** Cwd of the open chat; one-shot helpers reuse its warm services. */
export function activeCwd(): string | null {
  return active?.cwd ?? null
}

/**
 * One-shot completion used by mods (prompt improver): no tools, no session
 * file, the default model from settings. Resolves with the answer text.
 */
export async function completeOnce(cwd: string, system: string, prompt: string): Promise<string> {
  const services = await getServices(cwd)
  const settings = loadSettings()
  const model =
    settings.defaultProvider && settings.defaultModel
      ? services.modelRuntime.getModel(settings.defaultProvider, settings.defaultModel)
      : undefined
  if (!model) throw new Error('Модель не выбрана: Настройки → Модель')
  if (!services.modelRuntime.hasConfiguredAuth(model.provider)) {
    throw new Error(`У провайдера ${model.provider} нет ключа`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 90_000)
  try {
    const message = await services.modelRuntime.complete(
      model,
      { systemPrompt: system || undefined, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] },
      { signal: controller.signal }
    )
    const text = textOfContent(message.content)
    if (!text) throw new Error(message.errorMessage || 'модель вернула пустой ответ')
    const tokens = (message.usage?.input ?? 0) + (message.usage?.output ?? 0)
    if (tokens) recordUsage(tokens, message.usage?.cost?.total ?? 0)
    return text
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('AI не ответил за 90 секунд')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Updates pi inside ~/.alpha/runtime and streams log lines to the renderer. */
export function updatePi(): void {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const child = spawn(
    npm,
    ['install', '--no-audit', '--no-fund', `@earendil-works/pi-coding-agent@latest`, '--prefix', RUNTIME_DIR],
    { cwd: RUNTIME_DIR, env: { ...process.env, npm_config_prefix: undefined } }
  )
  const push = (line: string) => send({ kind: 'pi-update', line })
  child.stdout.on('data', (d: Buffer) => push(d.toString()))
  child.stderr.on('data', (d: Buffer) => push(d.toString()))
  child.on('close', (code) => {
    push(`exit ${code}`)
    if (code === 0) {
      piCache = null
      servicesCache.clear()
      push(`done: ${piVersion()}`)
    }
  })
}