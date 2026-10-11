import { Fragment, useEffect, useRef, useState } from 'react'
import type {
  AppState,
  ModeId,
  ModInfo,
  ModSettingField,
  ModSettingsStore,
  ModelInfo,
  Project,
  RegisteredModSettings,
  Settings,
  SkillInfo,
  ThinkingLevel,
  UsageDay,
  UsageModel
} from '@shared/types'
import { HIGH_MOD_RISKS } from '@shared/types'
import { DARK_THEMES, LIGHT_THEMES, isFreeModel } from '@shared/types'
import { invoke } from '../api'
import { Icon } from '../Icon'
import DropSelect, { type DropOption } from './DropSelect'
import CodeEditor, { DirtyMark } from './CodeEditor'
import { getRegisteredModSettings } from '../modapi'
import { t } from '../i18n'

interface Props {
  settings: Settings
  projects: Project[]
  activeProjectId: string
  piVersion: string
  appVersion: string
  piLog: string
  onChange: (patch: Partial<Settings>) => Promise<void>
  onClose: () => void
  onModsChanged: (mod: ModInfo) => void
  onInsertPrompt: (text: string) => void
  /** Settings pages registered by ui mods (alpha.ui.registerSettingsPage). */
  modPages: { modId: string; id: string; title: string; render(container: HTMLElement): void | (() => void) }[]
}

type SectionId =
  | 'model'
  | 'modes'
  | 'skills'
  | 'agents'
  | 'prompts'
  | 'permissions'
  | 'mcp'
  | 'notes'
  | 'look'
  | 'limits'
  | 'hotkeys'
  | 'pi'
  | 'logs'
  | 'backup'
  | 'mods'

const SECTIONS: { id: SectionId; key: string; group: string }[] = [
  { id: 'model', key: 'set.model', group: 'group.agent' },
  { id: 'modes', key: 'set.modes', group: 'group.agent' },
  { id: 'skills', key: 'set.skills', group: 'group.agent' },
  { id: 'prompts', key: 'set.prompts', group: 'group.agent' },
  { id: 'permissions', key: 'set.permissions', group: 'group.agent' },
  { id: 'agents', key: 'set.agents', group: 'group.agent' },
  { id: 'mcp', key: 'set.mcp', group: 'group.agent' },
  { id: 'notes', key: 'view.notes', group: 'group.interface' },
  { id: 'look', key: 'set.look', group: 'group.interface' },
  { id: 'limits', key: 'set.limits', group: 'group.interface' },
  { id: 'hotkeys', key: 'set.hotkeys', group: 'group.interface' },
  { id: 'pi', key: 'set.pi', group: 'group.system' },
  { id: 'logs', key: 'set.logs', group: 'group.system' },
  { id: 'backup', key: 'set.backup', group: 'group.system' },
  { id: 'mods', key: 'set.mods', group: 'group.system' }
]

const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// Accent palette: lavender family first, then a curated set of single accents.
const PALETTE = [
  '#5e6ad2', '#828fff', '#7a7fad', '#2997ff', '#0a84ff', '#64d2ff',
  '#30d158', '#bf5af2', '#ff9f0a', '#ff375f', '#8e8e93', '#f7f8f8'
]

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="form-row">
      <label className="field">{label}</label>
      {children}
    </div>
  )
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }): React.JSX.Element {
  return <div className={`switch ${on ? 'on' : ''}`} onClick={onToggle} role="switch" aria-checked={on} />
}

/** App-styled dropdown for every settings row (native selects are gone). */
function Sel({
  value,
  onChange,
  options,
  className
}: {
  value: string
  onChange: (value: string) => void
  options: DropOption[]
  className?: string
}): React.JSX.Element {
  return <DropSelect value={value} options={options} onChange={onChange} className={className} minWidth={200} />
}

function ModFieldControl({
  field,
  value,
  onChange
}: {
  field: ModSettingField
  value: unknown
  onChange: (value: unknown) => void
}): React.JSX.Element {
  if (field.type === 'toggle') return <Switch on={Boolean(value)} onToggle={() => onChange(!value)} />
  if (field.type === 'select') {
    return (
      <DropSelect
        value={String(value ?? '')}
        options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
        onChange={onChange}
        minWidth={140}
      />
    )
  }
  if (field.type === 'number') {
    return <input type="number" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
  }
  return <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
}

function ModSettingsPage({ page }: { page: { render(container: HTMLElement): void | (() => void) } }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    return page.render(ref.current) ?? undefined
  }, [page])
  return <div className="mod-settings-page" ref={ref} />
}

