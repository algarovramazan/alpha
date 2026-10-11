// Shared types between main, preload and renderer.

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Built-in theme presets grouped by family. */
export const DARK_THEMES = ['dark', 'carbon', 'dracula', 'nord', 'monokai', 'gruvbox']
export const LIGHT_THEMES = ['light', 'solarized', 'sepia', 'ice', 'rose', 'paper']
export const THEME_IDS = ['system', ...LIGHT_THEMES, ...DARK_THEMES]

/** Working modes Alpha supports (one per chat). */
export type ModeId = 'agent' | 'plan' | 'debug' | 'assist' | 'quick'

/** Built-in side panels. Each one lives in the left or the right column. */
export type PanelId = 'projects' | 'files' | 'inspector'
export const PANEL_IDS: PanelId[] = ['projects', 'files', 'inspector']

export interface Settings {
  theme: string
  accent: string
  uiFont: string
  codeFont: string
  fontSize: number
  density: 'compact' | 'normal' | 'spacious'
  iconSize: 'small' | 'medium' | 'large' | 'xlarge' | 'xxlarge'
  language: 'ru' | 'en'
  defaultProvider: string
  defaultModel: string
  thinkingLevel: ThinkingLevel
  /** Mode stamped on every new chat; per-chat mode lives in chats-meta. */
  defaultMode: ModeId
  /** Per-mode prompt prefixes; empty string falls back to the built-in text. */
  modePrefixes: { plan: string; debug: string; quick: string }
  /** Thinking level used while a chat is in quick mode. */
  quickThinking: ThinkingLevel
  /** Which side each built-in panel lives on; a missing panel is on the left. */
  panelSides: Partial<Record<PanelId, 'left' | 'right'>>
  /** Panel shown in the left column and in the right column. */
  leftPanel: PanelId
  rightPanel: PanelId
  maxSessions: number
  dailyTokenLimit: number
  monthlyCostLimit: number
  subagentConcurrency: number
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  telemetry: boolean
  disabledSkills: string[]
  disabledMods: string[]
  activeThemeMod: string
  extraSkillPaths: string[]
  sidebarCollapsed: boolean
  inspectorCollapsed: boolean
  filesCollapsed: boolean
  designVersion: string
  hotkeys: Record<string, string>
  notifyDone: boolean
  approvalMode: 'off' | 'risky' | 'all'
  pinnedModels: string[]
  compactTools: boolean
  /** Subagent tool on by default (feature: default subagents). */
  subagents: boolean
}

export interface Project {
  id: string
  name: string
  path: string
  archived?: boolean
}

export interface ChatMeta {
  id: string
  path: string
  name?: string
  cwd?: string
  mtime: number
  /** Set when the chat was picked from a global search hit. */
  projectId?: string
}

/** Per-chat flags Alpha keeps on its own side of pi (pin, plan mode). */
export interface ChatExtra {
  pin?: boolean
  /** Legacy flag from the standalone plan mode; migrated to `mode`. */
  plan?: boolean
  mode?: ModeId
}

export type ChatsMeta = Record<string, Record<string, ChatExtra>>

export interface NoteInfo {
  path: string
  name: string
  folder: string
  mtime: number
  tags: string[]
}

export interface ToolCallUI {
  callId: string
  name: string
  args: string
  result?: string
  partial?: string
  running?: boolean
  isError?: boolean
  durationMs?: number
}

export interface UsageUI {
  tokens: number
  cost?: number
}

export type UIMessage =
  | { kind: 'user'; id: string; text: string; time: string; entryId?: string; queued?: boolean; checkpointId?: string }
  | {
      kind: 'assistant'
      id: string
      text: string
      thinking: string
      toolCalls: ToolCallUI[]
      time: string
      streaming?: boolean
      usage?: UsageUI
      /** Wall time of the whole run, reported with the done event. */
      durationMs?: number
      model?: string
      entryId?: string
    }
  | { kind: 'system'; id: string; text: string; time: string }

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: 'global' | 'project'
  enabled: boolean
}

export interface ModInfo {
  id: string
  name: string
  version: string
  kind: 'theme' | 'ui' | 'core'
  api: string
  description: string
  author?: string
  enabled: boolean
  error?: string
  /** Capabilities found by the static scan of the mod source. */
  risks: string[]
  /** Capabilities the manifest declares in "permissions". */
  declared: string[]
}

export interface ModelInfo {
  provider: string
  id: string
  name: string
  hasKey: boolean
  contextWindow?: number
}

/** Context window fill, reported with the done event. */
export interface ContextUsageUI {
  tokens: number
  percent: number
  contextWindow: number
}

/** Events pushed from main to renderer. */
export type SessionEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool.start'; callId: string; name: string; args: string }
  | { type: 'tool.update'; callId: string; partial: string }
  | { type: 'tool.end'; callId: string; ok: boolean; result?: string; error?: string; durationMs?: number }
  | { type: 'status'; phase: 'idle' | 'working' | 'waiting' | 'error'; message?: string }
  | { type: 'split'; usage?: UsageUI }
  | { type: 'done'; usage?: UsageUI; context?: ContextUsageUI; durationMs?: number }

