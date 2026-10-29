/**
 * The search index: what has been said in every chat, what the CLI remembers per repo, and
 * what each repo's docs say — one full-text index, so "when do we do monthly reviews against
 * prod?" is answered from wherever it was written down.
 *
 * Node's built-in SQLite with FTS5, in the data dir. Three kinds of row:
 *
 *   chat    one per message a person typed or the session answered, from every transcript on
 *           the machine (harnesses.md: the transcript is the universal source). Tool calls
 *           and tool results are deliberately not indexed — a `cat` of `.env.local` is in a
 *           tool result, and an index of those is a file worth stealing. What is indexed is
 *           still scrubbed for the shapes of secrets, because a person pastes a token into a
 *           prompt more often than they would like.
 *   memory  one per file under a project's auto-memory folder — which, for a repo with a
 *           mirror, is the folder keyed on the mirror's path (phase 0 results).
 *   doc     one per markdown file in a mirror at its base branch: CLAUDE.md, README, docs/.
 *
 * Incremental: a transcript is re-read only when its size or mtime moved, a mirror only when
 * its base commit did. A refresh is throttled, and one is in flight at a time.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { listRepos } from '../workspaces/catalogue.mjs'
import { defaultBranch, git, mirrorPath } from '../workspaces/git.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.OUTPOST_DATA || path.join(here, '..', '..', 'data')
const DB_FILE = path.join(DATA_DIR, 'search.db')
const CLI_PROJECTS = path.join(os.homedir(), '.claude', 'projects')

/** A refresh asked for within this long of the last one is answered by the index as it is. */
const REFRESH_MIN_MS = 30 * 1000
/** A message longer than this is cut: what is being found is the subject, not the whole essay. */
const CHUNK_MAX = 4000

let db = null
let lastRefresh = 0
let refreshing = null

/** The shapes a secret takes in a prompt. Replaced before the text reaches the index. */
const SECRET_SHAPES = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/g,
  /\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s"']{6,}/gi,
]

export function scrub(text) {
  let out = String(text || '')
  for (const re of SECRET_SHAPES) out = out.replace(re, (m, key) => (key ? `${key}=[redacted]` : '[redacted]'))
  return out
}

function open() {
  if (db) return db
  db = new DatabaseSync(DB_FILE)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, kind TEXT, stamp TEXT, indexedAt INTEGER);
    CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
      body, title, kind UNINDEXED, source UNINDEXED, ref UNINDEXED, at UNINDEXED, tokenize = 'porter unicode61'
    );
  `)
  return db
}

function firstText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
}

/** A person's prompt, without the wrappers the CLI adds around one. */
function promptOf(record) {
  if (!record || record.type !== 'user' || record.isMeta || record.isSidechain || record.isCompactSummary) return ''
  let text = firstText(record.message?.content).trim()
  text = text.replace(/^(?:\[(?:Image|Pasted text)[^\]]*\]\s*)+/i, '')
  if (!text || text.startsWith('<') || /^(Caveat: The messages below|This session is being continued from)/.test(text)) return ''
  return text
}

function answerOf(record) {
  if (!record || record.type !== 'assistant' || record.isSidechain) return ''
  return firstText(record.message?.content).trim()
}

async function indexTranscript(file, d) {
  const stat = await fsp.stat(file)
  const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`
  const prior = d.prepare('SELECT stamp FROM sources WHERE path = ?').get(file)
  if (prior?.stamp === stamp) return false
  const text = await fsp.readFile(file, 'utf8')
  let title = ''
  let sessionId = ''
  let cwd = ''
  const rows = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    sessionId ||= rec.sessionId || ''
    cwd ||= rec.cwd || ''
    const prompt = promptOf(rec)
    const answer = prompt ? '' : answerOf(rec)
    const body = prompt || answer
    if (!body) continue
    if (prompt && !title) title = prompt.slice(0, 72)
    const at = Date.parse(rec.timestamp || '') || stat.mtimeMs
    rows.push({ body: scrub(body).slice(0, CHUNK_MAX), role: prompt ? 'user' : 'assistant', at })
  }
  const del = d.prepare('DELETE FROM entries WHERE source = ?')
  const ins = d.prepare('INSERT INTO entries (body, title, kind, source, ref, at) VALUES (?, ?, ?, ?, ?, ?)')
  const up = d.prepare('INSERT OR REPLACE INTO sources (path, kind, stamp, indexedAt) VALUES (?, ?, ?, ?)')
  d.exec('BEGIN')
  try {
    del.run(file)
    const ref = JSON.stringify({ sessionId, cwd: path.basename(cwd), file: path.basename(file) })
    for (const r of rows) ins.run(r.body, title || path.basename(cwd), r.role === 'user' ? 'chat' : 'answer', file, ref, r.at)
    up.run(file, 'transcript', stamp, Date.now())
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return true
}

