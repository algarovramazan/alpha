// Public API handed to GUI mods (kind: "ui"). Mods import nothing: the whole
// API object is passed to their default export function.
//
// Every registration carries the id of the mod that made it, so a disabled mod
// can be unloaded live: its panels, status items and commands disappear and the
// React components unmount (running their render cleanup).

import type { ModSettingField, ModSettingsStore, RegisteredModSettings, Settings } from '@shared/types'
import { invoke } from './api'

export interface PanelDef {
  id: string
  title: string
  side?: 'right' | 'left' | 'bottom'
  render(container: HTMLElement): void | (() => void)
}

export interface StatusItemDef {
  id: string
  render(container: HTMLElement): void | (() => void)
}

export interface CommandDef {
  id: string
  title: string
  run(): void
}

/** A button next to the composer input, registered by a ui mod. */
export interface ComposerActionDef {
  id: string
  title: string
  run(ctx: { text: string; replace(next: string): void }): void | Promise<void>
}

/** A row at the bottom of the left sidebar (API 1.1). */
export interface SidebarItemDef {
  id: string
  title: string
  render(container: HTMLElement): void | (() => void)
}

/** A full page in the settings window, next to the built-in sections (API 1.1). */
export interface SettingsPageDef {
  id: string
  title: string
  render(container: HTMLElement): void | (() => void)
}

interface Owned<T> {
  modId: string
  def: T
}

const panels: Owned<PanelDef>[] = []
const statusItems: Owned<StatusItemDef>[] = []
const commands: Owned<CommandDef>[] = []
const composerActions: Owned<ComposerActionDef>[] = []
const sidebarItems: Owned<SidebarItemDef>[] = []
const settingsPages: Owned<SettingsPageDef>[] = []
const settingsRegistry: RegisteredModSettings[] = []
const eventListeners = new Map<string, Set<{ modId: string; handler: (payload: unknown) => void }>>()
const listeners = new Set<() => void>()
const loaded = new Map<string, string>() // modId -> code marker
const activating = new Set<string>() // guards concurrent activation of one mod

let cachedSettings: Settings | null = null
let modSettingsCache: ModSettingsStore = {}

/** Fills the local mod-settings cache from main (called once at startup). */
export async function loadModSettings(): Promise<void> {
  try {
    modSettingsCache = await invoke<ModSettingsStore>('modSettings:all')
  } catch {
    modSettingsCache = {}
  }
}

export function getRegisteredModSettings(): RegisteredModSettings[] {
  return [...settingsRegistry]
}

/** Fires an event for every ui mod subscription (alpha.on). */
export function emitModEvent(name: string, payload: unknown): void {
  for (const entry of eventListeners.get(name) ?? []) {
    try {
      entry.handler(payload)
    } catch (error) {
      console.error(`[mod:${entry.modId}]`, error)
    }
  }
}

function resolveModSettings(modId: string): Record<string, unknown> {
  const fields = settingsRegistry.find((entry) => entry.modId === modId)?.fields ?? []
  const resolved: Record<string, unknown> = {}
  for (const field of fields) resolved[field.key] = field.default ?? ''
  return { ...resolved, ...(modSettingsCache[modId] ?? {}) }
}

export function setModSettings(settings: Settings): void {
  cachedSettings = settings
}

