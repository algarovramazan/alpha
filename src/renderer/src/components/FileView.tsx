import { useEffect, useState } from 'react'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'
import { renderMarkdown } from '../markdown'
import { highlightCode, langFor } from '../highlight'

interface Props {
  path: string
  onToast: (text: string) => void
}

const PREVIEWABLE = ['md', 'markdown', 'pdf', 'html', 'htm']
const MAX_CHARS = 600_000
const NUL = String.fromCharCode(0)

function extension(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
}

/** Viewer for files picked in the file tree: highlighted code plus preview for md/pdf/html. */
export default function FileView({ path, onToast }: Props): React.JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'binary' | 'big'>('loading')
  const [preview, setPreview] = useState(false)

  const name = path.split('/').pop() ?? path
  const ext = extension(path)
  const canPreview = PREVIEWABLE.includes(ext)

  useEffect(() => {
    let alive = true
    setContent(null)
    setState('loading')
    setPreview(false)
    void invoke<string>('file:read', path).then((text) => {
      if (!alive) return
      if (text.length > MAX_CHARS) {
        setState('big')
        return
      }
      if (text.includes(NUL)) {
        setState('binary')
        return
      }
      setContent(text)
      setState('ready')
    })
    return () => {
      alive = false
    }
  }, [path])

  function openExternal(): void {
    void invoke<boolean>('shell:openPath', path).then((ok) =>
      onToast(ok ? t('tree.opened') : t('tree.openFail'))
    )
  }

  function body(): React.JSX.Element {
    if (state === 'loading') return <div className="empty-state">{t('common.loading')}</div>
    if (state === 'binary') {
      return (
        <div className="empty-state">
          {t('file.binary')}
          <br />
          <button className="btn small" onClick={openExternal}>
            {t('file.external')}
          </button>
        </div>
      )
    }
    if (state === 'big') return <div className="empty-state">{t('file.big')}</div>
    if (preview && ext === 'md') {
      return (
        <div className="file-scroll">
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content ?? '') }} />
        </div>
      )
    }
    if (preview && (ext === 'html' || ext === 'htm'))
      return <iframe className="file-frame" title={name} srcDoc={content ?? ''} sandbox="" />
    if (preview && ext === 'pdf') return <iframe className="file-frame" title={name} src={`file://${path}`} />
    return (
      <div className="file-scroll">
        <pre
          className="code-view"
          dangerouslySetInnerHTML={{ __html: highlightCode(content ?? '', langFor(name)) }}
        />
      </div>
    )
  }

  return (
    <div className="fileview">
      <div className="term-bar">
        <span className="term-title">
          <Icon name="file-tree" size={12} />
          {name}
        </span>
        <span className="term-cwd" title={path}>
          {path}
        </span>
        <span className="spacer" />
        {canPreview && state === 'ready' && (
          <button className="btn small" onClick={() => setPreview((value) => !value)}>
            <Icon name="eye" size={12} />
            {preview ? t('file.code') : t('file.preview')}
          </button>
        )}
        <button className="btn small" onClick={openExternal}>
          <Icon name="external" size={12} />
          {t('file.external')}
        </button>
      </div>
      {body()}
    </div>
  )
}
