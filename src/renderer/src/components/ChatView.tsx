import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { ContextUsageUI, ModeId, NoteInfo, SessionEvent, UIMessage, UsageUI } from '@shared/types'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'
import { renderMarkdown } from '../markdown'

export function reduce(messages: UIMessage[], event: SessionEvent): UIMessage[] {
  const next = [...messages]

  // Pure by design: React StrictMode invokes updaters twice in development,
  // so every touched message is cloned before modification.
  const cloneAssistant = (message: Extract<UIMessage, { kind: 'assistant' }>): typeof message => ({
    ...message,
    toolCalls: message.toolCalls.map((call) => ({ ...call }))
  })

  const ensureAssistant = (): Extract<UIMessage, { kind: 'assistant' }> => {
    const index = next.length - 1
    const last = next[index]
    if (last && last.kind === 'assistant' && last.streaming) {
      const copy = cloneAssistant(last)
      next[index] = copy
      return copy
    }
    const fresh: Extract<UIMessage, { kind: 'assistant' }> = {
      kind: 'assistant',
      id: `a-${Date.now()}-${next.length}`,
      text: '',
      thinking: '',
      toolCalls: [],
      time: new Date().toISOString(),
      streaming: true
    }
    next.push(fresh)
    return fresh
  }

  const touchLastAssistant = (): Extract<UIMessage, { kind: 'assistant' }> => {
    const index = next.length - 1
    const last = next[index]
    if (last && last.kind === 'assistant') {
      const copy = cloneAssistant(last)
      next[index] = copy
      return copy
    }
    return ensureAssistant()
  }

  switch (event.type) {
    case 'text': {
      const target = ensureAssistant()
      target.text += event.delta
      break
    }
    case 'thinking': {
      const target = ensureAssistant()
      target.thinking += event.delta
      break
    }
    case 'tool.start': {
      const target = ensureAssistant()
      target.toolCalls.push({ callId: event.callId, name: event.name, args: event.args, running: true })
      break
    }
    case 'tool.update': {
      const target = touchLastAssistant()
      const call = target.toolCalls.find((c) => c.callId === event.callId)
      if (call) call.partial = event.partial
      break
    }
    case 'tool.end': {
      const target = touchLastAssistant()
      const call = target.toolCalls.find((c) => c.callId === event.callId)
      if (call) {
        call.running = false
        call.isError = !event.ok
        call.result = event.ok ? event.result : (event.error ?? event.result)
        call.durationMs = event.durationMs
      }
      break
    }
    case 'done': {
      for (let index = next.length - 1; index >= 0; index--) {
        const msg = next[index]
        if (msg.kind === 'assistant') {
          next[index] = cloneAssistant(msg)
          const copy = next[index] as Extract<UIMessage, { kind: 'assistant' }>
          copy.streaming = false
          if (event.usage) copy.usage = event.usage
          if (event.durationMs) copy.durationMs = event.durationMs
          break
        }
      }
      break
    }
    case 'status':
      break
    case 'split': {
      // a completed assistant message: close the bubble so the next delta starts a new one
      for (let index = next.length - 1; index >= 0; index--) {
        const msg = next[index]
        if (msg.kind === 'assistant' && msg.streaming) {
          next[index] = cloneAssistant(msg)
          const copy = next[index] as Extract<UIMessage, { kind: 'assistant' }>
          copy.streaming = false
          if (event.usage) copy.usage = event.usage
          break
        }
      }
      break
    }
  }
  return next
}

// ---------------------------------------------------------------- line diff

type DiffLine = { kind: 'ctx' | 'del' | 'add'; text: string }

