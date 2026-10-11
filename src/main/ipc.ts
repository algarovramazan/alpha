import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { AppState, Project, Settings } from '../shared/types'
import {
  activateCoreMods,
  hideListsFor,
  installMod,
  listMods,
  removeToolsFor,
  resolveAsk,
  themeCss,
  uiModSources
} from './mods'
import { usageModels, usageRange, usageToday } from './usage'
import { resolveApproval } from './approvals'
import {
  allModSettings,
  listRegisteredModSettings,
  setModSettingsValue
} from './mod-settings'
import { createPrompt, deletePrompt, listPrompts, readPrompt, savePrompt } from './prompts'
import {
  abortPrompt,
  activeCwd,
  applyPiSettings,
  applyToActiveSession,
  completeOnce,
  contextSnapshot,
  deleteChat,
  forkChat,
  forkChatAt,
  invalidateServices,
  isGitRepo,
  listChats,
  listModels,
  openChat,
  piVersion,
  reconcileSessions,
  renameChat,
  reloadResources,
  searchChats,
  sendPrompt,
  setApiKey,
  removeApiKey,
  testConnection,
  updatePi
} from './pi'
import type { ChatExtra, ModeId } from '../shared/types'
import { AGENT_DIR, ALPHA_DIR, AUTH_FILE, GLOBAL_AGENTS_MD, MODS_DIR, PROMPTS_DIR, SKILLS_DIR } from './paths'
import { listSkills, skillFileContent } from './skills'
import {
  getMemory,
  kbDelete,
  kbImport,
  kbList,
  kbNew,
  kbRead,
  kbSave,
  projectManifests,
  projectMapFileFor,
  projectTree,
  saveProjectMap,
  setMemory
} from './context'
import { listCheckpoints, reviewCommit, reviewRevert, reviewStatus } from './review'
import { chatMode, primeChatModes, setChatMode } from './modes'
import { clearChatExtra, loadChatsMeta, patchChatExtra } from './chats-meta'
import { spawnSync } from 'node:child_process'
import { termChar, termInterrupt, termKill, termStart, termSubmit, termWrite } from './term'
import { notesDelete, notesFolders, notesImport, notesList, notesMkdir, notesRead, notesRename, notesRenameFolder, notesSave } from './notes'
import {
  DEFAULT_SETTINGS,
  appVersion,
  loadProjects,
  loadSettings,
  log,
  saveProjects,
  saveSettings,
  setLogLevel,
  tailLog
} from './store'

const HOME = homedir()
const MCP_FILE = join(AGENT_DIR, 'mcp.json')
// Kept as a getter: registerIpc runs before the window exists.
let getWindowFn: () => BrowserWindow | null = () => null

