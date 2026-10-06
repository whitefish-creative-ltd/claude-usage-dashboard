// Reads Claude Code's history (one JSON object per line, per session) into
// 10-minute buckets, then summarises the buckets for the dashboard. Pure code:
// register.tsx lists and reads the files and keeps the state between refreshes.

import type { Aggregate, RankedRow, TimeBucket, DayBucket, TokenBucket } from '../types'

export const SCAN_VERSION = 1
export const KEEP_DAYS = 15
const BUCKET_MS = 10 * 60_000
const DAY = 86_400_000
const SEP = '\u0001'

/** How far the scanner has read one history file. */
export type FileState = {
  /** characters already read, up to the last complete line */
  len: number
  size: number
  mtime: number
  readAt: number
  /** the last message ids seen, to skip a message written over several lines */
  ids: string[]
}

export type ScanState = {
  version: number
  files: Record<string, FileState>
  /** `${bucketStart}␁${sessionId}␁${cwd}␁${model}␁${entrypoint}` → [input, output, cacheWrite, cacheRead, messages] */
  buckets: Record<string, number[]>
  /** working folder → project name (its repository's folder name) */
  cwdProject: Record<string, string>
}

export const emptyScan = (): ScanState => ({ version: SCAN_VERSION, files: {}, buckets: {}, cwdProject: {} })

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

/** Adds the complete lines of one chunk of a history file to the buckets; returns the folders it saw. */
export function ingest(state: ScanState, path: string, chunk: string, file: FileState, cutoffMs: number): Set<string> {
  const cwds = new Set<string>()
  for (const line of chunk.split('\n')) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    let d: {
      type?: string
      message?: { id?: string; model?: string; usage?: Record<string, number> }
      requestId?: string
      uuid?: string
      timestamp?: string
      sessionId?: string
      cwd?: string
      entrypoint?: string
    }
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    const m = d.message
    const u = m?.usage
    if (d.type !== 'assistant' || !m || !u) continue
    const model = m.model ?? 'unknown'
    if (model === '<synthetic>') continue
    const id = m.id ?? d.requestId ?? d.uuid
    if (!id || file.ids.includes(id)) continue
    file.ids.push(id)
    if (file.ids.length > 20) file.ids.shift()
    const ts = Date.parse(d.timestamp ?? '')
    if (!Number.isFinite(ts) || ts < cutoffMs) continue
    const sid = d.sessionId ?? baseName(path).replace(/\.jsonl$/, '')
    const cwd = d.cwd ?? ''
    if (cwd) cwds.add(cwd)
    const key = [Math.floor(ts / BUCKET_MS) * BUCKET_MS, sid, cwd, model, d.entrypoint ?? 'unknown'].join(SEP)
    const b = state.buckets[key] ?? [0, 0, 0, 0, 0]
    b[0] = (b[0] ?? 0) + (u.input_tokens ?? 0)
    b[1] = (b[1] ?? 0) + (u.output_tokens ?? 0)
    b[2] = (b[2] ?? 0) + (u.cache_creation_input_tokens ?? 0)
    b[3] = (b[3] ?? 0) + (u.cache_read_input_tokens ?? 0)
    b[4] = (b[4] ?? 0) + 1
    state.buckets[key] = b
  }
  return cwds
}

/** Drops buckets older than the window the dashboard shows. */
export function prune(state: ScanState, now: number) {
  const cutoff = now - KEEP_DAYS * DAY
  for (const k of Object.keys(state.buckets)) if (Number(k.split(SEP)[0]) < cutoff) delete state.buckets[k]
}

/**
 * The folders to check for a `.git` entry when naming a working folder's project:
 * the folder and each parent, after cutting a worktree path back to its repository.
 */
export function projectCandidates(cwd: string): string[] {
  let p = cwd.replace(/[\\/]+$/, '')
  for (const marker of ['/.claude/worktrees/', '\\.claude\\worktrees\\', '/.worktrees/', '/worktrees/']) {
    const i = p.indexOf(marker)
    if (i !== -1) p = p.slice(0, i)
  }
  const out: string[] = []
  let cur = p
  while (cur && out.length < 12) {
    out.push(cur)
    const parent = cur.replace(/[\\/][^\\/]*$/, '')
    if (!parent || parent === cur) break
    cur = parent
  }
  return out
}

/** The project name for a working folder, given which candidate (if any) is a git root. */
export function projectName(cwd: string, gitRoot: string | undefined): string {
  const fallback = projectCandidates(cwd)[0] ?? cwd
  return baseName(gitRoot ?? fallback) || 'unknown'
}

const empty = (): TokenBucket => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, messages: 0 })
function add(b: TokenBucket, v: number[]) {
  const [i = 0, o = 0, cw = 0, cr = 0, n = 0] = v
  b.input += i
  b.output += o
  b.cacheWrite += cw
  b.cacheRead += cr
  b.total += i + o + cw + cr
  b.messages += n
}

