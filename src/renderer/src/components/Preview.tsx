import { useEffect, useState } from 'react'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'
import { renderMarkdown } from '../markdown'

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

function kind(path: string): 'html' | 'md' | 'text' {
  const name = fileName(path).toLowerCase()
  if (name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'md'
  return 'text'
}

/**
 * Artifacts tab: files the model wrote (write/edit) rendered in place.
 * The frame mounts only when the content is ready — a sandboxed srcdoc frame
 * that mounts empty never repaints after the attribute update.
 */
export default function Preview({ paths }: { paths: string[] }): React.JSX.Element {
  const [selected, setSelected] = useState('')
  const [loaded, setLoaded] = useState<{ path: string; html: string; stamp: number } | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (paths.length === 0) {
      if (selected) setSelected('')
      return
    }
    if (!selected || !paths.includes(selected)) setSelected(paths[0])
  }, [paths, selected])

  useEffect(() => {
    if (!selected) {
      setLoaded(null)
      return
    }
    setLoaded(null)
    let stale = false
    void invoke<string>('file:read', selected)
      .then((text) => {
        if (!stale) setLoaded({ path: selected, html: text, stamp: Date.now() })
      })
      .catch(() => {
        if (!stale) setLoaded({ path: selected, html: '', stamp: Date.now() })
      })
    return () => {
      stale = true
    }
  }, [selected, reload])

  if (paths.length === 0) {
    return (
      <div className="preview">
        <div className="empty-state preview-empty">{t('preview.empty')}</div>
      </div>
    )
  }

  const ready = loaded && loaded.path === selected
  const type = kind(selected)

  return (
    <div className="preview">
      <div className="preview-bar">
        <select className="nav-select preview-select" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {paths.map((path) => (
            <option key={path} value={path}>
              {fileName(path)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="icon-btn" title={t('preview.refresh')} onClick={() => setReload((n) => n + 1)}>
          <Icon name="refresh" size={14} />
        </button>
        <button
          className="icon-btn"
          title={t('preview.openBrowser')}
          onClick={() => void invoke('shell:openPath', selected)}
        >
          <Icon name="external" size={14} />
        </button>
        <button
          className="icon-btn"
          title={t('preview.open')}
          onClick={() => void invoke('shell:open', selected)}
        >
          <Icon name="export" size={14} />
        </button>
      </div>

      <div className="preview-body">
        {!ready && <div className="preview-loading">{t('common.loading')}</div>}
        {ready && type === 'html' && (
          <iframe
            key={`${selected}:${reload}`}
            className="preview-frame"
            sandbox="allow-scripts"
            srcDoc={loaded.html}
            title={fileName(selected)}
          />
        )}
        {ready && type === 'md' && (
          <div className="md preview-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(loaded.html) }} />
        )}
        {ready && type === 'text' && <pre className="log preview-text">{loaded.html}</pre>}
      </div>
    </div>
  )
}