function showOpen(options: OpenDialogOptions): ReturnType<typeof dialog.showOpenDialog> {
  const win = getWindowFn()
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function showSave(options: SaveDialogOptions): ReturnType<typeof dialog.showSaveDialog> {
  const win = getWindowFn()
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function currentProjectPath(projectId?: string): string {
  const projects = loadProjects()
  const project = projectId ? projects.find((p) => p.id === projectId) : projects[0]
  return project?.path ?? HOME
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  getWindowFn = getWindow
  const settings = (): Settings => loadSettings()

  // Restore per-chat modes (and legacy plan flags) after a restart.
  try {
    const meta = loadChatsMeta()
    primeChatModes(
      Object.values(meta).flatMap((perChat) =>
        Object.entries(perChat).map(([chatId, extra]) => ({
          chatId,
          mode: extra.mode as string | undefined,
          plan: extra.plan
        }))
      )
    )
  } catch {
    // broken meta file: every chat starts in the default mode
  }

  ipcMain.handle('alpha:app:state', async (): Promise<AppState> => {
    const s = settings()
    return {
      settings: s,
      projects: loadProjects(),
      appVersion: appVersion(),
      piVersion: await piVersion(),
      alphaDir: process.env.ALPHA_DIR ?? join(homedir(), '.alpha'),
      coreModErrors: []
    }
  })

  ipcMain.handle('alpha:app:title', (_e, title: string) => {
    getWindowFn()?.setTitle(typeof title === 'string' && title.length < 200 ? title : 'Alpha')
    return true
  })

  ipcMain.handle('alpha:ask:answer', (_e, payload: { id: string; value: string }) =>
    resolveAsk(String(payload?.id ?? ''), String(payload?.value ?? ''))
  )

  // ------------------------------------------------------------ projects
  ipcMain.handle('alpha:projects:add', async (): Promise<Project | null> => {
    const result = await showOpen({
      title: 'Открыть папку проекта',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    const projects = loadProjects()
    if (projects.some((p) => p.path === path)) return projects.find((p) => p.path === path)!
    const project: Project = { id: `p${Date.now().toString(36)}`, name: basename(path), path }
    saveProjects([...projects, project])
    return project
  })

  ipcMain.handle('alpha:projects:remove', (_e, projectId: string) => {
    saveProjects(loadProjects().filter((p) => p.id !== projectId))
    invalidateServices()
    return loadProjects()
  })

  // ------------------------------------------------------------ chats
  ipcMain.handle('alpha:chats:list', (_e, projectId: string) =>
    listChats(projectId, currentProjectPath(projectId))
  )
  ipcMain.handle('alpha:chats:new', (_e, projectId: string) =>
    openChat(projectId, currentProjectPath(projectId), undefined)
  )
  ipcMain.handle('alpha:chats:open', (_e, projectId: string, chatPath: string, cwd?: string) =>
    openChat(projectId, cwd || currentProjectPath(projectId), chatPath)
  )
  ipcMain.handle('alpha:chats:rename', (_e, projectId: string, chatId: string, name: string) =>
    renameChat(projectId, chatId, String(name ?? ''))
  )

  ipcMain.handle('alpha:approval:answer', (_e, payload: { id: string; allow: boolean; allowAll: boolean }) =>
    resolveApproval(String(payload?.id ?? ''), Boolean(payload?.allow), Boolean(payload?.allowAll))
  )

  ipcMain.handle('alpha:modSettings:all', () => allModSettings())
  ipcMain.handle('alpha:modSettings:set', (_e, modId: string, key: string, value: unknown) =>
    setModSettingsValue(String(modId), String(key), value)
  )
  ipcMain.handle('alpha:modSettings:registered', () => listRegisteredModSettings())

  const projectOf = (projectId?: string): string | undefined =>
    projectId && projectId !== 'home' ? currentProjectPath(projectId) : undefined

  ipcMain.handle('alpha:prompts:list', (_e, projectId?: string) => listPrompts(projectOf(projectId)))
  ipcMain.handle('alpha:prompts:get', (_e, path: string, projectId?: string) =>
    readPrompt(String(path), projectOf(projectId))
  )
  ipcMain.handle('alpha:prompts:save', (_e, path: string, content: string, projectId?: string) => {
    savePrompt(String(path), String(content ?? ''), projectOf(projectId))
    return true
  })
  ipcMain.handle('alpha:prompts:create', (_e, name: string) => {
    const path = createPrompt(String(name ?? ''))
    // make the new template visible to running sessions
    for (const cwd of [HOME, ...loadProjects().map((p) => p.path)]) {
      void reloadResources(cwd).catch(() => undefined)
    }
    return path
  })
  ipcMain.handle('alpha:prompts:delete', (_e, path: string, projectId?: string) => {
    deletePrompt(String(path), projectOf(projectId))
    for (const cwd of [HOME, ...loadProjects().map((p) => p.path)]) {
      void reloadResources(cwd).catch(() => undefined)
    }
    return true
  })
  ipcMain.handle('alpha:chats:delete', async (_e, projectId: string, chatId: string) => {
    await deleteChat(projectId, chatId)
    // drop pin/mode leftovers so nothing points at a removed session file
    clearChatExtra(String(projectId ?? 'home'), String(chatId ?? ''))
    return listChats(projectId, currentProjectPath(projectId))
  })
  ipcMain.handle('alpha:chats:fork', async (_e, projectId: string, chatRef: string) => {
    const newPath = await forkChat(projectId, currentProjectPath(projectId), chatRef)
    return openChat(projectId, currentProjectPath(projectId), newPath)
  })
  ipcMain.handle('alpha:chats:forkAt', (_e, projectId: string, chatRef: string, entryId: string) =>
    forkChatAt(projectId, currentProjectPath(projectId), chatRef, entryId)
  )
  ipcMain.handle('alpha:chats:search', (_e, projectId: string, query: string) =>
    searchChats(projectId, query)
  )

  // ------------------------------------------------------------ session
  ipcMain.handle('alpha:session:send', (_e, text: string, queued?: boolean, chatId?: string) =>
    sendPrompt(text, Boolean(queued), typeof chatId === 'string' && chatId ? chatId : undefined)
  )
  ipcMain.handle('alpha:session:abort', (_e, chatId?: string) =>
    abortPrompt(typeof chatId === 'string' && chatId ? chatId : undefined)
  )

  // ------------------------------------------------------------ modes
  ipcMain.handle('alpha:mode:get', (_e, chatId: string) =>
    chatMode(String(chatId ?? '')) ?? null
  )
  ipcMain.handle('alpha:mode:set', (_e, projectId: string, chatId: string, mode: string) => {
    const id = String(chatId ?? '')
    const valid = (['agent', 'plan', 'debug', 'assist', 'quick'] as string[]).includes(mode)
      ? (mode as ModeId)
      : 'agent'
    setChatMode(id, valid)
    // persist; `plan: false` clears the legacy flag from old builds
    patchChatExtra(String(projectId ?? 'home'), id, { mode: valid, plan: false })
    return valid
  })

  // ---------------------------------------------- memory and knowledge base
  ipcMain.handle('alpha:memory:get', (_e, projectId: string) => getMemory(String(projectId ?? 'home')))
  ipcMain.handle('alpha:memory:set', (_e, projectId: string, text: string) => {
    setMemory(String(projectId ?? 'home'), String(text ?? ''))
    return true
  })
  ipcMain.handle('alpha:kb:list', (_e, projectId: string) =>
    kbList(String(projectId ?? 'home'), currentProjectPath(projectId))
  )
  ipcMain.handle('alpha:kb:read', (_e, projectId: string, name: string) =>
    kbRead(String(projectId ?? 'home'), currentProjectPath(projectId), String(name ?? ''))
  )
  ipcMain.handle('alpha:kb:save', (_e, projectId: string, name: string, content: string) => {
    kbSave(String(projectId ?? 'home'), currentProjectPath(projectId), String(name ?? ''), String(content ?? ''))
    return true
  })
  ipcMain.handle('alpha:kb:new', (_e, projectId: string, name: string) =>
    kbNew(String(projectId ?? 'home'), currentProjectPath(projectId), String(name ?? 'note'))
  )
  ipcMain.handle('alpha:kb:delete', (_e, projectId: string, name: string) => {
    kbDelete(String(projectId ?? 'home'), currentProjectPath(projectId), String(name ?? ''))
    return true
  })
  ipcMain.handle('alpha:kb:add', async (_e, projectId: string) => {
    const result = await showOpen({
      title: 'Добавить в базу знаний',
      properties: ['openFile'],
      filters: [{ name: 'text', extensions: ['md', 'txt'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return kbImport(String(projectId ?? 'home'), currentProjectPath(projectId), result.filePaths[0])
  })

  // --------------------------------------------------------- context detail
  ipcMain.handle('alpha:context:detail', (_e, projectId: string, chatId?: string) => {
    const cwd = currentProjectPath(projectId)
    const snap = contextSnapshot(typeof chatId === 'string' && chatId ? chatId : undefined)
    const kbBytes = kbList(String(projectId ?? 'home'), cwd)
      .filter((item) => !item.map)
      .reduce((sum, item) => sum + item.size, 0)
    const mapPath = projectMapFileFor(String(projectId ?? 'home'), cwd)
    const mapSize = existsSync(mapPath) ? statSync(mapPath).size : 0
    const globalAgents = existsSync(GLOBAL_AGENTS_MD) ? statSync(GLOBAL_AGENTS_MD).size : 0
    const projectAgents = existsSync(join(cwd, 'AGENTS.md')) ? statSync(join(cwd, 'AGENTS.md')).size : 0
    const toks = (bytes: number): number => Math.round(bytes / 4)
    const staticTokens =
      toks(globalAgents + projectAgents) + toks(getMemory(String(projectId ?? 'home')).length) + toks(kbBytes) + toks(mapSize)
    const total = snap?.total ?? 0
    const history = Math.max(0, total - (snap?.system ?? 0) - staticTokens)
    return {
      total,
      window: snap?.window ?? 0,
      percent: snap?.window ? Math.round((total / snap.window) * 100) : 0,
      injected: snap?.injected ?? [],
      pending: snap?.pending ?? false,
      parts: [
        { key: 'system', label: 'Системный промпт', tokens: snap?.system ?? 0 },
        { key: 'agents', label: 'AGENTS.md', tokens: toks(globalAgents + projectAgents) },
        { key: 'memory', label: 'Память проекта', tokens: toks(getMemory(String(projectId ?? 'home')).length) },
        { key: 'knowledge', label: 'База знаний', tokens: toks(kbBytes) },
        { key: 'map', label: 'PROJECT.md', tokens: toks(mapSize) },
        { key: 'history', label: 'История и инструменты', tokens: history }
      ]
    }
  })

  // ------------------------------------------------------- codebase map
  ipcMain.handle('alpha:codemap:build', async (_e, projectId: string) => {
    const cwd = currentProjectPath(projectId)
    const tree = projectTree(cwd).join('\n')
    const manifests = projectManifests(cwd)
    const prompt =
      'Create a PROJECT.md codebase map for this repository. Sections: what the project is, ' +
      'directory layout (one line per top-level area), key entry points, build/test commands, conventions. ' +
      'Be factual — only what the listing and manifests show. Answer with the raw Markdown file content, no code fence.\n\n' +
      `File tree:\n${tree}\n\n${manifests}`
    const text = await completeOnce(cwd, 'You write concise project reference files in Markdown.', prompt)
    const file = saveProjectMap(projectMapFileFor(String(projectId ?? 'home'), cwd), text)
    return file
  })

  // ------------------------------------------------------------- review
  ipcMain.handle('alpha:review:status', (_e, projectId: string) =>
    reviewStatus(String(projectId ?? 'home'), currentProjectPath(projectId))
  )
  ipcMain.handle('alpha:review:revert', (_e, projectId: string, path: string) =>
    reviewRevert(String(projectId ?? 'home'), currentProjectPath(projectId), String(path ?? ''))
  )
  ipcMain.handle('alpha:review:commit', (_e, projectId: string, message: string) =>
    reviewCommit(currentProjectPath(projectId), String(message ?? ''))
  )
  ipcMain.handle('alpha:checkpoint:list', (_e, chatId: string) => listCheckpoints(String(chatId ?? '')))

  // ------------------------------------------------------------ terminal
  ipcMain.handle('alpha:term:start', (_e, projectId: string) => termStart(currentProjectPath(projectId)))
  ipcMain.handle('alpha:term:write', (_e, command: string) => termWrite(String(command ?? '')))
  ipcMain.handle('alpha:term:char', (_e, ch: string) => {
    termChar(String(ch ?? '').slice(0, 8))
    return true
  })
  ipcMain.handle('alpha:term:submit', (_e, line: string) => termSubmit(String(line ?? '')))
  ipcMain.handle('alpha:term:interrupt', () => {
    termInterrupt()
    return true
  })
  ipcMain.handle('alpha:term:kill', () => {
    termKill()
    return true
  })

  // ------------------------------------------------------------ ai (mods)
  ipcMain.handle('alpha:ai:complete', (_e, payload: { system?: string; prompt: string }) => {
    const cwd = activeCwd() ?? currentProjectPath(undefined)
    return completeOnce(cwd, String(payload?.system ?? ''), String(payload?.prompt ?? ''))
  })

  // ------------------------------------------------------------ settings
  ipcMain.handle('alpha:settings:get', () => settings())
  ipcMain.handle('alpha:settings:set', async (_e, patch: Partial<Settings>) => {
    const next = { ...settings(), ...patch }
    saveSettings(next)
    setLogLevel(next.logLevel)
    // pi reconfiguration is the slow part; appearance-only patches stay instant.
    const PI_KEYS = [
      'defaultProvider',
      'defaultModel',
      'thinkingLevel',
      'mode',
      'disabledSkills',
      'extraSkillPaths',
      'maxSessions',
      'subagentConcurrency',
      'dailyTokenLimit',
      'monthlyCostLimit'
    ]
    if (Object.keys(patch).some((key) => PI_KEYS.includes(key))) {
      await applyPiSettings(next)
    }
    if (Object.keys(patch).includes('maxSessions')) reconcileSessions()
    // Model and thinking level must move the chat that is open right now,
    // not only the next session.
    if (Object.keys(patch).some((key) => ['defaultProvider', 'defaultModel', 'thinkingLevel', 'quickThinking'].includes(key))) {
      await applyToActiveSession(next)
    }
    return next
  })
  ipcMain.handle('alpha:settings:reset', async () => {
    saveSettings({ ...DEFAULT_SETTINGS })
    setLogLevel(DEFAULT_SETTINGS.logLevel)
    await applyPiSettings(DEFAULT_SETTINGS)
    return DEFAULT_SETTINGS
  })
  ipcMain.handle('alpha:keys:reset', () => {
    if (existsSync(AUTH_FILE)) rmSync(AUTH_FILE)
    invalidateServices()
    return true
  })

  // ------------------------------------------------------------ skills
  ipcMain.handle('alpha:skills:list', (_e, projectId?: string) =>
    listSkills(projectId ? currentProjectPath(projectId) : undefined, settings().disabledSkills, settings().extraSkillPaths)
  )
  ipcMain.handle('alpha:skills:file', (_e, skillPath: string) => skillFileContent(skillPath))
  ipcMain.handle('alpha:skills:setEnabled', async (_e, name: string, enabled: boolean) => {
    const s = settings()
    const disabled = new Set(s.disabledSkills)
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    const next = { ...s, disabledSkills: [...disabled] }
    saveSettings(next)
    await applyPiSettings(next)
    invalidateServices()
    for (const cwd of [HOME, ...loadProjects().map((p) => p.path)]) await reloadResources(cwd)
    return next
  })
  ipcMain.handle('alpha:skills:addPath', async () => {
    const result = await showOpen({ properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return settings().extraSkillPaths
    const next = { ...settings(), extraSkillPaths: [...settings().extraSkillPaths, result.filePaths[0]] }
    saveSettings(next)
    invalidateServices()
    return next.extraSkillPaths
  })
  ipcMain.handle('alpha:skills:openDir', () => {
    mkdirSync(SKILLS_DIR, { recursive: true })
    shell.openPath(SKILLS_DIR)
  })

  // ------------------------------------------------------------ AGENTS.md
  ipcMain.handle('alpha:agentsmd:get', (_e, scope: 'global' | 'project', projectId?: string) => {
    const file = scope === 'global' ? GLOBAL_AGENTS_MD : join(currentProjectPath(projectId), 'AGENTS.md')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  })
  ipcMain.handle('alpha:agentsmd:set', (_e, scope: 'global' | 'project', projectId: string | undefined, text: string) => {
    const file = scope === 'global' ? GLOBAL_AGENTS_MD : join(currentProjectPath(projectId), 'AGENTS.md')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return true
  })

  // ------------------------------------------------------------ mods
  ipcMain.handle('alpha:mods:list', () => listMods())
  ipcMain.handle('alpha:mods:setEnabled', (_e, id: string, enabled: boolean) => {
    const s = settings()
    const disabled = new Set(s.disabledMods)
    if (enabled) disabled.delete(id)
    else {
      disabled.add(id)
      removeToolsFor(id)
      hideListsFor(id)
    }
    const next = { ...s, disabledMods: [...disabled] }
    saveSettings(next)
    invalidateServices()
    return listMods()
  })
  ipcMain.handle('alpha:mods:themeCss', (_e, id: string) => themeCss(id))
  ipcMain.handle('alpha:mods:uiSources', () => uiModSources())
  ipcMain.handle('alpha:mods:install', async () => {
    const result = await showOpen({
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'mod', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, message: 'cancelled' }
    return installMod(result.filePaths[0])
  })
  ipcMain.handle('alpha:mods:openDir', () => {
    mkdirSync(MODS_DIR, { recursive: true })
    shell.openPath(MODS_DIR)
  })

  // ------------------------------------------------------------ models
  ipcMain.handle('alpha:models:list', (_e, projectId?: string) =>
    listModels(currentProjectPath(projectId))
  )
  ipcMain.handle('alpha:models:setKey', async (_e, provider: string, key: string, projectId?: string) => {
    await setApiKey(currentProjectPath(projectId), provider, key)
    // keys must not stay world-readable on disk
    try {
      const { chmodSync } = await import('node:fs')
      chmodSync(AUTH_FILE, 0o600)
    } catch {
      // file may not exist yet
    }
    return true
  })
  ipcMain.handle('alpha:models:test', (_e, projectId?: string) => testConnection(currentProjectPath(projectId)))
  ipcMain.handle('alpha:models:removeKey', async (_e, provider: string, projectId?: string) => {
    await removeApiKey(currentProjectPath(projectId), provider)
    return true
  })

  // ------------------------------------------------------------ pi
  ipcMain.handle('alpha:pi:update', () => {
    updatePi()
    return true
  })

  // ------------------------------------------------------------ logs / backup
  ipcMain.handle('alpha:logs:tail', (_e, lines?: number) => tailLog(lines ?? 200))
  ipcMain.handle('alpha:diagnostics:copy', async () => {
    const s = settings()
    const lines = [
      `alpha ${appVersion()}`,
      `pi ${await piVersion()}`,
      `os ${process.platform} ${process.version}`,
      `alphaDir ${process.env.ALPHA_DIR ?? join(homedir(), '.alpha')}`,
      `theme ${s.theme} accent ${s.accent} font ${s.fontSize}px`,
      `model ${s.defaultProvider}/${s.defaultModel} thinking ${s.thinkingLevel}`,
      '',
      tailLog(100)
    ]
    return lines.join('\n')
  })
  // ------------------------------------------- profile export / import (zip-less)
  ipcMain.handle('alpha:backup:export', async () => {
    const result = await showSave({
      defaultPath: 'alpha-profile.json',
      filters: [{ name: 'json', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return 'Отменено'
    const prompts: Record<string, string> = {}
    if (existsSync(PROMPTS_DIR)) {
      for (const file of readdirSync(PROMPTS_DIR)) {
        if (!/\.(md|txt)$/i.test(file)) continue
        try {
          prompts[file] = readFileSync(join(PROMPTS_DIR, file), 'utf8')
        } catch {
          // unreadable template, skip
        }
      }
    }
    const mods: Record<string, Record<string, string>> = {}
    if (existsSync(MODS_DIR)) {
      for (const dir of readdirSync(MODS_DIR)) {
        const full = join(MODS_DIR, dir)
        try {
          if (!statSync(full).isDirectory()) continue
        } catch {
          continue
        }
        const files: Record<string, string> = {}
        for (const name of ['mod.json', 'index.js', 'theme.css']) {
          if (!existsSync(join(full, name))) continue
          try {
            files[name] = readFileSync(join(full, name), 'utf8')
          } catch {
            // unreadable mod file, skip
          }
        }
        if (files['mod.json']) mods[dir] = files
      }
    }
    const projects = loadProjects()
    const data = {
      alpha: appVersion(),
      exportedAt: new Date().toISOString(),
      settings: loadSettings(),
      projects,
      agentsMd: existsSync(GLOBAL_AGENTS_MD) ? readFileSync(GLOBAL_AGENTS_MD, 'utf8') : '',
      prompts,
      mods
    }
    writeFileSync(result.filePath, JSON.stringify(data, null, 2))
    return `Профиль сохранён: ${projects.length} проектов, ${Object.keys(prompts).length} шаблонов, ${Object.keys(mods).length} модов`
  })
  ipcMain.handle('alpha:backup:import', async () => {
    const result = await showOpen({
      properties: ['openFile'],
      filters: [{ name: 'json', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return 'Отменено'
    try {
      const data = JSON.parse(readFileSync(result.filePaths[0], 'utf8')) as {
        settings?: Settings
        projects?: Project[]
        agentsMd?: string
        prompts?: Record<string, string>
        mods?: Record<string, Record<string, string>>
      }
      if (data.settings) saveSettings({ ...DEFAULT_SETTINGS, ...data.settings })
      if (Array.isArray(data.projects)) saveProjects(data.projects)
      if (typeof data.agentsMd === 'string' && data.agentsMd) {
        mkdirSync(dirname(GLOBAL_AGENTS_MD), { recursive: true })
        writeFileSync(GLOBAL_AGENTS_MD, data.agentsMd)
      }
      let promptCount = 0
      for (const [name, content] of Object.entries(data.prompts ?? {})) {
        if (!/^[\w.\- ]+\.(md|txt)$/i.test(name)) continue
        mkdirSync(PROMPTS_DIR, { recursive: true })
        writeFileSync(join(PROMPTS_DIR, name), content)
        promptCount++
      }
      let modCount = 0
      for (const [id, files] of Object.entries(data.mods ?? {})) {
        if (!/^[\w-]+$/.test(id) || !files['mod.json']) continue
        const dir = join(MODS_DIR, id)
        mkdirSync(dir, { recursive: true })
        for (const [name, content] of Object.entries(files)) {
          if (!/^[\w.\-]+$/.test(name)) continue
          writeFileSync(join(dir, name), content)
        }
        modCount++
      }
      setLogLevel(loadSettings().logLevel)
      await applyPiSettings(loadSettings())
      invalidateServices()
      return `Профиль импортирован: шаблонов ${promptCount}, модов ${modCount}`
    } catch (error) {
      log('error', `profile import: ${String(error)}`)
      return `Ошибка импорта: ${error instanceof Error ? error.message : String(error)}`
    }
  })
  ipcMain.handle('alpha:shell:open', (_e, path: string) => {
    shell.showItemInFolder(path)
    return true
  })
  ipcMain.handle('alpha:shell:openPath', async (_e, path: string) => {
    const error = await shell.openPath(String(path))
    return error === ''
  })
  ipcMain.handle('alpha:file:read', (_e, path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : ''))
  ipcMain.handle('alpha:file:write', (_e, path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return true
  })
  ipcMain.handle('alpha:file:save', async (_e, options: { defaultName: string; content: string }) => {
    const defaultName = String(options?.defaultName ?? 'alpha-export.md')
    const ext = (defaultName.split('.').pop() || 'md').toLowerCase()
    const result = await showSave({
      defaultPath: defaultName,
      filters: [{ name: ext, extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, String(options?.content ?? ''))
    return result.filePath
  })
  // Second left panel: one directory level of the project tree, lazy by design.
  ipcMain.handle('alpha:file:tree', (_e, projectId: string, dir?: string) => {
    const root = dir ? String(dir) : projectId && projectId !== 'home' ? currentProjectPath(projectId) : HOME
    const empty = { root, entries: [] as { name: string; path: string; dir: boolean }[] }
    if (!root || !existsSync(root)) return empty
    let raw: string[]
    try {
      raw = readdirSync(root)
    } catch {
      return empty
    }
    const entries = raw
      .map((name) => {
        let isDir = false
        try {
          isDir = statSync(join(root, name)).isDirectory()
        } catch {
          // broken symlink: list it as a file
        }
        return { name, path: join(root, name), dir: isDir }
      })
      .sort((a, b) =>
        a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1
      )
      .slice(0, 600)
    return { root, entries }
  })
  ipcMain.handle('alpha:win:control', (_e, action: string) => {
    const win = getWindowFn()
    if (!win) return false
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
    else if (action === 'close') win.close()
    return true
  })
  ipcMain.handle('alpha:usage:today', () => usageToday())
  ipcMain.handle('alpha:usage:range', (_e, days?: number) =>
    usageRange(Math.min(Math.max(Number(days) || 14, 1), 90))
  )
  ipcMain.handle('alpha:usage:models', (_e, days?: number) =>
    usageModels(Math.min(Math.max(Number(days) || 14, 1), 90))
  )

  // ------------------------------------------------- files for @-mentions
  ipcMain.handle('alpha:files:all', (_e, projectId: string) => {
    const root = projectId && projectId !== 'home' ? currentProjectPath(projectId) : HOME
    const out: string[] = []
    const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', '__pycache__', '.venv', 'venv', 'target'])
    const walk = (dir: string, depth: number): void => {
      if (out.length >= 2000 || depth > 6) return
      let raw: string[]
      try {
        raw = readdirSync(dir)
      } catch {
        return
      }
      for (const name of raw) {
        if (out.length >= 2000) return
        const full = join(dir, name)
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          if (name.startsWith('.') || SKIP.has(name)) continue
          out.push(relative(root, full).split(sep).join('/'))
          walk(full, depth + 1)
        } else {
          out.push(relative(root, full).split(sep).join('/'))
        }
      }
    }
    if (existsSync(root)) walk(root, 0)
    return out
  })

  // ------------------------------------------------------ checkpoints
  const checkpointDirFor = (chatId: string): string => join(ALPHA_DIR, 'checkpoints', String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_'))

  ipcMain.handle('alpha:checkpoint:create', (_e, projectId: string, chatId: string) => {
    const cwd = currentProjectPath(projectId)
    if (!isGitRepo(cwd)) return null
    const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-uall'], { encoding: 'utf8' })
    if (status.status !== 0) return null
    // Nothing dirty: a checkpoint would be a no-op restore, skip the copy.
    if (!String(status.stdout).trim()) return null
    const files: { path: string; b64: string }[] = []
    for (const line of status.stdout.split('\n')) {
      if (!line.trim()) continue
      const path = line.slice(3).replace(/^"|"$/g, '')
      const full = join(cwd, path)
      try {
        if (!statSync(full).isFile() || statSync(full).size > 1_000_000 || files.length >= 500) continue
        files.push({ path, b64: readFileSync(full).toString('base64') })
      } catch {
        // deleted between status and read: nothing to back up
      }
    }
    const id = `ck${Date.now().toString(36)}`
    const dir = join(checkpointDirFor(chatId), id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ts: Date.now(), files }))
    // keep the last 15 checkpoints per chat
    try {
      const parent = checkpointDirFor(chatId)
      const all = readdirSync(parent)
        .map((n) => ({ n, m: statSync(join(parent, n)).mtimeMs }))
        .sort((a, b) => a.m - b.m)
      while (all.length > 15) {
        const old = all.shift()!
        rmSync(join(parent, old.n), { recursive: true, force: true })
      }
    } catch {
      // prune is best effort
    }
    return id
  })

  ipcMain.handle('alpha:checkpoint:restore', (_e, projectId: string, chatId: string, id: string) => {
    const cwd = currentProjectPath(projectId)
    const manifestPath = join(checkpointDirFor(chatId), String(id), 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error('checkpoint not found')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; b64: string }[] }
    const known = new Set(manifest.files.map((f) => f.path))
    for (const f of manifest.files) {
      const full = join(cwd, f.path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, Buffer.from(f.b64, 'base64'))
    }
    let reverted = 0
    const status = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '-uall'], { encoding: 'utf8' })
    if (status.status === 0) {
      for (const line of status.stdout.split('\n')) {
        if (!line.trim()) continue
        const st = line.slice(0, 2)
        const path = line.slice(3).replace(/^"|"$/g, '')
        if (known.has(path)) continue
        if (st === '??') {
          try {
            unlinkSync(join(cwd, path))
            reverted++
          } catch {
            // already gone
          }
        } else {
          spawnSync('git', ['-C', cwd, 'checkout', 'HEAD', '--', path])
          reverted++
        }
      }
    }
    return `${known.size} файлов восстановлено, отменено новых правок: ${reverted}`
  })

  // ------------------------------------------------- chats meta (pin)
  ipcMain.handle('alpha:chats:meta:get', (_e, projectId: string) => loadChatsMeta()[projectId] ?? {})
  ipcMain.handle('alpha:chats:meta:set', (_e, projectId: string, chatId: string, patch: ChatExtra) => {
    const perProject = patchChatExtra(String(projectId ?? ''), String(chatId ?? ''), patch)
    return perProject
  })

  // ------------------------------------------------- projects archive
  ipcMain.handle('alpha:projects:archive', (_e, projectId: string, archived: boolean) => {
    saveProjects(loadProjects().map((p) => (p.id === projectId ? { ...p, archived } : p)))
    return loadProjects()
  })

  // ------------------------------------------------- MCP servers panel
  ipcMain.handle('alpha:mcp:list', () => {
    if (!existsSync(MCP_FILE)) return { mcpServers: {} }
    try {
      const parsed = JSON.parse(readFileSync(MCP_FILE, 'utf8')) as Record<string, unknown>
      return parsed && typeof parsed === 'object' && parsed.mcpServers ? parsed : { mcpServers: {} }
    } catch {
      return { mcpServers: {} }
    }
  })
  // ------------------------------------------------------------ notes
  ipcMain.handle('alpha:notes:list', () => notesList())
  ipcMain.handle('alpha:notes:read', (_e, rel: string) => notesRead(String(rel ?? '')))
  ipcMain.handle('alpha:notes:save', (_e, rel: string, content: string) => {
    notesSave(String(rel ?? ''), String(content ?? ''))
    return true
  })
  ipcMain.handle('alpha:notes:mkdir', (_e, folder: string) => {
    notesMkdir(String(folder ?? ''))
    return true
  })
  ipcMain.handle('alpha:notes:delete', (_e, rel: string) => {
    notesDelete(String(rel ?? ''))
    return true
  })
  ipcMain.handle('alpha:notes:rename', (_e, rel: string, newRel: string) =>
    notesRename(String(rel ?? ''), String(newRel ?? ''))
  )
  ipcMain.handle('alpha:notes:folders', () => notesFolders())
  ipcMain.handle('alpha:notes:folderRename', (_e, folder: string, newName: string) =>
    notesRenameFolder(String(folder ?? ''), String(newName ?? ''))
  )
  ipcMain.handle('alpha:notes:import', async () => {
    const result = await showOpen({
      title: 'Импорт заметок',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'markdown', extensions: ['md', 'markdown', 'txt'] }]
    })
    if (result.canceled || !result.filePaths.length) return 0
    return notesImport(result.filePaths)
  })

  ipcMain.handle('alpha:mcp:save', async (_e, text: string) => {
    const parsed = JSON.parse(String(text ?? '{}')) as { mcpServers?: unknown }
    if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      throw new Error('JSON должен содержать объект mcpServers')
    }
    writeFileSync(MCP_FILE, JSON.stringify(parsed, null, 2))
    // running sessions must pick the servers up on their next turn
    invalidateServices()
    for (const cwd of [homedir(), ...loadProjects().map((p) => p.path)]) {
      await reloadResources(cwd).catch(() => undefined)
    }
    return true
  })
}

export async function startMods(): Promise<void> {
  const errors = await activateCoreMods()
  if (errors.length) log('warn', `core mods failed: ${errors.map((e) => e.id).join(', ')}`)
}