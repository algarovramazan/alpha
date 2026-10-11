import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillInfo } from '../shared/types'
import { SKILLS_DIR } from './paths'

function readFrontmatter(file: string): { name: string; description: string } {
  let name = ''
  let description = ''
  try {
    const raw = readFileSync(file, 'utf8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (match) {
      const nameMatch = match[1].match(/^name:\s*(.+)$/m)
      const descMatch = match[1].match(/^description:\s*(.+)$/m)
      if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
      if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // broken SKILL.md still lists as a skill with empty fields
  }
  return { name: name || basenameWithoutExt(file), description }
}

function basenameWithoutExt(file: string): string {
  return file.split('/').slice(-2)[0] ?? file
}

function scanSkills(dir: string, source: 'global' | 'project', disabled: Set<string>): SkillInfo[] {
  if (!existsSync(dir)) return []
  const out: SkillInfo[] = []
  for (const entry of readdirSync(dir)) {
    const skillFile = join(dir, entry, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const { name, description } = readFrontmatter(skillFile)
    const id = `${source}:${name}`
    out.push({
      name,
      description,
      path: join(dir, entry),
      source,
      enabled: !disabled.has(id) && !disabled.has(name)
    })
  }
  return out
}

/** Lists skills from ~/.alpha/skills and <project>/.pi/skills. */
export function listSkills(projectPath: string | undefined, disabled: string[], extraPaths: string[]): SkillInfo[] {
  const disabledSet = new Set(disabled)
  const global = scanSkills(SKILLS_DIR, 'global', disabledSet)
  const project = projectPath ? scanSkills(join(projectPath, '.pi', 'skills'), 'project', disabledSet) : []
  const extra: SkillInfo[] = []
  for (const p of extraPaths) {
    // extra paths may point at a skill itself or at a folder of skills
    if (existsSync(join(p, 'SKILL.md'))) {
      const { name, description } = readFrontmatter(join(p, 'SKILL.md'))
      extra.push({ name, description, path: p, source: 'global', enabled: !disabledSet.has(name) })
    } else {
      extra.push(...scanSkills(p, 'global', disabledSet))
    }
  }
  return [...global, ...extra, ...project].sort((a, b) => a.name.localeCompare(b.name))
}

export function skillFileContent(skillPath: string): string {
  const file = join(skillPath, 'SKILL.md')
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file, 'utf8') : ''
}