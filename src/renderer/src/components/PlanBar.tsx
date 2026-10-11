import { useState } from 'react'
import { t } from '../i18n'
import { Icon } from '../Icon'

export interface PlanList {
  title: string
  items: { text: string; status: string }[]
}

interface Props {
  lists: Record<string, PlanList>
}

const GLYPHS: Record<string, string> = { todo: '○', doing: '◐', done: '●' }

/**
 * Compact plan strip pinned above the feed: the model's task list stays in
 * view while the chat scrolls instead of hiding in the inspector column.
 */
export default function PlanBar({ lists }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const all = Object.values(lists).flatMap((list) => list.items)
  if (all.length === 0) return null
  const done = all.filter((item) => item.status === 'done').length
  const percent = Math.round((done / all.length) * 100)

  return (
    <div className={`plan ${open ? 'open' : ''}`}>
      <button className="plan-head" onClick={() => setOpen(!open)}>
        <Icon name="check" size={12} />
        <span className="plan-title">{t('plan.title')}</span>
        <span className="plan-count">
          {done}/{all.length}
        </span>
        <span className="plan-track">
          <span className="plan-fill" style={{ width: `${percent}%` }} />
        </span>
        <span className={`plan-caret ${open ? 'on' : ''}`}>
          <Icon name="chevron-right" size={11} />
        </span>
      </button>
      {open && (
        <div className="plan-body">
          {Object.entries(lists).map(([key, list]) => (
            <div key={key} className="plan-list">
              <div className="plan-list-title">{list.title}</div>
              {list.items.map((item, index) => (
                <div key={index} className={`plan-item ${item.status}`}>
                  <span className="glyph">{item.status === 'done' ? <Icon name="check" size={12} /> : (GLYPHS[item.status] ?? '○')}</span>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
