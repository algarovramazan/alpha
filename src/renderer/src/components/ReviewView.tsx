import { useCallback, useEffect, useState } from 'react'
import type { CheckpointInfo, ReviewStatus } from '@shared/types'
import { invoke } from '../api'
import { Icon } from '../Icon'
import { t } from '../i18n'

interface Props {
  projectId: string
  chatId: string | null
  onToast: (text: string) => void
}

function DiffBody({ diff }: { diff: string }): React.JSX.Element {
  const lines = diff.split('\n').slice(0, 1500)
  return (
    <div className="diff">
      {lines.map((line, index) => {
        const kind = line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+') && !line.startsWith('+++')
            ? 'add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'del'
              : 'ctx'
        return (
          <div key={index} className={`diff-line ${kind}`}>
            {kind === 'add' ? '+' : kind === 'del' ? '-' : kind === 'hunk' ? '' : ' '}
            {line}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Review tab: working-tree diffs with per-file revert, one-click WIP commit
 * and the checkpoint list of the active chat (roll the workspace back).
 */
export default function ReviewView({ projectId, chatId, onToast }: Props): React.JSX.Element {
  const [status, setStatus] = useState<ReviewStatus | null>(null)
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([])
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<ReviewStatus>('review:status', projectId))
      if (chatId) setCheckpoints(await invoke<CheckpointInfo[]>('checkpoint:list', chatId))
      else setCheckpoints([])
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    }
  }, [projectId, chatId, onToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function revert(path: string): Promise<void> {
    if (!window.confirm(t('review.revertConfirm').replace('{path}', path))) return
    try {
      await invoke('review:revert', projectId, path)
      onToast(t('review.reverted'))
      await refresh()
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    }
  }

  async function commit(): Promise<void> {
    setBusy(true)
    try {
      const hash = await invoke<string>('review:commit', projectId, message)
      onToast(`${t('review.committed')} ${hash}`)
      setMessage('')
      await refresh()
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function restore(id: string): Promise<void> {
    if (!chatId || !window.confirm(t('ck.restoreConfirm'))) return
    try {
      const summary = await invoke<string>('checkpoint:restore', projectId, chatId, id)
      onToast(`${t('ck.restored')}: ${summary}`)
      await refresh()
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    }
  }

  if (status && !status.git) {
    return (
      <div className="empty-state">
        {t('review.notGit')}
        <br />
        <span className="hint">{t('review.notGitHint')}</span>
      </div>
    )
  }

  const added = status?.files.reduce((sum, file) => sum + file.added, 0) ?? 0
  const removed = status?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0

  return (
    <div className="review-view">
      <div className="sessions-head">
        <span className="insp-title">{t('review.title')}</span>
        <span className="hint">
          {status ? `${status.branch} · ${t('review.files').replace('{n}', String(status.files.length))}` : '…'}
        </span>
        <span className="hint mono">
          +{added} / −{removed}
        </span>
        <button className="icon-btn" title={t('common.refresh')} onClick={() => void refresh()}>
          <Icon name="refresh" size={13} />
        </button>
      </div>

      <div className="review-commit">
        <input
          placeholder={t('review.commitHint')}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (status?.files.length ?? 0) > 0) void commit()
          }}
        />
        <button
          className="btn primary small"
          disabled={busy || !status || status.files.length === 0}
          onClick={() => void commit()}
        >
          <Icon name="git-commit" size={13} />
          {t('review.commit')}
        </button>
      </div>

      <div className="review-files">
        {!status && <div className="hint">{t('common.loading')}</div>}
        {status && status.files.length === 0 && (
          <div className="empty-state">
            {t('review.clean')}
            <br />
            <span className="hint">{t('review.cleanHint')}</span>
          </div>
        )}
        {status?.files.map((file) => (
          <div key={file.path} className="review-file">
            <div className="review-file-head" onClick={() => setOpenFile(openFile === file.path ? null : file.path)}>
              <span className={`caret ${openFile === file.path ? 'open' : ''}`}>
                <Icon name="chevron-right" size={12} />
              </span>
              <span className={`review-status ${file.status === '??' ? 'new' : ''}`}>{file.status.trim() || 'M'}</span>
              <span className="mono review-path">{file.path}</span>
              <span className="hint">
                +{file.added} / −{file.removed}
              </span>
              <button
                className="btn small"
                title={t('review.revert')}
                onClick={(event) => {
                  event.stopPropagation()
                  void revert(file.path)
                }}
              >
                <Icon name="undo" size={12} />
              </button>
            </div>
            {openFile === file.path && <DiffBody diff={file.diff} />}
          </div>
        ))}
      </div>

      <div className="sessions-head">
        <span className="insp-title">{t('review.checkpoints')}</span>
        <span className="hint">{t('review.checkpointsHint')}</span>
      </div>
      <div className="review-files">
        {checkpoints.length === 0 && <div className="hint">{t('ck.none')}</div>}
        {checkpoints.map((checkpoint) => (
          <div key={checkpoint.id} className="session-row">
            <Icon name="layers" size={13} />
            <span className="mono">{new Date(checkpoint.ts).toLocaleString()}</span>
            <span className="hint">
              {checkpoint.files} {t('review.filesLower')}
            </span>
            <button className="btn small" onClick={() => void restore(checkpoint.id)}>
              <Icon name="undo" size={12} />
              {t('ck.restore')}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}