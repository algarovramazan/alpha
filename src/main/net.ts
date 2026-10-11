import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emit } from './bus'
import { RUNTIME_DIR } from './paths'
import { log } from './store'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  via: string
}

// ---------------------------------------------------------------------------
// Local SearXNG in an isolated docker container (127.0.0.1 only, free, no key).
// Alpha starts it automatically; if docker is missing the fallback sources work.
// ---------------------------------------------------------------------------

const CONTAINER = 'alpha-searxng'
const DEFAULT_LOCAL = 'http://127.0.0.1:8888'
const VOL_DIR = join(RUNTIME_DIR, 'searxng')

const SETTINGS_YML = `use_default_settings: true
server:
  secret_key: "alpha-local-searx-2026"
  limiter: false
  image_proxy: true
  bind_address: "0.0.0.0"
search:
  formats:
    - html
    - json
`

let searchRequested = false
let ensureFlight: Promise<void> | null = null
let ensureRetryAt = 0
let healthyUntil = 0
let unhealthyUntil = 0

function localUrl(): string {
  return (process.env.ALPHA_SEARXNG_URL || DEFAULT_LOCAL).replace(/\/$/, '')
}

export function localSearchStatus(): { url: string; healthy: boolean } {
  return { url: localUrl(), healthy: Date.now() < healthyUntil }
}

async function fetchWithTimeout(url: string, ms: number, accept = '*/*'): Promise<Response> {
  return fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Alpha/0.1', accept },
    signal: AbortSignal.timeout(ms)
  })
}

async function checkLocal(): Promise<boolean> {
  if (Date.now() < healthyUntil) return true
  if (Date.now() < unhealthyUntil) return false
  try {
    const response = await fetchWithTimeout(`${localUrl()}/search?q=test&format=json`, 3000, 'application/json')
    const body = (await response.json()) as { results?: unknown[] }
    if (response.ok && Array.isArray(body.results)) {
      healthyUntil = Date.now() + 5 * 60_000
      return true
    }
  } catch {
    // not there (yet)
  }
  unhealthyUntil = Date.now() + 30_000
  return false
}

function docker(args: string[], timeoutMs = 15_000): { ok: boolean; out: string } {
  try {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs })
    return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } catch (error) {
    return { ok: false, out: String(error) }
  }
}

/**
 * Starts the isolated instance in the background when it is missing.
 * Never throws: every failure falls back to the keyless sources.
 */
export function ensureLocalSearx(): void {
  if (process.env.ALPHA_SEARXNG_URL) return // user runs their own instance
  if (ensureFlight || Date.now() < ensureRetryAt) return
  ensureFlight = (async () => {
    try {
      if (await checkLocal()) return
      const info = docker(['info', '--format', '{{.ServerVersion}}'], 6000)
      if (!info.ok) {
        log('info', 'web search: docker unavailable, using fallback sources')
        ensureRetryAt = Date.now() + 60 * 60_000
        return
      }
      mkdirSync(VOL_DIR, { recursive: true })
      const settingsPath = join(VOL_DIR, 'settings.yml')
      if (!existsSync(settingsPath)) writeFileSync(settingsPath, SETTINGS_YML)

      const exists = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], 8000)
      if (exists.ok && exists.out.trim() === 'false') {
        docker(['start', CONTAINER], 10_000)
      } else if (!exists.ok) {
        log('info', 'web search: pulling searxng image and starting the container')
        const run = docker(
          [
            'run',
            '-d',
            '--name',
            CONTAINER,
            '--restart',
            'unless-stopped',
            '-p',
            '127.0.0.1:8888:8080',
            '-v',
            `${VOL_DIR}:/etc/searxng`,
            'searxng/searxng:latest'
          ],
          5 * 60_000
        )
        if (!run.ok) {
          log('warn', `searxng start failed: ${run.out.slice(0, 300)}`)
          ensureRetryAt = Date.now() + 30 * 60_000
          return
        }
      }

      // wait for boot (image pull already happened above)
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        unhealthyUntil = 0
        if (await checkLocal()) break
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      if (Date.now() < healthyUntil) {
        log('info', `local searxng ready at ${localUrl()}`)
        if (searchRequested) emit({ kind: 'toast', level: 'info', message: 'Локальный поиск SearXNG подключён' })
      } else {
        ensureRetryAt = Date.now() + 15 * 60_000
        log('warn', 'local searxng did not become ready, fallbacks stay active')
      }
    } catch (error) {
      log('warn', `searxng ensure: ${String(error)}`)
      ensureRetryAt = Date.now() + 15 * 60_000
    } finally {
      ensureFlight = null
    }
  })()
}

