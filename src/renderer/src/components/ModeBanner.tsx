import type { ModeId } from '@shared/types'
import { Icon } from '../Icon'
import { t } from '../i18n'

interface Props {
  mode: ModeId
  onApprove?: () => void
  onExit: () => void
}

/**
 * The strip above the feed that explains what the current mode changes and
 * offers the one action that matters (approve the plan, leave the mode).
 * Returns null in the default agent mode: no noise when nothing differs.
 */
export default function ModeBanner({ mode, onApprove, onExit }: Props): React.JSX.Element | null {
  if (mode === 'agent') return null

  const content: Record<Exclude<ModeId, 'agent'>, { icon: string; approve?: boolean }> = {
    plan: { icon: 'list-check', approve: true },
    debug: { icon: 'alert' },
    assist: { icon: 'eye' },
    quick: { icon: 'rocket' }
  }
  const info = content[mode as Exclude<ModeId, 'agent'>]
  if (!info) return null

  return (
    <div className={`plan-banner mode-banner mode-${mode}`}>
      <span className="mode-glyph">
        <Icon name={info.icon} size={14} />
      </span>
      <strong className="mode-name">{t(`modes.${mode}`)}</strong>
      <span className="mode-desc">{t(`modes.${mode}Desc`)}</span>
      <span className="mode-spacer" />
      {info.approve && onApprove && (
        <button className="btn primary small" onClick={onApprove}>
          {t('plan.approve')}
        </button>
      )}
      <button className="btn small" onClick={onExit}>
        {info.approve ? t('plan.exit') : t('modes.toAgent')}
      </button>
    </div>
  )
}
