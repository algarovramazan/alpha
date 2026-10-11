// Internal terminal: one persistent interactive bash per project directory.
//
// The shell runs with pipes instead of a pty (Electron has no node-pty here),
// so full-screen programs do not work, but prompts, readline editing, history
// and cd all behave like a normal shell. The renderer keeps a hidden input for
// key capture; bash itself echoes typed characters back into the stream.
//
// Every user-typed line passes the same approval gate as model bash calls
// (approvalMode: off / risky / all), so `sudo` or `rm -rf` still ask first.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { emit } from './bus'
import { gateToolCall } from './approvals'
import { log } from './store'

let child: ChildProcessWithoutNullStreams | null = null
let cwd = ''

// OSC escape sequences (window title updates) — the renderer is not a real
// terminal emulator, so they are stripped instead of shown as garbage.
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
// bash job-control warnings on a non-tty stdin (English and Russian locales).
const NOISE = /^\s*bash: .*(ioctl|job control|заданиями)/

function clean(text: string): string {
  return text
    .replace(OSC, '')
    .split('\n')
    .filter((line) => !NOISE.test(line))
    .join('\n')
    .replace(/\r\n/g, '\n')
}

function push(data: string): void {
  const text = clean(data)
  if (text) emit({ kind: 'term', data: text })
}

/** Starts the shell for a project directory (or reuses the running one). */
export function termStart(targetCwd: string): { cwd: string; running: boolean } {
  if (child && cwd === targetCwd) return { cwd, running: true }
  termStop()
  cwd = targetCwd
  try {
    child = spawn('/bin/bash', ['-i'], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      stdio: 'pipe',
      // Own process group: lets the interrupt button signal bash and its children.
      detached: true
    })
  } catch (error) {
    log('warn', `terminal start: ${String(error)}`)
    child = null
    return { cwd, running: false }
  }
  child.stdout.on('data', (data: Buffer) => push(data.toString()))
  child.stderr.on('data', (data: Buffer) => push(data.toString()))
  child.stdin.on('error', () => {
    // EPIPE while the shell is exiting is expected
  })
  child.on('close', (code) => {
    push(`\n[shell exited: ${code}]\n`)
    child = null
  })
  log('info', `terminal started in ${cwd}`)
  return { cwd, running: true }
}

export function termStop(): void {
  if (!child) return
  try {
    child.stdin.end()
    child.kill()
  } catch {
    // already gone
  }
  child = null
}

/** SIGINT to the shell's process group — what Ctrl+C would do on a real tty. */
export function termInterrupt(): void {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGINT')
  } catch {
    // group already gone
  }
}

/** Stops the shell together with its process group. */
export function termKill(): void {
  if (!child) return
  const pid = child.pid
  try {
    child.stdin.end()
    if (pid) process.kill(-pid, 'SIGTERM')
    else child.kill()
  } catch {
    // already gone
  }
  child = null
}

export function termCwd(): string {
  return cwd
}

/** Sends one command line through the approval gate into the shell. */
export async function termWrite(command: string): Promise<void> {
  const line = String(command).replace(/\r?\n$/, '')
  const decision = await gateToolCall('terminal', { command: line }, cwd)
  if (decision?.block) {
    push(`\n[blocked by approval] ${line}\n`)
    return
  }
  if (!child && cwd) termStart(cwd)
  if (!child) {
    push('[shell is not running]\n')
    return
  }
  child.stdin.write(`${line}\n`)
}

/** Raw single keystroke straight into readline: bash echoes it back. */
export function termChar(ch: string): void {
  if (!child) return
  try {
    child.stdin.write(ch)
  } catch {
    // dying shell, ignore
  }
}

/** Enter typed in the terminal: gate the whole line, then commit or erase it. */
export async function termSubmit(line: string): Promise<void> {
  const command = String(line ?? '').replace(/\r?\n$/, '')
  if (!child && cwd) termStart(cwd)
  if (!child) {
    push('[shell is not running]\n')
    return
  }
  if (!command.trim()) {
    child.stdin.write('\n')
    return
  }
  const decision = await gateToolCall('terminal', { command }, cwd)
  if (decision?.block) {
    // Ctrl+U: kill the typed line so nothing half-armed stays on screen
    child.stdin.write('\u0015')
    push(`\n[blocked by approval] ${command}\n`)
    return
  }
  child.stdin.write('\n')
}
