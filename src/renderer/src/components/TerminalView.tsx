import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '../api'
import { t } from '../i18n'
import { Icon } from '../Icon'

interface Props {
  buffer: string
  cwd: string
  onClear: () => void
}

interface TermView {
  text: string
  col: number
  lines: string[]
}

/**
 * Lite terminal emulation over the raw shell stream: readline on a piped
 * bash -i answers with plain text, `\b` (cursor left) and `\x1b[K` (clear to
 * end of line). We apply those to keep the screen truthful — backspace,
 * history recall and editing all become visible. OSC titles are stripped in
 * the main process; every other CSI sequence is ignored. Full-screen apps
 * (vim, htop) need a real pty and stay out of scope.
 */
function processTerm(raw: string): TermView {
  const lines: string[] = ['']
  let row = 0
  let col = 0
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\u001b') {
      const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(raw.slice(i))
      if (match) {
        if (match[2] === 'K') lines[row] = lines[row].slice(0, col)
        i += match[0].length
        continue
      }
      if (raw[i + 1] === ']') {
        // unterminated OSC would already be stripped in main; skip the pair
        i += 2
        continue
      }
      i += 2
      continue
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1)
    } else if (ch === '\r') {
      col = 0
    } else if (ch === '\n') {
      lines.push('')
      row++
      col = 0
      // keep memory bounded for endless streams
      if (lines.length > 1500) {
        lines.splice(0, 500)
        row -= 500
      }
    } else if (ch >= ' ' && ch !== '\u007f') {
      const line = lines[row]
      if (col < line.length) {
        lines[row] = line.slice(0, col) + ch + line.slice(col + 1)
      } else {
        lines[row] = line + ch
      }
      col++
    }
    i++
  }
  return { text: lines.join('\n'), col, lines }
}

/**
 * Real typing, no input row below: every keystroke goes straight into bash
 * readline and is echoed back by the shell itself. Editing, history (↑↓) and
 * Tab completion behave like a normal terminal; Enter passes the whole line
 * through the approval gate.
 */
export default function TerminalView({ buffer, cwd, onClear }: Props): React.JSX.Element {
  const outRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  // the gate mirror of what the user typed since the last Enter / history key
  const lineRef = useRef('')
  const historyRef = useRef<string[]>([])
  const histRef = useRef(-1)

  // Stay glued to the bottom: new output scrolls the view.
  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight })
  }, [buffer])

  useEffect(() => {
    lineRef.current = ''
    histRef.current = -1
  }, [cwd])

  const view = useMemo(() => processTerm(buffer), [buffer])

  const send = (ch: string): void => {
    void invoke('term:char', ch)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const key = event.key
    const ctrl = event.ctrlKey || event.metaKey
    if (key === 'Enter') {
      event.preventDefault()
      const line = lineRef.current
      void invoke('term:submit', line)
      if (line.trim()) {
        historyRef.current = [...historyRef.current.filter((h) => h !== line), line].slice(-100)
      }
      histRef.current = -1
      lineRef.current = ''
      return
    }
    if (key === 'Backspace') {
      event.preventDefault()
      lineRef.current = lineRef.current.slice(0, -1)
      send('\u007f')
      return
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault()
      const list = historyRef.current
      if (list.length === 0) return
      histRef.current =
        key === 'ArrowUp' ? Math.min(histRef.current + 1, list.length - 1) : Math.max(histRef.current - 1, -1)
      const recalled = histRef.current >= 0 ? list[list.length - 1 - histRef.current] : ''
      // erase what readline shows, then retype the recalled line
      for (let i = 0; i < lineRef.current.length; i++) send('\u007f')
      for (const ch of recalled) send(ch)
      lineRef.current = recalled
      return
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault()
      send(key === 'ArrowLeft' ? '\u001b[D' : '\u001b[C')
      return
    }
    if (key === 'c' && ctrl) {
      event.preventDefault()
      lineRef.current = ''
      void invoke('term:interrupt')
      return
    }
    if (key === 'u' && ctrl) {
      event.preventDefault()
      lineRef.current = ''
      send('\u0015')
      return
    }
    if (key === 'l' && ctrl) {
      event.preventDefault()
      send('\u000c')
      return
    }
    if (key === 'Tab') {
      event.preventDefault()
      send('\t')
      return
    }
    if (key.length === 1 && !ctrl) {
      event.preventDefault()
      lineRef.current += key
      send(key)
    }
  }

  const head = view.lines.slice(0, -1).join('\n')
  const lastLine = view.lines[view.lines.length - 1] ?? ''
  const before = lastLine.slice(0, view.col)
  const after = lastLine.slice(view.col)

  return (
    <div
      className="term"
      ref={wrapRef}
      tabIndex={0}
      onClick={() => wrapRef.current?.focus()}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={onKeyDown}
    >
      <div className="term-bar">
        <span className="term-title mono">bash</span>
        <span className="term-cwd mono">{cwd}</span>
        <span className="spacer" />
        <button className="icon-btn" title={t('term.interrupt')} onClick={() => void invoke('term:interrupt')}>
          <Icon name="x-circle" size={12} />
        </button>
        <button className="icon-btn" title={t('term.clear')} onClick={onClear}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      <div className="term-out" ref={outRef}>
        <pre>{head}</pre>
        <pre className="term-last">
          {before}
          {focused && <span className="term-caret">▉</span>}
          {after}
        </pre>
      </div>
      <div className="term-hintbar hint">
        <span className="spacer" />
        {t('term.typeHint')}
      </div>
    </div>
  )
}