export default function SettingsModal(props: Props): React.JSX.Element {
  const [section, setSection] = useState<string>(() => {
    const stored = sessionStorage.getItem('alpha-settings-section')
    // sections from older builds map onto their new ids
    if (stored === 'thinking') return 'modes'
    return stored || 'model'
  })
  const selectSection = (id: string): void => {
    setSection(id)
    sessionStorage.setItem('alpha-settings-section', id)
  }
  const {
    settings,
    onChange,
    onClose,
    activeProjectId,
    piVersion,
    appVersion,
    piLog,
    projects,
    onModsChanged,
    onInsertPrompt,
    modPages
  } = props

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-nav">
          {SECTIONS.map((entry, index) => {
            const showGroup = index === 0 || SECTIONS[index - 1].group !== entry.group
            return (
              <Fragment key={entry.id}>
                {showGroup && <div className="nav-group">{t(entry.group)}</div>}
                <button
                  className={section === entry.id ? 'active' : ''}
                  onClick={() => selectSection(entry.id)}
                >
                  {t(entry.key)}
                </button>
              </Fragment>
            )
          })}
          {modPages.map((page) => (
            <button
              key={`${page.modId}:${page.id}`}
              className={section === `mod:${page.modId}:${page.id}` ? 'active' : ''}
              onClick={() => selectSection(`mod:${page.modId}:${page.id}`)}
            >
              {page.title}
            </button>
          ))}
        </div>
        <div className="modal-body">
          <div className="modal-head">
            <h2>
              {section.startsWith('mod:')
                ? (modPages.find((page) => `mod:${page.modId}:${page.id}` === section)?.title ?? t('set.mods'))
                : t(SECTIONS.find((s) => s.id === section)?.key ?? 'set.title')}
            </h2>
            <button className="btn small" onClick={onClose}>
              {t('set.close')}
            </button>
          </div>
          {section === 'model' && <ModelSection settings={settings} onChange={onChange} projectId={activeProjectId} />}
          {section === 'modes' && <ModesSection settings={settings} onChange={onChange} />}
          {section === 'skills' && <SkillsSection settings={settings} onChange={onChange} projectId={activeProjectId} />}
          {section === 'agents' && <AgentsSection projects={projects} projectId={activeProjectId} />}
          {section === 'mcp' && <McpSection />}
          {section === 'notes' && <NotesSettingsSection />}
          {section === 'prompts' && <PromptsSection projectId={activeProjectId} onInsert={onInsertPrompt} />}
          {section === 'permissions' && <PermissionsSection settings={settings} onChange={onChange} />}
          {section === 'look' && <LookSection settings={settings} onChange={onChange} />}
          {section === 'limits' && <LimitsSection settings={settings} onChange={onChange} />}
          {section === 'hotkeys' && <HotkeysSection settings={settings} onChange={onChange} />}
          {section === 'pi' && <PiSection piVersion={piVersion} appVersion={appVersion} piLog={piLog} />}
          {section === 'logs' && <LogsSection settings={settings} onChange={onChange} />}
          {section === 'backup' && <BackupSection onChange={onChange} />}
          {section === 'mods' && <ModsSection settings={settings} onChange={onChange} onModsChanged={onModsChanged} />}
          {section.startsWith('mod:') &&
            (() => {
              const page = modPages.find((entry) => `mod:${entry.modId}:${entry.id}` === section)
              return page ? <ModSettingsPage page={page} /> : null
            })()}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- model

function ModelSection({
  settings,
  onChange,
  projectId
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
  projectId: string
}): React.JSX.Element {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [apiKey, setApiKey] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    void invoke<ModelInfo[]>('models:list', projectId).then(setModels)
  }, [projectId])

  const providers = [...new Set(models.map((m) => m.provider))]
  const provider = settings.defaultProvider || providers[0] || ''
  // Only models of providers with a configured key are offered for selection.
  const keyedModels = models.filter((m) => m.hasKey)
  const providerHasKey = keyedModels.some((m) => m.provider === provider)
  const providerModels = keyedModels.filter((m) => m.provider === provider)
  const pinnedSet = new Set(settings.pinnedModels)
  const pinnedInProvider = providerModels.filter((m) => pinnedSet.has(`${m.provider}/${m.id}`))
  const unpinnedInProvider = providerModels.filter((m) => !pinnedSet.has(`${m.provider}/${m.id}`))
  const anyKey = models.some((m) => m.hasKey)
  const currentKey =
    settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : ''
  const currentIsKeyed = keyedModels.some((m) => `${m.provider}/${m.id}` === currentKey)
  const isPinned = pinnedSet.has(currentKey)
  const valueInProvider =
    currentIsKeyed && currentKey.startsWith(`${provider}/`) ? settings.defaultModel : ''

  return (
    <div>
      <Row label={t('set.provider')}>
        <Sel
          value={provider}
          options={
            providers.length === 0 ? [{ value: '', label: '—' }] : providers.map((p) => ({ value: p, label: p }))
          }
          onChange={(value) => void onChange({ defaultProvider: value, defaultModel: '' })}
        />
      </Row>
      <Row label={t('set.modelId')}>
        <Sel
          className="set-model"
          value={valueInProvider}
          options={[
            { value: '', label: '—' },
            ...pinnedInProvider.map((m) => ({ value: m.id, label: m.name, group: t('model.pinned') })),
            ...unpinnedInProvider.filter(isFreeModel).map((m) => ({ value: m.id, label: m.name, group: t('model.groupFree') })),
            ...unpinnedInProvider.filter((m) => !isFreeModel(m)).map((m) => ({ value: m.id, label: m.name, group: t('model.groupPaid') }))
          ]}
          onChange={(value) => void onChange({ defaultModel: value })}
        />
        <button
          className="btn small"
          disabled={!currentIsKeyed}
          title={isPinned ? t('model.unpin') : t('model.pin')}
          onClick={() => {
            if (!currentIsKeyed) return
            const next = isPinned
              ? settings.pinnedModels.filter((key) => key !== currentKey)
              : [...settings.pinnedModels, currentKey]
            void onChange({ pinnedModels: next })
          }}
        >
          <Icon name="pin" size={13} />
          {isPinned ? t('model.unpin') : t('model.pin')}
        </button>
      </Row>
      {!providerHasKey && provider && <p className="hint">{t('model.noKey')}</p>}
      <Row label={t('set.apiKey')}>
        <input
          type="password"
          placeholder={provider || 'provider'}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <button
          className="btn small"
          onClick={() => {
            void (async () => {
              await invoke('models:setKey', provider, apiKey, projectId)
              setApiKey('')
              setMessage(`${provider}: ok`)
              setModels(await invoke<ModelInfo[]>('models:list', projectId))
            })()
          }}
        >
          {t('set.saveKey')}
        </button>
      </Row>
      <div className="form-row">
        <button className="btn small" onClick={() => void invoke('models:test', projectId).then((r) => setMessage(String(r)))}>
          {t('set.test')}
        </button>
        {!anyKey && <span className="hint">{t('set.noKeys')}</span>}
        {message && <span className="hint">{message}</span>}
      </div>

      <div className="insp-title">{t('providers.keys')}</div>
      <div className="list">
        {providers.length === 0 && <div className="list-row hint">{t('providers.none')}</div>}
        {providers.map((name) => {
          const hasKey = models.some((m) => m.provider === name && m.hasKey)
          return (
            <div className="list-row" key={name}>
              <div className="grow">
                <div>{name}</div>
                <div className="sub">{hasKey ? t('providers.has') : t('providers.missing')}</div>
              </div>
              <button
                className="btn small"
                onClick={() => void invoke('models:test', projectId).then((r) => setMessage(String(r)))}
              >
                {t('set.test')}
              </button>
              {hasKey && (
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (!window.confirm(`${t('providers.remove')} — ${name}?`)) return
                    void invoke('models:removeKey', name, projectId).then(() =>
                      invoke<ModelInfo[]>('models:list', projectId).then(setModels)
                    )
                  }}
                >
                  {t('providers.remove')}
                </button>
              )}
            </div>
          )
        })}
      </div>
      <p className="hint">{t('set.applyNext')}</p>
    </div>
  )
}

