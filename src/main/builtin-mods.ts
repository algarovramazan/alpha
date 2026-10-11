import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODS_DIR } from './paths'

interface BuiltinMod {
  id: string
  /** When present, the files are rewritten if the installed copy lacks the marker. */
  marker?: string
  files: Record<string, string>
}

// First-run example mods. They show the three mod classes and double as a
// quick way to see that the mod system works.
const MODS: BuiltinMod[] = [
  {
    id: 'noir',
    marker: '/* noir v2 */',
    files: {
      'mod.json': JSON.stringify(
        { id: 'noir', name: 'Noir', version: '1.1.0', kind: 'theme', api: '1.0', description: 'Тёмная тема с зелёным акцентом' },
        null,
        2
      ),
      'theme.css': `/* noir v2 */
:root {
  --bg: #0b0f0d;
  --surface: #101512;
  --surface-2: #161d19;
  --text: #d7f5e4;
  --text-dim: #7fa392;
  --border: #1f2a24;
  --accent: #3ddc84;
  --radius: 8px;
}
`
    }
  },
  {
    id: 'notes',
    files: {
      'mod.json': JSON.stringify(
        { id: 'notes', name: 'Notes', version: '1.0.0', kind: 'ui', api: '1.0', description: 'Панель заметок в инспекторе' },
        null,
        2
      ),
      'index.js': `export default function (alpha) {
  alpha.ui.registerPanel({
    id: 'notes',
    title: 'Заметки',
    side: 'right',
    render(container) {
      const area = document.createElement('textarea')
      area.value = localStorage.getItem('alpha-mod-notes') || ''
      area.style.cssText =
        'width:100%;min-height:120px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px;font:inherit;resize:vertical'
      area.addEventListener('input', () => localStorage.setItem('alpha-mod-notes', area.value))
      container.appendChild(area)
      return () => area.remove()
    }
  })
}
`
    }
  },
  {
    id: 'short-prompts',
    marker: '// short-prompts v2',
    files: {
      'mod.json': JSON.stringify(
        {
          id: 'short-prompts',
          name: 'Short prompts',
          version: '1.1.0',
          kind: 'core',
          api: '1.0',
          description: 'Добавляет префикс к каждому сообщению, префикс настраивается в Настройки → Моды'
        },
        null,
        2
      ),
      'index.js': `// short-prompts v2
export default function (alpha) {
  alpha.ui.registerSettings({
    fields: [
      { key: 'prefix', label: 'Префикс каждого сообщения', type: 'text', default: 'Отвечай коротко.' }
    ]
  })

  alpha.on('session:before-send', (ctx) => {
    const prefix = String(alpha.modSettings.get().prefix ?? '').trim()
    if (prefix) ctx.prompt = prefix + '\\n' + ctx.prompt
  })

  alpha.log('short-prompts v2 active')
}
`
    }
  },
]

export function installBuiltinMods(): void {
  mkdirSync(MODS_DIR, { recursive: true })
  for (const mod of MODS) {
    const dir = join(MODS_DIR, mod.id)
    if (existsSync(dir)) {
      if (!mod.marker) continue
      const haystack = ['index.js', 'theme.css']
        .map((name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : ''))
        .join('\n')
      if (haystack.includes(mod.marker)) continue
      // upgrade an older installed copy in place
      for (const [name, content] of Object.entries(mod.files)) {
        writeFileSync(join(dir, name), content)
      }
      continue
    }
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(mod.files)) {
      writeFileSync(join(dir, name), content)
    }
  }
}