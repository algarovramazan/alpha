import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContextDetail, KbItem, UIMessage, UsageUI } from '@shared/types'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'

/** The generated codebase map: a file in the project root, listed in the knowledge base. */
const MAP_NAME = 'PROJECT.md'
/** The title the main process gives the map in the list of injected context parts. */
const MAP_PART = 'Codebase map (PROJECT.md)'

interface Props {
  messages: UIMessage[]
  status: 'idle' | 'working' | 'waiting' | 'error'
  statusMessage?: string
  projectId: string
  chatId: string | null
  /** Cumulative tokens and cost of the whole chat (feature: live totals). */
  chatUsage?: UsageUI
  onToast: (text: string) => void
  /** Folds the column that shows this panel. */
  onClose?: () => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lastAssistant(messages: UIMessage[]): Extract<UIMessage, { kind: 'assistant' }> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.kind === 'assistant') return msg
  }
  return null
}

function filesFromTools(message: Extract<UIMessage, { kind: 'assistant' }> | null): string[] {
  if (!message) return []
  const files = new Set<string>()
  for (const call of message.toolCalls) {
    if (!['write', 'edit', 'read'].includes(call.name)) continue
    try {
      const args = JSON.parse(call.args) as { path?: string; file_path?: string }
      const path = args.path ?? args.file_path
      if (path) files.add(path)
    } catch {
      // args are not json, skip
    }
  }
  return [...files]
}

/**
 * Collapsible section. `openSignal` is a counter: bumping it opens the section
 * from outside (run errors, a finished map build) without a click.
 */
function Section({
  title,
  children,
  defaultOpen = true,
  badge,
  openSignal
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
  badge?: string
  openSignal?: number
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (openSignal) setOpen(true)
  }, [openSignal])
  return (
    <div className="insp-section">
      <button className="insp-section-head" onClick={() => setOpen(!open)}>
        <span className={`caret ${open ? 'open' : ''}`}>
          <Icon name="chevron-right" size={12} />
        </span>
        <span>{title}</span>
        {badge && <span className="hint">{badge}</span>}
      </button>
      {open && <div className="insp-section-body">{children}</div>}
    </div>
  )
}