export function subscribeRegistry(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function notify(): void {
  for (const cb of listeners) cb()
}

function upsert<T>(list: Owned<T>[], modId: string, id: string, def: T): void {
  const index = list.findIndex((entry) => entry.modId === modId && (entry.def as { id?: string }).id === id)
  if (index >= 0) list[index] = { modId, def }
  else list.push({ modId, def })
}

function makeApi(modId: string) {
  return {
    ui: {
      registerPanel(def: PanelDef): void {
        upsert(panels, modId, def.id, def)
        notify()
      },
      registerStatusItem(def: StatusItemDef): void {
        upsert(statusItems, modId, def.id, def)
        notify()
      },
      registerCommand(def: CommandDef): void {
        upsert(commands, modId, def.id, def)
        notify()
      },
      /** Button in the composer row; run() receives the draft and a setter. */
      registerComposerAction(def: ComposerActionDef): void {
        upsert(composerActions, modId, def.id, def)
        notify()
      },
      /** Row at the bottom of the left sidebar (API 1.1). */
      registerSidebarItem(def: SidebarItemDef): void {
        upsert(sidebarItems, modId, def.id, def)
        notify()
      },
      /** Full settings page rendered in Настройки (API 1.1). */
      registerSettingsPage(def: SettingsPageDef): void {
        upsert(settingsPages, modId, def.id, def)
        notify()
      },
      /** Settings fields rendered in Настройки → Моды. */
      registerSettings: (def: { fields: ModSettingField[] }): void => {
        const fields = Array.isArray(def?.fields) ? def.fields : []
        const index = settingsRegistry.findIndex((entry) => entry.modId === modId)
        if (index >= 0) settingsRegistry[index] = { modId, fields }
        else settingsRegistry.push({ modId, fields })
        notify()
      }
    },
    settings: {
      get: (): Settings | null => cachedSettings
    },
    modSettings: {
      get: (): Record<string, unknown> => resolveModSettings(modId),
      set: (key: string, value: unknown): void => {
        modSettingsCache[modId] = { ...(modSettingsCache[modId] ?? {}), [key]: value }
        void invoke('modSettings:set', modId, key, value)
      }
    },
    on: (name: string, handler: (payload: unknown) => void): (() => void) => {
      const set = eventListeners.get(name) ?? new Set<{ modId: string; handler: (payload: unknown) => void }>()
      const entry = { modId, handler }
      set.add(entry)
      eventListeners.set(name, set)
      return () => {
        set.delete(entry)
        if (set.size === 0) eventListeners.delete(name)
      }
    },
    theme: {
      get: () => ({
        accent: cachedSettings?.accent ?? '#5b8cff',
        mode: cachedSettings?.theme ?? 'system'
      })
    },
    /** One-shot AI completion on the default model (prompt improver and friends). */
    ai: {
      complete: (input: { system?: string; prompt: string }): Promise<string> =>
        invoke<string>('ai:complete', {
          system: String(input?.system ?? ''),
          prompt: String(input?.prompt ?? '')
        })
    },
    log: (...args: unknown[]): void => console.log(`[mod:${modId}]`, ...args)
  }
}

export const modApi = makeApi('alpha')

export function unregisterMod(modId: string): void {
  const drop = <T>(list: Owned<T>[]): void => {
    for (let index = list.length - 1; index >= 0; index--) {
      if (list[index].modId === modId) list.splice(index, 1)
    }
  }
  drop(panels)
  drop(statusItems)
  drop(commands)
  drop(composerActions)
  drop(sidebarItems)
  drop(settingsPages)
  for (const [name, set] of eventListeners) {
    for (const entry of [...set]) {
      if (entry.modId === modId) set.delete(entry)
    }
    if (set.size === 0) eventListeners.delete(name)
  }
  const settingsIndex = settingsRegistry.findIndex((entry) => entry.modId === modId)
  if (settingsIndex >= 0) settingsRegistry.splice(settingsIndex, 1)
  loaded.delete(modId)
  notify()
}

export function getRegistry(): {
  panels: (PanelDef & { modId: string })[]
  statusItems: (StatusItemDef & { modId: string })[]
  commands: (CommandDef & { modId: string })[]
  composerActions: (ComposerActionDef & { modId: string })[]
  sidebarItems: (SidebarItemDef & { modId: string })[]
  settingsPages: (SettingsPageDef & { modId: string })[]
} {
  return {
    panels: panels.map((entry) => ({ ...entry.def, modId: entry.modId })),
    statusItems: statusItems.map((entry) => ({ ...entry.def, modId: entry.modId })),
    commands: commands.map((entry) => ({ ...entry.def, modId: entry.modId })),
    composerActions: composerActions.map((entry) => ({ ...entry.def, modId: entry.modId })),
    sidebarItems: sidebarItems.map((entry) => ({ ...entry.def, modId: entry.modId })),
    settingsPages: settingsPages.map((entry) => ({ ...entry.def, modId: entry.modId }))
  }
}

/**
 * Reconciles loaded ui mods with the enabled set from the main process.
 * Mods that disappeared are unloaded, new ones are activated once.
 */
export async function loadUiMods(sources: { id: string; code: string }[]): Promise<string[]> {
  const errors: string[] = []
  const enabledIds = new Set(sources.map((source) => source.id))

  for (const modId of [...loaded.keys()]) {
    if (!enabledIds.has(modId)) unregisterMod(modId)
  }

  for (const { id, code } of sources) {
    if (loaded.has(id) || activating.has(id)) continue
    activating.add(id)
    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      const imported = (await import(/* @vite-ignore */ url)) as { default?: (api: unknown) => void }
      URL.revokeObjectURL(url)
      if (typeof imported.default !== 'function') throw new Error('no default export function')
      imported.default(makeApi(id))
      loaded.set(id, code.slice(0, 64))
    } catch (error) {
      const message = `${id}: ${error instanceof Error ? error.message : String(error)}`
      console.error('[mod]', message)
      errors.push(message)
    } finally {
      activating.delete(id)
    }
  }
  notify()
  return errors
}