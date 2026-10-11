import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModSettingField, ModSettingsStore, RegisteredModSettings } from '../shared/types'
import { ALPHA_DIR } from './paths'
import { log } from './store'

const FILE = join(ALPHA_DIR, 'mods-settings.json')
const registered: RegisteredModSettings[] = []

function readStore(): ModSettingsStore {
  if (!existsSync(FILE)) return {}
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as ModSettingsStore
  } catch (error) {
    log('warn', `mod settings read: ${String(error)}`)
    return {}
  }
}

function writeStore(store: ModSettingsStore): void {
  mkdirSync(ALPHA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(store, null, 2))
}

/** Called by core mods through alpha.ui.registerSettings. */
export function registerModSettings(modId: string, fields: ModSettingField[]): void {
  const index = registered.findIndex((entry) => entry.modId === modId)
  const entry: RegisteredModSettings = { modId, fields }
  if (index >= 0) registered[index] = entry
  else registered.push(entry)
}

export function listRegisteredModSettings(): RegisteredModSettings[] {
  return [...registered]
}

export function allModSettings(): ModSettingsStore {
  return readStore()
}

/** Stored values merged over the registered defaults. */
export function getModSettingsWithDefaults(modId: string): Record<string, unknown> {
  const stored = readStore()[modId] ?? {}
  const fields = registered.find((entry) => entry.modId === modId)?.fields ?? []
  const resolved: Record<string, unknown> = {}
  for (const field of fields) resolved[field.key] = field.default ?? ''
  return { ...resolved, ...stored }
}

export function setModSettingsValue(modId: string, key: string, value: unknown): ModSettingsStore {
  const store = readStore()
  store[modId] = { ...(store[modId] ?? {}), [key]: value }
  writeStore(store)
  return store
}