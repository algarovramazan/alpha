import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AlphaEvent,
  AppState,
  ChatMeta,
  ContextUsageUI,
  ModeId,
  ModelInfo,
  PanelId,
  Project,
  SessionPhase,
  Settings,
  SkillInfo,
  ThinkingLevel,
  UIMessage
} from '@shared/types'
import { PANEL_IDS } from '@shared/types'
import { LIGHT_THEMES } from '@shared/types'
import { isFreeModel } from '@shared/types'
import { invoke } from './api'
import ChatView, { Composer, reduce, type ComposerApi, type StackItem } from './components/ChatView'
import DropSelect, { type DropOption } from './components/DropSelect'
import FileTree from './components/FileTree'
import FileView from './components/FileView'
import Inspector from './components/Inspector'
import PlanBar from './components/PlanBar'
import PanelRail, { type RailItem } from './components/PanelRail'
import ModeBanner from './components/ModeBanner'
import ModeSelect from './components/ModeSelect'
import Sidebar from './components/Sidebar'
import { Icon } from './Icon'
import { setLang, t } from './i18n'
import { renderMarkdown, warmMarkdown } from './markdown'
import { getRegistry, loadModSettings, loadUiMods, setModSettings, subscribeRegistry, emitModEvent } from './modapi'

// Heavy sections load on demand (code splitting, item 7).
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const Preview = lazy(() => import('./components/Preview'))
// Heavy views load on demand: the first paint ships only the chat.
const NotesView = lazy(() => import('./components/NotesView'))
const ReviewView = lazy(() => import('./components/ReviewView'))
const TerminalView = lazy(() => import('./components/TerminalView'))

interface CoreList {
  title: string
  items: { text: string; status: string }[]
}

/** Task lists are per chat: a key like 'a-…' or 'home' for the empty state. */
type ListsByChat = Record<string, Record<string, CoreList>>

interface AskRequest {
  id: string
  question: string
  options: string[]
}

interface ApprovalRequest {
  id: string
  tool: string
  summary: string
}

const ICON_SCALE: Record<string, string> = { small: '1', medium: '1.15', large: '1.45', xlarge: '1.8', xxlarge: '2.2' }

const UI_FONTS: Record<string, string> = {
  system: `-apple-system, 'SF Pro Display', system-ui, 'Inter', 'Segoe UI', sans-serif`,
  Inter: `'Inter', -apple-system, system-ui, sans-serif`,
  Manrope: `'Manrope', -apple-system, system-ui, sans-serif`,
  Rubik: `'Rubik', -apple-system, system-ui, sans-serif`
}

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Icons of the built-in panels in the rail. */
const PANEL_ICON: Record<PanelId, string> = { projects: 'project', files: 'folder', inspector: 'chart' }

/** Which column a built-in panel lives in: left unless the user moved it right. */
function sideOfPanel(settings: Settings | null, id: PanelId): 'left' | 'right' {
  return settings?.panelSides?.[id] === 'right' ? 'right' : 'left'
}

function resolveMode(settings: Settings): 'dark' | 'light' {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  if (settings.theme === 'system') return prefersDark ? 'dark' : 'light'
  return LIGHT_THEMES.includes(settings.theme) ? 'light' : 'dark'
}

function applyTheme(settings: Settings): void {
  const root = document.documentElement
  const mode = resolveMode(settings)
  // A mod theme owns the tokens: 'mod' matches neither the light nor the dark
  // attribute block, so the injected :root rules of the mod win by order.
  const theme = settings.activeThemeMod ? 'mod' : settings.theme === 'system' ? mode : settings.theme
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-density', settings.density)
  // The accent is an inline override: while a mod theme is active its own
  // accent must win, so the inline value is removed.
  if (settings.activeThemeMod) root.style.removeProperty('--accent')
  else root.style.setProperty('--accent', settings.accent)
  // Base font size: html { font-size: var(--fs) } scales every rem-based size.
  root.style.setProperty('--fs', `${settings.fontSize}px`)
  root.style.setProperty('--icon-scale', ICON_SCALE[settings.iconSize] ?? ICON_SCALE.medium)
  root.style.setProperty('--font-ui', UI_FONTS[settings.uiFont] ?? UI_FONTS.system)
  root.style.setProperty('--font-code', `'${settings.codeFont}', 'JetBrains Mono', ui-monospace, monospace`)
  root.style.colorScheme = mode
}

function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  const key = event.key
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return ''
  parts.push(key.length === 1 ? key.toUpperCase() : key)
  return parts.join('+')
}

