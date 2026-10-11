// Per-chat metadata Alpha keeps outside pi's session files: pin, plan-mode
// legacy flag and the current mode. One JSON file, read and written by both
// the ipc layer and the session code.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatExtra, ChatsMeta } from '../shared/types'
import { ALPHA_DIR } from './paths'

const CHATS_META_FILE = join(ALPHA_DIR, 'chats-meta.json')

export function loadChatsMeta(): ChatsMeta {
  if (!existsSync(CHATS_META_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(CHATS_META_FILE, 'utf8')) as ChatsMeta
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function saveChatsMeta(meta: ChatsMeta): void {
  mkdirSync(dirname(CHATS_META_FILE), { recursive: true })
  writeFileSync(CHATS_META_FILE, JSON.stringify(meta, null, 2))
}

export function getChatExtra(projectId: string, chatId: string): ChatExtra {
  return loadChatsMeta()[projectId || 'home']?.[chatId] ?? {}
}

/**
 * Merges a patch into one chat's entry. `false`, `''` and `undefined` delete
 * the key, so `{ pin: false }` unpins and `{ mode: '' }` clears the mode.
 */
export function patchChatExtra(projectId: string, chatId: string, patch: ChatExtra): ChatExtra {
  const meta = loadChatsMeta()
  const owner = projectId || 'home'
  const perProject = { ...(meta[owner] ?? {}) }
  const next: ChatExtra = { ...(perProject[chatId] ?? {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === false || value === undefined || value === '') {
      delete (next as Record<string, unknown>)[key]
    } else {
      ;(next as Record<string, unknown>)[key] = value
    }
  }
  if (Object.keys(next).length === 0) delete perProject[chatId]
  else perProject[chatId] = next
  saveChatsMeta({ ...meta, [owner]: perProject })
  return next
}

/** Drops the whole entry: called when the chat itself is deleted. */
export function clearChatExtra(projectId: string, chatId: string): void {
  const meta = loadChatsMeta()
  const owner = projectId || 'home'
  if (!meta[owner]?.[chatId]) return
  delete meta[owner][chatId]
  if (Object.keys(meta[owner]).length === 0) delete meta[owner]
  saveChatsMeta(meta)
}