/** Summarises the buckets as the dashboard reads them, in the computer's local time. */
export function summarize(state: ScanState, now: number, weekSince?: number, sessionSince?: number): Omit<Aggregate, 'desktopSessions' | 'scanMs' | 'records'> {
  const local = new Date(now)
  const today = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime()
  const hourNow = new Date(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours()).getTime()
  const hour0 = hourNow - 23 * 3_600_000
  const dayStart = (i: number) => new Date(local.getFullYear(), local.getMonth(), local.getDate() - 13 + i).getTime()
  const day0 = dayStart(0)
  const weekTs = weekSince ?? today - 6 * DAY
  const sessionTs = sessionSince ?? now - 5 * 3_600_000

  const hourly: TimeBucket[] = Array.from({ length: 24 }, (_, i) => ({ t: hour0 + i * 3_600_000, byModel: {}, ...empty() }))
  const daily: DayBucket[] = Array.from({ length: 14 }, (_, i) => {
    const t = dayStart(i)
    const d = new Date(t)
    return { t, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, byModel: {}, ...empty() }
  })
  const weekDays: TimeBucket[] = Array.from({ length: 7 }, (_, i) => ({ t: weekTs + i * DAY, byModel: {}, ...empty() }))
  const totals = { lastHour: empty(), session: empty(), today: empty(), week: empty(), fourteenDays: empty() }
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const tables = { projects: new Map<string, RankedRow>(), models: new Map<string, RankedRow>(), entrypoints: new Map<string, RankedRow>(), sessions: new Map<string, RankedRow>() }
  const sessionProject = new Map<string, string>()
  const row = (table: Map<string, RankedRow>, name: string) => {
    let r = table.get(name)
    if (!r) {
      r = { name, session: empty(), today: empty(), week: empty(), fourteenDays: empty(), byModel: {} }
      table.set(name, r)
    }
    return r
  }

  for (const [key, v] of Object.entries(state.buckets)) {
    const [tRaw = '0', sid = '', cwd = '', model = 'unknown', entry = 'unknown'] = key.split(SEP)
    const t = Number(tRaw)
    if (t < day0) continue
    const total = (v[0] ?? 0) + (v[1] ?? 0) + (v[2] ?? 0) + (v[3] ?? 0)
    const project = cwd ? (state.cwdProject[cwd] ?? projectName(cwd, undefined)) : 'unknown'
    sessionProject.set(sid, project)
    add(totals.fourteenDays, v)
    const lt = new Date(t)
    const hm = heatmap[(lt.getDay() + 6) % 7]
    if (hm) hm[lt.getHours()] = (hm[lt.getHours()] ?? 0) + total
    // the last day starting at or before t (days aren't all 24 hours long across a clock change)
    for (let i = daily.length - 1; i >= 0; i--) {
      const d = daily[i]
      if (d && t >= d.t) {
        add(d, v)
        d.byModel[model] = (d.byModel[model] ?? 0) + total
        break
      }
    }
    if (t >= hour0) {
      const h0 = hourly[Math.floor((t - hour0) / 3_600_000)]
      if (h0) {
        add(h0, v)
        h0.byModel[model] = (h0.byModel[model] ?? 0) + total
      }
    }
    if (t >= weekTs) {
      const w = weekDays[Math.floor((t - weekTs) / DAY)]
      if (w) {
        add(w, v)
        w.byModel[model] = (w.byModel[model] ?? 0) + total
      }
    }
    const isToday = t >= today
    const isWeek = t >= weekTs
    const isSession = t + BUCKET_MS > sessionTs
    if (t + BUCKET_MS > now - 3_600_000) add(totals.lastHour, v)
    if (isSession) add(totals.session, v)
    if (isToday) add(totals.today, v)
    if (isWeek) add(totals.week, v)
    for (const [table, name] of [
      [tables.projects, project],
      [tables.models, model],
      [tables.entrypoints, entry],
      [tables.sessions, sid],
    ] as const) {
      const r = row(table, name)
      add(r.fourteenDays, v)
      if (isSession) add(r.session, v)
      if (isToday) add(r.today, v)
      if (isWeek) {
        add(r.week, v)
        r.byModel[model] = (r.byModel[model] ?? 0) + total
      }
    }
  }

  const ranked = (m: Map<string, RankedRow>) => [...m.values()].sort((a, b) => b.week.total - a.week.total || b.fourteenDays.total - a.fourteenDays.total)
  return {
    generatedAt: now,
    todayStart: today,
    tzOffsetMinutes: -local.getTimezoneOffset(),
    weekStart: weekTs,
    sessionStart: sessionTs,
    totals,
    hourly,
    daily,
    weekDays,
    projects: ranked(tables.projects),
    models: ranked(tables.models),
    entrypoints: ranked(tables.entrypoints),
    sessions: ranked(tables.sessions).map(r => ({ ...r, project: sessionProject.get(r.name) ?? 'unknown' })),
    heatmap,
  }
}
