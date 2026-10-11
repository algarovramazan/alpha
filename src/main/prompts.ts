import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_DIR } from './paths'
import { log } from './store'

export interface PromptInfo {
  name: string
  path: string
  source: 'global' | 'project'
}

const GLOBAL_PROMPTS = join(AGENT_DIR, 'prompts')

function listDir(dir: string, source: 'global' | 'project'): PromptInfo[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name: name.replace(/\.md$/, ''), path: join(dir, name), source }))
  } catch (error) {
    log('warn', `prompts list: ${String(error)}`)
    return []
  }
}

export function listPrompts(projectPath?: string): PromptInfo[] {
  const project = projectPath ? listDir(join(projectPath, '.pi', 'prompts'), 'project') : []
  return [...listDir(GLOBAL_PROMPTS, 'global'), ...project].sort((a, b) => a.name.localeCompare(b.name))
}

function isAllowed(path: string, projectPath?: string): boolean {
  const allowed = [GLOBAL_PROMPTS, projectPath ? join(projectPath, '.pi', 'prompts') : '']
    .filter(Boolean)
    .map((root) => `${root}/`)
  return allowed.some((root) => path.startsWith(root)) && path.endsWith('.md')
}

export function readPrompt(path: string, projectPath?: string): string {
  if (!isAllowed(path, projectPath)) throw new Error('prompt path not allowed')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function savePrompt(path: string, content: string, projectPath?: string): void {
  if (!isAllowed(path, projectPath)) throw new Error('prompt path not allowed')
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

export function createPrompt(name: string, projectPath?: string): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  if (!safe) throw new Error('пустое имя шаблона')
  const dir = projectPath ? join(projectPath, '.pi', 'prompts') : GLOBAL_PROMPTS
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${safe}.md`)
  if (existsSync(path)) throw new Error(`шаблон уже есть: ${safe}`)
  writeFileSync(path, `---\ndescription: ${safe}\n---\n\n$ARGUMENTS\n`)
  return path
}

export function deletePrompt(path: string, projectPath?: string): void {
  if (!isAllowed(path, projectPath)) throw new Error('prompt path not allowed')
  if (existsSync(path) && statSync(path).isFile()) rmSync(path)
}