import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installBuiltinMods } from './builtin-mods'
import { installBuiltinDefaults } from './builtin-defaults'

// All Alpha state lives here. The system pi (~/.pi) is never read or written.
export const ALPHA_DIR = process.env.ALPHA_DIR ?? join(homedir(), '.alpha')

// pi expects its global config directory layout: settings.json, auth.json,
// skills/, AGENTS.md. We point it at ~/.alpha/agent.
// Note: the prompt file says ~/.alpha/agents.md, pi reads AGENTS.md in its agent dir.
export const AGENT_DIR = join(ALPHA_DIR, 'agent')
export const GLOBAL_AGENTS_MD = join(AGENT_DIR, 'AGENTS.md')
export const SKILLS_DIR = join(AGENT_DIR, 'skills')
export const CHATS_DIR = join(ALPHA_DIR, 'chats')
export const MODS_DIR = join(ALPHA_DIR, 'mods')
export const THEMES_DIR = join(ALPHA_DIR, 'themes')
export const LOGS_DIR = join(ALPHA_DIR, 'logs')
export const RUNTIME_DIR = join(ALPHA_DIR, 'runtime')
export const PROMPTS_DIR = join(AGENT_DIR, 'prompts')
export const NOTES_DIR = join(ALPHA_DIR, 'notes')
export const CONFIG_FILE = join(ALPHA_DIR, 'config.json')
export const PROJECTS_FILE = join(ALPHA_DIR, 'projects.json')
export const AUTH_FILE = join(AGENT_DIR, 'auth.json')

// Chats live flat in ONE folder: no per-project subfolders on disk.
export function chatsDirFor(_projectId: string): string {
  return CHATS_DIR
}

/** One-time flattening: pulls session files out of per-project subfolders
 *  and removes those folders when they become empty. */
function flattenChats(): void {
  if (!existsSync(CHATS_DIR)) return
  for (const entry of readdirSync(CHATS_DIR)) {
    const sub = join(CHATS_DIR, entry)
    try {
      if (!statSync(sub).isDirectory()) continue
      for (const file of readdirSync(sub)) {
        if (!file.endsWith('.jsonl')) continue
        const target = join(CHATS_DIR, file)
        if (!existsSync(target)) renameSync(join(sub, file), target)
      }
      rmdirSync(sub) // succeeds only when the folder is empty
    } catch {
      // not a folder or not empty: leave it alone
    }
  }
}

export function ensureDirs(): void {
  for (const dir of [ALPHA_DIR, AGENT_DIR, SKILLS_DIR, PROMPTS_DIR, CHATS_DIR, MODS_DIR, THEMES_DIR, LOGS_DIR, RUNTIME_DIR, NOTES_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
  flattenChats()
  // mod scripts are ESM: mark the mods folder so node does not guess
  const marker = join(MODS_DIR, 'package.json')
  if (!existsSync(marker)) writeFileSync(marker, '{"type":"module"}\n')
  installBuiltinMods()
  installBuiltinDefaults()
}