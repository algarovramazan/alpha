import { useCallback, useEffect, useState } from 'react'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'

export interface TreeEntry {
  name: string
  path: string
  dir: boolean
}

interface TreeResponse {
  root: string
  entries: TreeEntry[]
}

interface Props {
  projectId: string
  onOpen: (path: string) => void
  /** Folds the column that shows this panel. */
  onClose?: () => void
}

/**
 * Second left panel: a lazy project file tree. One directory level is loaded
 * on expand, so a huge tree never costs a single scan.
 */
export default function FileTree({ projectId, onOpen, onClose }: Props): React.JSX.Element {
  const [root, setRoot] = useState('')
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await invoke<TreeResponse>('file:tree', projectId)
      setRoot(response.root)
      setChildren({ [response.root]: response.entries })
      setExpanded(new Set())
    } catch {
      setChildren({})
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) {
          next.delete(path)
          return next
        }
        next.add(path)
        return next
      })
      if (children[path]) return
      void invoke<TreeResponse>('file:tree', projectId, path).then((response) => {
        setChildren((current) => ({ ...current, [path]: response.entries }))
      })
    },
    [children, projectId]
  )

  function rows(dirPath: string, depth: number): React.ReactNode {
    const entries = children[dirPath]
    if (!entries) return null
    if (entries.length === 0) {
      return (
        <div className="tree-row empty" style={{ paddingLeft: `${10 + depth * 12}px` }}>
          {t('tree.empty')}
        </div>
      )
    }
    return entries.map((entry) => (
      <div key={entry.path}>
        <div
          className="tree-row"
          style={{ paddingLeft: `${6 + depth * 12}px` }}
          title={entry.path}
          onClick={() => (entry.dir ? toggle(entry.path) : onOpen(entry.path))}
        >
          <span className={`tree-caret ${expanded.has(entry.path) ? 'on' : ''} ${entry.dir ? '' : 'blank'}`}>
            {entry.dir && <Icon name="chevron-right" size={10} />}
          </span>
          <span className={`tree-name ${entry.dir ? 'dir' : ''}`}>{entry.name}</span>
        </div>
        {entry.dir && expanded.has(entry.path) && rows(entry.path, depth + 1)}
      </div>
    ))
  }

  const rootName = root.split('/').filter(Boolean).pop() ?? root

  return (
    <div className="filetree">
      <div className="sidebar-title tree-head">
        <span className="tree-root" title={root}>
          <Icon name="folder" size={13} />
          {t('tree.title')}
          {rootName && <span className="hint"> · {rootName}</span>}
        </span>
        <span className="title-actions">
          <button className="icon-btn" title={t('tree.refresh')} onClick={() => void load()}>
            <Icon name="refresh" size={12} />
          </button>
          {onClose && (
            <button className="icon-btn" title={t('panels.close')} onClick={onClose}>
              <Icon name="close-compact" size={13} />
            </button>
          )}
        </span>
      </div>
      <div className="tree-scroll">
        {loading && !root && <div className="hint tree-row">{t('common.loading')}</div>}
        {root && rows(root, 0)}
      </div>
    </div>
  )
}