async function indexMemoryFile(file, projectDir, d) {
  const stat = await fsp.stat(file)
  const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`
  const prior = d.prepare('SELECT stamp FROM sources WHERE path = ?').get(file)
  if (prior?.stamp === stamp) return false
  const text = scrub(await fsp.readFile(file, 'utf8'))
  const m = /^name:\s*(.+)$/m.exec(text)
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM entries WHERE source = ?').run(file)
    d.prepare('INSERT INTO entries (body, title, kind, source, ref, at) VALUES (?, ?, ?, ?, ?, ?)').run(
      text.slice(0, CHUNK_MAX),
      m ? m[1].trim() : path.basename(file, '.md'),
      'memory',
      file,
      JSON.stringify({ project: projectDir, file: path.basename(file) }),
      stat.mtimeMs
    )
    d.prepare('INSERT OR REPLACE INTO sources (path, kind, stamp, indexedAt) VALUES (?, ?, ?, ?)').run(file, 'memory', stamp, Date.now())
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return true
}

async function indexMirrorDocs(repo, d) {
  const mirror = mirrorPath(repo.id)
  let base
  let head
  try {
    base = repo.baseBranch || (await defaultBranch(mirror))
    head = (await git(['rev-parse', `origin/${base}`], { cwd: mirror })).trim()
  } catch {
    return false // no mirror yet, or no such branch: nothing to index until a chat clones it
  }
  const key = `mirror:${repo.id}`
  const prior = d.prepare('SELECT stamp FROM sources WHERE path = ?').get(key)
  if (prior?.stamp === head) return false
  const listing = await git(['ls-tree', '-r', '--name-only', `origin/${base}`], { cwd: mirror, timeout: 30000 })
  const files = listing.split('\n').filter((f) => /\.md$/i.test(f) && !/node_modules\//.test(f)).slice(0, 400)
  const docs = []
  for (const f of files) {
    try {
      const text = await git(['show', `origin/${base}:${f}`], { cwd: mirror, timeout: 30000 })
      docs.push({ path: f, text: scrub(text) })
    } catch {
      /* a file git cannot show is skipped */
    }
  }
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM entries WHERE source = ?').run(key)
    const ins = d.prepare('INSERT INTO entries (body, title, kind, source, ref, at) VALUES (?, ?, ?, ?, ?, ?)')
    for (const doc of docs) {
      // Long docs are split on headings, so a hit lands on the section rather than the file.
      const sections = doc.text.split(/\n(?=#{1,3} )/)
      for (const section of sections) {
        if (!section.trim()) continue
        const heading = /^#{1,3} (.+)$/m.exec(section)
        ins.run(section.slice(0, CHUNK_MAX), `${repo.name}/${doc.path}${heading ? ` › ${heading[1].trim()}` : ''}`, 'doc', key, JSON.stringify({ repo: repo.id, path: doc.path, base }), Date.now())
      }
    }
    d.prepare('INSERT OR REPLACE INTO sources (path, kind, stamp, indexedAt) VALUES (?, ?, ?, ?)').run(key, 'docs', head, Date.now())
    d.exec('COMMIT')
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  }
  return true
}

/**
 * Bring the index up to date. Throttled and single-flight: a burst of searches is one scan.
 * Returns how many sources changed. Errors in one source never stop the others.
 */
export async function refresh({ force = false } = {}) {
  if (refreshing) return refreshing
  if (!force && Date.now() - lastRefresh < REFRESH_MIN_MS) return 0
  refreshing = (async () => {
    const d = open()
    let changed = 0
    const seen = new Set()
    let projects = []
    try {
      projects = await fsp.readdir(CLI_PROJECTS)
    } catch {
      /* no CLI projects dir: nothing to index */
    }
    for (const dir of projects) {
      const full = path.join(CLI_PROJECTS, dir)
      let names = []
      try {
        names = await fsp.readdir(full)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const file = path.join(full, name)
        seen.add(file)
        try {
          if (await indexTranscript(file, d)) changed++
        } catch {
          /* a transcript mid-write, or unreadable: next time */
        }
      }
      const memoryDir = path.join(full, 'memory')
      let memos = []
      try {
        memos = await fsp.readdir(memoryDir)
      } catch {
        continue
      }
      for (const name of memos) {
        if (!name.endsWith('.md') || name === 'MEMORY.md') continue
        const file = path.join(memoryDir, name)
        seen.add(file)
        try {
          if (await indexMemoryFile(file, dir, d)) changed++
        } catch {
          /* skipped */
        }
      }
    }
    let repos = []
    try {
      repos = await listRepos()
    } catch {
      /* no catalogue */
    }
    for (const repo of repos) {
      seen.add(`mirror:${repo.id}`)
      try {
        if (await indexMirrorDocs(repo, d)) changed++
      } catch {
        /* a mirror mid-fetch: next time */
      }
    }
    // Sources that are gone take their rows with them — except a transcript. The CLI purges
    // old ones on its own clock, and what was said in a chat is worth finding long after the
    // file and the workspace are gone; a memory or a doc that was deleted is one somebody
    // meant to delete.
    for (const row of d.prepare('SELECT path, kind FROM sources').all()) {
      if (seen.has(row.path) || row.kind === 'transcript') continue
      d.prepare('DELETE FROM entries WHERE source = ?').run(row.path)
      d.prepare('DELETE FROM sources WHERE path = ?').run(row.path)
      changed++
    }
    lastRefresh = Date.now()
    return changed
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

/** FTS5 takes a query language; a person's words are quoted so punctuation cannot break it. */
function ftsQuery(text) {
  const words = String(text || '')
    .split(/\s+/)
    .map((w) => w.replace(/["']/g, '').trim())
    .filter((w) => w.length > 1)
  if (!words.length) return ''
  return words.map((w) => `"${w}"`).join(' ')
}

/**
 * Search. `kinds` narrows to `chat`, `answer`, `memory` or `doc`. Results carry a snippet
 * with the match marked, the title (a chat's first prompt, a memory's name, a doc's path and
 * heading), and a `ref` the caller can follow.
 */
export async function search(query, { kinds = [], limit = 20 } = {}) {
  await refresh()
  const d = open()
  const q = ftsQuery(query)
  if (!q) return []
  const where = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : ''
  const rows = d
    .prepare(
      `SELECT title, kind, source, ref, at, snippet(entries, 0, '«', '»', '…', 24) AS snippet, bm25(entries) AS rank
       FROM entries WHERE entries MATCH ?${where} ORDER BY rank LIMIT ?`
    )
    .all(q, ...kinds, Math.max(1, Math.min(100, limit)))
  return rows.map((r) => ({
    kind: r.kind,
    title: r.title,
    snippet: r.snippet,
    at: Number(r.at) || 0,
    ref: safeJson(r.ref),
  }))
}

const safeJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export async function indexStats() {
  const d = open()
  const sources = d.prepare('SELECT kind, COUNT(*) AS n FROM sources GROUP BY kind').all()
  const entries = d.prepare('SELECT COUNT(*) AS n FROM entries').get()
  return { sources, entries: entries?.n || 0, lastRefresh }
}
