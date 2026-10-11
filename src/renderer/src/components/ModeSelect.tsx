import { useEffect, useRef, useState } from 'react'
import type { ModeId } from '@shared/types'
import { Icon } from '../Icon'
import { t } from '../i18n'

const ITEMS: { id: ModeId; icon: string; key: string; descKey: string }[] = [
  { id: 'agent', icon: 'sparkle', key: 'modes.agent', descKey: 'modes.agentDesc' },
  { id: 'plan', icon: 'list-check', key: 'modes.plan', descKey: 'modes.planDesc' },
  { id: 'debug', icon: 'alert', key: 'modes.debug', descKey: 'modes.debugDesc' },
  { id: 'assist', icon: 'eye', key: 'modes.assist', descKey: 'modes.assistDesc' },
  { id: 'quick', icon: 'rocket', key: 'modes.quick', descKey: 'modes.quickDesc' }
]

interface Props {
  mode: ModeId
  defaultMode: ModeId
  hotkey?: string
  onChange: (mode: ModeId) => void
}

/**
 * Mode selector in the topbar: one pill showing the current mode, a popover
 * with every mode, its description and a check mark. Mode changes persist per
 * chat and apply from the next prompt / next tool call.
 */
export default function ModeSelect({ mode, defaultMode, hotkey, onChange }: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = ITEMS.find((item) => item.id === mode) ?? ITEMS[0]

  return (
    <div className="mode-select" ref={rootRef}>
      <button
        className={`mode-pill ${mode !== defaultMode ? 'changed' : ''}`}
        title={t(current.descKey)}
        onClick={() => setOpen(!open)}
      >
        <Icon name={current.icon} size={13} />
        <span className="mode-name">{t(current.key)}</span>
        {hotkey && <span className="hint mode-key">{hotkey}</span>}
      </button>
      {open && (
        <div className="mode-menu" role="menu">
          {ITEMS.map((item) => (
            <button
              key={item.id}
              className={`mode-item ${item.id === mode ? 'active' : ''}`}
              onClick={() => {
                onChange(item.id)
                setOpen(false)
              }}
            >
              <Icon name={item.icon} size={14} />
              <span className="mode-item-text">
                <span className="mode-item-title">{t(item.key)}</span>
                <span className="hint">{t(item.descKey)}</span>
              </span>
              {item.id === mode && <Icon name="check" size={13} />}
              {item.id === defaultMode && <span className="hint">{t('modes.defaultDot')}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
