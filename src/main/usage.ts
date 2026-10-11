import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UsageDay } from '../shared/types'
import { ALPHA_DIR } from './paths'
import { log } from './store'

const USAGE_FILE = join(ALPHA_DIR, 'usage.jsonl')

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

interface UsageRow {
  d: string
  t: number
  c: number
  m?: string
}

function readRows(): UsageRow[] {
  if (!existsSync(USAGE_FILE)) return []
  try {
    return readFileSync(USAGE_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageRow)
  } catch (error) {
    log('warn', `usage read: ${String(error)}`)
    return []
  }
}

export function recordUsage(tokens: number, cost: number, model?: string): void {
  try {
    const row: UsageRow = { d: today(), t: tokens, c: cost }
    if (model) row.m = model
    appendFileSync(USAGE_FILE, JSON.stringify(row) + '\n')
  } catch (error) {
    log('warn', `usage write: ${String(error)}`)
  }
}

/** Tokens and cost per model over the last `days` days, biggest first. */
export function usageModels(days: number): { m: string; t: number; c: number }[] {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const per = new Map<string, { m: string; t: number; c: number }>()
  for (const row of readRows()) {
    if (row.d < since) continue
    const key = row.m ?? '—'
    const hit = per.get(key) ?? { m: key, t: 0, c: 0 }
    hit.t += row.t
    hit.c += row.c
    per.set(key, hit)
  }
  return [...per.values()].sort((a, b) => b.t - a.t)
}

export function usageToday(): UsageDay {
  const day = today()
  const rows = readRows().filter((row) => row.d === day)
  return { d: day, t: sum(rows, 't'), c: sum(rows, 'c') }
}

/** Last `days` days ending today, missing days filled with zeros. */
export function usageRange(days: number): UsageDay[] {
  const rows = readRows()
  const out: UsageDay[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
    const dayRows = rows.filter((row) => row.d === date)
    out.push({ d: date, t: sum(dayRows, 't'), c: sum(dayRows, 'c') })
  }
  return out
}

function sum(rows: UsageRow[], field: 't' | 'c'): number {
  return rows.reduce((total, row) => total + (typeof row[field] === 'number' ? row[field] : 0), 0)
}