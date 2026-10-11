// Project memory and knowledge base: the context Alpha injects into prompts.
//
//   ~/.alpha/memory/<projectId>.md        durable facts the model maintains
//   <project>/.alpha/knowledge/*.md       documents that ground every chat
//   ~/.alpha/knowledge/<projectId>/*.md   knowledge for the "no project" scope
//   <project>/PROJECT.md                  codebase map, built on demand
//
// Pure filesystem helpers live here; anything that needs pi stays in pi.ts.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ALPHA_DIR } from './paths'
import { log } from './store'
import type { KbItem } from '../shared/types'

const MEMORY_DIR = join(ALPHA_DIR, 'memory')
const HOME_KB_DIR = join(ALPHA_DIR, 'knowledge')

function safeId(projectId: string): string {
  return String(projectId || 'home').replace(/[^a-zA-Z0-9_-]/g, '_') || 'home'
}

export function memoryFile(projectId: string): string {
  return join(MEMORY_DIR, `${safeId(projectId)}.md`)
}

export function getMemory(projectId: string): string {
  const file = memoryFile(projectId)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function setMemory(projectId: string, text: string): void {
  mkdirSync(MEMORY_DIR, { recursive: true })
  writeFileSync(memoryFile(projectId), String(text ?? '').slice(0, 50_000))
}

/** Knowledge lives inside the project so it travels with the repository. */
export function knowledgeDir(projectId: string, projectPath?: string): string {
  if (projectId && projectId !== 'home' && projectPath) return join(projectPath, '.alpha', 'knowledge')
  return join(HOME_KB_DIR, safeId(projectId))
}

function safeName(name: string): string {
  const base = basename(String(name ?? '')).trim()
  if (!base || base.startsWith('.')) throw new Error('bad file name')
  const clean = base.replace(/[^\w.\- ]/g, '_')
  return clean.endsWith('.md') || clean.endsWith('.txt') ? clean : `${clean}.md`
}

/** Name of the codebase map as it appears in the knowledge base list. */
export const MAP_NAME = 'PROJECT.md'

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Where a knowledge entry lives. The map is generated into the project root. */
function entryPath(projectId: string, projectPath: string | undefined, name: string): string {
  if (name === MAP_NAME) return projectMapFileFor(projectId, projectPath ?? '')
  return join(knowledgeDir(projectId, projectPath), safeName(name))
}

/**
 * Everything the knowledge panel shows: the codebase map first (when it exists),
 * then the documents of the knowledge folder. The map is a generated file, so it
 * is listed explicitly with `map: true` instead of being found by folder scan.
 */
export function kbList(projectId: string, projectPath?: string): KbItem[] {
  const maps: KbItem[] = []
  const docs: KbItem[] = []
  const map = projectMapFileFor(projectId, projectPath ?? '')
  if (existsSync(map)) maps.push({ name: MAP_NAME, path: map, size: sizeOf(map), map: true })
  const dir = knowledgeDir(projectId, projectPath)
  if (existsSync(dir)) {
    try {
      for (const name of readdirSync(dir)) {
        // the "no project" scope keeps its map in this same folder: never list it twice
        if (name === MAP_NAME || !/\.(md|txt)$/i.test(name)) continue
        const path = join(dir, name)
        docs.push({ name, path, size: sizeOf(path) })
      }
    } catch {
      // unreadable folder: the map (if any) is still shown
    }
  }
  return [...maps, ...docs.sort((a, b) => a.name.localeCompare(b.name))]
}

export function kbRead(projectId: string, projectPath: string | undefined, name: string): string {
  const path = entryPath(projectId, projectPath, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function kbSave(projectId: string, projectPath: string | undefined, name: string, content: string): string {
  const path = entryPath(projectId, projectPath, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, String(content ?? ''))
  return path
}

export function kbNew(projectId: string, projectPath: string | undefined, name: string): string {
  if (safeName(name) === MAP_NAME) throw new Error(`${MAP_NAME} занят картой проекта, выберите другое имя`)
  return kbSave(projectId, projectPath, name, `# ${safeName(name).replace(/\.(md|txt)$/i, '')}\n\n`)
}

export function kbDelete(projectId: string, projectPath: string | undefined, name: string): void {
  rmSync(entryPath(projectId, projectPath, name), { force: true })
}

/** Copies an external file picked in a dialog into the knowledge base. */
export function kbImport(projectId: string, projectPath: string | undefined, source: string): string {
  const name = safeName(basename(source))
  if (name === MAP_NAME) throw new Error(`${MAP_NAME} занят картой проекта, переименуйте файл`)
  const content = readFileSync(source, 'utf8')
  return kbSave(projectId, projectPath, name, content)
}

export function projectMapFile(projectPath: string): string {
  return join(projectPath, 'PROJECT.md')
}

/** The "no project" scope keeps its map inside ~/.alpha/knowledge, never in $HOME. */
export function projectMapFileFor(projectId: string, projectPath: string): string {
  if (!projectId || projectId === 'home' || !projectPath) {
    return join(HOME_KB_DIR, safeId(projectId || 'home'), 'PROJECT.md')
  }
  return join(projectPath, 'PROJECT.md')
}

// ---------------------------------------------------------------- injection

const LIMIT_EACH = 3000
const LIMIT_TOTAL = 9000

function chunk(text: string): string {
  const clean = text.trim()
  return clean.length > LIMIT_EACH ? `${clean.slice(0, LIMIT_EACH)}\n…` : clean
}

function statPair(path: string): string | null {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * Fingerprint of everything that gets injected. Size + mtime instead of full
 * content: the check runs on every send and must stay cheap.
 */
export function contextFingerprint(projectId: string, projectPath: string): string {
  const parts: string[] = []
  const memory = statPair(memoryFile(projectId))
  if (memory) parts.push(`m${memory}`)
  const dir = knowledgeDir(projectId, projectPath)
  if (existsSync(dir)) {
    try {
      for (const name of readdirSync(dir)) {
        if (!/\.(md|txt)$/i.test(name)) continue
        const pair = statPair(join(dir, name))
        if (pair) parts.push(`k${name}${pair}`)
      }
    } catch {
      // unreadable knowledge dir: fingerprint without it
    }
  }
  const map = statPair(projectMapFileFor(projectId, projectPath))
  if (map) parts.push(`p${map}`)
  const all = parts.join('|')
  let hash = 0
  for (let index = 0; index < all.length; index++) hash = (hash * 31 + all.charCodeAt(index)) | 0
  return `${all.length}:${hash}`
}

export interface ContextBuild {
  /** The <project-context> block, or '' when there is nothing to inject. */
  block: string
  /** Human-readable names of what went in — shown in the inspector. */
  parts: string[]
}

/** The <project-context> block prepended to a prompt. */
export function buildContextBlock(projectId: string, projectPath: string): ContextBuild {
  const sections: string[] = []
  const parts: string[] = []
  let budget = LIMIT_TOTAL

  const push = (title: string, body: string): void => {
    const text = chunk(body)
    if (!text || budget <= 0) return
    const clipped = text.length > budget ? `${text.slice(0, budget)}…` : text
    budget -= clipped.length
    sections.push(`## ${title}\n${clipped}`)
    parts.push(title)
  }

  const memory = getMemory(projectId)
  if (memory.trim()) push('Project memory', memory)

  for (const item of kbList(projectId, projectPath)) {
    if (item.map) continue // the map gets its own section below
    try {
      push(`Knowledge: ${item.name}`, readFileSync(item.path, 'utf8'))
    } catch {
      // skip unreadable file
    }
  }

  const mapFile = projectMapFileFor(projectId, projectPath)
  if (existsSync(mapFile)) {
    try {
      push('Codebase map (PROJECT.md)', readFileSync(mapFile, 'utf8'))
    } catch {
      // skip unreadable map
    }
  }

  if (sections.length === 0) return { block: '', parts: [] }
  return { block: `<project-context>\n${sections.join('\n\n')}\n</project-context>`, parts }
}

// ---------------------------------------------------------------- code map

const SKIP = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  '.git',
  '.alpha',
  'pkg'
])

/** Compact project skeleton for the PROJECT.md prompt: paths with sizes. */
export function projectTree(root: string, maxLines = 400): string[] {
  const lines: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (lines.length >= maxLines || depth > 5) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries.sort()) {
      if (lines.length >= maxLines) return
      const full = join(dir, name)
      let isDir = false
      let size = 0
      try {
        const st = statSync(full)
        isDir = st.isDirectory()
        size = st.size
      } catch {
        continue
      }
      if (isDir) {
        if (name.startsWith('.') || SKIP.has(name)) continue
        lines.push(`${'  '.repeat(depth)}${name}/`)
        walk(full, depth + 1)
      } else {
        lines.push(`${'  '.repeat(depth)}${name} (${size}b)`)
      }
    }
  }
  if (existsSync(root)) walk(root, 0)
  return lines
}

/** Small root files that tell the model what the project is. */
export function projectManifests(root: string): string {
  const names = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile', 'README.md']
  const out: string[] = []
  for (const name of names) {
    const file = join(root, name)
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, 'utf8').slice(0, 2000)
      out.push(`### ${name}\n${text}`)
    } catch {
      log('debug', `codemap: cannot read ${name}`)
    }
  }
  return out.join('\n\n')
}

export function saveProjectMap(file: string, content: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content.trim() + '\n')
  return file
}