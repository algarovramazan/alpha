// Inline SVG icons from /icons. Files use stroke/fill="currentColor" so they
// follow the surrounding text color in any theme.
const files = import.meta.glob('../../../icons/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>

const byName: Record<string, string> = {}
for (const [path, content] of Object.entries(files)) {
  const name = path.split('/').pop()
  if (name) byName[name.replace(/\.svg$/, '')] = content
}

export function hasIcon(name: string): boolean {
  return Boolean(byName[name])
}

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }): React.JSX.Element | null {
  const raw = byName[name]
  if (!raw) return null
  return (
    <span
      className={`icon ${className ?? ''}`}
      style={{
        width: `calc(var(--icon-scale, 1) * ${size}px)`,
        height: `calc(var(--icon-scale, 1) * ${size}px)`
      }}
      dangerouslySetInnerHTML={{ __html: raw }}
    />
  )
}
