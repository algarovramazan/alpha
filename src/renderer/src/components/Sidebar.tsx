import { useEffect, useRef, useState } from 'react'
import type { ChatExtra, ChatMeta, Project, SessionPhase } from '@shared/types'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'

export interface SidebarModItem {
  modId: string
  id: string
  title: string
  render(container: HTMLElement): void | (() => void)
}

function ModSidebarRow({ item, version }: { item: SidebarModItem; version: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return item.render(ref.current) ?? undefined
  }, [item, version])
  return <div className="mod-sidebar-row" ref={ref} title={item.title} />
}

interface Props {
  projects: Project[]
  activeProject: string
  chats: ChatMeta[]
  activeChatId: string | null
  phases?: Record<string, SessionPhase>
  modItems?: SidebarModItem[]
  modVersion?: number
  /** Folds the column that shows this panel. */
  onClose?: () => void
  onSelectProject: (id: string) => void
  onSelectChat: (chat: ChatMeta) => void
  onNewChat: () => void
  onBulkDeleted: (ids: string[]) => void
  onChanged: () => void
}

export default function Sidebar({
  projects,
  activeProject,
  chats,
  activeChatId,
  phases = {},
  modItems = [],
  modVersion = 0,
  onClose,
  onSelectProject,
  onSelectChat,
  onNewChat,
  onBulkDeleted,
  onChanged
}: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [globalSearch, setGlobalSearch] = useState(false)
  const [hits, setHits] = useState<{ path: string; chatId: string; preview: string; projectId?: string; projectName?: string }[]>([])
  const [searching, setSearching] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [meta, setMeta] = useState<Record<string, ChatExtra>>({})
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void invoke<Record<string, ChatExtra>>('chats:meta:get', activeProject).then(setMeta).catch(() => setMeta({}))
  }, [activeProject, chats])

  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuFor])

  async function search(value: string): Promise<void> {
    setQuery(value)
    if (value.trim().length < 2) {
      setHits([])
      return
    }
    setSearching(true)
    try {
      setHits(await invoke('chats:search', globalSearch ? 'all' : activeProject, value.trim()))
    } finally {
      setSearching(false)
    }
  }

  async function addProject(): Promise<void> {
    const project = await invoke<Project | null>('projects:add')
    if (project) onChanged()
  }

  async function removeProject(project: Project): Promise<void> {
    await invoke('projects:remove', project.id)
    if (project.id === activeProject) onSelectProject('home')
    onChanged()
  }

  async function setArchived(project: Project, archived: boolean): Promise<void> {
    await invoke('projects:archive', project.id, archived)
    onChanged()
  }

  async function removeChat(chat: ChatMeta): Promise<void> {
    if (!window.confirm(t('side.deleteConfirm'))) return
    await invoke('chats:delete', activeProject, chat.id)
    onChanged()
  }

  async function patchMeta(chat: ChatMeta, patch: ChatExtra): Promise<void> {
    setMeta(await invoke<Record<string, ChatExtra>>('chats:meta:set', activeProject, chat.id, patch))
  }

  function startRename(chat: ChatMeta): void {
    setEditing(chat.id)
    setDraft(chat.name || '')
  }

  function toggleSelected(id: string): void {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  function exitSelectMode(): void {
    setSelectMode(false)
    setSelected(new Set())
  }

  async function bulkDelete(): Promise<void> {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!window.confirm(t('side.bulkConfirm').replace('{n}', String(ids.length)))) return
    for (const id of ids) {
      await invoke('chats:delete', activeProject, id)
    }
    exitSelectMode()
    onBulkDeleted(ids)
    onChanged()
  }

  function commitRename(): void {
    if (!editing) return
    const value = draft.trim()
    void invoke('chats:rename', activeProject, editing, value).then(() => {
      setEditing(null)
      onChanged()
    })
  }

  function selectHit(hit: { path: string; chatId: string; preview: string; projectId?: string }): void {
    onSelectChat({ id: hit.chatId, path: hit.path, mtime: 0, projectId: hit.projectId })
  }

  const allProjects: Project[] = [{ id: 'home', name: t('side.noProject'), path: '~' }, ...projects]
  const visibleProjects = allProjects.filter((project) => project.id === 'home' || !project.archived)
  const archivedProjects = projects.filter((project) => project.archived)

  // pinned chats first, then everything else by recency
  const pinned = chats.filter((chat) => (meta[chat.id] ?? {}).pin)
  const plain = chats.filter((chat) => !(meta[chat.id] ?? {}).pin)

  const chatRow = (chat: ChatMeta): React.JSX.Element => {
    const extra = meta[chat.id] ?? {}
    const phase = phases[chat.id]
    const live = phase === 'working' || phase === 'waiting'
    return (
      <div
        key={chat.id}
        className={`item ${chat.id === activeChatId && !selectMode ? 'active' : ''} ${
          selected.has(chat.id) ? 'checked' : ''
        }`}
        onClick={() => (selectMode ? toggleSelected(chat.id) : onSelectChat(chat))}
      >
        {selectMode && (
          <span className={`checkbox ${selected.has(chat.id) ? 'on' : ''}`}>
            {selected.has(chat.id) && <Icon name="check" size={10} />}
          </span>
        )}
        {!selectMode && extra.pin && (
          <span className="pin-mark" title={t('side.pinned')}>
            <Icon name="pin" size={10} />
          </span>
        )}
        {!selectMode && live && (
          <span
            className={`dot-live ${phase === 'working' ? 'working' : ''}`}
            title={phase === 'working' ? t('status.working') : t('status.waiting')}
          />
        )}
        {editing === chat.id ? (
          <input
            className="rename-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setEditing(null)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="name" title={chat.name || chat.id}>
            {chat.name || chat.id.slice(0, 8)}
            {chat.cwd && chat.cwd.includes('/.alpha/worktrees/') && (
              <span className="hint worktree-mark" title="git worktree">
                <Icon name="git-branch" size={10} />
              </span>
            )}
          </span>
        )}
        <span className="row-actions">
          {!selectMode && (
            <button
              className="icon-btn"
              title={t('side.menu')}
              onClick={(e) => {
                e.stopPropagation()
                setMenuFor(menuFor === chat.id ? null : chat.id)
              }}
            >
              <Icon name="dots" size={12} />
            </button>
          )}
        </span>
        {menuFor === chat.id && !selectMode && (
          <div className="row-menu" onMouseDown={(e) => e.stopPropagation()}>
            <button onClick={() => { setMenuFor(null); void patchMeta(chat, { pin: !extra.pin }) }}>
              {extra.pin ? t('side.unpin') : t('side.pin')}
            </button>
            <button onClick={() => { setMenuFor(null); startRename(chat) }}>{t('side.rename')}</button>
            <button className="danger" onClick={() => { setMenuFor(null); void removeChat(chat) }}>{t('side.delete')}</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-title">
          {t('side.projects')}
          <span className="title-actions">
            <button className="icon-btn" title={t('side.addProject')} onClick={() => void addProject()}>
              <Icon name="add" size={13} />
            </button>
            {onClose && (
              <button className="icon-btn" title={t('panels.close')} onClick={onClose}>
                <Icon name="close-compact" size={13} />
              </button>
            )}
          </span>
        </div>
        {visibleProjects.map((project) => (
          <div
            key={project.id}
            className={`item ${project.id === activeProject ? 'active' : ''}`}
            onClick={() => onSelectProject(project.id)}
          >
            <span className="name">{project.name}</span>
            {project.id !== 'home' && (
              <span className="row-actions">
                <button
                  className="icon-btn"
                  title={t('side.archiveBtn')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void setArchived(project, true)
                  }}
                >
                  <Icon name="archive" size={11} />
                </button>
                <button
                  className="icon-btn"
                  title={t('side.delete')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeProject(project)
                  }}
                >
                  <Icon name="trash" size={11} />
                </button>
              </span>
            )}
          </div>
        ))}
        {archivedProjects.length > 0 && (
          <div className={`archive-block ${archiveOpen ? 'open' : ''}`}>
            <button className="archive-head" onClick={() => setArchiveOpen(!archiveOpen)}>
              <Icon name="archive" size={11} />
              {t('side.archive')}
              <span className="hint">{archivedProjects.length}</span>
            </button>
            {archiveOpen &&
              archivedProjects.map((project) => (
                <div
                  key={project.id}
                  className={`item archived ${project.id === activeProject ? 'active' : ''}`}
                  onClick={() => onSelectProject(project.id)}
                >
                  <span className="name">{project.name}</span>
                  <span className="row-actions">
                    <button
                      className="icon-btn"
                      title={t('side.unarchive')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void setArchived(project, false)
                      }}
                    >
                      <Icon name="undo" size={11} />
                    </button>
                    <button
                      className="icon-btn"
                      title={t('side.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeProject(project)
                      }}
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-title">
          {t('side.chats')}
          <span className="title-actions">
            <button
              className={`icon-btn ${selectMode ? 'on' : ''}`}
              title={selectMode ? t('side.cancel') : t('side.select')}
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            >
              <Icon name="select" size={13} />
            </button>
            <button className="icon-btn" title={t('side.newChat')} onClick={onNewChat}>
              <Icon name="add" size={13} />
            </button>
          </span>
        </div>
        <div className="search-wrap">
          <Icon name="search" size={13} />
          <input
            className="search-input"
            placeholder={t('side.search')}
            value={query}
            onChange={(e) => void search(e.target.value)}
          />
          <button
            className={`icon-btn scope-btn ${globalSearch ? 'on' : ''}`}
            title={t('side.globalSearch')}
            onClick={() => {
              const next = !globalSearch
              setGlobalSearch(next)
              if (query.trim().length >= 2) void search(query)
            }}
          >
            <Icon name="globe" size={12} />
          </button>
        </div>
      </div>

      <div className="chats-scroll">
        {query.trim().length >= 2
          ? hits.map((hit) => (
              <div key={`${hit.projectId ?? activeProject}:${hit.path}`} className="item" onClick={() => selectHit(hit)}>
                <span className="name">
                  {globalSearch && hit.projectName && <span className="hint proj-name">{hit.projectName} · </span>}
                  {hit.preview || hit.chatId}
                </span>
              </div>
            ))
          : [
              pinned.length > 0 && (
                <div key="g-pinned" className="group-label">
                  <Icon name="pin" size={10} />
                  {t('side.pinned')}
                </div>
              ),
              ...pinned.map(chatRow),
              ...plain.map(chatRow)
            ].filter(Boolean)}
        {chats.length === 0 && query.trim().length < 2 && <div className="hint" style={{ padding: '4px 8px' }}>{t('side.empty')}</div>}
        {searching && <div className="hint" style={{ padding: '4px 8px' }}>{t('common.loading')}</div>}
      </div>

      {modItems.length > 0 && (
        <div className="sidebar-section mod-sidebar">
          {modItems.map((item) => (
            <ModSidebarRow key={`${item.modId}:${item.id}`} item={item} version={modVersion} />
          ))}
        </div>
      )}

      {selectMode && (
        <div className="bulk-bar">
          <span className="hint">{t('side.selected').replace('{n}', String(selected.size))}</span>
          <button className="btn small danger" disabled={selected.size === 0} onClick={() => void bulkDelete()}>
            {t('side.delete')}
          </button>
        </div>
      )}
    </div>
  )
}
