import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, Settings } from '../shared/types'
import { THEME_IDS } from '../shared/types'
import { CONFIG_FILE, LOGS_DIR, PROJECTS_FILE } from './paths'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#5e6ad2',
  uiFont: 'system',
  codeFont: 'JetBrains Mono',
  fontSize: 16,
  density: 'compact',
  iconSize: 'medium',
  language: 'ru',
  defaultProvider: '',
  defaultModel: '',
  thinkingLevel: 'medium',
  defaultMode: 'agent',
  modePrefixes: { plan: '', debug: '', quick: '' },
  quickThinking: 'off',
  panelSides: {},
  leftPanel: 'projects',
  rightPanel: 'inspector',
  maxSessions: 4,
  dailyTokenLimit: 0,
  monthlyCostLimit: 0,
  subagentConcurrency: 4,
  logLevel: 'info',
  telemetry: false,
  disabledSkills: [],
  disabledMods: [],
  activeThemeMod: '',
  extraSkillPaths: [],
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  filesCollapsed: true,
  designVersion: 'linear',
  hotkeys: {
    palette: 'Ctrl+K',
    newChat: 'Ctrl+N',
    sidebar: 'Ctrl+B',
    inspector: 'Ctrl+I',
    settings: 'Ctrl+,',
    export: 'Ctrl+E'
  },
  notifyDone: true,
  approvalMode: 'risky',
  pinnedModels: [],
  compactTools: false,
  /** Subagents are a default feature: the tool ships enabled. */
  subagents: true
}

// One-time migration to the Linear design language (DESIGN-linear.app.md).
// Only appearance fields move; everything else the user changed stays.
function migrateDesign(settings: Settings): Settings {
  if (settings.designVersion === 'linear') return settings
  return {
    ...settings,
    theme: 'dark',
    accent: '#5e6ad2',
    uiFont: 'system',
    fontSize: 16,
    density: 'compact',
    designVersion: 'linear'
  }
}

export function loadSettings(): Settings {
  let raw: Record<string, unknown> = {}
  if (existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>
    } catch {
      raw = {}
    }
  }
  const merged = { ...DEFAULT_SETTINGS, ...raw } as Settings
  // Legacy migration: the old `mode: agent | assist` becomes defaultMode.
  if (!('defaultMode' in raw)) merged.defaultMode = raw.mode === 'assist' ? 'assist' : 'agent'
  // Object settings are merged key by key: a file written before a new key
  // existed must not lose its default binding.
  merged.hotkeys = { ...DEFAULT_SETTINGS.hotkeys, ...(merged.hotkeys ?? {}) }
  merged.modePrefixes = { ...DEFAULT_SETTINGS.modePrefixes, ...(merged.modePrefixes ?? {}) }
  const migrated = migrateDesign(merged)
  const normalized = normalizeDesign(migrated)
  const changed =
    JSON.stringify(normalized) !== JSON.stringify(merged) || JSON.stringify(normalized) !== JSON.stringify(migrated)
  if (changed) {
    writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2))
  }
  return normalized
}

// Heals corrupted or hand-edited appearance values instead of breaking the UI.
function normalizeDesign(settings: Settings): Settings {
  const next = { ...settings }
  if (!['light', 'dark', 'system'].includes(next.theme) && !THEME_IDS.includes(next.theme)) next.theme = 'dark'
  if (!/^#[0-9a-fA-F]{3,8}$/.test(next.accent)) next.accent = DEFAULT_SETTINGS.accent
  if (!Number.isFinite(next.fontSize) || next.fontSize < 12 || next.fontSize > 24) next.fontSize = DEFAULT_SETTINGS.fontSize
  if (!['compact', 'normal', 'spacious'].includes(next.density)) next.density = DEFAULT_SETTINGS.density
  if (!['small', 'medium', 'large', 'xlarge', 'xxlarge'].includes(next.iconSize)) next.iconSize = DEFAULT_SETTINGS.iconSize
  if (typeof next.filesCollapsed !== 'boolean') next.filesCollapsed = DEFAULT_SETTINGS.filesCollapsed
  const modes = ['agent', 'plan', 'debug', 'assist', 'quick']
  if (!modes.includes(next.defaultMode)) next.defaultMode = 'agent'
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  if (!levels.includes(next.quickThinking)) next.quickThinking = 'off'
  // Panels: every value must name a real panel and a real side, or it heals to the default.
  const panels = ['projects', 'files', 'inspector']
  if (!panels.includes(next.leftPanel)) next.leftPanel = 'projects'
  if (!panels.includes(next.rightPanel)) next.rightPanel = 'inspector'
  const sides: Record<string, 'left' | 'right'> = {}
  if (next.panelSides && typeof next.panelSides === 'object') {
    for (const [id, side] of Object.entries(next.panelSides)) {
      if (panels.includes(id) && (side === 'left' || side === 'right')) sides[id] = side
    }
  }
  next.panelSides = sides
  if (!next.modePrefixes || typeof next.modePrefixes !== 'object') next.modePrefixes = { ...DEFAULT_SETTINGS.modePrefixes }
  return next
}

export function saveSettings(settings: Settings): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(settings, null, 2))
}

export function loadProjects(): Project[] {
  if (!existsSync(PROJECTS_FILE)) return []
  try {
    const raw = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

export function saveProjects(projects: Project[]): void {
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2))
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const

let cachedVersion = ''

/**
 * The app version from package.json (0.1.1+). app.getVersion() reports the
 * Electron version in development, so the file is read directly.
 */
export function appVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string
    }
    cachedVersion = pkg.version || '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

let currentLevel: keyof typeof LEVELS = 'info'

export function setLogLevel(level: keyof typeof LEVELS): void {
  currentLevel = level
}

export function log(level: keyof typeof LEVELS, message: string): void {
  if (LEVELS[level] > LEVELS[currentLevel]) return
  const line = `${new Date().toISOString()} [${level}] ${message}\n`
  try {
    mkdirSync(LOGS_DIR, { recursive: true })
    appendFileSync(join(LOGS_DIR, 'alpha.log'), line)
  } catch {
    // logging must never break the app
  }
  if (level === 'error') console.error(message)
}

export function tailLog(lines = 200): string {
  const file = join(LOGS_DIR, 'alpha.log')
  if (!existsSync(file)) return ''
  const content = readFileSync(file, 'utf8')
  return content.split('\n').slice(-lines).join('\n')
}