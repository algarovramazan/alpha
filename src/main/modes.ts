// The mode system: one place that decides what the agent may do in a chat.
//
//   agent   — full tools, regular approvals            (default)
//   plan    — read-only, must present a plan first
//   debug   — full tools + debugging protocol prefix + verbose UI
//   assist  — read-only, answers without editing       (legacy "assist" mode)
//   quick   — full tools, terse answers, thinking override per chat
//
// Policy runs in the pi `tool_call` gate, so switching a mode applies to the
// very next tool call; prefixes apply on the next prompt.

import type { ChatExtra, ModeId, Settings, ThinkingLevel } from '../shared/types'
import { getChatExtra } from './chats-meta'
import { loadSettings } from './store'

export type ToolPolicy = 'full' | 'readonly' | 'plan'

export const MODE_IDS: ModeId[] = ['agent', 'plan', 'debug', 'assist', 'quick']

export const MODE_POLICY: Record<ModeId, ToolPolicy> = {
  agent: 'full',
  plan: 'plan',
  debug: 'full',
  assist: 'readonly',
  quick: 'full'
}

/** Built-in prefixes; a non-empty setting overrides them per mode. */
export const DEFAULT_PREFIX: Record<'plan' | 'debug' | 'quick', string> = {
  plan:
    '[PLAN MODE] You are in plan mode: file changes and state-changing commands are blocked. ' +
    'Explore the code with read-only tools, then reply with a concise step-by-step implementation plan ' +
    '(files to touch, what changes, risks) and wait for the user to approve it. Do not implement anything yet.',
  debug:
    '[DEBUG MODE] Follow the debugging protocol: (1) reproduce the failure with the smallest command you can, ' +
    '(2) form a hypothesis about the root cause, (3) read the relevant code, (4) make the minimal fix, ' +
    '(5) re-run the failing command or test to prove it works, (6) report the root cause and the proof. ' +
    'Do not refactor anything beyond the fix. If a tool result contains an error, start from it.',
  quick:
    '[QUICK MODE] Answer concisely: lead with the result, skip preambles, keep code snippets short. ' +
    'Still verify critical claims with read-only tools when the task requires it.'
}

const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'find',
  'list',
  'web_search',
  'web_fetch',
  'ask_user',
  'update_task_list',
  'project_memory'
])

const READ_ONLY_BASH =
  /^\s*(git\s+(status|diff|log|show|branch|stash\s+list|ls-files|rev-parse)|ls(\s|$)|cat(\s|$)|head(\s|$)|tail(\s|$)|wc(\s|$)|pwd|which(\s|$)|echo(\s|$)|find(\s|-)|grep(\s|$)|rg(\s|$)|npm\s+(ls|list|outdated|run\s+(test|lint|check))|node\s+-v|python\d?\s+--version|file(\s|$)|du(\s|$)|stat(\s|$)|diff(\s|$))/i

// ------------------------------------------------------------- state

/** Live mode per chat. Stamped from chats-meta when the session opens. */
const chatModes = new Map<string, ModeId>()
const chatCwds = new Map<string, string>()
const managerChat = new WeakMap<object, string>()

export function registerSession(chatId: string, manager: object, cwd: string, mode: ModeId): void {
  managerChat.set(manager, chatId)
  chatCwds.set(chatId, cwd)
  chatModes.set(chatId, mode)
}

export function unregisterSession(chatId: string): void {
  chatModes.delete(chatId)
  chatCwds.delete(chatId)
}

export function chatIdForManager(manager: unknown): string | undefined {
  if (!manager || typeof manager !== 'object') return undefined
  return managerChat.get(manager as object)
}

export function setChatMode(chatId: string, mode: ModeId): void {
  chatModes.set(chatId, mode)
}

export function chatMode(chatId: string): ModeId | undefined {
  return chatModes.get(chatId)
}

/** Mode of a chat that is not open yet: meta first, then the default. */
export function initialMode(projectId: string, chatId: string): ModeId {
  const extra = getChatExtra(projectId, chatId)
  const mode = extra.mode ?? (extra.plan ? 'plan' : undefined)
  if (mode && (MODE_IDS as string[]).includes(mode)) return mode
  return resolveDefaultMode(loadSettings())
}

/** Old configs wrote agent/assist into `mode`; keep reading them. */
export function resolveDefaultMode(settings: Settings): ModeId {
  const mode = settings.defaultMode
  if (mode && (MODE_IDS as string[]).includes(mode)) return mode
  return 'agent'
}

/** Restores persisted flags after a restart (chats-meta is read by ipc). */
export function primeChatModes(entries: { chatId: string; mode?: string; plan?: boolean }[]): void {
  for (const entry of entries) {
    const mode = entry.mode ?? (entry.plan ? 'plan' : undefined)
    if (mode && (MODE_IDS as string[]).includes(mode)) chatModes.set(entry.chatId, mode as ModeId)
    else chatModes.delete(entry.chatId)
  }
}

// ------------------------------------------------------------- prefixes

/** The instruction block prepended to the next prompt for this mode. */
export function modePrefix(mode: ModeId, settings: Settings): string {
  if (mode === 'agent' || mode === 'assist') return ''
  const custom = settings.modePrefixes?.[mode]?.trim()
  return custom || DEFAULT_PREFIX[mode as 'plan' | 'debug' | 'quick']
}

/** Thinking level a chat should run with right now: quick mode overrides the
 *  project/global value, which itself may come from `.alpha/settings.json`. */
export function desiredThinking(chatId: string, projectOverride?: ThinkingLevel): ThinkingLevel {
  const settings = loadSettings()
  if (chatModes.get(chatId) === 'quick') return settings.quickThinking
  return projectOverride ?? settings.thinkingLevel
}

// ------------------------------------------------------------- gate

function policyActive(policy: ToolPolicy, resolvedChatId: string | undefined, cwd: string): boolean {
  if (resolvedChatId !== undefined) {
    const mode = chatModes.get(resolvedChatId)
    if (!mode) return false
    return MODE_POLICY[mode] === policy
  }
  // Unknown session (in-memory child): fall back to the cwd rule, so a
  // read-only chat's workspace stays read-only for helpers too.
  return [...chatModes.entries()].some(
    ([id, mode]) => MODE_POLICY[mode] === policy && chatCwds.get(id) === cwd
  )
}

function blocked(policy: ToolPolicy): { block: boolean; reason: string } {
  return {
    block: true,
    reason:
      policy === 'plan'
        ? 'PLAN MODE: file changes and state-changing commands are blocked. ' +
          'Explore with read-only tools, then present a step-by-step plan and wait for the user to approve it. ' +
          'Do not retry the blocked action.'
        : 'READ-ONLY MODE: this chat must not change files or run state-changing commands. ' +
          'Answer with what you can read; do not retry the blocked action.'
  }
}

/** Decides whether the gate blocks this tool call, and why. */
export function modeDecision(
  toolName: string,
  input: unknown,
  resolvedChatId: string | undefined,
  cwd: string
): { block: boolean; reason: string } | undefined {
  const planActive = policyActive('plan', resolvedChatId, cwd)
  const readonlyActive = !planActive && policyActive('readonly', resolvedChatId, cwd)
  if (!planActive && !readonlyActive) return undefined

  if (READ_ONLY_TOOLS.has(toolName)) return undefined
  if (toolName === 'bash' || toolName === 'terminal') {
    const command = String((input as Record<string, unknown>)?.command ?? '')
    if (READ_ONLY_BASH.test(command)) return undefined
  }
  return blocked(planActive ? 'plan' : 'readonly')
}