function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length * b.length > 400_000) return null // too big for the DP, show raw
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] })
      i++
    } else {
      out.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

interface EditArgs {
  path?: string
  edits?: { oldText?: string; newText?: string }[]
  content?: string
}

function parseToolArgs(raw: string): EditArgs | null {
  try {
    return JSON.parse(raw) as EditArgs
  } catch {
    return null
  }
}

function DiffView({ before, after }: { before: string; after: string }): React.JSX.Element {
  const lines = lineDiff(before, after)
  if (!lines) return <pre className="diff">{`--- old\n${before}\n+++ new\n${after}`}</pre>
  return (
    <div className="diff">
      {lines.map((line, index) => (
        <div key={index} className={`diff-line ${line.kind}`}>
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </div>
      ))}
    </div>
  )
}

async function revertEdits(args: EditArgs): Promise<string> {
  if (!args.path || !args.edits?.length) return t('tool.noData')
  const current = await invoke<string>('file:read', args.path)
  let content = current
  for (const edit of [...args.edits].reverse()) {
    if (!edit.newText || edit.newText === edit.oldText) continue
    const occurrences = content.split(edit.newText).length - 1
    if (occurrences !== 1) return `${args.path}: ${t('tool.revertConflict').replace('{n}', String(occurrences))}`
    content = content.replace(edit.newText, edit.oldText ?? '')
  }
  await invoke('file:write', args.path, content)
  return ''
}

// ---------------------------------------------------------------- tool row

interface ToolCallProps {
  callId: string
  name: string
  args: string
  result?: string
  partial?: string
  running?: boolean
  isError?: boolean
  durationMs?: number
  onToast: (text: string) => void
}

function ToolRow(props: ToolCallProps): React.JSX.Element {
  const { name, args, result, running, isError, durationMs, onToast } = props
  const [open, setOpen] = useState(false)
  const [reverting, setReverting] = useState(false)
  const parsed = parseToolArgs(args)
  const brief = args.replace(/\s+/g, ' ').slice(0, 120)
  const showDiff = !running && name === 'edit' && parsed?.edits?.length
  const showWrite = !running && name === 'write' && typeof parsed?.content === 'string'

  return (
    <div className={`tool ${open ? 'open' : ''}`}>
      <div className="tool-head" onClick={() => setOpen(!open)}>
        <span className="caret">
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="tool-name">{name}</span>
        <span className="tool-arg">{brief}</span>
        {running && <span className="badge">…</span>}
        {!running && isError && <span className="badge err">error</span>}
        {!running && !isError && durationMs !== undefined && <span className="badge ok">{durationMs}ms</span>}
      </div>
      {open && (
        <div className="tool-body">
          {showDiff && (
            <>
              <div className="tool-path">{parsed.path}</div>
              {parsed.edits!.map((edit, index) => (
                <DiffView key={index} before={edit.oldText ?? ''} after={edit.newText ?? ''} />
              ))}
              <div className="tool-actions">
                <button
                  className="btn small"
                  disabled={reverting}
                  onClick={(e) => {
                    e.stopPropagation()
                    setReverting(true)
                    void revertEdits(parsed).then((error) => {
                      setReverting(false)
                      onToast(error || t('tool.reverted'))
                    })
                  }}
                >
                  {reverting ? '…' : t('tool.revert')}
                </button>
              </div>
            </>
          )}
          {showWrite && (
            <>
              <div className="tool-path">{parsed.path}</div>
              <DiffView before="" after={parsed.content!} />
            </>
          )}
          {!showDiff && !showWrite && (
            <>
              <div>{args}</div>
              {result ? <div>{result}</div> : null}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- feed

interface FeedProps {
  messages: UIMessage[]
  canFork: boolean
  compactTools?: boolean
  /** Debug mode: run blocks stay expanded even in compact mode. */
  forceRuns?: boolean
  onCopy: (text: string) => void
  onForkEntry: (entryId: string) => void
  onStarter?: (text: string) => void
  onRestoreCheckpoint?: (checkpointId: string) => void
}

const FEED_HEAD = 20
const FEED_TAIL = 180

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Markdown re-parses only when the text actually changed, not on every flush. */
const Md = memo(function Md({ text }: { text: string }): React.JSX.Element {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
})

type AssistantMsg = Extract<UIMessage, { kind: 'assistant' }>

/** In compact mode thinking and tool calls fold into one animated line. */
function RunBlock({ message, compact, force, onToast }: { message: AssistantMsg; compact: boolean; force?: boolean; onToast: (text: string) => void }): React.JSX.Element {
  // debug mode starts expanded; the user can still fold the run by hand
  const [open, setOpen] = useState(Boolean(force))
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!message.streaming) return
    const timer = setInterval(() => setFrame((f) => f + 1), 90)
    return () => clearInterval(timer)
  }, [message.streaming])

  const details = (
    <>
      {message.thinking && (
        <details className="thinking">
          <summary>{t('chat.thinking')}</summary>
          <div className="body">{message.thinking}</div>
        </details>
      )}
      {message.toolCalls.map((call) => (
        <ToolRow key={call.callId} {...call} onToast={onToast} />
      ))}
    </>
  )
  if (!compact || open) return <>{details}</>
  const seconds = message.toolCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / 1000
  return (
    <button className={`run-line ${message.streaming ? 'live' : ''}`} onClick={() => setOpen(!open)}>
      {message.streaming ? (
        <>
          <span className="run-spin">{SPIN[frame % SPIN.length]}</span>
          {t('comp.thinkingLine')}
        </>
      ) : (
        <>
          <span className="run-done">✓</span>
          {message.toolCalls.length > 0
            ? t('comp.runDone').replace('{n}', String(message.toolCalls.length)).replace('{s}', seconds.toFixed(1))
            : t('comp.runDoneShort').replace('{s}', seconds.toFixed(1))}
        </>
      )}
    </button>
  )
}

interface MessageProps {
  message: UIMessage
  canFork: boolean
  compact: boolean
  force: boolean
  onCopy: (text: string) => void
  onFork: (entryId: string) => void
  onRestore?: (checkpointId: string) => void
  onToast: (text: string) => void
}

/** One feed row. Memoized: during streaming only the message being written
 *  changes identity, so every earlier row skips re-rendering. */
const Message = memo(function Message({
  message,
  canFork,
  compact,
  force,
  onCopy,
  onFork,
  onRestore,
  onToast
}: MessageProps): React.JSX.Element {
  if (message.kind === 'user') {
    return (
      <div className={`msg user ${message.queued ? 'queued' : ''}`}>
        {message.queued && (
          <div className="msg-meta">
            <span className="badge">{t('chat.queued')}</span>
          </div>
        )}
        <div className="msg-actions">
          <button className="msg-action" title={t('chat.copy')} onClick={() => onCopy(message.text)}>
            <Icon name="copy" size={13} />
          </button>
          {onRestore && message.checkpointId && (
            <button
              className="msg-action"
              title={t('ck.restore')}
              onClick={() => onRestore(message.checkpointId!)}
            >
              <Icon name="undo" size={13} />
            </button>
          )}
          {canFork && message.entryId && (
            <button className="msg-action" title={t('chat.forkFrom')} onClick={() => onFork(message.entryId!)}>
              <Icon name="fork" size={13} />
            </button>
          )}
        </div>
        {message.text}
      </div>
    )
  }
  if (message.kind === 'system') {
    return <div className="msg system">{message.text}</div>
  }
  return (
    <div className={`msg assistant ${message.toolCalls.some((call) => call.isError) ? 'err-run' : ''}`}>
      <div className="msg-meta">
        <span>{message.model ?? 'pi'}</span>
        {message.durationMs ? <span>{(message.durationMs / 1000).toFixed(1)}s</span> : null}
        {message.usage && (
          <span>
            {formatTokens(message.usage.tokens)}
            {message.usage.cost ? ` · $${message.usage.cost.toFixed(3)}` : ''}
          </span>
        )}
      </div>
      {message.text && (
        <div className="msg-actions">
          <button className="msg-action" title={t('chat.copy')} onClick={() => onCopy(message.text)}>
            <Icon name="copy" size={13} />
          </button>
        </div>
      )}
      {(message.thinking || message.toolCalls.length > 0) && (
        <RunBlock message={message} compact={compact} force={force} onToast={onToast} />
      )}
      {message.text && (message.streaming ? (
        <div className="md-stream">{message.text}</div>
      ) : (
        <Md text={message.text} />
      ))}
      {message.streaming && !message.text && !message.thinking && !message.toolCalls.length && (
        <span className="hint">…</span>
      )}
    </div>
  )
})

export default function ChatView({
  messages,
  canFork,
  compactTools = false,
  forceRuns = false,
  onCopy,
  onForkEntry,
  onStarter,
  onRestoreCheckpoint
}: FeedProps): React.JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const [toastText, setToastText] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expanded, setExpanded] = useState(false)

  // Windowing: long chats render a head and a tail with a gap between them,
  // so a 1000-message history never mounts at once (item 6, no dependencies).
  const hiddenCount =
    !expanded && messages.length > FEED_HEAD + FEED_TAIL ? messages.length - FEED_HEAD - FEED_TAIL : 0
  const head = hiddenCount ? messages.slice(0, FEED_HEAD) : messages
  const tail = hiddenCount ? messages.slice(-FEED_TAIL) : []

  useEffect(() => {
    setExpanded(false)
  }, [messages[0]?.id])

  useEffect(() => {
    if (stick) endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, stick])

  function onScroll(): void {
    const box = boxRef.current
    if (!box) return
    setStick(box.scrollHeight - box.scrollTop - box.clientHeight < 80)
  }

  const showToast = useCallback((text: string): void => {
    setToastText(text)
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastText(''), 2500)
  }, [])

  const messageProps = {
    canFork,
    compact: compactTools,
    force: forceRuns,
    onCopy,
    onFork: onForkEntry,
    onRestore: onRestoreCheckpoint,
    onToast: showToast
  } as const

  return (
    <div className="feed-wrap">
      <div className="feed" ref={boxRef} onScroll={onScroll}>
      <div className="feed-inner">
        {messages.length === 0 && (
          <div className="empty-state">
            {t('chat.empty')}
            <br />
            <span className="hint">{t('chat.noModel')}</span>
            {onStarter && (
              <div className="starters">
                {['starter.explain', 'starter.bug', 'starter.test', 'starter.plan'].map((key) => (
                  <button key={key} className="starter" onClick={() => onStarter(t(key))}>
                    {t(key)}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {head.map((m) => (
          <Message key={m.id} message={m} {...messageProps} />
        ))}
        {hiddenCount > 0 && (
          <div className="feed-gap">
            <button className="btn small" onClick={() => setExpanded(true)}>
              {t('chat.showMore').replace('{n}', String(hiddenCount))}
            </button>
          </div>
        )}
        {tail.map((m) => (
          <Message key={m.id} message={m} {...messageProps} />
        ))}
        <div ref={endRef} />
      </div>
      </div>
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  )
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`
  return `${tokens} tok`
}

// ---------------------------------------------------------------- composer

interface SlashPrompt {
  name: string
  path: string
}

interface SlashSkill {
  name: string
  description: string
}

interface SlashCommand {
  id: string
  title: string
}

interface SlashItem {
  group: 'prompt' | 'skill' | 'command'
  title: string
  hint?: string
  ref: string
}

/** The composer exposes its draft to mod actions (prompt improver etc.). */
export interface ComposerApi {
  text: string
  replace(next: string): void
}

export interface StackItem {
  id: string
  text: string
}

interface ComposerProps {
  working: boolean
  projectId: string
  /** Current chat mode, shown as a chip in the composer footer. */
  mode?: ModeId
  /** Scope for the local draft: per chat, so drafts never leak between chats. */
  draftScope?: string
  seed?: { text: string; stamp: number } | null
  apiRef?: React.RefObject<ComposerApi>
  actions?: { id: string; title: string }[]
  actionBusy?: string | null
  onAction?: (id: string) => void
  slashPrompts?: SlashPrompt[]
  slashSkills?: SlashSkill[]
  slashCommands?: SlashCommand[]
  onRunCommand?: (id: string) => void
  stack?: StackItem[]
  ctx?: ContextUsageUI | null
  onUnqueue?: (id: string) => void
  onSend: (text: string, queued: boolean) => void
  onAbort: () => void
}

export function Composer({
  working,
  projectId,
  mode = 'agent',
  draftScope,
  seed,
  apiRef,
  actions = [],
  actionBusy = null,
  onAction,
  slashPrompts = [],
  slashSkills = [],
  slashCommands = [],
  onRunCommand,
  stack = [],
  ctx = null,
  onUnqueue,
  onSend,
  onAbort
}: ComposerProps): React.JSX.Element {
  const draftKey = `alpha-draft:${draftScope ?? projectId}`
  const [value, setValue] = useState(() => localStorage.getItem(draftKey) ?? '')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashClosed, setSlashClosed] = useState(false)
  const [files, setFiles] = useState<string[] | null>(null)
  const [notes, setNotes] = useState<string[] | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  // @-mentions: project file paths, loaded once per project on the first '@'.
  useEffect(() => {
    setFiles(null)
    setMentionQuery(null)
  }, [projectId])
  useEffect(() => {
    if (mentionQuery === null || files) return
    void invoke<string[]>('files:all', projectId)
      .then(setFiles)
      .catch(() => setFiles([]))
  }, [mentionQuery, files, projectId])
  // notes join the same '@' menu as notes:<имя>
  useEffect(() => {
    if (mentionQuery === null || notes) return
    void invoke<NoteInfo[]>('notes:list')
      .then((list) => setNotes(list.map((note) => `notes:${note.path.replace(/\.md$/i, '')}`)))
      .catch(() => setNotes([]))
  }, [mentionQuery, notes])

  // The '@token' right before the caret, or null when no mention is being typed.
  function mentionToken(text: string, caret: number): string | null {
    const before = text.slice(0, caret)
    const match = /(^|\s)@([^\s@]*)$/.exec(before)
    return match ? match[2] : null
  }

  // Reload the draft when the project changes.
  useEffect(() => {
    setValue(localStorage.getItem(draftKey) ?? '')
    setSlashClosed(false)
  }, [draftKey])

  // External insert (prompt library): prefill the field and focus it.
  useEffect(() => {
    if (!seed) return
    setValue(seed.text)
    localStorage.setItem(draftKey, seed.text)
    setSlashClosed(true)
    ref.current?.focus()
    if (ref.current) {
      ref.current.style.height = 'auto'
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`
    }
  }, [seed, draftKey])

  function resize(): void {
    if (!ref.current) return
    ref.current.style.height = 'auto'
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 200)}px`
  }

  // Keep the shared handle in sync: mod actions read the draft and replace it.
  useEffect(() => {
    if (!apiRef) return
    apiRef.current = {
      text: value,
      replace: (next: string) => {
        setText(next)
        requestAnimationFrame(() => {
          if (!ref.current) return
          ref.current.focus()
          ref.current.selectionStart = ref.current.selectionEnd = ref.current.value.length
        })
      }
    }
  }, [value, apiRef])

  function setText(next: string): void {
    setValue(next)
    localStorage.setItem(draftKey, next)
    setSlashClosed(true)
    setSlashIndex(0)
    requestAnimationFrame(resize)
  }

  function submit(queued: boolean): void {
    const text = value.trim()
    if (!text) return
    setValue('')
    localStorage.removeItem(draftKey)
    setSlashClosed(false)
    setSlashIndex(0)
    setMentionQuery(null)
    if (ref.current) ref.current.style.height = 'auto'
    onSend(text, queued)
  }

  // Slash menu: `/` at the start of the draft opens templates, skills and mod
  // commands. Nothing appears until at least one character follows the slash.
  const firstLine = value.split('\n', 1)[0] ?? ''
  const token = firstLine.startsWith('/') ? (firstLine.slice(1).split(/\s/)[0] ?? '') : null
  const slashItems: SlashItem[] =
    token === null || token.length === 0 || slashClosed
      ? []
      : ([
          ...slashPrompts.map((item) => ({ group: 'prompt' as const, title: item.name, ref: item.path })),
          ...slashSkills.map((item) => ({
            group: 'skill' as const,
            title: item.name,
            hint: item.description,
            ref: item.name
          })),
          ...slashCommands.map((item) => ({ group: 'command' as const, title: item.title, ref: item.id }))
        ] as SlashItem[])
          .filter((item) => {
            const query = token.toLowerCase()
            return item.title.toLowerCase().includes(query) || (item.hint ?? '').toLowerCase().includes(query)
          })
          .slice(0, 12)
  const slashOpen = slashItems.length > 0
  const activeItem = slashOpen ? slashItems[Math.min(slashIndex, slashItems.length - 1)] : null

  // ------------------------------------------------------------- mentions
  const pool = [...(files ?? []), ...(notes ?? [])]
  const mentionItems: string[] =
    mentionQuery === null
      ? []
      : pool.filter((value) => value.toLowerCase().includes(mentionQuery!.toLowerCase())).slice(0, 10)
  const mentionOpen = mentionQuery !== null && !slashOpen && mentionItems.length > 0
  const activeMention = mentionOpen ? mentionItems[Math.min(mentionIndex, mentionItems.length - 1)] : null

  function pickMention(path: string): void {
    const textarea = ref.current
    if (!textarea) return
    const caret = textarea.selectionStart ?? value.length
    const before = value.slice(0, caret)
    const match = /(^|\s)@([^\s@]*)$/.exec(before)
    if (!match) return
    const start = caret - match[2].length - 1
    const next = `${value.slice(0, start)}@${path} ${value.slice(caret)}`
    setValue(next)
    localStorage.setItem(draftKey, next)
    setMentionQuery(null)
    setMentionIndex(0)
    requestAnimationFrame(() => {
      if (!ref.current) return
      const at = start + path.length + 2
      ref.current.selectionStart = ref.current.selectionEnd = at
      ref.current.focus()
    })
  }

  async function pickSlash(item: SlashItem): Promise<void> {
    const rest = token !== null ? value.slice(1 + token.length) : ''
    if (item.group === 'command') {
      setValue('')
      localStorage.removeItem(draftKey)
      setSlashClosed(true)
      if (ref.current) ref.current.style.height = 'auto'
      onRunCommand?.(item.ref)
      ref.current?.focus()
      return
    }
    let insert = ''
    if (item.group === 'prompt') {
      try {
        insert = await invoke<string>('prompts:get', item.ref, projectId)
      } catch {
        insert = ''
      }
    } else {
      insert = t('slash.useSkill').replace('{name}', item.ref)
    }
    const tail = rest.trim()
    setText(tail ? `${insert.trimEnd()}\n${tail}` : insert)
    ref.current?.focus()
    requestAnimationFrame(() => {
      if (!ref.current) return
      ref.current.selectionStart = ref.current.selectionEnd = ref.current.value.length
    })
  }

  const groups: { id: SlashItem['group']; label: string }[] = [
    { id: 'prompt', label: t('slash.prompts') },
    { id: 'skill', label: t('slash.skills') },
    { id: 'command', label: t('slash.commands') }
  ]

  return (
    <div className="composer">
      {stack.length > 0 && (
        <div className="stack-row">
          {stack.map((item) => (
            <span key={item.id} className="stack-chip" title={item.text}>
              <span className="stack-text">{item.text}</span>
              <button className="stack-x" title={t('common.cancel')} onClick={() => onUnqueue?.(item.id)}>
                <Icon name="close-compact" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {slashOpen && (
        <div className="slash-pop">
          {groups.map((group) => {
            const entries = slashItems
              .map((item, index) => ({ item, index }))
              .filter((entry) => entry.item.group === group.id)
            if (entries.length === 0) return null
            return (
              <div key={group.id} className="slash-group">
                <div className="slash-group-title">{group.label}</div>
                {entries.map(({ item, index }) => (
                  <div
                    key={`${group.id}:${item.ref}`}
                    className={`slash-item ${activeItem === item ? 'active' : ''}`}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void pickSlash(item)}
                  >
                    <span className="slash-name">{item.title}</span>
                    {item.hint && <span className="hint slash-hint">{item.hint}</span>}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}
      <div className="composer-inner">
        <div className="composer-box">
        <textarea
          ref={ref}
          placeholder={t('chat.placeholder')}
          value={value}
          rows={1}
          onChange={(e) => {
            setValue(e.target.value)
            localStorage.setItem(draftKey, e.target.value)
            setSlashClosed(false)
            setSlashIndex(0)
            setMentionQuery(mentionToken(e.target.value, e.target.selectionStart ?? 0))
            setMentionIndex(0)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`
          }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((index) => Math.min(index + 1, slashItems.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((index) => Math.max(index - 1, 0))
                return
              }
              if (e.key === 'Enter' && !e.shiftKey && activeItem) {
                e.preventDefault()
                void pickSlash(activeItem)
                return
              }
              if (e.key === 'Tab' && activeItem) {
                e.preventDefault()
                void pickSlash(activeItem)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setSlashClosed(true)
                return
              }
            }
            if (mentionOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setMentionIndex((index) => Math.min(index + 1, mentionItems.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionIndex((index) => Math.max(index - 1, 0))
                return
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && activeMention) {
                e.preventDefault()
                pickMention(activeMention)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setMentionQuery(null)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(working)
            }
          }}
        />
          <div className="composer-side">
            {actions.map((action) => (
              <button
                key={action.id}
                className="icon-btn composer-action"
                disabled={actionBusy !== null || !value.trim()}
                title={actionBusy === action.id ? `${action.title}…` : action.title}
                onClick={() => onAction?.(action.id)}
              >
                <Icon name="sparkle" size={15} />
              </button>
            ))}
            <button
              className={`composer-send ${working ? 'stop' : ''}`}
              disabled={!working && !value.trim()}
              title={working ? t('chat.stop') : t('chat.send')}
              onClick={() => (working ? onAbort() : submit(false))}
            >
              <Icon name={working ? 'stop' : 'arrow-up'} size={13} />
            </button>
          </div>
        </div>
        {working && (
          <button className="btn queue-btn" onClick={() => submit(true)} disabled={!value.trim()}>
            {t('chat.queue')}
          </button>
        )}
      </div>
      <div className="composer-foot">
        <span className={`comp-chip mode-${mode}`} title={t(`modes.${mode}Desc`)}>
          {t(`modes.${mode}`)}
        </span>
        <span className="comp-hints">
          <span className="kbd-chip">@</span> {t('comp.hintAt')}
          <span className="kbd-chip">/</span> {t('comp.hintSlash')}
          <span className="kbd-chip">Enter</span> {t('comp.hintEnter')}
          <span className="kbd-chip">Shift+Enter</span> {t('comp.hintShift')}
        </span>
        {ctx && ctx.contextWindow > 0 && (
          <span
            className={`ctx-meter ${ctx.percent >= 85 ? 'warn' : ''}`}
            title={`${t('comp.ctx')}: ${formatTokens(ctx.tokens)} / ${formatTokens(ctx.contextWindow)}`}
          >
            <span className="ctx-track">
              <span className="ctx-fill" style={{ width: `${Math.min(100, Math.round(ctx.percent))}%` }} />
            </span>
            <span className="ctx-label">{Math.round(ctx.percent)}%</span>
          </span>
        )}
      </div>
    </div>
  )
}

export function usageOf(messages: UIMessage[]): UsageUI | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index]
    if (msg.kind === 'assistant' && msg.usage) return msg.usage
  }
  return undefined
}