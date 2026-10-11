import { useEffect, useState } from 'react'
import type { PanelId } from '@shared/types'
import { Icon } from '../Icon'
import { t } from '../i18n'

export interface RailItem {
  id: PanelId
  icon: string
  title: string
}

interface Props {
  side: 'left' | 'right'
  items: RailItem[]
  /** The panel shown in this side's column; null while the column is collapsed. */
  active: PanelId | null
  onSelect: (id: PanelId) => void
  onMove: (id: PanelId, side: 'left' | 'right') => void
  /** Pinned to the bottom of the rail (the settings button on the left). */
  footer?: React.ReactNode
}

/**
 * Vertical icon rail on the window edge. A click switches the panel of this
 * side (clicking the active icon folds the column); a right click offers to
 * move the panel to the other side.
 */
export default function PanelRail({ side, items, active, onSelect, onMove, footer }: Props): React.JSX.Element {
  const [menu, setMenu] = useState<{ id: PanelId; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  return (
    <nav className={`panel-rail ${side}`} aria-label={t(side === 'left' ? 'panels.leftRail' : 'panels.rightRail')}>
      {items.map((item) => (
        <button
          key={item.id}
          className={`rail-btn ${active === item.id ? 'active' : ''}`}
          title={item.title}
          aria-label={item.title}
          aria-pressed={active === item.id}
          onClick={() => onSelect(item.id)}
          onContextMenu={(event) => {
            event.preventDefault()
            setMenu({ id: item.id, x: event.clientX, y: event.clientY })
          }}
        >
          <Icon name={item.icon} size={16} />
        </button>
      ))}
      <span className="rail-spacer" />
      {footer}
      {menu && (
        <div
          className="rail-menu"
          role="menu"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: menu.y }}
          // the menu is the target of the click that opened it: keep the window listener out
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => {
              onMove(menu.id, side === 'left' ? 'right' : 'left')
              setMenu(null)
            }}
          >
            {t(side === 'left' ? 'panels.moveRight' : 'panels.moveLeft')}
          </button>
        </div>
      )}
    </nav>
  )
}
