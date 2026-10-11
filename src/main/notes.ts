import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { NOTES_DIR } from './paths'
import { log } from './store'
import type { NoteInfo } from '../shared/types'

// User notes: plain Markdown files in ~/.alpha/notes. Folders are subdirectories,
// tags are inline #tag words in the text. The agent reads them freely but is
// allowed to change them only on a direct request (rule lives in AGENTS.md).

/** All note folders (subdirectories), including empty ones, recursively. */
export function notesFolders(): string[] {
  const out: string[] = []
  if (!existsSync(NOTES_DIR)) return out
  const walk = (dir: string, folder: string): void => {
    let raw: string[]
    try {
      raw = readdirSync(dir)
    } catch {
      return
    }
    for (const name of raw.sort()) {
      const full = join(dir, name)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      const rel = folder ? `${folder}/${name}` : name
      out.push(rel)
      walk(full, rel)
    }
  }
  walk(NOTES_DIR, '')
  return out
}

/** Moves a whole folder: fs rename, folders may nest. */
export function notesRenameFolder(folder: string, newName: string): string {
  const from = safePath(folder)
  const clean = String(newName ?? '').replace(/^\/+/, '').replace(/[\\:*?"<>|]/g, '-').trim()
  if (!clean) throw new Error('пустое имя папки')
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''
  const to = safePath(parent ? `${parent}/${clean}` : clean)
  if (!existsSync(from)) throw new Error('папка не найдена')
  if (existsSync(to)) throw new Error('папка с таким именем уже есть')
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
  return parent
}

export function notesList(): NoteInfo[] {
  const out: NoteInfo[] = []
  if (!existsSync(NOTES_DIR)) return out
  const walk = (dir: string, folder: string): void => {
    let raw: string[]
    try {
      raw = readdirSync(dir)
    } catch {
      return
    }
    for (const name of raw.sort()) {
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full, folder ? `${folder}/${name}` : name)
        continue
      }
      if (!name.toLowerCase().endsWith('.md')) continue
      let content = ''
      let mtime = 0
      try {
        content = readFileSync(full, 'utf8')
        mtime = statSync(full).mtimeMs
      } catch {
        // unreadable note, still list it
      }
      out.push({
        path: folder ? `${folder}/${name}` : name,
        name: name.slice(0, -3),
        folder,
        mtime,
        tags: [...new Set([...content.matchAll(/\B#([\wа-яё-]{2,30})/gi)].map((m) => m[1].toLowerCase()))]
      })
    }
  }
  walk(NOTES_DIR, '')
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Resolves a relative note path, rejecting escapes from ~/.alpha/notes. */
function safePath(rel: string): string {
  const full = resolve(NOTES_DIR, String(rel ?? ''))
  if (full !== NOTES_DIR && !full.startsWith(NOTES_DIR + '/')) throw new Error('путь вне ~/.alpha/notes')
  return full
}

export function notesRead(rel: string): string {
  const full = safePath(rel)
  return existsSync(full) ? readFileSync(full, 'utf8') : ''
}

export function notesSave(rel: string, content: string): void {
  const full = safePath(rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, String(content ?? ''))
}

export function notesMkdir(folder: string): void {
  const full = safePath(String(folder ?? '').trim())
  if (full !== NOTES_DIR) mkdirSync(full, { recursive: true })
}

/** Renames/moves a note: newRel may include folders (folders are created). */
export function notesRename(rel: string, newRel: string): string {
  const from = safePath(rel)
  const to = safePath(newRel)
  if (!existsSync(from)) throw new Error('заметка не найдена')
  if (!to.endsWith('.md')) throw new Error('имя должно кончаться .md')
  if (existsSync(to)) throw new Error('заметка с таким именем уже есть')
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, readFileSync(from))
  rmSync(from, { force: true })
  return String(rel).split('/').slice(0, -1).join('/')
}

export function notesDelete(rel: string): void {
  const full = safePath(rel)
  if (existsSync(full)) rmSync(full, { force: true })
}

export function notesImport(files: string[]): number {
  let count = 0
  for (const file of files) {
    try {
      const base = file.split(/[\\/]/).pop() ?? `note-${Date.now()}.md`
      let target = join(NOTES_DIR, base)
      // same name: suffix -2, -3… instead of overwriting
      for (let n = 2; existsSync(target); n++) {
        target = join(NOTES_DIR, base.replace(/\.md$/i, '') + `-${n}.md`)
      }
      writeFileSync(target, readFileSync(file))
      count++
    } catch (error) {
      log('warn', `notes import: ${String(error)}`)
    }
  }
  return count
}