// ------------------------------------------------------------------ modes

function ModesSection({
  settings,
  onChange
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
}): React.JSX.Element {
  const [debugDraft, setDebugDraft] = useState(settings.modePrefixes.debug)
  const [quickDraft, setQuickDraft] = useState(settings.modePrefixes.quick)

  // Prefixes are long texts: edit locally, persist on blur.
  const commitPrefix = (key: 'debug' | 'quick', value: string): void => {
    if (value === settings.modePrefixes[key]) return
    void onChange({ modePrefixes: { ...settings.modePrefixes, [key]: value } })
  }

  const modeOptions = (['agent', 'plan', 'debug', 'assist', 'quick'] as ModeId[]).map((id) => ({
    value: id,
    label: t(`modes.${id}`)
  }))

  return (
    <div>
      <Row label={t('set.level')}>
        <Sel
          className="set-thinking"
          value={settings.thinkingLevel}
          options={THINKING.map((level) => ({ value: level, label: level }))}
          onChange={(value) => void onChange({ thinkingLevel: value as ThinkingLevel })}
        />
      </Row>
      <Row label={t('modes.default')}>
        <Sel
          className="set-mode"
          value={settings.defaultMode}
          options={modeOptions}
          onChange={(value) => void onChange({ defaultMode: value as ModeId })}
        />
      </Row>
      <p className="hint">{t('modes.defaultHint')}</p>
      <Row label={t('modes.quickThinking')}>
        <Sel
          value={settings.quickThinking}
          options={THINKING.map((level) => ({ value: level, label: level }))}
          onChange={(value) => void onChange({ quickThinking: value as ThinkingLevel })}
        />
      </Row>
      <div className="insp-title">{t('modes.prefixes')}</div>
      <div className="editor-block">
        <CodeEditor
          label={t('modes.prefixDebug')}
          hint={t('modes.prefixBuiltIn')}
          value={debugDraft}
          minHeight={140}
          onChange={setDebugDraft}
          onBlur={() => commitPrefix('debug', debugDraft.trim())}
          actions={<DirtyMark dirty={debugDraft.trim() !== settings.modePrefixes.debug} />}
        />
      </div>
      <div className="editor-block">
        <CodeEditor
          label={t('modes.prefixQuick')}
          hint={t('modes.prefixBuiltIn')}
          value={quickDraft}
          minHeight={96}
          onChange={setQuickDraft}
          onBlur={() => commitPrefix('quick', quickDraft.trim())}
          actions={<DirtyMark dirty={quickDraft.trim() !== settings.modePrefixes.quick} />}
        />
      </div>
      <p className="hint">{t('modes.hint')}</p>
      <p className="hint">{t('set.applyNext')}</p>
    </div>
  )
}

// ---------------------------------------------------------------- skills