interface Command {
  id: string
  title: string
  hint?: string
  icon?: string
  run: () => void
}

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProject] = useState('home')
  const [chats, setChats] = useState<ChatMeta[]>([])
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [status, setStatus] = useState<'idle' | 'working' | 'waiting' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [activeChat, setActiveChat] = useState<{ id: string; path: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [piLog, setPiLog] = useState('')
  const [themeCss, setThemeCss] = useState('')
  const [registryVersion, setRegistryVersion] = useState(0)
  const [ask, setAsk] = useState<AskRequest | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [mode, setMode] = useState<'dark' | 'light'>('dark')
  const [view, setView] = useState<'chat' | 'preview' | 'term' | 'file' | 'notes' | 'review'>('chat')
  // Multi-session state: phase of every chat, tracked from the event stream.
  const [phases, setPhases] = useState<Record<string, SessionPhase>>({})
  const [runMode, setRunMode] = useState<ModeId>('agent')
  const [openFile, setOpenFile] = useState<{ path: string; name: string } | null>(null)
  const [termBuf, setTermBuf] = useState('')
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  // Prompt stack per chat: queued prompts survive switching chats and are
  // released when their own chat settles.
  const [stacks, setStacks] = useState<Record<string, StackItem[]>>({})
  const [ctxUsage, setCtxUsage] = useState<ContextUsageUI | null>(null)
  // Task lists belong to the chat that produced them.
  const [listsByChat, setListsByChat] = useState<ListsByChat>({})
  // Quick chat settings (model, thinking, palette, settings) behind the ☰ button.
  const [quickOpen, setQuickOpen] = useState(false)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [seed, setSeed] = useState<{ text: string; stamp: number } | null>(null)
  // Slash menu sources: pi templates, skills and mod commands for this project.
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [promptTemplates, setPromptTemplates] = useState<{ name: string; path: string }[]>([])

  const activeChatRef = useRef<string | null>(null)
  activeChatRef.current = activeChat?.id ?? null
  const stack: StackItem[] = (activeChat?.id ? stacks[activeChat.id] : undefined) ?? []
  const activeProjectRef = useRef(activeProject)
  activeProjectRef.current = activeProject
  const settingsRef = useRef<Settings | null>(null)
  settingsRef.current = settings
  const chatsRef = useRef<ChatMeta[]>([])
  chatsRef.current = chats
  const messagesRef = useRef<UIMessage[]>([])
  messagesRef.current = messages
  const stackRef = useRef<StackItem[]>([])
  stackRef.current = stack
  const phasesRef = useRef<Record<string, SessionPhase>>({})
  phasesRef.current = phases
  /** Feeds of background chats: kept warm so focusing one loses no text. */
  const bgRef = useRef<Record<string, UIMessage[]>>({})
  // one AI title per chat, ever
  const titledChats = useRef<Set<string>>(new Set())
  // The composer hands its draft to mod actions (prompt improver and friends).
  const composerApi = useRef<ComposerApi>({ text: '', replace: () => {} })
  // Terminal output is buffered and flushed on a timer, like streamed text.
  const termRef = useRef('')
  const termTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Token deltas are buffered and flushed every 40ms instead of one IPC and
  // one re-render per token (streaming item 4).
  const pendingText = useRef('')
  const pendingThinking = useRef('')
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Late binding: the event subscription is set up before sendReal exists.
  const sendRealRef = useRef<(text: string) => void>(() => {})

  const flushDeltas = useCallback(() => {
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    const text = pendingText.current
    const thinking = pendingThinking.current
    if (!text && !thinking) return
    pendingText.current = ''
    pendingThinking.current = ''
    setMessages((current) => {
      let next = current
      if (text) next = reduce(next, { type: 'text', delta: text })
      if (thinking) next = reduce(next, { type: 'thinking', delta: thinking })
      return next
    })
  }, [])

  const scheduleFlush = (): void => {
    if (flushTimer.current !== null) return
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null
      flushDeltas()
    }, 40)
  }

  const resetDeltas = useCallback(() => {
    pendingText.current = ''
    pendingThinking.current = ''
    if (flushTimer.current !== null) {
      clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
  }, [])

  const scheduleTermFlush = useCallback(() => {
    if (termTimer.current !== null) return
    termTimer.current = setTimeout(() => {
      termTimer.current = null
      setTermBuf(termRef.current)
    }, 90)
  }, [])

  const refreshChats = useCallback(async () => {
    setChats(await invoke<ChatMeta[]>('chats:list', activeProject))
  }, [activeProject])

  const showToast = useCallback((text: string) => {
    setToast(text)
    setTimeout(() => setToast(''), 3000)
  }, [])

  // Stable handlers so the memoized message rows never re-render needlessly.
  const copyText = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text)
      showToast(t('chat.copy'))
    },
    [showToast]
  )
  const seedComposer = useCallback((text: string) => setSeed({ text, stamp: Date.now() }), [])

  /** After the first answer names the chat automatically (pi copies the first
   *  message into the title); replace that stub with a short AI title once. */
  const maybeAutoTitle = useCallback(
    async (chatId: string | null, projectId: string) => {
      if (!chatId || titledChats.current.has(chatId)) return
      const meta = chatsRef.current.find((chat) => chat.id === chatId)
      if (!meta?.name) return
      const firstUser = messagesRef.current.find((message) => message.kind === 'user')
      if (!firstUser || firstUser.kind !== 'user') return
      const stub = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 48)
      if (meta.name !== stub) return // renamed by hand, leave it alone
      titledChats.current.add(chatId)
      try {
        const raw = await invoke<string>('ai:complete', {
          system:
            'Придумай короткое название чата по сообщению пользователя. Ответь только названием: 3–6 слов, без кавычек, без точки, на языке сообщения.',
          prompt: firstUser.text.slice(0, 600)
        })
        const title = raw.replace(/["«»'`\n]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.$/, '').slice(0, 60)
        // Captured ids: a chat switch during the await must not rename another chat.
        if (title) await invoke('chats:rename', projectId, chatId, title)
      } catch {
        titledChats.current.delete(chatId)
      }
    },
    []
  )

  // -------------------------------------------------------------- events
  useEffect(() => {
    const unsubscribe = window.alpha.on((payload) => {
      const event = payload as AlphaEvent
      if (event.kind === 'session') {
        const ev = event.event
        const chatPath = event.chatPath
        const isActive = activeChatRef.current === chatPath
        if (ev.type === 'status') {
          setPhases((current) => ({ ...current, [chatPath]: ev.phase }))
        }
        if (!isActive) {
          // Background chat: keep its feed current and stay out of the way.
          if (ev.type !== 'status') bgRef.current[chatPath] = reduce(bgRef.current[chatPath] ?? [], ev)
          if (ev.type === 'done') {
            setPhases((current) => ({ ...current, [chatPath]: 'idle' }))
          }
          return
        }
        emitModEvent('session:event', ev)
        if (ev.type === 'done') emitModEvent('session:done', ev)
        if (ev.type === 'status') emitModEvent('session:status', ev)
        if (ev.type === 'status') {
          flushDeltas()
          setStatus(ev.phase)
          setStatusMessage(ev.message ?? '')
          // the agent settled: release the next prompt from the stack
          if (ev.phase === 'idle' && stackRef.current.length > 0) {
            const next = stackRef.current[0]
            setStacks((current) => {
              const key = activeChatRef.current
              if (!key) return current
              return { ...current, [key]: (current[key] ?? []).slice(1) }
            })
            sendRealRef.current(next.text)
          }
          return
        }
        if (ev.type === 'text') {
          pendingText.current += ev.delta
          scheduleFlush()
          return
        }
        if (ev.type === 'thinking') {
          pendingThinking.current += ev.delta
          scheduleFlush()
          return
        }
        flushDeltas()
        setMessages((current) => reduce(current, ev))
        if (ev.type === 'done') {
          setCtxUsage(ev.context ?? null)
          void refreshChats()
          void maybeAutoTitle(activeChatRef.current, activeProjectRef.current)
        }
      } else if (event.kind === 'finished') {
        if (event.chatId && event.chatId !== activeChatRef.current && document.hasFocus()) {
          showToast(`✓ ${event.chatName ?? t('sessions.done')}`)
        }
      } else if (event.kind === 'term') {
        termRef.current = (termRef.current + event.data).slice(-400_000)
        scheduleTermFlush()
      } else if (event.kind === 'toast') {
        showToast(event.message)
      } else if (event.kind === 'pi-update') {
        setPiLog((line) => line + event.line)
      } else if (event.kind === 'ask') {
        setAsk({ id: event.id, question: event.question, options: event.options })
      } else if (event.kind === 'approval') {
        setApproval({ id: event.id, tool: event.tool, summary: event.summary })
      } else if (event.kind === 'ui-list') {
        // task lists belong to the chat that produced them: a new or freshly
        // opened chat always starts empty
        const chatKey = activeChatRef.current ?? 'home'
        setListsByChat((current) => {
          const perChat = { ...(current[chatKey] ?? {}) }
          const key = `${event.modId}:${event.listId}`
          if (event.items === null) delete perChat[key]
          else perChat[key] = { title: event.title, items: event.items }
          return { ...current, [chatKey]: perChat }
        })
      }
    })
    const offRegistry = subscribeRegistry(() => setRegistryVersion((version) => version + 1))
    return () => {
      unsubscribe()
      offRegistry()
    }
  }, [refreshChats, showToast, flushDeltas, scheduleTermFlush])

  // -------------------------------------------------------------- startup (once)
  useEffect(() => {
    void (async () => {
      const appState = await invoke<AppState>('app:state')
      setState(appState)
      setSettings(appState.settings)
      setProjects(appState.projects)
      setLang(appState.settings.language)
      applyTheme(appState.settings)
      setModSettings(appState.settings)
      const [uiSources, css] = await Promise.all([
        invoke<{ id: string; code: string }[]>('mods:uiSources'),
        invoke<string>('mods:themeCss', appState.settings.activeThemeMod)
      ])
      setThemeCss(css)
      const errors = await loadUiMods(uiSources)
      if (errors.length) console.error('[mods]', errors)
      void loadModSettings()
      // heavy work deferred: markdown on idle, model list after the first frame
      warmMarkdown()
      const loadModels = (): void => {
        void invoke<ModelInfo[]>('models:list', 'home').then(setModels)
      }
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(loadModels, { timeout: 3000 })
      } else {
        setTimeout(loadModels, 350)
      }
    })()
    // Run once: re-running on project switch raced mod activation and
    // registered panels twice (the duplicated notes panel bug).
  }, [])

  // -------------------------------------------------------------- theme
  useEffect(() => {
    if (!settings) return
    applyTheme(settings)
    setModSettings(settings)
    setLang(settings.language)
    setMode(resolveMode(settings))
    void invoke<string>('mods:themeCss', settings.activeThemeMod).then(setThemeCss)
  }, [
    settings?.theme,
    settings?.accent,
    settings?.density,
    settings?.fontSize,
    settings?.uiFont,
    settings?.codeFont,
    settings?.language,
    settings?.iconSize,
    settings?.activeThemeMod
  ])

  useEffect(() => {
    void refreshChats()
  }, [activeProject, refreshChats])

  // Slash menu data follows the active project (project skills and prompts).
  useEffect(() => {
    void invoke<SkillInfo[]>('skills:list', activeProject)
      .then(setSkills)
      .catch(() => setSkills([]))
    void invoke<{ name: string; path: string }[]>('prompts:list', activeProject)
      .then(setPromptTemplates)
      .catch(() => setPromptTemplates([]))
  }, [activeProject])

  // The shell follows the project: opening the terminal tab starts bash there.
  useEffect(() => {
    if (view === 'term') void invoke('term:start', activeProject)
  }, [view, activeProject])

  // The quick menu closes on any click outside it and on Escape.
  useEffect(() => {
    if (!quickOpen) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (document.querySelector('.quick-menu')?.contains(target)) return
      if (document.querySelector('.quick-toggle')?.contains(target)) return
      setQuickOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setQuickOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [quickOpen])

  // -------------------------------------------------------------- window title
  useEffect(() => {
    const project = projects.find((p) => p.id === activeProject)
    const chatMeta = activeChat ? chats.find((chat) => chat.id === activeChat.id) : null
    const chatLabel = activeChat ? ` · ${chatMeta?.name || activeChat.id.slice(0, 8)}` : ''
    const title = project ? `Alpha — ${project.name}${chatLabel}` : `Alpha${chatLabel}`
    document.title = title
    void invoke('app:title', title)
  }, [projects, activeProject, activeChat, chats])

  const changeSettings = useCallback(async (patch: Partial<Settings>) => {
    // Optimistic first so panel toggles feel instant, then merge the
    // authoritative snapshot from main. Responses arrive in call order.
    setSettings((current) => (current ? { ...current, ...patch } : current))
    const next = await invoke<Settings>('settings:set', patch)
    setSettings((current) => (current ? { ...current, ...next } : next))
  }, [])

  const reloadMods = useCallback(async () => {
    const css = await invoke<string>('mods:themeCss', settingsRef.current?.activeThemeMod ?? '')
    setThemeCss(css)
    const sources = await invoke<{ id: string; code: string }[]>('mods:uiSources')
    await loadUiMods(sources)
    setRegistryVersion((version) => version + 1)
  }, [])

  // -------------------------------------------------------------- actions
  const openChat = useCallback(
    async (chat: ChatMeta, projectIdOverride?: string) => {
      // Switching never aborts: the chat you leave keeps working in the
      // background and is reused when you come back.
      const projectId = projectIdOverride ?? activeProject
      const result = await invoke<{ chatId: string; chatPath: string; messages: UIMessage[]; context?: ContextUsageUI }>(
        'chats:open',
        projectId,
        chat.path,
        chat.cwd
      )
      setActiveChat({ id: result.chatId, path: result.chatPath })
      activeChatRef.current = result.chatId
      resetDeltas()
      const cached = bgRef.current[result.chatId]
      setMessages(cached && cached.length ? cached : result.messages)
      setStatus(phasesRef.current[result.chatId] ?? 'idle')
      setStatusMessage('')
      setCtxUsage(result.context ?? null)
      void invoke<ModeId | null>('mode:get', result.chatId)
        .then((value) => setRunMode(value ?? (settingsRef.current?.defaultMode ?? 'agent')))
        .catch(() => setRunMode('agent'))
    },
    [activeProject]
  )

  const newChat = useCallback(async () => {
    const result = await invoke<{ chatId: string; chatPath: string; messages: UIMessage[] }>('chats:new', activeProject)
    setActiveChat({ id: result.chatId, path: result.chatPath })
    activeChatRef.current = result.chatId
    resetDeltas()
    setMessages(result.messages)
    setStatus('idle')
    setStatusMessage('')
    setCtxUsage(null)
    setRunMode(settingsRef.current?.defaultMode ?? 'agent')
    await refreshChats()
  }, [activeProject, refreshChats])

  const newWorktreeChat = useCallback(async () => {
    try {
      const result = await invoke<{ chatId: string; chatPath: string; messages: UIMessage[] }>(
        'chats:newWorktree',
        activeProject
      )
      setActiveChat({ id: result.chatId, path: result.chatPath })
      activeChatRef.current = result.chatId
      setMessages(result.messages)
      setStatus('idle')
      setStatusMessage('')
      setCtxUsage(null)
      setRunMode(settingsRef.current?.defaultMode ?? 'agent')
      await refreshChats()
      showToast(t('chat.worktree'))
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }, [activeProject, refreshChats, showToast])

  /** Real send: workspace checkpoint first, then the prompt itself. */
  const sendReal = useCallback(
    async (text: string) => {
      let chatId = activeChatRef.current
      if (!activeChat) {
        await newChat()
        chatId = activeChatRef.current
      }
      let checkpointId: string | null = null
      try {
        checkpointId = await invoke<string | null>('checkpoint:create', activeProjectRef.current, chatId ?? '')
      } catch {
        // no git, no checkpoint — the message still goes
      }
      setMessages((current) => [
        ...current,
        {
          kind: 'user',
          id: `u-${Date.now()}`,
          text,
          time: new Date().toISOString(),
          checkpointId: checkpointId ?? undefined
        }
      ])
      await invoke('session:send', text, false)
    },
    [activeChat, newChat]
  )
  sendRealRef.current = (text) => void sendReal(text)

  const enqueue = useCallback((text: string) => {
    const key = activeChatRef.current
    if (!key) return
    setStacks((current) => {
      const list = current[key] ?? []
      return { ...current, [key]: [...list, { id: `q-${Date.now()}-${list.length}`, text }] }
    })
  }, [])

  const send = useCallback(
    (text: string, queued: boolean) => {
      if (queued) enqueue(text)
      else void sendReal(text)
    },
    [enqueue, sendReal]
  )

  const restoreCheckpoint = useCallback(
    async (checkpointId: string) => {
      if (!activeChat) return
      if (!window.confirm(t('ck.restoreConfirm'))) return
      try {
        const summary = await invoke<string>('checkpoint:restore', activeProject, activeChat.id, checkpointId)
        showToast(`${t('ck.restored')}: ${summary}`)
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      }
    },
    [activeChat, activeProject, showToast]
  )

  // ------------------------------------------------------------- plan mode
  const changeMode = useCallback(
    async (next: ModeId) => {
      if (!activeChat) return
      try {
        const value = await invoke<ModeId>('mode:set', activeProject, activeChat.id, next)
        setRunMode(value)
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      }
    },
    [activeChat, activeProject, showToast]
  )

  const approvePlan = useCallback(() => {
    if (!activeChat) return
    void changeMode('agent').then(() => send(t('plan.approved'), false))
  }, [activeChat, changeMode, send])

  const forkWhole = useCallback(async () => {
    if (!activeChat) return
    const result = await invoke<{ chatId: string; chatPath: string; messages: UIMessage[] }>(
      'chats:fork',
      activeProject,
      activeChat.path
    )
    setActiveChat({ id: result.chatId, path: result.chatPath })
    activeChatRef.current = result.chatId
    setMessages(result.messages)
    await refreshChats()
    showToast(t('chat.forked'))
  }, [activeChat, activeProject, refreshChats, showToast])

  const forkEntry = useCallback(
    async (entryId: string) => {
      if (!activeChat) return
      try {
        const path = await invoke<string>('chats:forkAt', activeProject, activeChat.path, entryId)
        const result = await invoke<{ chatId: string; chatPath: string; messages: UIMessage[] }>(
          'chats:open',
          activeProject,
          path
        )
        setActiveChat({ id: result.chatId, path: result.chatPath })
        activeChatRef.current = result.chatId
        setMessages(result.messages)
        setStatus('idle')
        await refreshChats()
        showToast(t('chat.forked'))
      } catch (error) {
        showToast(String(error))
      }
    },
    [activeChat, activeProject, refreshChats, showToast]
  )

  const exportChat = useCallback(
    (format: 'md' | 'html' = 'md') => {
      if (!activeChat) return
      const title = document.title
      const content = format === 'html' ? chatToHtml(title, messages) : chatToMarkdown(title, messages)
      void invoke<string | null>('file:save', {
        defaultName: `alpha-${activeChat.id.slice(0, 8)}.${format}`,
        content
      }).then((path) => showToast(path ? `Сохранено: ${path}` : t('common.cancel')))
    },
    [activeChat, messages, showToast]
  )

  const runComposerAction = useCallback(
    async (id: string) => {
      const action = getRegistry().composerActions.find((entry) => entry.id === id)
      if (!action) return
      setActionBusy(id)
      try {
        await action.run({
          text: composerApi.current.text,
          replace: (next) => composerApi.current.replace(next)
        })
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      } finally {
        setActionBusy(null)
      }
    },
    [showToast]
  )

  // -------------------------------------------------------------- hotkeys
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new-chat',
        title: t('cmd.newChat'),
        hint: settings?.hotkeys.newChat,
        icon: 'add',
        run: () => void newChat()
      },
      { id: 'new-worktree', title: t('cmd.newWorktree'), icon: 'fork', run: () => void newWorktreeChat() },
      { id: 'settings', title: t('cmd.settings'), hint: settings?.hotkeys.settings, icon: 'sliders', run: () => setSettingsOpen(true) },
      {
        id: 'sidebar',
        title: t('cmd.sidebar'),
        hint: settings?.hotkeys.sidebar,
        icon: 'chevron-left',
        run: () => void changeSettings({ sidebarCollapsed: !settingsRef.current?.sidebarCollapsed })
      },
      {
        id: 'inspector',
        title: t('cmd.inspector'),
        hint: settings?.hotkeys.inspector,
        icon: 'chart',
        run: () => revealPanel('inspector')
      },
      {
        id: 'prompts',
        title: t('set.prompts'),
        run: () => {
          sessionStorage.setItem('alpha-settings-section', 'prompts')
          setSettingsOpen(true)
        }
      },
      {
        id: 'export',
        title: t('cmd.export'),
        hint: settings?.hotkeys.export,
        icon: 'export',
        run: () => exportChat('md')
      },
      { id: 'export-html', title: t('cmd.exportHtml'), icon: 'export', run: () => exportChat('html') },
      { id: 'review', title: t('review.title'), hint: settings?.hotkeys.review, icon: 'git-branch', run: () => setView('review') },
      ...((['agent', 'plan', 'debug', 'assist', 'quick'] as ModeId[]).map((id) => ({
        id: `mode:${id}`,
        title: `${t('cmd.mode')}: ${t(`modes.${id}`)}`,
        hint: id === 'plan' ? settings?.hotkeys.plan : undefined,
        run: () => {
          setView('chat')
          void changeMode(id)
        }
      }))),
      { id: 'terminal', title: t('view.term'), icon: 'command', run: () => setView('term') },
      {
        id: 'files',
        title: t('cmd.files'),
        icon: 'folder',
        run: () => revealPanel('files')
      },
      ...chats.map((chat) => ({
        id: `chat:${chat.id}`,
        title: chat.name || chat.id.slice(0, 8),
        hint: t('side.chats'),
        run: () => void openChat(chat)
      }))
    ]
    return list
  }, [settings, chats, mode, newChat, newWorktreeChat, changeSettings, changeMode, exportChat, openChat])

  const filteredCommands = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase()
    if (!query) return commands
    return commands.filter(
      (command) =>
        command.title.toLowerCase().includes(query) ||
        (command.hint ?? '').toLowerCase().includes(query) ||
        command.id.toLowerCase().includes(query)
    )
  }, [commands, paletteQuery])

  // Cumulative chat totals: every assistant usage entry summed (live totals).
  const chatUsage = useMemo(() => {
    let tokens = 0
    let cost = 0
    for (const message of messages) {
      if (message.kind !== 'assistant' || !message.usage) continue
      tokens += message.usage.tokens
      cost += message.usage.cost ?? 0
    }
    return tokens > 0 ? { tokens, cost } : undefined
  }, [messages])

  // Files the model wrote in this chat, newest first: preview tab sources.
  const artifacts = useMemo(() => {
    const seen: string[] = []
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message.kind !== 'assistant') continue
      for (const call of message.toolCalls) {
        if (call.name !== 'write' && call.name !== 'edit') continue
        try {
          const path = (JSON.parse(call.args) as { path?: string }).path
          if (path && !seen.includes(path)) seen.push(path)
        } catch {
          // args are not json, skip
        }
      }
    }
    return seen
  }, [messages])

  // keep the keyboard-highlighted command in view
  useEffect(() => {
    if (!paletteOpen) return
    document.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [paletteIndex, paletteOpen, filteredCommands])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const combo = comboFromEvent(event)
      const hotkeys = settingsRef.current?.hotkeys ?? {}
      const action = Object.entries(hotkeys).find(([, binding]) => binding === combo)?.[0]
      if (!action) {
        if (
          event.key === 'Escape' &&
          settingsOpen &&
          !paletteOpen &&
          !ask
        ) {
          setSettingsOpen(false)
        }
        return
      }
      event.preventDefault()
      if (action === 'palette') {
        setPaletteOpen((open) => !open)
        setPaletteQuery('')
        setPaletteIndex(0)
      } else if (action === 'newChat') void newChat()
      else if (action === 'sidebar') void changeSettings({ sidebarCollapsed: !settingsRef.current?.sidebarCollapsed })
      else if (action === 'inspector') revealPanel('inspector')
      else if (action === 'settings') setSettingsOpen(true)
      else if (action === 'export') exportChat()
      else if (action === 'plan') {
        setView('chat')
        void changeMode(runMode === 'plan' ? 'agent' : 'plan')
      } else if (action === 'review') setView('review')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [newChat, changeSettings, changeMode, mode, exportChat, settingsOpen, paletteOpen, ask])

  if (!state || !settings) {
    return <div className="empty-state">{t('common.loading')}</div>
  }

  const registry = getRegistry()
  const project = projects.find((p) => p.id === activeProject)
  const title = project?.name ?? t('side.noProject')

  const effectiveView: 'chat' | 'preview' | 'term' | 'file' | 'notes' | 'review' =
    view === 'file' && !openFile
      ? 'chat'
      : view === 'preview' && artifacts.length === 0
        ? 'chat'
        : view

  // Notes mode owns the full width: the panel columns step aside, the rail stays.
  const notesMode = effectiveView === 'notes'
  // Each built-in panel lives in the left or the right column; the user moves them.
  const leftIds = PANEL_IDS.filter((id) => sideOfPanel(settings, id) === 'left')
  const rightIds = PANEL_IDS.filter((id) => sideOfPanel(settings, id) === 'right')
  // One panel is visible per column. A panel that moved away falls back to the first of its column.
  const leftActive: PanelId | null = leftIds.includes(settings.leftPanel) ? settings.leftPanel : (leftIds[0] ?? null)
  const rightActive: PanelId | null = rightIds.includes(settings.rightPanel) ? settings.rightPanel : (rightIds[0] ?? null)
  const leftShown = leftActive !== null && !settings.sidebarCollapsed && !notesMode
  const rightShown = rightActive !== null && !settings.inspectorCollapsed && !notesMode
  const rightRail = rightIds.length > 0 && !notesMode
  // Grid rows: the topbar stretches over the chat and the right-hand columns;
  // the left rail and the left column run down the full window height.
  const gridCols: string[] = ['var(--rail-w)']
  const gridTop: string[] = ['rail']
  const gridBody: string[] = ['rail']
  if (leftShown) {
    gridCols.push('var(--panel-w)')
    gridTop.push('panel')
    gridBody.push('panel')
  }
  gridCols.push('minmax(0, 1fr)')
  gridTop.push('top')
  gridBody.push('chat')
  if (rightShown) {
    gridCols.push('var(--panel-w)')
    gridTop.push('top')
    gridBody.push('rpanel')
  }
  if (rightRail) {
    gridCols.push('var(--rail-w)')
    gridTop.push('top')
    gridBody.push('rrail')
  }
  const layoutStyle: React.CSSProperties = {
    gridTemplateColumns: gridCols.join(' '),
    gridTemplateAreas: `"${gridTop.join(' ')}" "${gridBody.join(' ')}"`
  }

  const railItem = (id: PanelId): RailItem => ({ id, icon: PANEL_ICON[id], title: t(`panels.${id}`) })

  // Rail click: switch the panel of that side. Clicking the open active panel folds its column.
  const railSelect = (side: 'left' | 'right', id: PanelId): void => {
    const collapsed = side === 'left' ? settings.sidebarCollapsed : settings.inspectorCollapsed
    const current = side === 'left' ? leftActive : rightActive
    if (!collapsed && current === id) {
      void changeSettings(side === 'left' ? { sidebarCollapsed: true } : { inspectorCollapsed: true })
    } else {
      void changeSettings(
        side === 'left' ? { leftPanel: id, sidebarCollapsed: false } : { rightPanel: id, inspectorCollapsed: false }
      )
    }
  }

  // Opens a panel wherever it lives: used by the hotkeys and the palette.
  const revealPanel = (id: PanelId): void => {
    if (sideOfPanel(settingsRef.current, id) === 'right') {
      void changeSettings({ rightPanel: id, inspectorCollapsed: false })
    } else {
      void changeSettings({ leftPanel: id, sidebarCollapsed: false })
    }
  }

  // Context menu of a rail icon: the panel changes its column and opens there.
  const movePanel = (id: PanelId, side: 'left' | 'right'): void => {
    const panelSides: Settings['panelSides'] = { ...settings.panelSides, [id]: side }
    if (side === 'right') void changeSettings({ panelSides, rightPanel: id, inspectorCollapsed: false })
    else void changeSettings({ panelSides, leftPanel: id, sidebarCollapsed: false })
  }

  // The × on a panel header: fold whichever column shows it.
  const foldPanel = (id: PanelId): void => {
    const side = sideOfPanel(settingsRef.current, id)
    void changeSettings(side === 'left' ? { sidebarCollapsed: true } : { inspectorCollapsed: true })
  }

  // Content of each built-in panel. Pages stay mounted when hidden, so a
  // folded column keeps its scroll position and its open tree.
  const renderPanel = (id: PanelId): React.ReactNode => {
    if (id === 'projects') {
      return (
        <Sidebar
          projects={projects}
          activeProject={activeProject}
          chats={chats}
          activeChatId={activeChat?.id ?? null}
          phases={phases}
          modItems={registry.sidebarItems}
          modVersion={registryVersion}
          onClose={() => foldPanel('projects')}
          onSelectProject={(id) => {
            setActiveProject(id)
            setActiveChat(null)
            activeChatRef.current = null
            setMessages([])
            setCtxUsage(null)
          }}
          onSelectChat={(chat) => void openChat(chat, chat.projectId)}
          onNewChat={() => void newChat()}
          onBulkDeleted={(ids) => {
            if (activeChat && ids.includes(activeChat.id)) {
              setActiveChat(null)
              activeChatRef.current = null
              setMessages([])
              setStatus('idle')
              setStatusMessage('')
            }
            void refreshChats()
          }}
          onChanged={() => {
            void invoke<AppState>('app:state').then((next) => setProjects(next.projects))
            void refreshChats()
          }}
        />
      )
    }
    if (id === 'files') {
      return (
        <FileTree
          projectId={activeProject}
          onClose={() => foldPanel('files')}
          onOpen={(path) => {
            setOpenFile({ path, name: path.split('/').pop() ?? path })
            setView('file')
          }}
        />
      )
    }
    return (
      <div className="inspector">
        <Inspector
          messages={messages}
          status={status}
          statusMessage={statusMessage}
          projectId={activeProject}
          chatId={activeChat?.id ?? null}
          chatUsage={chatUsage}
          onToast={showToast}
          onClose={() => foldPanel('inspector')}
        />
        {registry.statusItems.map((item) => (
          <StatusItem key={`${item.modId}:${item.id}`} item={item} version={registryVersion} />
        ))}
        {registry.panels
          .filter((panel) => panel.side !== 'bottom')
          .map((panel) => (
            <ModPanel key={`${panel.modId}:${panel.id}`} panel={panel} version={registryVersion} />
          ))}
        {Object.entries(listsByChat[activeChat?.id ?? 'home'] ?? {}).map(([key, list]) => (
          <CoreListPanel key={key} title={list.title} items={list.items} />
        ))}
      </div>
    )
  }

  const keyedModels = models.filter((m) => m.hasKey)
  const pinnedSet = new Set(settings.pinnedModels)
  const pinnedKeyed = keyedModels.filter((m) => pinnedSet.has(`${m.provider}/${m.id}`))
  const unpinnedKeyed = keyedModels.filter((m) => !pinnedSet.has(`${m.provider}/${m.id}`))
  const currentModelKey =
    settings.defaultProvider && settings.defaultModel
      ? `${settings.defaultProvider}/${settings.defaultModel}`
      : ''
  const modelValue = keyedModels.some((m) => `${m.provider}/${m.id}` === currentModelKey) ? currentModelKey : ''

  const modelOptions: DropOption[] = [{ value: '', label: `— ${t('set.model')} —` }]
  for (const model of pinnedKeyed) {
    modelOptions.push({ value: `${model.provider}/${model.id}`, label: model.name, group: t('model.pinned') })
  }
  for (const model of unpinnedKeyed.filter(isFreeModel)) {
    modelOptions.push({ value: `${model.provider}/${model.id}`, label: model.name, group: t('model.groupFree') })
  }
  for (const model of unpinnedKeyed.filter((m) => !isFreeModel(m))) {
    modelOptions.push({ value: `${model.provider}/${model.id}`, label: model.name, group: t('model.groupPaid') })
  }
  const thinkingOptions: DropOption[] = THINKING_LEVELS.map((level) => ({ value: level, label: level }))

  return (
    <div className="app" style={layoutStyle}>
      <style>{themeCss}</style>
      <PanelRail
        side="left"
        items={leftIds.map(railItem)}
        active={leftShown ? leftActive : null}
        onSelect={(id) => railSelect('left', id)}
        onMove={movePanel}
        footer={
          <button
            className="rail-btn"
            title={t('set.title')}
            aria-label={t('set.title')}
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="sliders" size={16} />
          </button>
        }
      />
      {leftIds.length > 0 && (
        <section className="panel-col left" hidden={!leftShown} aria-label={t('panels.leftColumn')}>
          {leftIds.map((id) => (
            <div key={id} className="panel-page" hidden={id !== leftActive}>
              {renderPanel(id)}
            </div>
          ))}
        </section>
      )}
      {rightRail && (
        <PanelRail
          side="right"
          items={rightIds.map(railItem)}
          active={rightShown ? rightActive : null}
          onSelect={(id) => railSelect('right', id)}
          onMove={movePanel}
        />
      )}
      {rightIds.length > 0 && (
        <section className="panel-col right" hidden={!rightShown} aria-label={t('panels.rightColumn')}>
          {rightIds.map((id) => (
            <div key={id} className="panel-page" hidden={id !== rightActive}>
              {renderPanel(id)}
            </div>
          ))}
        </section>
      )}

      <div className="topbar">
          <span className="brand" aria-hidden="true">
            <Icon name={mode === 'dark' ? 'alpha-logo-white' : 'alpha-logo'} size={15} />
          </span>
          <span className="title">{title}</span>
          <div className="tabs">
            <button
              className={`tab ${view === 'chat' ? 'active' : ''}`}
              title={t('view.chat')}
              onClick={() => setView('chat')}
            >
              {t('view.chat')}
            </button>
            {artifacts.length > 0 && (
              <button
                className={`tab ${view === 'preview' ? 'active' : ''}`}
                title={t('view.preview')}
                onClick={() => setView('preview')}
              >
                <Icon name="eye" size={13} />
                {t('view.preview')}
              </button>
            )}
            <button
              className={`tab ${view === 'term' ? 'active' : ''}`}
              title={t('view.term')}
              onClick={() => setView('term')}
            >
              <Icon name="terminal" size={13} />
              {t('view.term')}
            </button>
            <button
              className={`tab ${view === 'review' ? 'active' : ''}`}
              title={t('review.title')}
              onClick={() => setView('review')}
            >
              <Icon name="git-branch" size={13} />
              {t('review.short')}
            </button>
            <button
              className={`tab ${view === 'notes' ? 'active' : ''}`}
              title={t('view.notes')}
              onClick={() => setView('notes')}
            >
              <Icon name="note" size={13} />
              {t('view.notes')}
            </button>
            {openFile && (
              <button
                className={`tab file-tab ${view === 'file' ? 'active' : ''}`}
                title={openFile.path}
                onClick={() => setView('file')}
              >
                <Icon name="file-tree" size={12} />
                <span className="tab-label">{openFile.name}</span>
                <span
                  className="tab-close"
                  title={t('set.close')}
                  onClick={(event) => {
                    event.stopPropagation()
                    setOpenFile(null)
                    setView('chat')
                  }}
                >
                  <Icon name="close-compact" size={10} />
                </span>
              </button>
            )}
          </div>
          <span className="spacer" />

          <span className={`status-pill ${status}`}>
            {(status === 'working' || status === 'waiting') && <span className="pill-dot" />}
            {status === 'error' && <Icon name="x-circle" size={11} />}
            {status === 'idle'
              ? t('status.idle')
              : status === 'working'
                ? t('status.working')
                : status === 'waiting'
                  ? t('status.waiting')
                  : t('status.error')}
          </span>

          {activeChat && (
            <ModeSelect
              mode={runMode}
              defaultMode={settings.defaultMode}
              hotkey={settings.hotkeys.plan}
              onChange={(next) => void changeMode(next)}
            />
          )}

          <span className="quick-wrap">
            <button
              className="icon-btn quick-toggle"
              title={t('quick.title')}
              onClick={() => setQuickOpen((open) => !open)}
            >
              <Icon name="cpu" size={15} />
            </button>

            {quickOpen && (
              <div className="quick-menu" role="dialog" aria-label={t('quick.title')}>
                <div className="quick-label">{t('quick.model')}</div>
              <DropSelect
                className="model-select"
                caret={false}
                title={t('set.model')}
                value={modelValue}
                options={modelOptions}
                minWidth={260}
                pinned={settings.pinnedModels}
                onTogglePin={(value) => {
                  if (!value) return
                  const pinned = settings.pinnedModels
                  void changeSettings({
                    pinnedModels: pinned.includes(value)
                      ? pinned.filter((key) => key !== value)
                      : [...pinned, value]
                  })
                }}
                onChange={(raw) => {
                  // openrouter ids contain '/', so split only on the first separator
                  const separator = raw.indexOf('/')
                  void changeSettings({
                    defaultProvider: separator > 0 ? raw.slice(0, separator) : '',
                    defaultModel: separator > 0 ? raw.slice(separator + 1) : ''
                  })
                }}
              />
                <div className="quick-label">{runMode === 'quick' ? t('quick.levelQuick') : t('quick.level')}</div>
                <DropSelect
                  className="thinking-select"
                  caret={false}
                  title={t('set.level')}
                  value={runMode === 'quick' ? settings.quickThinking : settings.thinkingLevel}
                  options={thinkingOptions}
                  minWidth={160}
                  onChange={(value) =>
                    void changeSettings(
                      runMode === 'quick'
                        ? { quickThinking: value as ThinkingLevel }
                        : { thinkingLevel: value as ThinkingLevel }
                    )
                  }
                />
                {runMode === 'quick' && <div className="hint quick-hint">{t('quick.hintQuick')}</div>}
              </div>
            )}
          </span>

          <div className="win-controls">
            <button
              className="win-btn"
              title={t('win.min')}
              aria-label={t('win.min')}
              onClick={() => void invoke('win:control', 'minimize')}
            >
              <Icon name="window-minimize" size={12} />
            </button>
            <button
              className="win-btn"
              title={t('win.max')}
              aria-label={t('win.max')}
              onClick={() => void invoke('win:control', 'maximize')}
            >
              <Icon name="window-maximize" size={12} />
            </button>
            <button
              className="win-btn win-close"
              title={t('win.close')}
              aria-label={t('win.close')}
              onClick={() => void invoke('win:control', 'close')}
            >
              <Icon name="close-compact" size={11} />
            </button>
          </div>
        </div>

      <div className="chat-col">
        {effectiveView === 'chat' && activeChat && (
          <ModeBanner mode={runMode} onApprove={approvePlan} onExit={() => void changeMode('agent')} />
        )}
        {effectiveView === 'chat' && <PlanBar lists={listsByChat[activeChat?.id ?? 'home'] ?? {}} />}
        {effectiveView === 'review' ? (
          <ReviewView projectId={activeProject} chatId={activeChat?.id ?? null} onToast={showToast} />
        ) : effectiveView === 'preview' ? (
          <Suspense fallback={<div className="empty-state">{t('common.loading')}</div>}>
            <Preview paths={artifacts} />
          </Suspense>
        ) : effectiveView === 'notes' ? (
          <Suspense fallback={<div className="empty-state">{t('common.loading')}</div>}>
            <NotesView onToast={showToast} />
          </Suspense>
        ) : effectiveView === 'term' ? (
          <Suspense fallback={<div className="empty-state">{t('common.loading')}</div>}>
            <TerminalView
              buffer={termBuf}
              cwd={project?.path ?? '~'}
              onClear={() => {
                termRef.current = ''
                setTermBuf('')
              }}
            />
          </Suspense>
        ) : effectiveView === 'file' && openFile ? (
          <FileView path={openFile.path} onToast={showToast} />
        ) : (
          <ChatView
            messages={messages}
            canFork={Boolean(activeChat)}
            compactTools={settings.compactTools}
            forceRuns={runMode === 'debug'}
            onCopy={copyText}
            onForkEntry={(entryId) => void forkEntry(entryId)}
            onRestoreCheckpoint={(checkpointId) => void restoreCheckpoint(checkpointId)}
            onStarter={seedComposer}
          />
        )}

        {effectiveView === 'chat' &&
          registry.panels
            .filter((panel) => panel.side === 'bottom')
            .map((panel) => (
              <ModPanel key={`${panel.modId}:${panel.id}`} panel={panel} version={registryVersion} />
            ))}

        {(effectiveView === 'chat' || effectiveView === 'preview') && (
          <Composer
            working={status === 'working'}
            projectId={activeProject}
            mode={runMode}
            seed={seed}
            apiRef={composerApi}
            actions={registry.composerActions}
            actionBusy={actionBusy}
            onAction={(id) => void runComposerAction(id)}
            slashPrompts={promptTemplates}
            slashSkills={skills.filter((skill) => skill.enabled)}
            slashCommands={registry.commands}
            stack={stack}
            ctx={ctxUsage}
            draftScope={activeChat?.id ?? `new:${activeProject}`}
            onUnqueue={(id) =>
              setStacks((current) => {
                const key = activeChat?.id
                if (!key) return current
                return { ...current, [key]: (current[key] ?? []).filter((item) => item.id !== id) }
              })
            }
            onRunCommand={(id) => {
              registry.commands.find((command) => command.id === id)?.run()
            }}
            onSend={(text, queued) => void send(text, queued)}
            onAbort={() => void invoke('session:abort')}
          />
        )}
      </div>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
          settings={settings}
          projects={projects}
          activeProjectId={activeProject}
          piVersion={state.piVersion}
          appVersion={state.appVersion}
          piLog={piLog}
          onChange={changeSettings}
          onClose={() => setSettingsOpen(false)}
          onModsChanged={(mod) => {
            void reloadMods()
            if (mod.kind === 'core' && !mod.enabled) {
              showToast(`«${mod.name}» выключен. Перезапустите Alpha.`)
            }
          }}
          onInsertPrompt={(text) => {
            setSeed({ text, stamp: Date.now() })
            setSettingsOpen(false)
            setView('chat')
          }}
          modPages={registry.settingsPages}
        />
        </Suspense>
      )}

      {paletteOpen && (
        <div className="modal-backdrop palette-backdrop" onMouseDown={() => setPaletteOpen(false)}>
          <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder={t('palette.placeholder')}
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value)
                setPaletteIndex(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPaletteOpen(false)
                else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setPaletteIndex((index) => Math.min(index + 1, filteredCommands.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setPaletteIndex((index) => Math.max(index - 1, 0))
                } else if (e.key === 'Enter') {
                  const command = filteredCommands[paletteIndex]
                  if (command) {
                    command.run()
                    setPaletteOpen(false)
                  }
                }
              }}
            />
            <div className="palette-list">
              {filteredCommands.map((command, index) => (
                <div
                  key={command.id}
                  className={`palette-item ${index === paletteIndex ? 'active' : ''}`}
                  onMouseEnter={() => setPaletteIndex(index)}
                  onClick={() => {
                    command.run()
                    setPaletteOpen(false)
                  }}
                >
                  <span className="palette-label">
                    {command.icon && <Icon name={command.icon} size={14} />}
                    {command.title}
                  </span>
                  {command.hint && <span className="hint">{command.hint}</span>}
                </div>
              ))}
              {filteredCommands.length === 0 && <div className="hint palette-empty">{t('ins.none')}</div>}
            </div>
          </div>
        </div>
      )}

      {ask && (
        <AskDialog
          ask={ask}
          onAnswer={(value) => {
            void invoke('ask:answer', { id: ask.id, value })
            setAsk(null)
          }}
        />
      )}

      {approval && (
        <ApprovalDialog
          request={approval}
          onAnswer={(allow, allowAll) => {
            void invoke('approval:answer', { id: approval.id, allow, allowAll })
            setApproval(null)
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

const LIST_GLYPHS: Record<string, string> = { todo: '○', doing: '◐', done: '●' }

function escapeExportHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Full chat dump with thinking and tool calls, saved as Markdown. */
function chatToMarkdown(title: string, messages: UIMessage[]): string {
  const fence = '````'
  const out: string[] = [`# ${title}`, '']
  for (const message of messages) {
    if (message.kind === 'user') {
      out.push(`## ${t('export.you')}`, '', message.text, '')
    } else if (message.kind === 'system') {
      out.push(...message.text.split('\n').map((line) => `> ${line}`), '')
    } else {
      out.push('## Alpha', '')
      if (message.model) out.push(`*${message.model}*`, '')
      if (message.thinking) {
        out.push(`<details><summary>${t('chat.thinking')}</summary>`, '', message.thinking, '', '</details>', '')
      }
      for (const call of message.toolCalls) {
        out.push(`### \`${call.name}\``, '', fence, call.args, fence, '')
        if (call.result) out.push(fence, call.result, fence, '')
      }
      if (message.text) out.push(message.text, '')
    }
  }
  return out.join('\n')
}

/** Self-contained HTML page: opens in any browser, keeps tool calls and thinking. */
function chatToHtml(title: string, messages: UIMessage[]): string {
  const esc = escapeExportHtml
  const parts: string[] = []
  for (const message of messages) {
    if (message.kind === 'user') {
      parts.push(
        `<section class="msg user"><div class="meta">${esc(t('export.you'))}</div><div class="text">${esc(message.text)}</div></section>`
      )
    } else if (message.kind === 'system') {
      parts.push(`<section class="system">${esc(message.text)}</section>`)
    } else {
      const blocks: string[] = []
      if (message.thinking) {
        blocks.push(
          `<details><summary>${esc(t('chat.thinking'))}</summary><pre>${esc(message.thinking)}</pre></details>`
        )
      }
      for (const call of message.toolCalls) {
        const result = call.result ? `<pre>${esc(call.result)}</pre>` : ''
        blocks.push(`<details><summary>${esc(call.name)}</summary><pre>${esc(call.args)}</pre>${result}</details>`)
      }
      if (message.text) blocks.push(`<div class="text">${renderMarkdown(message.text)}</div>`)
      parts.push(`<section class="msg ai"><div class="meta">${esc(message.model ?? 'pi')}</div>${blocks.join('\n')}</section>`)
    }
  }
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #010102; color: #f7f8f8; font: 15px/1.55 -apple-system, 'Segoe UI', system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.35rem; border-bottom: 1px solid #23252a; padding-bottom: 12px; }
  .msg { border-left: 2px solid #23252a; padding: 8px 0 8px 14px; margin: 18px 0; }
  .msg.user { border: 1px solid #23252a; border-radius: 12px; background: #0f1011; padding: 12px 16px; }
  .meta { color: #62666d; font-size: 12px; margin-bottom: 6px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.ai .text { white-space: normal; }
  details { margin: 6px 0; border: 1px solid #23252a; border-radius: 8px; background: #141516; padding: 6px 10px; }
  summary { cursor: pointer; color: #8a8f98; font-size: 13px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.5 'JetBrains Mono', ui-monospace, monospace; color: #d0d6e0; }
  .system { color: #8a8f98; font-size: 13px; margin: 10px 0; }
  code { background: #141516; border: 1px solid #23252a; border-radius: 4px; padding: 1px 5px; font-size: 0.9em; }
  pre code { background: none; border: none; padding: 0; }
  a { color: #828fff; }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${parts.join('\n')}
</main>
</body>
</html>`
}

function CoreListPanel({ title, items }: { title: string; items: { text: string; status: string }[] }): React.JSX.Element {
  return (
    <div className="core-list">
      <div className="insp-title">{title}</div>
      {items.map((item, index) => (
        <div key={index} className={`core-list-item ${item.status}`}>
          <span className="glyph">
            {item.status === 'done' ? <Icon name="check" size={13} /> : (LIST_GLYPHS[item.status] ?? '○')}
          </span>
          <span>{item.text}</span>
        </div>
      ))}
    </div>
  )
}

function AskDialog({ ask, onAnswer }: { ask: AskRequest; onAnswer: (value: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('')
  const submit = (): void => {
    if (value.trim()) onAnswer(value.trim())
  }
  return (
    <div className="modal-backdrop ask-backdrop">
      <div className="ask-dialog" role="dialog" aria-modal="true">
        <div className="ask-question">{ask.question}</div>
        <div className="ask-options">
          {ask.options.map((option) => (
            <button key={option} className="ask-option" onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
        <div className="ask-custom">
          <input
            autoFocus
            placeholder={t('ask.placeholder')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button className="btn primary" disabled={!value.trim()} onClick={submit}>
            {t('ask.answer')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ApprovalDialog({
  request,
  onAnswer
}: {
  request: ApprovalRequest
  onAnswer: (allow: boolean, allowAll: boolean) => void
}): React.JSX.Element {
  return (
    <div className="modal-backdrop ask-backdrop">
      <div className="ask-dialog approval" role="dialog" aria-modal="true">
        <div className="approval-head">
          <Icon name="alert" size={18} />
          <span>{request.tool === 'terminal' ? t('approval.terminal') : t('approval.title')}</span>
          <span className="mono approval-tool">{request.tool}</span>
        </div>
        <pre className="log approval-summary">{request.summary}</pre>
        <div className="approval-actions">
          <button className="btn primary" onClick={() => onAnswer(true, false)}>
            {t('approval.allow')}
          </button>
          <button className="btn" onClick={() => onAnswer(true, true)}>
            {t('approval.allowAll')}
          </button>
          <button className="btn danger" onClick={() => onAnswer(false, false)}>
            {t('approval.deny')}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusItem({
  item,
  version
}: {
  item: { render(container: HTMLElement): void | (() => void) }
  version: number
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return item.render(ref.current) ?? undefined
  }, [item, version])
  return <span ref={ref} />
}

function ModPanel({
  panel,
  version
}: {
  panel: { title: string; render(container: HTMLElement): void | (() => void) }
  version: number
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return panel.render(ref.current) ?? undefined
  }, [panel, version])
  return (
    <div className="mod-panel">
      <div className="mod-panel-title">{panel.title}</div>
      <div ref={ref} />
    </div>
  )
}