export type AlphaEvent =
  | { kind: 'session'; chatPath: string; event: SessionEvent }
  | { kind: 'term'; data: string }
  | { kind: 'toast'; level: 'info' | 'error'; message: string }
  | { kind: 'pi-update'; line: string }
  | { kind: 'ask'; id: string; question: string; options: string[] }
  | { kind: 'ui-list'; modId: string; listId: string; title: string; items: { text: string; status: string }[] | null }
  | { kind: 'finished'; summary: string; chatId?: string; chatName?: string }
  | { kind: 'approval'; id: string; tool: string; summary: string }

export interface AppState {
  settings: Settings
  projects: Project[]
  appVersion: string
  piVersion: string
  alphaDir: string
  coreModErrors: { id: string; error: string }[]
}

export type SessionPhase = 'idle' | 'working' | 'waiting' | 'error'

/** Approximate context-window breakdown for the inspector. */
export interface ContextDetail {
  total: number
  window: number
  percent: number
  parts: { key: string; label: string; tokens: number }[]
  /** Context parts injected into the prompt of this chat (last send). */
  injected: string[]
  /** Memory, knowledge or the map changed since the last prompt: pending injection. */
  pending: boolean
}

export interface ReviewFile {
  path: string
  status: string
  added: number
  removed: number
  diff: string
}

export interface ReviewStatus {
  git: boolean
  branch: string
  files: ReviewFile[]
}

export interface CheckpointInfo {
  id: string
  ts: number
  files: number
}

export interface KbItem {
  name: string
  path: string
  size: number
  /** The codebase map (PROJECT.md) rather than a document of the knowledge folder. */
  map?: boolean
}

export interface ChatHit {
  path: string
  chatId: string
  preview: string
  projectId?: string
  projectName?: string
}

export interface UsageDay {
  d: string
  t: number
  c: number
}

export interface UsageModel {
  m: string
  t: number
  c: number
}

/** Fields a mod registers through alpha.ui.registerSettings. */
export interface ModSettingField {
  key: string
  label: string
  type: 'text' | 'number' | 'toggle' | 'select'
  options?: string[]
  default?: string | number | boolean
}

export interface RegisteredModSettings {
  modId: string
  fields: ModSettingField[]
}

export type ModSettingsStore = Record<string, Record<string, unknown>>

/** Mod capabilities that need an explicit confirmation before enabling. */
export const HIGH_MOD_RISKS = ['fs', 'process', 'child_process', 'net', 'eval']

/** Cheap free-tier heuristic: openrouter marks free variants with ":free". */
export function isFreeModel(model: { id: string }): boolean {
  const id = model.id.toLowerCase()
  return id.includes(':free') || id.endsWith('-free')
}

/** IPC channels exposed to the renderer. */
export const ALPHA_CHANNELS = [
  'app:state',
  'files:all',
  'mode:get',
  'mode:set',
  'memory:get',
  'memory:set',
  'kb:list',
  'kb:read',
  'kb:save',
  'kb:add',
  'kb:new',
  'kb:delete',
  'review:status',
  'review:revert',
  'review:commit',
  'checkpoint:list',
  'context:detail',
  'codemap:build',
  'checkpoint:create',
  'checkpoint:restore',
  'chats:meta:get',
  'chats:meta:set',
  'projects:archive',
  'mcp:list',
  'mcp:save',
  'notes:list',
  'notes:read',
  'notes:save',
  'notes:mkdir',
  'notes:delete',
  'notes:rename',
  'notes:folders',
  'notes:folderRename',
  'notes:import',
  'app:title',
  'ask:answer',
  'projects:add',
  'projects:remove',
  'chats:list',
  'chats:new',
  'chats:open',
  'chats:delete',
  'chats:fork',
  'chats:search',
  'session:send',
  'session:abort',
  'settings:get',
  'settings:set',
  'settings:reset',
  'keys:reset',
  'skills:list',
  'skills:file',
  'skills:setEnabled',
  'skills:addPath',
  'skills:openDir',
  'agentsmd:get',
  'agentsmd:set',
  'mods:list',
  'mods:setEnabled',
  'mods:themeCss',
  'mods:uiSources',
  'mods:install',
  'mods:openDir',
  'models:list',
  'models:setKey',
  'models:test',
  'pi:update',
  'logs:tail',
  'diagnostics:copy',
  'backup:export',
  'backup:import',
  'shell:open',
  'shell:openPath',
  'file:read',
  'file:write',
  'file:save',
  'file:tree',
  'term:start',
  'term:write',
  'term:char',
  'term:submit',
  'term:interrupt',
  'term:kill',
  'ai:complete',
  'win:control',
  'usage:today',
  'usage:range',
  'usage:models',
  'chats:forkAt',
  'chats:newWorktree',
  'chats:rename',
  'approval:answer',
  'prompts:list',
  'prompts:get',
  'prompts:save',
  'prompts:create',
  'prompts:delete',
  'models:removeKey',
  'modSettings:all',
  'modSettings:set',
  'modSettings:registered'
] as const

export type AlphaChannel = (typeof ALPHA_CHANNELS)[number]