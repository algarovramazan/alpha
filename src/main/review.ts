// Review panel: working-tree diffs, per-file revert, WIP commit and the
// checkpoint list. Everything here is plain git in the project directory.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckpointInfo, ReviewFile, ReviewStatus } from '../shared/types'
import { isGitRepo } from './pi'
import { ALPHA_DIR } from './paths'
import { log } from './store'

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { ok: result.status === 0, out: String(result.stdout ?? '') }
}

function countDiff(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/** Splits one `git diff HEAD` output into per-path chunks. */
function splitUnifiedDiff(diff: string): Map<string, string> {
  const map = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  const flush = (): void => {
    if (current) map.set(current, buf.join('\n'))
    buf = []
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line)
      current = match ? match[1] : null
      buf = current ? [line] : []
    } else if (current) {
      buf.push(line)
    }
  }
  flush()
  return map
}

export function reviewStatus(_projectId: string, cwd: string): ReviewStatus {
  if (!isGitRepo(cwd)) return { git: false, branch: '', files: [] }
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()
  const status = git(cwd, ['status', '--porcelain', '-uall'])
  const entries: { path: string; status: string }[] = []
  for (const line of status.out.split('\n')) {
    if (!line.trim()) continue
    entries.push({ status: line.slice(0, 2).trim() || 'M', path: line.slice(3).replace(/^"|"$/g, '') })
  }
  // One diff for every tracked path: staged and unstaged both show up in
  // `git diff HEAD`, which the per-file `git diff` silently missed.
  const tracked = entries.filter((entry) => entry.status !== '??').map((entry) => entry.path)
  const byPath = tracked.length ? splitUnifiedDiff(git(cwd, ['diff', 'HEAD', '--', ...tracked]).out) : new Map<string, string>()

  const files: ReviewFile[] = entries.map((entry) => {
    const diff = byPath.get(entry.path) ?? ''
    const { added, removed } = countDiff(diff)
    if (entry.status === '??' && !diff) {
      // Untracked files are not in git diff: show their content as additions.
      try {
        const text = readFileSync(join(cwd, entry.path), 'utf8').slice(0, 20_000)
        const body = text
          .split('\n')
          .map((row) => `+${row}`)
          .join('\n')
        return { path: entry.path, status: entry.status, added: text.split('\n').length, removed: 0, diff: body }
      } catch {
        // binary or vanished, keep empty diff
      }
    }
    return { path: entry.path, status: entry.status, added, removed, diff }
  })
  return { git: true, branch, files }
}

export function reviewRevert(projectId: string, cwd: string, path: string): string {
  if (!isGitRepo(cwd)) throw new Error('not a git repo')
  const clean = String(path ?? '').trim()
  if (!clean || clean.startsWith('/') || clean.includes('..')) throw new Error('bad path')
  const tracked = git(cwd, ['ls-files', '--', clean]).out.trim()
  if (tracked) {
    const result = spawnSync('git', ['-C', cwd, 'checkout', 'HEAD', '--', clean], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(String(result.stderr || 'git checkout failed'))
  } else {
    rmSync(join(cwd, clean), { force: true })
  }
  log('info', `review revert: ${clean}`)
  return clean
}

export function reviewCommit(cwd: string, message: string): string {
  if (!isGitRepo(cwd)) throw new Error('not a git repo')
  const add = spawnSync('git', ['-C', cwd, 'add', '-A'], { encoding: 'utf8' })
  if (add.status !== 0) throw new Error(String(add.stderr || 'git add failed'))
  const text = String(message ?? '').trim() || 'alpha: wip'
  const commit = spawnSync('git', ['-C', cwd, 'commit', '-m', text], { encoding: 'utf8' })
  if (commit.status !== 0) throw new Error(String(commit.stderr || 'git commit failed'))
  log('info', `review commit: ${text}`)
  return git(cwd, ['rev-parse', '--short', 'HEAD']).out.trim()
}

// ---------------------------------------------------------------- checkpoints

const CHECKPOINT_ROOT = join(ALPHA_DIR, 'checkpoints')

function checkpointDir(chatId: string): string {
  // Same layout as the create handler in ipc.ts.
  return join(CHECKPOINT_ROOT, String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_'))
}

export function listCheckpoints(chatId: string): CheckpointInfo[] {
  const dir = checkpointDir(chatId)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .map((id) => {
        const manifest = join(dir, id, 'manifest.json')
        let ts = 0
        let files = 0
        try {
          ts = statSync(manifest).mtimeMs
          const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { files?: unknown[] }
          files = Array.isArray(parsed.files) ? parsed.files.length : 0
        } catch {
          return null
        }
        return { id, ts, files }
      })
      .filter((entry): entry is CheckpointInfo => entry !== null)
      .sort((a, b) => b.ts - a.ts)
  } catch {
    return []
  }
}