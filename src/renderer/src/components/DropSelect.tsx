import { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'

export interface DropOption {
  value: string
  label: string
  group?: string
}

interface Props {
  value: string
  options: DropOption[]
  onChange: (value: string) => void
  title?: string
  minWidth?: number
  /** Extra class on the trigger (keeps `nav-select` for existing checks). */
  className?: string
  /** Hide the chevron where the affordance is obvious (model, thinking level). */
  caret?: boolean
  /** Values marked with a filled star (pin state). */
  pinned?: string[]
  /** Toggles the pin without selecting the item; renders the hover star. */
  onTogglePin?: (value: string) => void
}

/**
 * Native <select> cannot follow the design system (radius grammar, surface
 * ladder), so every selector is a button with an app-styled popup card.
 * Trigger and items carry `data-value` so tests can address them directly.
 */
export default function DropSelect({
  value,
  options,
  onChange,
  title,
  minWidth,
  className = '',
  caret = true,
  pinned = [],
  onTogglePin
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const rootRef = useRef<HTMLSpanElement>(null)

  const selected = options.find((option) => option.value === value)
  const pinnedSet = new Set(pinned)

  const groups: { name: string; items: { option: DropOption; index: number }[] }[] = []
  options.forEach((option, i) => {
    const name = option.group ?? ''
    let bucket = groups.find((group) => group.name === name)
    if (!bucket) {
      bucket = { name, items: [] }
      groups.push(bucket)
    }
    bucket.items.push({ option, index: i })
  })

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    if (open) setIndex(Math.max(0, options.findIndex((option) => option.value === value)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // keep the keyboard-highlighted row inside the scrollable menu
  useEffect(() => {
    if (!open) return
    rootRef.current?.querySelector('.drop-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [index, open])

  function pick(i: number): void {
    const option = options[i]
    if (option) onChange(option.value)
    setOpen(false)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault()
        setIndex(Math.max(0, options.findIndex((option) => option.value === value)))
        setOpen(true)
      }
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((i) => Math.min(i + 1, options.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(index)
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <span className="drop-select" ref={rootRef} title={title}>
      <button
        type="button"
        className={`nav-select drop-trigger ${className}`}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className="drop-label">{selected?.label ?? '—'}</span>
      </button>
      {open && (
        <div className="drop-menu" role="listbox" style={minWidth ? { minWidth: `${minWidth}px` } : undefined}>
          {groups.map((group) => (
            <div key={group.name || '_'} className="drop-group">
              {group.name && <div className="drop-group-title">{group.name}</div>}
              {group.items.map(({ option, index: i }) => (
                <div
                  key={option.value || '_empty'}
                  className={`drop-item ${i === index ? 'active' : ''} ${option.value === value ? 'current' : ''} ${
                    pinnedSet.has(option.value) ? 'is-pinned' : ''
                  }`}
                  data-value={option.value}
                  onMouseEnter={() => setIndex(i)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(i)}
                >
                  <span className="drop-item-label">{option.label}</span>
                  <span className="drop-item-side">
                    {onTogglePin && (
                      <button
                        type="button"
                        className={`drop-star ${pinnedSet.has(option.value) ? 'on' : ''}`}
                        title={pinnedSet.has(option.value) ? 'Открепить' : 'Закрепить'}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          onTogglePin(option.value)
                        }}
                      >
                        <Icon name="star" size={12} />
                      </button>
                    )}
                    {option.value === value && <Icon name="check" size={12} />}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
