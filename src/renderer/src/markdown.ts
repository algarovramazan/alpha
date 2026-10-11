// markdown-it is loaded lazily on the first idle callback, so it stays out of
// the initial renderer bundle (code splitting item 7 + 9).
interface MarkdownRenderer {
  render(src: string): string
}

let instance: MarkdownRenderer | null = null

export function warmMarkdown(): void {
  if (instance) return
  void import('markdown-it')
    .then((module) => {
      instance = new module.default({ html: false, linkify: true, breaks: false })
    })
    .catch(() => undefined)
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Renders markdown once the library is warm; a plain escaped block before that. */
export function renderMarkdown(text: string): string {
  if (instance) return instance.render(text)
  warmMarkdown()
  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`)
    .join('')
}