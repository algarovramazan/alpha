// Small syntax highlighter — no dependency, one regex pass per language.
// Input is escaped token by token; output is HTML with <span class="tok-*">.

export type Lang = 'js' | 'py' | 'shell' | 'html' | 'css' | 'json' | 'md' | 'yml' | 'sql' | 'c' | 'generic'

interface LangCfg {
  line?: string
  block?: string
  string: string
  keywords: string[]
  extra?: string
}

const JS_STRING = '`(?:\\\\.|[^`\\\\])*`|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\''
const SIMPLE_STRING = '"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\''
const TAG = '<\\/?[a-zA-Z][\\w:.-]*|\\/?>'

const KEYWORDS: Record<string, string[]> = {
  js: [
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'of', 'in', 'new', 'class',
    'extends', 'super', 'import', 'from', 'export', 'default', 'async', 'await', 'try', 'catch', 'finally',
    'throw', 'typeof', 'instanceof', 'delete', 'switch', 'case', 'break', 'continue', 'do', 'yield', 'static',
    'this', 'null', 'undefined', 'true', 'false', 'interface', 'type', 'enum', 'implements', 'private',
    'protected', 'public', 'readonly', 'as', 'satisfies'
  ],
  py: [
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is', 'import',
    'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'pass', 'break', 'continue', 'global',
    'nonlocal', 'yield', 'assert', 'del', 'async', 'await', 'True', 'False', 'None', 'self', 'match', 'case'
  ],
  shell: [
    'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function',
    'return', 'export', 'local', 'source', 'alias', 'exit', 'set', 'unset', 'read', 'trap', 'shift', 'eval',
    'exec', 'test', 'select', 'until', 'declare', 'readonly'
  ],
  sql: [
    'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table',
    'drop', 'alter', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'order', 'by', 'limit',
    'as', 'and', 'or', 'not', 'null', 'primary', 'key', 'index', 'int', 'varchar', 'text', 'boolean',
    'union', 'having', 'exists', 'between', 'like', 'distinct'
  ],
  c: [
    'int', 'char', 'float', 'double', 'void', 'long', 'short', 'unsigned', 'signed', 'struct', 'union',
    'enum', 'typedef', 'static', 'const', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'default', 'break', 'continue', 'goto', 'sizeof', 'extern', 'volatile', 'auto', 'register', 'func',
    'package', 'range', 'go', 'chan', 'defer', 'map', 'string', 'bool', 'var', 'nil', 'interface', 'type'
  ],
  css: ['important', 'media', 'import', 'supports', 'keyframes', 'var', 'from', 'to'],
  json: ['true', 'false', 'null'],
  html: [],
  md: [],
  yml: [],
  generic: []
}

const CONFIGS: Record<Lang, LangCfg> = {
  js: { line: '\\/\\/[^\\n]*', block: '\\/\\*[\\s\\S]*?\\*\\/', string: JS_STRING, keywords: KEYWORDS.js },
  c: { line: '\\/\\/[^\\n]*', block: '\\/\\*[\\s\\S]*?\\*\\/', string: JS_STRING, keywords: KEYWORDS.c },
  py: { line: '#[^\\n]*', block: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'', string: JS_STRING, keywords: KEYWORDS.py },
  shell: { line: '#[^\\n]*', string: JS_STRING, keywords: KEYWORDS.shell },
  html: { block: '<!--[\\s\\S]*?-->', string: SIMPLE_STRING, keywords: KEYWORDS.html, extra: TAG },
  css: { block: '\\/\\*[\\s\\S]*?\\*\\/', string: SIMPLE_STRING, keywords: KEYWORDS.css },
  json: { string: '"(?:\\\\.|[^"\\\\])*"', keywords: KEYWORDS.json },
  md: { line: '^\\s{0,3}<!--[^\\n]*', string: '`[^`\\n]*`', keywords: KEYWORDS.md },
  yml: { line: '#[^\\n]*', string: SIMPLE_STRING, keywords: KEYWORDS.yml },
  sql: { line: '--[^\\n]*', string: "'(?:[^'\\n])*'", keywords: KEYWORDS.sql },
  generic: { line: '\\/\\/[^\\n]*', string: SIMPLE_STRING, keywords: KEYWORDS.generic }
}

const EXT_LANG: Record<string, Lang> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', vue: 'js',
  py: 'py', pyw: 'py',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md',
  yml: 'yml', yaml: 'yml',
  sql: 'sql',
  c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', java: 'c', go: 'c', rs: 'c', kt: 'c', swift: 'c', cs: 'c'
}

export function langFor(fileName: string): Lang {
  const name = fileName.split('/').pop() ?? fileName
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  return EXT_LANG[ext] ?? 'generic'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function kindsOf(cfg: LangCfg): string[] {
  const kinds: string[] = []
  if (cfg.block) kinds.push('comment')
  if (cfg.line) kinds.push('comment')
  kinds.push('string')
  if (cfg.extra) kinds.push('tag')
  kinds.push('number')
  if (cfg.keywords.length) kinds.push('keyword')
  return kinds
}

function buildRegex(cfg: LangCfg): RegExp {
  const parts: string[] = []
  if (cfg.block) parts.push(`(${cfg.block})`)
  if (cfg.line) parts.push(`(${cfg.line})`)
  parts.push(`(${cfg.string})`)
  if (cfg.extra) parts.push(`(${cfg.extra})`)
  parts.push('(\\b\\d+(?:\\.\\d+)?\\b)')
  if (cfg.keywords.length) parts.push(`\\b(${cfg.keywords.join('|')})\\b`)
  return new RegExp(parts.join('|'), 'gi')
}

/** Renders highlighted HTML for a code string. */
export function highlightCode(code: string, lang: Lang): string {
  const cfg = CONFIGS[lang] ?? CONFIGS.generic
  const kinds = kindsOf(cfg)
  const regex = buildRegex(cfg)
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(code)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++
      continue
    }
    out += escapeHtml(code.slice(last, match.index))
    let kind = ''
    for (let group = 1; group <= kinds.length; group++) {
      if (match[group] !== undefined) {
        kind = kinds[group - 1]
        break
      }
    }
    out += kind ? `<span class="tok-${kind}">${escapeHtml(match[0])}</span>` : escapeHtml(match[0])
    last = match.index + match[0].length
  }
  out += escapeHtml(code.slice(last))
  return out
}
