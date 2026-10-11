import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteInfo } from '@shared/types'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'
import { renderMarkdown } from '../markdown'

type CreateKind = '' | 'note' | 'folder' | 'rename' | 'folderRename'

/**
 * Notes — Obsidian-like personal markdown, NOT a second brain.
 * The agent may change notes only on a direct request (see AGENTS.md);
 * this view is purely manual: folders (nested), tags, editor, preview,
 * import, drag-and-drop between folders, rename of notes and folders.
 */
export default function NotesView({ onToast }: { onToast: (text: string) => void }): React.JSX.Element {
  const [notes, setNotes] = useState<NoteInfo[]>([])
  const [fsFolders, setFsFolders] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [dirty, setDirty] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [creating, setCreating] = useState<CreateKind>('')
  const [draft, setDraft] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Refs feed the autosave timer: a state closure would capture stale text.
  const contentRef = useRef('')
  const selectedRef = useRef<string | null>(null)
  const savedRef = useRef('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveSeq = useRef(0)
  contentRef.current = content
  selectedRef.current = selected
  savedRef.current = saved

  const refresh = async (): Promise<NoteInfo[]> => {
    const list = await invoke<NoteInfo[]>('notes:list')
    setNotes(list)
    void invoke<string[]>('notes:folders').then(setFsFolders).catch(() => setFsFolders([]))
    return list
  }
  useEffect(() => {
    void refresh()
  }, [])

  // auto-open the newest note once, so the view never opens blank
  useEffect(() => {
    if (selected === null && notes.length > 0) {
      setSelected(notes[0].path)
      void invoke<string>('notes:read', notes[0].path).then((text) => {
        setContent(text)
        setSaved(text)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes.length])

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const note of notes) for (const tag of note.tags) set.add(tag)
    return [...set].sort()
  }, [notes])

  const visible = useMemo(
    () =>
      notes.filter(
        (note) =>
          (!tagFilter || note.tags.includes(tagFilter)) &&
          (!filter.trim() ||
            note.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
            note.tags.some((tag) => tag.includes(filter.trim().toLowerCase())))
      ),
    [notes, filter, tagFilter]
  )

  const folderSet = useMemo(() => {
    const set = new Set<string>(fsFolders)
    for (const note of visible) if (note.folder) set.add(note.folder)
    return [...set].sort()
  }, [fsFolders, visible])

  const rootNotes = useMemo(() => visible.filter((note) => !note.folder), [visible])
  const notesIn = (folder: string): NoteInfo[] => visible.filter((note) => note.folder === folder)

  const current = notes.find((note) => note.path === selected)

  async function open(note: NoteInfo): Promise<void> {
    // Autosave replaces the old "unsaved changes" confirm: flush, then switch.
    if (dirty) await save(true)
    const text = await invoke<string>('notes:read', note.path)
    setSelected(note.path)
    setContent(text)
    setSaved(text)
    setSavedAt(null)
    setDirty(false)
    setMode('edit')
  }

  /** Saves the current note. Silent saves are autosave: no toast, no refresh noise. */
  async function save(silent = false): Promise<void> {
    const path = selectedRef.current
    const text = contentRef.current
    if (!path || text === savedRef.current) {
      setDirty(false)
      return
    }
    const seq = ++saveSeq.current
    try {
      await invoke('notes:save', path, text)
      if (saveSeq.current !== seq) return // a newer save already won
      setSaved(text)
      setDirty(false)
      setSavedAt(new Date())
      void refresh()
      if (!silent) onToast(t('notes.saved'))
    } catch (error) {
      if (silent) {
        // retry shortly; dirty stays so nothing looks saved that is not
        if (saveTimer.current === null) {
          saveTimer.current = setTimeout(() => {
            saveTimer.current = null
            void save(true)
          }, 3000)
        }
      } else {
        onToast(error instanceof Error ? error.message : String(error))
      }
    }
  }

  function scheduleAutosave(): void {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void save(true)
    }, 800)
  }

  // Leaving the view or the window still flushes pending text.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      if (selectedRef.current && contentRef.current !== savedRef.current) {
        void invoke('notes:save', selectedRef.current, contentRef.current)
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function remove(): Promise<void> {
    if (!selected) return
    if (!window.confirm(t('notes.deleteConfirm'))) return
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    await invoke('notes:delete', selected)
    setSelected(null)
    setContent('')
    setSaved('')
    setDirty(false)
    await refresh()
  }

  function startCreate(kind: CreateKind): void {
    setCreating(kind)
    setDraft(kind === 'folderRename' && renamingFolder ? renamingFolder : '')
    setMode('edit')
  }

  function commit(): void {
    const value = draft.trim()
    const kind = creating
    const editPath = selected
    const editFolder = renamingFolder
    setCreating('')
    setRenamingFolder(null)
    setDraft('')
    if (!value) return
    if (kind === 'note') {
      const clean = value.replace(/[\\/:*?"<>|]/g, '-').replace(/\.md$/, '')
      const folder = (notes.find((note) => note.path === editPath)?.folder) ?? ''
      const path = folder ? `${folder}/${clean}.md` : `${clean}.md`
      void invoke('notes:save', path, `# ${clean}\n\n`)
        .then(refresh)
        .then(() => open({ path, name: clean, folder, mtime: Date.now(), tags: [] }))
    } else if (kind === 'folder') {
      const clean = value.replace(/(^\/+|\/+$)/g, '').replace(/[\\:*?"<>|]/g, '-')
      void invoke('notes:mkdir', clean).then(refresh)
    } else if (kind === 'rename' && editPath) {
      const clean = value.replace(/^\/+/, '').replace(/[\\:*?"<>|]/g, '-').replace(/\.md$/, '')
      void invoke<string>('notes:rename', editPath, `${clean}.md`)
        .then(() => {
          setSelected(`${clean}.md`)
          setDirty(false)
          return refresh()
        })
        .then(() => onToast(t('notes.renamed')))
        .catch((error) => onToast(error instanceof Error ? error.message : String(error)))
    } else if (kind === 'folderRename' && editFolder) {
      void invoke<string>('notes:folderRename', editFolder, value.replace(/(^\/+|\/+$)/g, '').replace(/[\\:*?"<>|]/g, '-'))
        .then(() => {
          if (editPath?.startsWith(`${editFolder}/`)) setSelected(`${value}/${editPath.slice(editFolder.length + 1)}`)
          return refresh()
        })
        .catch((error) => onToast(error instanceof Error ? error.message : String(error)))
    }
  }

  async function moveNote(path: string, folder: string): Promise<void> {
    const name = path.split('/').pop()!
    const target = folder ? `${folder}/${name}` : name
    if (target === path) return
    try {
      await invoke<string>('notes:rename', path, target)
      if (selected === path) setSelected(target)
      await refresh()
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    }
  }

  async function importNotes(): Promise<void> {
    const count = await invoke<number>('notes:import')
    if (count > 0) {
      await refresh()
      onToast(t('notes.imported').replace('{n}', String(count)))
    }
  }

  function edit(text: string): void {
    setContent(text)
    setDirty(text !== saved)
    scheduleAutosave()
  }

  function toggleCollapse(folder: string): void {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }

  const groupLabel = (folder: string, count: number): React.JSX.Element => (
    <div
      className={`group-label drop-target ${dropTarget === folder ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropTarget(folder)
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation() // the root drop zone sits below this one
        setDropTarget(null)
        const id = e.dataTransfer.getData('text/plain') || dragging
        if (id) void moveNote(id, folder)
        setDragging(null)
      }}
    >
      <button className="group-caret" onClick={() => toggleCollapse(folder)}>
        <Icon name="chevron-right" size={11} className={collapsed.has(folder) ? '' : 'rotated'} />
      </button>
      <span className="grow">{folder}</span>
      <span className="hint">{count}</span>
      <button
        className="icon-btn"
        title={t('notes.renameFolder')}
        onClick={(e) => {
          e.stopPropagation()
          setRenamingFolder(folder)
          startCreate('folderRename')
        }}
      >
        <Icon name="pencil" size={10} />
      </button>
    </div>
  )

  const noteRow = (note: NoteInfo): React.JSX.Element => (
    <div
      key={note.path}
      className={`item ${selected === note.path ? 'active' : ''}`}
      draggable={!creating}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', note.path)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(note.path)
      }}
      onDragEnd={() => setDragging(null)}
      onClick={() => void open(note)}
    >
      <span className="name" title={note.path}>
        {note.name}
      </span>
      {note.tags.length > 0 && <span className="hint">{note.tags.length}</span>}
    </div>
  )

  return (
    <div className="notes">
      <div className="notes-side">
        <div className="notes-toolbar">
          <span className="notes-title">
            <Icon name="note" size={14} />
            {t('view.notes')}
          </span>
          <span className="row-actions">
            <button className="icon-btn" title={t('notes.new')} onClick={() => startCreate('note')}>
              <Icon name="note-plus" size={13} />
            </button>
            <button className="icon-btn" title={t('notes.newFolder')} onClick={() => startCreate('folder')}>
              <Icon name="folder-plus" size={13} />
            </button>
            <button className="icon-btn" title={t('notes.import')} onClick={() => void importNotes()}>
              <Icon name="upload" size={13} />
            </button>
          </span>
        </div>
        {creating ? (
          <div className="search-wrap">
            <Icon name={creating === 'folder' || creating === 'folderRename' ? 'folder-plus' : 'pencil'} size={13} />
            <input
              ref={inputRef}
              className="search-input"
              placeholder={
                creating === 'note'
                  ? t('notes.new')
                  : creating === 'folder'
                    ? t('notes.newFolder')
                    : creating === 'folderRename'
                      ? t('notes.renameFolder')
                      : t('notes.renameTitle')
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                else if (e.key === 'Escape') {
                  setCreating('')
                  setRenamingFolder(null)
                }
              }}
            />
          </div>
        ) : (
          <div className="search-wrap">
            <Icon name="search" size={13} />
            <input className="search-input" placeholder={t('notes.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        {allTags.length > 0 && (
          <div className="notes-tags">
            {allTags.map((tag) => (
              <button
                key={tag}
                className={`tag-chip ${tagFilter === tag ? 'on' : ''}`}
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
              >
                <Icon name="tag" size={10} />
                {tag}
              </button>
            ))}
          </div>
        )}
        <div
          className="notes-list"
          onDragOver={(e) => {
            if (dragging) e.preventDefault()
          }}
          onDrop={(e) => {
            if (!dragging) return
            e.preventDefault()
            const id = e.dataTransfer.getData('text/plain') || dragging
            if (id) void moveNote(id, '')
            setDragging(null)
            setDropTarget(null)
          }}
        >
          {rootNotes.length > 0 && <div className="notes-group">{rootNotes.map(noteRow)}</div>}
          {folderSet.map((folder) => {
            const items = notesIn(folder)
            if (collapsed.has(folder) && items.length === 0) items.length = 0
            const visibleItems = collapsed.has(folder) ? [] : items
            return (
              <div key={folder} className="notes-group">
                {groupLabel(folder, items.length)}
                {visibleItems.map(noteRow)}
              </div>
            )
          })}
          {visible.length === 0 && folderSet.length === 0 && (
            <div className="hint" style={{ padding: '4px 8px' }}>{t('notes.empty')}</div>
          )}
        </div>
      </div>
      <div className="notes-main">
        {selected ? (
          <>
            <div className="notes-editor-toolbar">
              {creating === 'rename' ? (
                <input
                  ref={inputRef}
                  className="rename-input wide"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit()
                    else if (e.key === 'Escape') setCreating('')
                  }}
                />
              ) : (
                <>
                  <span className="notes-path mono">
                    <Icon name="note" size={11} />
                    {selected}
                  </span>
                  <button className="icon-btn" title={t('notes.rename')} onClick={() => startCreate('rename')}>
                    <Icon name="pencil" size={11} />
                  </button>
                </>
              )}
              <span className="spacer" />
              {dirty ? (
                <span className="hint">{t('notes.dirtyShort')}</span>
              ) : savedAt ? (
                <span className="hint">
                  {t('notes.autosaved').replace('{t}', savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}
                </span>
              ) : null}
              {current?.tags.map((tag) => (
                <span key={tag} className="tag-chip">
                  <Icon name="tag" size={10} />
                  {tag}
                </span>
              ))}
              <button className={`btn small ${mode === 'preview' ? '' : 'primary'}`} onClick={() => setMode('edit')}>
                {t('file.code')}
              </button>
              <button className={`btn small ${mode === 'preview' ? 'primary' : ''}`} onClick={() => setMode('preview')}>
                {t('file.preview')}
              </button>
              <button className="btn small" disabled={!dirty} onClick={() => void save()}>
                <Icon name="save" size={12} />
                {t('notes.save')}
              </button>
              <button className="btn small danger" onClick={() => void remove()}>
                <Icon name="trash" size={12} />
                {t('side.delete')}
              </button>
            </div>
            {mode === 'edit' ? (
              <textarea
                className="notes-editor"
                spellCheck={false}
                value={content}
                onChange={(e) => edit(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault()
                    void save()
                  }
                }}
              />
            ) : (
              <div className="notes-preview md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
            )}
          </>
        ) : (
          <div className="empty-state">
            {t('notes.empty')}
            <br />
            <span className="hint">{t('notes.emptyHint')}</span>
            <div>
              <button className="btn" style={{ marginTop: 12 }} onClick={() => startCreate('note')}>
                <Icon name="note-plus" size={13} />
                {t('notes.new')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
