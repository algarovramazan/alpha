import { t } from '../i18n'

interface Props {
  label?: string
  hint?: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  minHeight?: number
  placeholder?: string
  /** Extra controls in the header row (dirty flag, buttons). */
  actions?: React.ReactNode
}

/**
 * The settings text editor. Card with a header row and a code-font field,
 * styled by the input grammar of DESIGN-linear.app.md: card radius 12,
 * field radius 8, padding 8x12, 2px accent focus ring at 50%.
 */
export default function CodeEditor({
  label,
  hint,
  value,
  onChange,
  onBlur,
  minHeight,
  placeholder,
  actions
}: Props): React.JSX.Element {
  return (
    <div className="editor">
      {(label || hint || actions) && (
        <div className="editor-head">
          {label && <span className="editor-label">{label}</span>}
          {hint && <span className="hint">{hint}</span>}
          {actions && <span className="editor-actions">{actions}</span>}
        </div>
      )}
      <textarea
        className="editor-field"
        spellCheck={false}
        style={minHeight ? { minHeight: `${minHeight}px` } : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
      />
    </div>
  )
}

/** Small "unsaved" flag for editor headers. */
export function DirtyMark({ dirty }: { dirty: boolean }): React.JSX.Element | null {
  return dirty ? <span className="hint">{t('notes.dirtyShort')}</span> : null
}