function tok(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export default function Inspector({
  messages,
  status,
  statusMessage,
  projectId,
  chatId,
  chatUsage,
  onToast,
  onClose
}: Props): React.JSX.Element {
  const [openCall, setOpenCall] = useState<string | null>(null)
  const assistant = lastAssistant(messages)
  const files = useMemo(() => filesFromTools(assistant), [assistant])
  const tokens = assistant?.usage?.tokens ?? 0

  // ------------------------------------------------------------ context
  const [detail, setDetail] = useState<ContextDetail | null>(null)
  // Errors pop the tools section open so the failing call is one glance away.
  const [errorTick, setErrorTick] = useState(0)
  useEffect(() => {
    if (status === 'error') setErrorTick((tick) => tick + 1)
  }, [status])
  const refreshContext = useCallback(() => {
    void invoke<ContextDetail>('context:detail', projectId, chatId ?? undefined)
      .then(setDetail)
      .catch(() => setDetail(null))
  }, [projectId, chatId])
  // Refresh on every change of the chat and of the run state: the injected
  // list and the pending flag move with each prompt.
  useEffect(() => {
    refreshContext()
  }, [refreshContext, status])

  // ------------------------------------------------------------- memory
  const [memory, setMemory] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)
  const loadMemory = useCallback(() => {
    void invoke<string>('memory:get', projectId)
      .then((text) => {
        setMemory(text)
        setMemoryDirty(false)
      })
      .catch(() => undefined)
  }, [projectId])
  useEffect(() => {
    loadMemory()
  }, [loadMemory])
  // The model writes memory through its tool: reload once a run settles,
  // unless the user is typing in the field right now.
  useEffect(() => {
    if (status === 'idle' && !memoryDirty) loadMemory()
  }, [status, memoryDirty, loadMemory])

  // --------------------------------------------------------- knowledge
  const [kb, setKb] = useState<KbItem[]>([])
  const [kbFile, setKbFile] = useState<string | null>(null)
  const [kbText, setKbText] = useState('')
  const [kbDirty, setKbDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  // Counters that open the sections: a finished map build must show its result.
  const [kbSignal, setKbSignal] = useState(0)
  const [ctxSignal, setCtxSignal] = useState(0)
  // The map row flashes once after a build so the eye finds where the result went.
  const [flash, setFlash] = useState<string | null>(null)

  const refreshKb = useCallback(() => {
    void invoke<KbItem[]>('kb:list', projectId).then(setKb).catch(() => setKb([]))
  }, [projectId])
  useEffect(() => {
    refreshKb()
    setKbFile(null)
    setKbDirty(false)
  }, [refreshKb])
  // Documents and the map also change outside this panel (the model writes
  // notes, the map builds in the background): refresh when a run settles.
  useEffect(() => {
    if (status === 'idle') refreshKb()
  }, [status, refreshKb])

  useEffect(() => {
    if (!flash) return
    const scroll = setTimeout(() => {
      document.querySelector(`[data-kb="${flash}"]`)?.scrollIntoView({ block: 'nearest' })
    }, 80)
    const clear = setTimeout(() => setFlash(null), 2200)
    return () => {
      clearTimeout(scroll)
      clearTimeout(clear)
    }
  }, [flash])

  function confirmDiscard(): boolean {
    return !kbDirty || window.confirm(t('kb.discardConfirm'))
  }

  async function openKb(name: string): Promise<void> {
    if (kbFile === name) {
      if (!confirmDiscard()) return
      setKbFile(null)
      setKbDirty(false)
      return
    }
    if (!confirmDiscard()) return
    try {
      setKbText(await invoke<string>('kb:read', projectId, name))
      setKbFile(name)
      setKbDirty(false)
    } catch (error) {
      onToast(errorText(error))
    }
  }

  async function saveKb(): Promise<void> {
    if (!kbFile) return
    try {
      await invoke('kb:save', projectId, kbFile, kbText)
      setKbDirty(false)
      onToast(t('set.saved'))
      refreshKb()
      refreshContext()
    } catch (error) {
      onToast(errorText(error))
    }
  }

  async function newKb(): Promise<void> {
    const name = window.prompt(t('kb.newName'), 'notes')
    if (!name) return
    try {
      await invoke<string>('kb:new', projectId, name)
      refreshKb()
      refreshContext()
    } catch (error) {
      onToast(errorText(error))
    }
  }

  async function importKb(): Promise<void> {
    try {
      const path = await invoke<string | null>('kb:add', projectId)
      if (path) {
        refreshKb()
        refreshContext()
      }
    } catch (error) {
      onToast(errorText(error))
    }
  }

  async function deleteKb(name: string): Promise<void> {
    if (!window.confirm(`${t('side.delete')} — ${name}?`)) return
    try {
      await invoke('kb:delete', projectId, name)
      if (kbFile === name) {
        setKbFile(null)
        setKbDirty(false)
      }
      refreshKb()
      refreshContext()
    } catch (error) {
      onToast(errorText(error))
    }
  }

  async function buildMap(): Promise<void> {
    setBusy(true)
    try {
      const file = await invoke<string>('codemap:build', projectId)
      onToast(`${t('kb.mapBuilt')}: ${file}`)
      refreshKb()
      refreshContext()
      setKbSignal((value) => value + 1)
      setCtxSignal((value) => value + 1)
      setFlash(MAP_NAME)
    } catch (error) {
      onToast(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  // What the map means for the next prompt, stated plainly for the user.
  const mapEntry = kb.find((item) => item.map)
  const mapInContext = Boolean(detail?.injected.includes(MAP_PART))
  const mapHint = mapEntry
    ? !mapInContext
      ? t('kb.mapPending')
      : detail?.pending
        ? t('kb.mapStale')
        : t('kb.mapReady')
    : null

  return (
    <div>
      <div className="insp-title insp-head">
        <span>{t('ins.title')}</span>
        {onClose && (
          <button className="icon-btn" title={t('panels.close')} onClick={onClose}>
            <Icon name="close-compact" size={13} />
          </button>
        )}
      </div>

      <div className="kv">
        <span className="k">{t('status.idle')}</span>
        <span className={`status-pill ${status}`}>{status === 'idle' ? t('status.idle') : status === 'working' ? t('status.working') : status === 'waiting' ? t('status.waiting') : t('status.error')}</span>
      </div>
      {statusMessage && <div className="hint">{statusMessage}</div>}

      <div className="kv">
        <span className="k">{t('ins.run')}</span>
        <span className="v">{tokens ? `${tokens} tok` : '—'}</span>
      </div>
      <div className="kv">
        <span className="k" title={t('ins.chatTotalHint')}>
          {t('ins.chatTotal')}
        </span>
        <span className="v">
          {chatUsage && chatUsage.tokens > 0
            ? `${tok(chatUsage.tokens)} tok${chatUsage.cost ? ` · $${chatUsage.cost.toFixed(3)}` : ''}`
            : '—'}
        </span>
      </div>

      <Section title={t('ins.tools')} openSignal={errorTick}>
        {assistant?.toolCalls.length ? (
          assistant.toolCalls.map((call) => (
            <div key={call.callId} className="kv" style={{ cursor: 'pointer' }} onClick={() => setOpenCall(openCall === call.callId ? null : call.callId)}>
              <span className="k" style={{ fontFamily: 'var(--font-code)' }}>
                {call.name}
              </span>
              <span className="v">{call.running ? '…' : call.isError ? 'err' : `${call.durationMs ?? 0}ms`}</span>
            </div>
          ))
        ) : (
          <div className="hint">{t('ins.none')}</div>
        )}
        {openCall && (
          <pre className="log" style={{ marginTop: 8 }}>
            {(assistant?.toolCalls.find((c) => c.callId === openCall)?.args ?? '') +
              (assistant?.toolCalls.find((c) => c.callId === openCall)?.result
                ? `\n\n${assistant?.toolCalls.find((c) => c.callId === openCall)?.result}`
                : '')}
          </pre>
        )}
      </Section>

      <Section title={t('ins.files')}>
        {files.length ? files.map((file) => <div key={file} className="file-row" title={file}>{file}</div>) : <div className="hint">{t('ins.none')}</div>}
      </Section>

      <Section title={t('ins.context')} defaultOpen openSignal={ctxSignal} badge={detail && detail.window > 0 ? `${detail.percent}%` : undefined}>
        {detail ? (
          <>
            <div className="kv">
              <span className="k">{t('ins.contextTotal')}</span>
              <span className="v">
                {tok(detail.total)}
                {detail.window > 0 ? ` / ${tok(detail.window)}` : ''}
              </span>
            </div>
            {detail.parts.map((part) => (
              <div key={part.key} className="ctx-part" title={`${part.label}: ${part.tokens} tok`}>
                <span className="ctx-part-label">{part.label}</span>
                <span className="ctx-track">
                  <span
                    className="ctx-fill"
                    style={{ width: `${detail.total > 0 ? Math.min(100, (part.tokens / detail.total) * 100) : 0}%` }}
                  />
                </span>
                <span className="ctx-part-tok">{tok(part.tokens)}</span>
              </div>
            ))}
            {detail.pending && <div className="hint ctx-pending">{t('ins.contextPending')}</div>}
            {detail.injected.length > 0 && (
              <div className="ctx-injected" title={t('ins.injectedHint')}>
                <span className="hint">{t('ins.injected')}:</span>
                {detail.injected.map((name) => (
                  <span className="risk-chip" key={name}>
                    {name}
                  </span>
                ))}
              </div>
            )}
            <div className="form-row">
              <button className="btn small" onClick={refreshContext}>
                <Icon name="refresh" size={12} />
                {t('common.refresh')}
              </button>
            </div>
          </>
        ) : (
          <div className="hint">{t('ins.none')}</div>
        )}
      </Section>

      <Section title={t('ins.memory')} defaultOpen={false} badge={memory.trim() ? undefined : t('ins.empty')}>
        <textarea
          className="memory-edit"
          spellCheck={false}
          placeholder={t('ins.memoryHint')}
          value={memory}
          onChange={(event) => {
            setMemory(event.target.value)
            setMemoryDirty(true)
          }}
        />
        <div className="form-row">
          <button
            className="btn small primary"
            disabled={!memoryDirty}
            onClick={() =>
              void invoke('memory:set', projectId, memory)
                .then(() => {
                  setMemoryDirty(false)
                  onToast(t('set.saved'))
                  refreshContext()
                })
                .catch((error) => onToast(errorText(error)))
            }
          >
            {t('set.save')}
          </button>
          <button className="btn small" onClick={loadMemory}>
            {t('common.cancel')}
          </button>
        </div>
        <p className="hint">{t('ins.memoryModelHint')}</p>
      </Section>

      <Section title={t('ins.knowledge')} defaultOpen={false} openSignal={kbSignal} badge={kb.length ? String(kb.length) : t('ins.empty')}>
        <div className="form-row">
          <button className="btn small" onClick={() => void newKb()}>
            <Icon name="add" size={12} />
            {t('kb.new')}
          </button>
          <button className="btn small" onClick={() => void importKb()}>
            <Icon name="upload" size={12} />
            {t('kb.add')}
          </button>
          <button className="btn small" disabled={busy} onClick={() => void buildMap()}>
            <Icon name="layers" size={12} />
            {busy ? '…' : t('kb.map')}
          </button>
        </div>
        {kb.length === 0 && <div className="hint">{t('kb.empty')}</div>}
        {kb.map((item) => (
          <div
            key={item.name}
            data-kb={item.name}
            className={`file-row kb-row ${item.map ? 'map' : ''} ${flash === item.name ? 'flash' : ''}`}
            onClick={() => void openKb(item.name)}
          >
            <span className="grow mono kb-name">
              {kbFile === item.name ? '▾' : '▸'} {item.name}
            </span>
            {item.map && <span className="risk-chip">{t('kb.mapBadge')}</span>}
            <span className="hint">{Math.max(1, Math.round(item.size / 1024))}kb</span>
            <button
              className="icon-btn"
              title={t('side.delete')}
              onClick={(event) => {
                event.stopPropagation()
                void deleteKb(item.name)
              }}
            >
              <Icon name="trash" size={11} />
            </button>
          </div>
        ))}
        {mapHint && <div className="hint kb-map-status">{mapHint}</div>}
        {kbFile && (
          <>
            <div className="kb-editing hint">
              {kbFile}
              {kbDirty ? ` · ${t('kb.unsaved')}` : ''}
            </div>
            <textarea
              className="memory-edit"
              spellCheck={false}
              value={kbText}
              onChange={(event) => {
                setKbText(event.target.value)
                setKbDirty(true)
              }}
            />
            <div className="form-row">
              <button className="btn small primary" disabled={!kbDirty} onClick={() => void saveKb()}>
                {t('set.save')}
              </button>
            </div>
          </>
        )}
        <p className="hint">{t('kb.hint')}</p>
      </Section>
    </div>
  )
}