// ---------------------------------------------------------------------------
// Keyless fallback sources
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function searchLocal(query: string, max: number): Promise<SearchHit[]> {
  if (!(await checkLocal())) return []
  const response = await fetchWithTimeout(
    `${localUrl()}/search?q=${encodeURIComponent(query)}&format=json`,
    10_000,
    'application/json'
  )
  if (!response.ok) throw new Error(`local searx: HTTP ${response.status}`)
  const body = (await response.json()) as {
    results?: { title?: string; url?: string; content?: string }[]
  }
  return (body.results ?? []).slice(0, max).map((result) => ({
    title: result.title ?? '',
    url: result.url ?? '',
    snippet: (result.content ?? '').slice(0, 300),
    via: 'searxng'
  }))
}

async function searchWikipedia(query: string, max: number): Promise<SearchHit[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=opensearch&limit=${max}&format=json&namespace=0&search=` +
    encodeURIComponent(query)
  const response = await fetchWithTimeout(url, 8000, 'application/json')
  if (!response.ok) return []
  const body = (await response.json()) as [string, string[], string[], string[]]
  const hits: SearchHit[] = []
  for (let index = 0; index < (body[1] ?? []).length; index++) {
    hits.push({
      title: body[1][index] ?? '',
      url: (body[3] ?? [])[index] ?? '',
      snippet: (body[2] ?? [])[index] ?? '',
      via: 'wikipedia'
    })
  }
  return hits
}

async function searchHackerNews(query: string, max: number): Promise<SearchHit[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${max}`
  const response = await fetchWithTimeout(url, 8000, 'application/json')
  if (!response.ok) return []
  const body = (await response.json()) as {
    hits?: { title?: string | null; url?: string | null; story_text?: string | null; objectID?: string }[]
  }
  return (body.hits ?? [])
    .filter((hit) => hit.title)
    .map((hit) => ({
      title: hit.title ?? '',
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      snippet: stripTags(hit.story_text ?? '').slice(0, 300),
      via: 'hackernews'
    }))
}

async function searchStackoverflow(query: string, max: number): Promise<SearchHit[]> {
  const url =
    `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow` +
    `&pagesize=${max}&q=${encodeURIComponent(query)}`
  const response = await fetchWithTimeout(url, 8000, 'application/json')
  if (!response.ok) return []
  const body = (await response.json()) as {
    items?: { title?: string; link?: string; body?: string; is_answered?: boolean }[]
  }
  return (body.items ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.link ?? '',
    snippet: stripTags(item.body ?? '').slice(0, 300),
    via: item.is_answered ? 'stackoverflow·answered' : 'stackoverflow'
  }))
}

async function searchGithub(query: string, max: number): Promise<SearchHit[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${max}`
  const response = await fetchWithTimeout(url, 8000, 'application/vnd.github+json')
  if (!response.ok) return []
  const body = (await response.json()) as {
    items?: { full_name?: string; html_url?: string; description?: string | null }[]
  }
  return (body.items ?? []).map((item) => ({
    title: item.full_name ?? '',
    url: item.html_url ?? '',
    snippet: (item.description ?? '').slice(0, 300),
    via: 'github'
  }))
}

// Local SearXNG first (complete results); keyless APIs cover the rest.
const FALLBACKS = [searchWikipedia, searchHackerNews, searchStackoverflow, searchGithub]

/** Free, keyless web search: isolated local SearXNG + public fallback APIs. */
export async function webSearch(query: string, max: number): Promise<SearchHit[]> {
  searchRequested = true
  const limit = Math.min(Math.max(max, 1), 10)
  const clean = String(query ?? '').trim()
  if (!clean) return []

  ensureLocalSearx()

  try {
    const local = await searchLocal(clean, limit)
    if (local.length > 0) return local
  } catch (error) {
    log('warn', `local search: ${String(error)}`)
  }

  for (const source of FALLBACKS) {
    try {
      const hits = await source(clean, limit)
      if (hits.length >= 2) return hits
    } catch {
      // try the next source
    }
  }
  return []
}

/** Downloads a page and returns readable text (max 6000 chars). */
export async function webFetchPage(url: string): Promise<string> {
  const response = await fetchWithTimeout(url, 12_000)
  if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`)
  const html = await response.text()
  return stripTags(html).slice(0, 6000)
}