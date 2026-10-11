import type { AlphaEvent } from '../shared/types'
import { emit } from './bus'
import { loadSettings, log } from './store'

interface Decision {
  allow: boolean
  allowAll: boolean
}

const pending = new Map<string, (decision: Decision) => void>()
let seq = 0
// "Разрешить всё" lasts until the next session opens.
let allowAllActive = false

export function resetApprovals(): void {
  allowAllActive = false
  for (const resolve of pending.values()) resolve({ allow: false, allowAll: false })
  pending.clear()
}

export function resolveApproval(id: string, allow: boolean, allowAll: boolean): boolean {
  const resolve = pending.get(id)
  if (!resolve) return false
  pending.delete(id)
  resolve({ allow, allowAll })
  return true
}

const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bchmod\s+-R\b/i,
  /(\|\s*(ba|z)?sh\b)/,
  /\bnpm\s+publish\b/i,
  />\s*\/etc\//i
]

function summarize(toolName: string, input: unknown): string {
  const record = (input ?? {}) as Record<string, unknown>
  if (toolName === 'bash') return String(record.command ?? record.cmd ?? JSON.stringify(input))
  if (toolName === 'write' || toolName === 'edit') return String(record.path ?? record.file_path ?? '')
  return JSON.stringify(input).slice(0, 300)
}

function isPathInside(path: string, root: string): boolean {
  const normalized = path.startsWith('/') ? path : `${root}/${path}`
  return normalized === root || normalized.startsWith(`${root}/`)
}

/** Decides whether this tool call needs the user's confirmation. */
export function isRisky(toolName: string, input: unknown, cwd: string): { risky: boolean; summary: string } {
  const summary = summarize(toolName, input)
  const mode = loadSettings().approvalMode
  if (mode === 'off') return { risky: false, summary }
  if (mode === 'all') return { risky: true, summary }
  if (toolName === 'bash' || toolName === 'terminal') {
    return { risky: DANGER_PATTERNS.some((pattern) => pattern.test(summary)), summary }
  }
  if (toolName === 'write' || toolName === 'edit') {
    const path = String((input as Record<string, unknown>)?.path ?? '')
    return { risky: Boolean(path) && !isPathInside(path, cwd), summary }
  }
  return { risky: false, summary }
}

/**
 * The gate invoked from pi's `tool_call` extension hook.
 * Returns { block: true, reason } when the user declines.
 */
export async function gateToolCall(
  toolName: string,
  input: unknown,
  cwd: string
): Promise<{ block?: boolean; reason?: string } | undefined> {
  if (allowAllActive) return undefined
  const { risky, summary } = isRisky(toolName, input, cwd)
  if (!risky) return undefined

  const id = `approval-${++seq}`
  const decision = await new Promise<Decision>((resolve) => {
    pending.set(id, resolve)
    emit({ kind: 'approval', id, tool: toolName, summary })
    log('info', `approval requested: ${toolName} ${summary.slice(0, 120)}`)
  })

  if (decision.allowAll) {
    allowAllActive = true
    return undefined
  }
  if (decision.allow) return undefined
  return {
    block: true,
    reason: 'Пользователь отклонил это действие. Не повторяй его автоматически — спроси, как сделать иначе.'
  }
}