function SkillsSection({
  settings,
  onChange,
  projectId
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
  projectId: string
}): React.JSX.Element {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<{ name: string; content: string } | null>(null)

  async function refresh(): Promise<void> {
    setSkills(await invoke<SkillInfo[]>('skills:list', projectId))
  }

  useEffect(() => {
    void refresh()
  }, [projectId, settings.disabledSkills.join('|')])

  async function toggle(skill: SkillInfo): Promise<void> {
    await invoke('skills:setEnabled', skill.name, !skill.enabled)
    const current = settings.disabledSkills
    const next = skill.enabled ? [...current, skill.name] : current.filter((name) => name !== skill.name)
    await onChange({ disabledSkills: next })
    await refresh()
  }

  const filtered = skills.filter(
    (s) => !query || s.name.toLowerCase().includes(query.toLowerCase()) || s.description.toLowerCase().includes(query.toLowerCase())
  )

  return (
    <div>
      <div className="form-row">
        <input className="search-input" style={{ maxWidth: 260 }} placeholder={t('set.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn small" onClick={() => void invoke('skills:addPath').then(() => refresh())}>
          {t('set.addPath')}
        </button>
        <button className="btn small" onClick={() => void invoke('skills:openDir')}>
          {t('set.openDir')}
        </button>
      </div>
      <div className="list">
        {filtered.map((skill) => (
          <div className="list-row" key={`${skill.source}:${skill.name}`}>
            <div className="grow" style={{ cursor: 'pointer' }} onClick={() => void invoke<string>('skills:file', skill.path).then((content) => setOpen({ name: skill.name, content }))}>
              <div>{skill.name}</div>
              <div className="sub">{skill.description || skill.path}</div>
            </div>
            <span className="hint">{skill.source}</span>
            <Switch on={skill.enabled} onToggle={() => void toggle(skill)} />
          </div>
        ))}
        {filtered.length === 0 && <div className="list-row hint">{t('ins.none')}</div>}
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          <div className="insp-title">{open.name}/SKILL.md</div>
          <pre className="log">{open.content}</pre>
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => setOpen(null)}>
            {t('set.close')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- agents.md

function AgentsSection({ projects, projectId }: { projects: Project[]; projectId: string }): React.JSX.Element {
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [text, setText] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void invoke<string>('agentsmd:get', scope, projectId).then(setText)
    setSaved(false)
  }, [scope, projectId])

  return (
    <div>
      <div className="form-row">
        <Sel
          value={scope}
          options={[
            { value: 'global', label: t('set.scopeGlobal') },
            { value: 'project', label: t('set.scopeProject') }
          ]}
          onChange={(value) => setScope(value as 'global' | 'project')}
        />
        <button
          className="btn primary small"
          onClick={() => {
            void invoke('agentsmd:set', scope, projectId, text).then(() => {
              setSaved(true)
              setTimeout(() => setSaved(false), 1500)
            })
          }}
        >
          {t('set.save')}
        </button>
        {saved && <span className="hint">{t('set.saved')}</span>}
      </div>
      <CodeEditor label={t('set.agents')} value={text} onChange={(value) => setText(value)} minHeight={420} />
      <p className="hint">
        {scope === 'global' ? '~/.alpha/agent/AGENTS.md' : `${projects.find((p) => p.id === projectId)?.path ?? '~'}/AGENTS.md`}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- prompts

interface PromptItem {
  name: string
  path: string
  source: 'global' | 'project'
}

function PromptsSection({
  projectId,
  onInsert
}: {
  projectId: string
  onInsert: (text: string) => void
}): React.JSX.Element {
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [selected, setSelected] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [message, setMessage] = useState('')

  async function open(path: string): Promise<void> {
    setSelected(path)
    setContent(path ? await invoke<string>('prompts:get', path, projectId) : '')
    setDirty(false)
  }

  async function refresh(keep?: string): Promise<void> {
    const list = await invoke<PromptItem[]>('prompts:list', projectId)
    setPrompts(list)
    const target = keep && list.some((item) => item.path === keep) ? keep : (list[0]?.path ?? '')
    await open(target)
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const selectedName = prompts.find((item) => item.path === selected)?.name ?? ''

  return (
    <div>
      <p className="hint">{t('prompts.hint')}</p>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button
          className="btn small"
          onClick={() => {
            const name = window.prompt(t('prompts.new'))
            if (!name) return
            void invoke<string>('prompts:create', name)
              .then((path) => refresh(path))
              .catch((error) => setMessage(String(error)))
          }}
        >
          {t('prompts.new')}
        </button>
        <button
          className="btn small primary"
          disabled={!selectedName}
          onClick={() => onInsert(`/${selectedName} `)}
        >
          {t('prompts.insert')}
        </button>
        <button
          className="btn small"
          disabled={!selected || !dirty}
          onClick={() => {
            void invoke('prompts:save', selected, content, projectId).then(() => {
              setDirty(false)
              setMessage(t('set.saved'))
              setTimeout(() => setMessage(''), 1500)
            })
          }}
        >
          {t('set.save')}
        </button>
        <button
          className="btn small danger"
          disabled={!selected}
          onClick={() => {
            if (!window.confirm(`${t('prompts.delete')} — ${selectedName}?`)) return
            void invoke('prompts:delete', selected, projectId).then(() => refresh())
          }}
        >
          {t('prompts.delete')}
        </button>
        {message && <span className="hint">{message}</span>}
      </div>

      {prompts.length === 0 ? (
        <div className="hint">{t('prompts.empty')}</div>
      ) : (
        <div className="list prompts-list">
          {prompts.map((item) => (
            <div
              className={`list-row ${item.path === selected ? 'selected' : ''}`}
              key={item.path}
              style={{ cursor: 'pointer' }}
              onClick={() => void open(item.path)}
            >
              <div className="grow">
                <div>/{item.name}</div>
              </div>
              <span className="hint">{item.source === 'project' ? t('set.scopeProject') : t('set.scopeGlobal')}</span>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <CodeEditor
          label={`/${selectedName}`}
          actions={dirty ? <span className="hint">{t('notes.dirtyShort')}</span> : null}
          value={content}
          minHeight={260}
          onChange={(value) => {
            setContent(value)
            setDirty(true)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- permissions

function PermissionsSection({
  settings,
  onChange
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
}): React.JSX.Element {
  return (
    <div>
      <Row label={t('permissions.mode')}>
        <Sel
          className="set-approval"
          value={settings.approvalMode}
          options={[
            { value: 'risky', label: t('permissions.risky') },
            { value: 'all', label: t('permissions.all') },
            { value: 'off', label: t('permissions.off') }
          ]}
          onChange={(value) => void onChange({ approvalMode: value as Settings['approvalMode'] })}
        />
      </Row>
      <p className="hint">{t('permissions.hint')}</p>
      <div className="list">
        <div className="list-row">
          <div className="grow">
            <div className="mono">rm -rf · sudo · git push · chmod -R · curl | sh</div>
            <div className="sub">{t('permissions.bashHint')}</div>
          </div>
        </div>
        <div className="list-row">
          <div className="grow">
            <div className="mono">write / edit вне папки проекта</div>
            <div className="sub">{t('permissions.pathHint')}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- look

function LookSection({
  settings,
  onChange
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
}): React.JSX.Element {
  const [accentOpen, setAccentOpen] = useState(false)
  const [themeMods, setThemeMods] = useState<ModInfo[]>([])

  useEffect(() => {
    void invoke<ModInfo[]>('mods:list').then((list) =>
      setThemeMods(list.filter((mod) => mod.kind === 'theme' && mod.enabled && !mod.error))
    )
  }, [settings.activeThemeMod])

  return (
    <div>
      <Row label={t('set.theme')}>
        <Sel
          className="set-theme"
          value={settings.activeThemeMod ? `mod:${settings.activeThemeMod}` : settings.theme}
          options={[
            { value: 'system', label: t('set.themeSystem'), group: t('set.themeGroupBase') },
            { value: 'light', label: t('set.themeLight'), group: t('set.themeGroupBase') },
            { value: 'dark', label: t('set.themeDark'), group: t('set.themeGroupBase') },
            ...LIGHT_THEMES.filter((id) => id !== 'light').map((id) => ({
              value: id,
              label: t(`set.theme_${id}`),
              group: t('set.themeGroupLight')
            })),
            ...DARK_THEMES.filter((id) => id !== 'dark').map((id) => ({
              value: id,
              label: t(`set.theme_${id}`),
              group: t('set.themeGroupDark')
            })),
            ...themeMods.map((mod) => ({ value: `mod:${mod.id}`, label: mod.name, group: t('theme.modThemes') }))
          ]}
          onChange={(value) => {
            if (!value) return
            if (value.startsWith('mod:')) void onChange({ activeThemeMod: value.slice(4) })
            else void onChange({ theme: value, activeThemeMod: '' })
          }}
        />
      </Row>
      <Row label={t('set.accent')}>
        <div className="accent-wrap">
          <button className="accent-trigger" onClick={() => setAccentOpen(!accentOpen)}>
            <span className="swatch active" style={{ background: settings.accent }} />
            <span className="mono">{settings.accent}</span>
          </button>
          {accentOpen && (
            <div className="accent-pop">
              <div className="accent-grid">
                {PALETTE.map((color) => (
                  <button
                    key={color}
                    className={`swatch ${settings.accent.toLowerCase() === color ? 'active' : ''}`}
                    style={{ background: color }}
                    title={color}
                    onClick={() => void onChange({ accent: color })}
                  />
                ))}
              </div>
              <label className="accent-custom">
                {t('accent.custom')}
                <input
                  type="color"
                  value={settings.accent}
                  onChange={(e) => void onChange({ accent: e.target.value })}
                />
              </label>
            </div>
          )}
        </div>
      </Row>
      <Row label={t('set.uiFont')}>
        <Sel
          value={settings.uiFont}
          options={[
            { value: 'system', label: 'Системный (SF Pro)' },
            { value: 'Inter', label: 'Inter' },
            { value: 'Manrope', label: 'Manrope' },
            { value: 'Rubik', label: 'Rubik' }
          ]}
          onChange={(value) => void onChange({ uiFont: value })}
        />
      </Row>
      <Row label={t('set.codeFont')}>
        <Sel
          value={settings.codeFont}
          options={[
            { value: 'JetBrains Mono', label: 'JetBrains Mono' },
            { value: 'Fira Code', label: 'Fira Code' },
            { value: 'Source Code Pro', label: 'Source Code Pro' },
            { value: 'DejaVu Sans Mono', label: 'DejaVu Sans Mono' }
          ]}
          onChange={(value) => void onChange({ codeFont: value })}
        />
      </Row>
      <Row label={t('set.fontSize')}>
        <Sel
          className="set-font-size"
          value={String(settings.fontSize)}
          options={[14, 15, 16, 17, 18].map((size) => ({ value: String(size), label: String(size) }))}
          onChange={(value) => void onChange({ fontSize: Number(value) })}
        />
      </Row>
      <Row label={t('set.density')}>
        <Sel
          value={settings.density}
          options={[
            { value: 'compact', label: t('set.densityCompact') },
            { value: 'normal', label: t('set.densityNormal') },
            { value: 'spacious', label: t('set.densitySpacious') }
          ]}
          onChange={(value) => void onChange({ density: value as Settings['density'] })}
        />
      </Row>
      <Row label={t('set.iconSize')}>
        <Sel
          className="set-icon-size"
          value={settings.iconSize}
          options={[
            { value: 'small', label: t('set.iconSmall') },
            { value: 'medium', label: t('set.iconMedium') },
            { value: 'large', label: t('set.iconLarge') },
            { value: 'xlarge', label: t('set.iconXLarge') },
            { value: 'xxlarge', label: t('set.iconXXLarge') }
          ]}
          onChange={(value) => void onChange({ iconSize: value as Settings['iconSize'] })}
        />
      </Row>
      <Row label={t('set.language')}>
        <Sel
          value={settings.language}
          options={[
            { value: 'ru', label: 'Русский' },
            { value: 'en', label: 'English' }
          ]}
          onChange={(value) => void onChange({ language: value as Settings['language'] })}
        />
      </Row>
      <div className="form-row">
        <label className="field">{t('set.compactTools')}</label>
        <Switch on={settings.compactTools} onToggle={() => void onChange({ compactTools: !settings.compactTools })} />
      </div>
      <p className="hint">{t('set.compactToolsHint')}</p>
    </div>
  )
}

// ---------------------------------------------------------------- limits

function LimitsSection({
  settings,
  onChange
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
}): React.JSX.Element {
  const [days, setDays] = useState<UsageDay[]>([])
  const [models, setModels] = useState<UsageModel[]>([])

  useEffect(() => {
    void invoke<UsageDay[]>('usage:range', 14).then(setDays)
    void invoke<UsageModel[]>('usage:models', 14).then(setModels)
  }, [settings.dailyTokenLimit])

  const max = Math.max(1, ...days.map((day) => day.t))
  const totalTokens = days.reduce((sum, day) => sum + day.t, 0)
  const totalCost = days.reduce((sum, day) => sum + day.c, 0)

  return (
    <div>
      <div className="insp-title">{t('usage.chart')}</div>
      <div className="chart">
        {days.map((day) => (
          <div
            key={day.d}
            className="bar"
            style={{ height: `${Math.max(2, (day.t / max) * 100)}%` }}
            title={`${day.d}: ${day.t} tok${day.c ? ` · $${day.c.toFixed(3)}` : ''}`}
          />
        ))}
      </div>
      <div className="hint">
        {formatTotal(totalTokens)} · {totalCost > 0 ? `$${totalCost.toFixed(2)}` : '$0.00'}
      </div>
      {models.length > 0 && (
        <>
          <div className="insp-title" style={{ marginTop: 14 }}>{t('usage.models')}</div>
          <div className="list">
            {models.map((entry) => (
              <div className="list-row" key={entry.m}>
                <div className="grow mono">{entry.m}</div>
                <span className="hint">
                  {formatTotal(entry.t)}{entry.c > 0 ? ` · $${entry.c.toFixed(2)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ height: 18 }} />
      <Row label={t('set.maxSessions')}>
        <input type="number" min={1} max={32} value={settings.maxSessions} onChange={(e) => void onChange({ maxSessions: Number(e.target.value) })} />
      </Row>
      <Row label={t('set.dailyTokens')}>
        <input type="number" min={0} value={settings.dailyTokenLimit} onChange={(e) => void onChange({ dailyTokenLimit: Number(e.target.value) })} />
      </Row>
      <Row label={t('set.monthlyCost')}>
        <input type="number" min={0} value={settings.monthlyCostLimit} onChange={(e) => void onChange({ monthlyCostLimit: Number(e.target.value) })} />
      </Row>
      <Row label={t('set.concurrency')}>
        <input type="number" min={1} max={32} value={settings.subagentConcurrency} onChange={(e) => void onChange({ subagentConcurrency: Number(e.target.value) })} />
      </Row>
      <div className="form-row">
        <label className="field">{t('set.subagents')}</label>
        <Switch on={settings.subagents} onToggle={() => void onChange({ subagents: !settings.subagents })} />
      </div>
      <p className="hint">{t('set.subagentsHint')}</p>
    </div>
  )
}

function formatTotal(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tok`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`
  return `${tokens} tok`
}

const HOTKEY_ACTIONS: { id: string; labelKey: string }[] = [
  { id: 'palette', labelKey: 'hotkeys.palette' },
  { id: 'newChat', labelKey: 'cmd.newChat' },
  { id: 'sidebar', labelKey: 'hotkeys.sidebar' },
  { id: 'inspector', labelKey: 'hotkeys.inspector' },
  { id: 'settings', labelKey: 'set.title' },
  { id: 'export', labelKey: 'hotkeys.export' },
  { id: 'plan', labelKey: 'hotkeys.plan' },
  { id: 'review', labelKey: 'hotkeys.review' }
]

const DEFAULT_HOTKEYS: Settings['hotkeys'] = {
  palette: 'Ctrl+K',
  newChat: 'Ctrl+N',
  sidebar: 'Ctrl+B',
  inspector: 'Ctrl+I',
  settings: 'Ctrl+,',
  export: 'Ctrl+E',
  plan: 'Ctrl+P',
  review: 'Ctrl+D'
}

function HotkeysSection({
  settings,
  onChange
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
}): React.JSX.Element {
  const [listening, setListening] = useState<string | null>(null)

  useEffect(() => {
    if (!listening) return
    const actionId: string = listening
    function onKeyDown(event: KeyboardEvent): void {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        setListening(null)
        return
      }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return
      const parts: string[] = []
      if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key)
      void onChange({ hotkeys: { ...settings.hotkeys, [actionId]: parts.join('+') } })
      setListening(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [listening, settings.hotkeys, onChange])

  return (
    <div>
      <p className="hint">{t('hotkeys.hint')}</p>
      <div className="list">
        {HOTKEY_ACTIONS.map((action) => (
          <div className="list-row" key={action.id}>
            <div className="grow">{t(action.labelKey)}</div>
            <button
              className={`btn small hotkey ${listening === action.id ? 'listening' : ''}`}
              onClick={() => setListening(action.id)}
            >
              {listening === action.id ? '…' : (settings.hotkeys[action.id] ?? '—')}
            </button>
          </div>
        ))}
      </div>
      <div className="form-row" style={{ marginTop: 14 }}>
        <button className="btn small" onClick={() => void onChange({ hotkeys: { ...DEFAULT_HOTKEYS } })}>
          {t('hotkeys.reset')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- MCP

interface McpConfig {
  mcpServers: Record<string, Record<string, unknown>>
}

/** Structured MCP editor: rows for every server with enable/disable, edit and
 *  delete; the raw JSON view stays available behind a toggle. */
function McpSection(): React.JSX.Element {
  const [config, setConfig] = useState<McpConfig | null>(null)
  const [message, setMessage] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [rawMode, setRawMode] = useState(false)
  const [raw, setRaw] = useState('')
  // Saving reloads pi resources: text edits debounce, structural ones commit.
  const pending = useRef<McpConfig | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void invoke<McpConfig>('mcp:list').then(setConfig)
  }, [])

  function flush(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const next = pending.current
    pending.current = null
    if (!next) return
    setMessage('')
    void invoke('mcp:save', JSON.stringify(next, null, 2))
      .then(() => setMessage(t('mcp.saved')))
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)))
  }

  // Unmount must not drop a half-typed edit.
  useEffect(
    () => () => {
      if (timer.current !== null && pending.current) {
        clearTimeout(timer.current)
        const config = pending.current
        pending.current = null
        void invoke('mcp:save', JSON.stringify(config, null, 2)).catch(() => undefined)
      }
    },
    []
  )

  const servers = config?.mcpServers ?? {}
  const names = Object.keys(servers)

  function persist(next: McpConfig): void {
    setConfig(next)
    pending.current = next
    flush()
  }

  function persistSoft(next: McpConfig): void {
    setConfig(next)
    pending.current = next
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      flush()
    }, 600)
  }

  function patchServer(name: string, patch: Record<string, unknown>, soft = false): void {
    const next = { mcpServers: { ...servers, [name]: { ...servers[name], ...patch } } }
    if (soft) persistSoft(next)
    else persist(next)
  }

  function addServer(): void {
    const name = window.prompt(t('mcp.add'), 'my-server')
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) return
    persist({
      mcpServers: {
        ...servers,
        [name]: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-name'], enabled: true }
      }
    })
    setEditing(name)
  }

  function removeServer(name: string): void {
    if (!window.confirm(`${t('side.delete')} — ${name}?`)) return
    const next = { ...servers }
    delete next[name]
    persist({ mcpServers: next })
  }

  function summary(server: Record<string, unknown>): string {
    if (typeof server.url === 'string' && server.url) return server.url
    const args = Array.isArray(server.args) ? (server.args as unknown[]).join(' ') : ''
    return `${String(server.command ?? '')} ${args}`.trim() || '—'
  }

  function saveRaw(): void {
    try {
      const parsed = JSON.parse(raw || '{}') as McpConfig
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') throw new Error('mcpServers missing')
      persist(parsed)
      setRawMode(false)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div>
      <p className="hint">{t('mcp.hint')}</p>
      <div className="form-row" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={addServer}>
          {t('mcp.add')}
        </button>
        <button
          className="btn small"
          onClick={() => {
            if (!rawMode) setRaw(JSON.stringify(config ?? { mcpServers: {} }, null, 2))
            setRawMode(!rawMode)
          }}
        >
          {t('mcp.raw')}
        </button>
        {message && <span className="hint">{message}</span>}
      </div>

      {rawMode ? (
        <>
          <CodeEditor label="JSON" value={raw} onChange={setRaw} minHeight={240} />
          <div className="form-row" style={{ marginTop: 10 }}>
            <button className="btn primary small" onClick={saveRaw}>
              {t('mcp.save')}
            </button>
          </div>
        </>
      ) : config === null ? (
        <p className="hint">{t('common.loading')}</p>
      ) : names.length === 0 ? (
        <p className="hint">{t('mcp.empty')}</p>
      ) : (
        <div className="list" style={{ marginBottom: 10 }}>
          {names.map((name) => {
            const server = servers[name]
            const enabled = server.enabled !== false
            return (
              <Fragment key={name}>
                <div className="list-row">
                  <div className="grow" style={{ cursor: 'pointer' }} onClick={() => setEditing(editing === name ? null : name)}>
                    <div className="mono">{name}</div>
                    <div className="sub mono">{summary(server)}</div>
                  </div>
                  <Switch on={enabled} onToggle={() => patchServer(name, { enabled: !enabled })} />
                  <button className="icon-btn" title={t('set.edit')} onClick={() => setEditing(editing === name ? null : name)}>
                    <Icon name="pencil" size={13} />
                  </button>
                  <button className="icon-btn" title={t('side.delete')} onClick={() => removeServer(name)}>
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                {editing === name && (
                  <div className="mcp-editor">
                    <Row label="command">
                      <input
                        className="mono"
                        value={String(server.command ?? '')}
                        onChange={(e) => patchServer(name, { command: e.target.value }, true)}
                      />
                    </Row>
                    <Row label="args">
                      <input
                        className="mono"
                        value={(Array.isArray(server.args) ? (server.args as unknown[]) : []).join(' ')}
                        onChange={(e) =>
                          patchServer(name, { args: e.target.value.split(' ').filter((part) => part.length > 0) }, true)
                        }
                      />
                    </Row>
                    <Row label="url (sse)">
                      <input
                        className="mono"
                        placeholder="https://…"
                        value={String(server.url ?? '')}
                        onChange={(e) =>
                          patchServer(
                            name,
                            e.target.value ? { url: e.target.value, command: '', args: [] } : { url: '' },
                            true
                          )
                        }
                      />
                    </Row>
                    <Row label="env (json)">
                      <input
                        className="mono"
                        placeholder="{}"
                        value={server.env ? JSON.stringify(server.env) : ''}
                        onChange={(e) => {
                          try {
                            const value = e.target.value.trim()
                            patchServer(name, value ? { env: JSON.parse(value) } : { env: undefined }, true)
                          } catch {
                            // incomplete JSON while typing: keep the old value
                          }
                        }}
                      />
                    </Row>
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      )}
      <p className="hint">{t('mcp.enableHint')}</p>
    </div>
  )
}

// ---------------------------------------------------------------- notes

function NotesSettingsSection(): React.JSX.Element {
  const [dir, setDir] = useState('~/.alpha/notes')

  useEffect(() => {
    void invoke<AppState>('app:state').then((state) => setDir(`${state.alphaDir}/notes`))
  }, [])

  return (
    <div>
      <p className="hint">{t('notes.settingsHint')}</p>
      <p className="hint mono">{dir}</p>
      <div className="form-row">
        <button className="btn small" onClick={() => void invoke('shell:openPath', dir)}>
          <Icon name="external" size={12} />
          {t('set.openDir')}
        </button>
        <button
          className="btn small"
          onClick={() =>
            void invoke<number>('notes:import').then((count) => {
              if (count > 0) window.alert(t('notes.imported').replace('{n}', String(count)))
            })
          }
        >
          <Icon name="upload" size={12} />
          {t('notes.import')}
        </button>
      </div>
      <div className="list" style={{ marginTop: 14 }}>
        <div className="list-row">
          <div className="grow">{t('notes.ruleTags')}</div>
          <span className="hint">#тег в тексте</span>
        </div>
        <div className="list-row">
          <div className="grow">{t('notes.ruleAi')}</div>
          <span className="hint">{t('notes.ruleAiHint')}</span>
        </div>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>{t('notes.mentionHint')}</p>
    </div>
  )
}

// ---------------------------------------------------------------- pi

function PiSection({
  piVersion,
  appVersion,
  piLog
}: {
  piVersion: string
  appVersion: string
  piLog: string
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <div>
      <div className="form-row">
        <span className="mono">Alpha {appVersion} · pi {piVersion}</span>
        <button
          className="btn small primary"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void invoke('pi:update')
          }}
        >
          {t('set.updatePi')}
        </button>
        {busy && <span className="hint">{t('set.piLog')}…</span>}
      </div>
      <div className="insp-title">{t('set.piLog')}</div>
      <pre className="log">{piLog || '—'}</pre>
      <p className="hint">~/.alpha/runtime · npm i @earendil-works/pi-coding-agent@latest</p>
    </div>
  )
}

// ---------------------------------------------------------------- logs

function LogsSection({
  settings,
  onChange
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
}): React.JSX.Element {
  const [lines, setLines] = useState('')

  useEffect(() => {
    void invoke<string>('logs:tail', 200).then(setLines)
  }, [settings.logLevel])

  return (
    <div>
      <Row label={t('set.logLevel')}>
        <Sel
          value={settings.logLevel}
          options={['error', 'warn', 'info', 'debug'].map((level) => ({ value: level, label: level }))}
          onChange={(value) => void onChange({ logLevel: value as Settings['logLevel'] })}
        />
      </Row>
      <div className="form-row">
        <label className="field">{t('notify.done')}</label>
        <Switch on={settings.notifyDone} onToggle={() => void onChange({ notifyDone: !settings.notifyDone })} />
      </div>
      <div className="form-row">
        <label className="field">{t('set.telemetry')}</label>
        <Switch on={settings.telemetry} onToggle={() => void onChange({ telemetry: !settings.telemetry })} />
        <span className="hint">{t('set.telemetryHint')}</span>
      </div>
      <div className="form-row">
        <button className="btn small" onClick={() => void invoke<string>('diagnostics:copy').then((text) => navigator.clipboard.writeText(text))}>
          {t('set.copyDiag')}
        </button>
        <button className="btn small" onClick={() => void invoke<string>('logs:tail', 200).then(setLines)}>
          ↻
        </button>
      </div>
      <pre className="log">{lines || '—'}</pre>
    </div>
  )
}

// ---------------------------------------------------------------- backup

function BackupSection({ onChange }: { onChange: (patch: Partial<Settings>) => Promise<void> }): React.JSX.Element {
  const [message, setMessage] = useState('')
  return (
    <div>
      <div className="form-row">
        <button
          className="btn small"
          onClick={() => void invoke<string>('backup:export').then((result) => setMessage(result))}
        >
          {t('set.export')}
        </button>
        <button
          className="btn small"
          onClick={() =>
            void invoke<string>('backup:import').then((result) => {
              setMessage(result)
              if (result && !/ошиб/i.test(result)) setTimeout(() => window.location.reload(), 700)
            })
          }
        >
          {t('set.import')}
        </button>
      </div>
      <div className="form-row">
        <button
          className="btn small"
          onClick={() => {
            if (window.confirm(t('set.reset'))) void invoke('settings:reset').then(() => window.location.reload())
          }}
        >
          {t('set.reset')}
        </button>
        <button
          className="btn small danger"
          onClick={() => {
            if (window.confirm(t('set.resetKeys'))) void invoke('keys:reset').then(() => setMessage('keys: ok'))
          }}
        >
          {t('set.resetKeys')}
        </button>
        {message && <span className="hint">{message}</span>}
      </div>
      <p className="hint">{t('set.profileHint')}</p>
    </div>
  )
}

// ---------------------------------------------------------------- mods

function ModsSection({
  settings,
  onChange,
  onModsChanged
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
  onModsChanged: (mod: ModInfo) => void
}): React.JSX.Element {
  const [mods, setMods] = useState<ModInfo[]>([])
  const [message, setMessage] = useState('')
  const [modValues, setModValues] = useState<ModSettingsStore>({})
  const [mainFields, setMainFields] = useState<RegisteredModSettings[]>([])
  // One open accordion per list (NN/g): settings live under their own mod.
  const [openMod, setOpenMod] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setMods(await invoke<ModInfo[]>('mods:list'))
  }

  useEffect(() => {
    void refresh()
    void invoke<ModSettingsStore>('modSettings:all').then(setModValues)
    void invoke<RegisteredModSettings[]>('modSettings:registered').then(setMainFields)
  }, [])

  // Fields registered by core mods (main) and ui mods (renderer).
  const registeredFields = [
    ...mainFields,
    ...getRegisteredModSettings().filter((entry) => !mainFields.some((main) => main.modId === entry.modId))
  ]

  return (
    <div>
      <p className="hint">{t('set.modsHint')}</p>
      <div className="form-row">
        <button
          className="btn small"
          onClick={() => {
            void invoke<{ ok: boolean; message: string }>('mods:install').then((result) => {
              setMessage(result.message)
              void refresh()
            })
          }}
        >
          {t('set.installMod')}
        </button>
        <button className="btn small" onClick={() => void invoke('mods:openDir')}>
          {t('set.openDir')}
        </button>
      </div>

      <div className="list">
        {mods.map((mod) => {
          const registration = registeredFields.find((entry) => entry.modId === mod.id)
          const isOpen = Boolean(registration) && openMod === mod.id
          return (
            <Fragment key={mod.id}>
              <div className="list-row">
                <div className="grow">
              <div>
                {mod.name} <span className="hint">{mod.version} · {mod.kind} · api {mod.api}</span>
              </div>
              <div className="sub">{mod.error ? `ошибка: ${mod.error}` : mod.description}</div>
              <div className="risks">
                {mod.risks.map((risk) => (
                  <span
                    className={`risk-chip ${mod.declared.includes(risk) ? 'declared' : ''}`}
                    key={risk}
                  >
                    {risk}
                  </span>
                ))}
                {mod.risks.length === 0 && <span className="hint">{t('risks.none')}</span>}
              </div>
            </div>
            {registration && (
              <button
                className={`icon-btn mod-gear ${isOpen ? 'on' : ''}`}
                title={t('mods.gear')}
                onClick={() => setOpenMod(isOpen ? null : mod.id)}
              >
                <Icon name="sliders" size={14} />
              </button>
            )}
            <Switch
              on={mod.enabled}
              onToggle={() => {
                const turningOn = !mod.enabled
                const high = mod.risks.filter(
                  (risk) => HIGH_MOD_RISKS.includes(risk) && !mod.declared.includes(risk)
                )
                if (turningOn && mod.kind !== 'theme' && high.length > 0) {
                  if (!window.confirm(`${t('risks.confirm')} ${high.join(', ')}`)) return
                }
                void invoke<ModInfo[]>('mods:setEnabled', mod.id, !mod.enabled).then(async (updated) => {
                  setMods(updated)
                  const changed = updated.find((entry) => entry.id === mod.id)
                  if (!changed) return
                  if (changed.kind === 'theme' && !changed.enabled && settings.activeThemeMod === changed.id) {
                    await onChange({ activeThemeMod: '' })
                  }
                  onModsChanged(changed)
                })
              }}
            />
              </div>
              {isOpen && registration && (
                <div className="mod-inline">
                  {registration.fields.map((field) => (
                    <div className="list-row" key={field.key}>
                      <div className="grow">{field.label}</div>
                      <ModFieldControl
                        field={field}
                        value={modValues[mod.id]?.[field.key] ?? field.default ?? ''}
                        onChange={(value) => {
                          setModValues({
                            ...modValues,
                            [mod.id]: { ...(modValues[mod.id] ?? {}), [field.key]: value }
                          })
                          void invoke('modSettings:set', mod.id, field.key, value)
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Fragment>
          )
        })}
        {mods.length === 0 && <div className="list-row hint">~/.alpha/mods — {t('ins.none')}</div>}
      </div>

      {message && <p className="hint">{message}</p>}
    </div>
  )
}