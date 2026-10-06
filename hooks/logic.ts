import type { Aggregate, Plan, PlanWindow, SessionRow, Settings, Snapshot } from '../types'

export const DAY = 86_400_000
export const HOUR = 3_600_000

export const DEFAULT_SETTINGS: Settings = {
  workDays: 5,
  amber: 80,
  red: 90,
  awaitingHours: 12,
  refreshSeconds: 60,
  osNotify: true,
  statusLine: true,
  showBand: true,
}

/** Categorical slots (dataviz reference palette), assigned in fixed order. */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
export const STATUS = { ok: '#0ca30c', amber: '#fab219', red: '#d03b3b' }

export type Level = 'ok' | 'amber' | 'red'
export const RANK: Record<Level, number> = { ok: 0, amber: 1, red: 2 }

export function levelOf(pct: number | undefined, s: Settings): Level {
  if (pct === undefined) return 'ok'
  if (pct >= s.red) return 'red'
  if (pct >= s.amber) return 'amber'
  return 'ok'
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

export function fmtPct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–'
  return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}%`
}

/** claude-opus-5-5 → Opus 5.5; claude-haiku-4-5-20251001 → Haiku 4.5 */
export function prettyModel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
  if (!m) return id
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[3] ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`
}

export function prettyEntry(id: string): string {
  const names: Record<string, string> = {
    'claude-desktop': 'Desktop app',
    cli: 'Terminal (CLI)',
    'claude-vscode': 'VS Code',
    'sdk-ts': 'Agent SDK (TS)',
    'sdk-py': 'Agent SDK (Py)',
    'sdk-cli': 'Agent SDK',
    remote: 'Remote / web',
  }
  return names[id] ?? id
}

export function relTime(ms: number, now: number): string {
  const d = ms - now
  const a = Math.abs(d)
  const txt =
    a < 60_000 ? `${Math.round(a / 1000)}s` : a < HOUR ? `${Math.round(a / 60_000)}m` : a < DAY ? `${Math.floor(a / HOUR)}h ${Math.round((a % HOUR) / 60_000)}m` : `${Math.floor(a / DAY)}d ${Math.round((a % DAY) / HOUR)}h`
  return d >= 0 ? `in ${txt}` : `${txt} ago`
}

/** Keeps colors following the model, never its rank: new models take the next free slot. */
export function assignColors(prev: Record<string, string>, models: string[]): Record<string, string> {
  const next = { ...prev }
  const used = new Set(Object.values(next))
  for (const m of [...models].sort()) {
    if (next[m]) continue
    const free = SERIES.find(c => !used.has(c)) ?? SERIES[SERIES.length - 1]
    next[m] = free
    used.add(free)
  }
  return next
}

// ---------- plan (the app's usage card) ----------

type RawWindow = { label?: string; percentUsed?: number; resetsAt?: string }

export function windowKind(label: string): string {
  const l = label.toLowerCase()
  if (l.includes('5-hour') || l.includes('five')) return 'five_hour'
  if (l.includes('weekly') && l.includes('all models')) return 'seven_day'
  if (l.includes('weekly')) return `model:${label.split('·').pop()?.trim() ?? label}`
  return l.replace(/\s+/g, '_')
}

export function parseAppPlan(text: string, now: number): Plan | null {
  let d: { plan?: { status?: string; plan?: string; windows?: RawWindow[]; extraUsage?: { enabled?: boolean }; note?: string } }
  try {
    d = JSON.parse(text)
  } catch {
    return null
  }
  const p = d.plan
  if (!p) return null
  if (p.status !== 'ok') return { source: 'app', windows: [], note: p.note ?? `Plan limits ${p.status ?? 'unavailable'}`, at: now }
  const windows: PlanWindow[] = (p.windows ?? []).map(w => ({
    kind: windowKind(w.label ?? ''),
    label: w.label ?? '',
    percentUsed: Number(w.percentUsed ?? 0),
    resetsAt: w.resetsAt,
  }))
  return { source: 'app', plan: p.plan, windows, extraUsageEnabled: p.extraUsage?.enabled, at: now }
}

export function planFromRateLimits(limits: { kind: string; percentUsed: number; resetsAt?: string }[], now: number): Plan {
  const label: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly · all models' }
  return {
    source: limits.length ? 'session' : 'none',
    windows: limits.map(l => ({ kind: l.kind, label: label[l.kind] ?? l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    note: limits.length ? undefined : 'No plan reading yet (it arrives with the next model response).',
    at: now,
  }
}

export const findWindow = (plan: Plan | null, kind: string) => plan?.windows.find(w => w.kind === kind)

// ---------- sessions ----------

type RawSession = {
  sessionId?: string
  title?: string
  cwd?: string
  isRunning?: boolean
  isArchived?: boolean
  lastActivityAt?: string
  link?: string
  remoteControlActive?: boolean
  group?: { name?: string } | null
}

export function parseSessions(text: string): SessionRow[] | null {
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(d)) return null
  return (d as RawSession[]).map(s => ({
    sessionId: s.sessionId ?? '',
    title: s.title || 'Untitled session',
    cwd: s.cwd ?? '',
    isRunning: Boolean(s.isRunning),
    isArchived: Boolean(s.isArchived),
    lastActivityAt: s.lastActivityAt ?? '',
    link: s.link,
    remoteControlActive: Boolean(s.remoteControlActive),
    group: s.group?.name,
  }))
}

export function splitSessions(rows: SessionRow[], s: Settings, now: number) {
  const live = rows.filter(r => !r.isArchived)
  const processing = live.filter(r => r.isRunning)
  const awaiting = live.filter(r => !r.isRunning && now - Date.parse(r.lastActivityAt) <= s.awaitingHours * HOUR)
  const remote = live.filter(r => r.remoteControlActive)
  return { processing, awaiting, remote }
}

// ---------- daily budget ----------
//
// Budget days are 24-hour slots counted from the weekly reset: day 1 starts at
// the reset, day 2 a day later, and so on. The first `workDays` of them are
// working days and each adds one daily budget (100% ÷ workDays) as it starts.

export type DayUsage = { index: number; t: number; pct: number; isEstimate: boolean; isToday: boolean; isWorkDay: boolean; tokens: number }

/** When the current weekly window started: its reset minus seven days. */
export function weekStartOf(plan: Plan | null, agg: Aggregate | null): number | undefined {
  const week = findWindow(plan, 'seven_day')
  if (week?.resetsAt) return Date.parse(week.resetsAt) - 7 * DAY
  return agg?.weekStart
}

/** Weekly-window percent at time `t`, from the last snapshot at or before it in the same window. */
function weekAt(history: Snapshot[], resetsAt: string, t: number, periodStart: number): number | undefined {
  if (t <= periodStart) return 0
  let best: Snapshot | undefined
  for (const s of history) if (s.wr === resetsAt && s.t <= t && (!best || s.t > best.t)) best = s
  return best?.w
}

/**
 * How much of the weekly limit each budget day so far used, in weekly-% points.
 * Exact where snapshots bracket the day; otherwise the window's percent is
 * spread over the days by their share of Claude Code tokens (an estimate).
 */
export function dailyUsage(agg: Aggregate | null, history: Snapshot[], plan: Plan | null, now: number, s: Settings = DEFAULT_SETTINGS): DayUsage[] {
  const week = findWindow(plan, 'seven_day')
  const start = weekStartOf(plan, agg)
  if (!agg || start === undefined) return []
  const resetsAt = week?.resetsAt
  const weekPct = week?.percentUsed ?? 0
  const slots = Array.from({ length: 7 }, (_, i) => start + i * DAY).filter(t => t <= now)
  const tokensAt = (t: number) => agg.weekDays?.find(w => Math.abs(w.t - t) < 60_000)?.total ?? 0
  const periodTokens = slots.reduce((n, t) => n + tokensAt(t), 0)
  return slots.map((t, i) => {
    const end = Math.min(t + DAY, now)
    const a = resetsAt ? weekAt(history, resetsAt, t, start) : undefined
    const b = resetsAt ? weekAt(history, resetsAt, end, start) : undefined
    const exact = a !== undefined && b !== undefined && (end >= now || history.some(x => x.wr === resetsAt && x.t >= end - 15 * 60_000))
    const tokens = tokensAt(t)
    const pct = exact ? Math.max(0, (end >= now ? weekPct : (b as number)) - (a as number)) : periodTokens > 0 ? weekPct * (tokens / periodTokens) : 0
    return { index: i, t, pct, isEstimate: !exact, isToday: now >= t && now < t + DAY, isWorkDay: i < Math.min(7, Math.max(1, s.workDays)), tokens }
  })
}

export function dailyBudget(s: Settings): number {
  return 100 / Math.min(7, Math.max(1, s.workDays))
}

/** [time, cumulative %] steps of the allowance: each working budget day adds one budget as it starts. */
export function allowanceSteps(start: number, s: Settings): [number, number][] {
  const budget = dailyBudget(s)
  const work = Math.min(7, Math.max(1, s.workDays))
  const steps: [number, number][] = []
  let cum = 0
  for (let i = 0; i < 7; i++) {
    const t = start + i * DAY
    steps.push([t, cum])
    if (i < work) cum = Math.min(100, cum + budget)
    steps.push([t, cum])
  }
  steps.push([start + 7 * DAY, cum])
  return steps
}

/** The allowance available at time `t` from `allowanceSteps`. */
export function allowanceAt(steps: [number, number][], t: number): number {
  let v = 0
  for (const [st, cum] of steps) if (st <= t) v = cum
  return v
}

/** Today's use of the weekly window as a percent of the daily budget. */
export function todayVsBudget(days: DayUsage[], s: Settings): { used: number; pctOfBudget: number; isEstimate: boolean } | undefined {
  const today = days.find(d => d.isToday)
  if (!today) return undefined
  return { used: today.pct, pctOfBudget: (today.pct / dailyBudget(s)) * 100, isEstimate: today.isEstimate }
}

export function pushSnapshot(history: Snapshot[], plan: Plan | null, now: number): Snapshot[] {
  const week = findWindow(plan, 'seven_day')
  if (!week?.resetsAt) return history
  const five = findWindow(plan, 'five_hour')?.percentUsed ?? 0
  const last = history[history.length - 1]
  const keep = history.filter(s => now - s.t < 9 * DAY)
  if (last && last.w === week.percentUsed && last.wr === week.resetsAt && last.f === five && now - last.t < 15 * 60_000) return keep
  return [...keep, { t: now, w: week.percentUsed, wr: week.resetsAt, f: five }].slice(-3000)
}

// ---------- projects by sidebar group ----------

export const UNGROUPED = 'Ungrouped'
export const NO_SESSION = 'Not in the app'

export type ProjectGroup<P> = { name: string; projects: P[]; week: number; fourteenDays: number }

/**
 * Files each project under the sidebar group its sessions belong to (the group
 * most of its sessions are in; the most recent one breaks a tie). Projects with no
 * session in the app (terminal-only, or older than the list) go last.
 */
export function groupProjects<P extends { name: string; week: { total: number }; fourteenDays: { total: number } }>(
  projects: P[],
  sessions: SessionRow[],
  cwdProjects: Record<string, string>,
): ProjectGroup<P>[] {
  const votes = new Map<string, Map<string, { n: number; last: number }>>()
  for (const s of sessions) {
    const project = cwdProjects[s.cwd]
    if (!project) continue
    const group = s.group ?? UNGROUPED
    const byGroup = votes.get(project) ?? new Map<string, { n: number; last: number }>()
    const v = byGroup.get(group) ?? { n: 0, last: 0 }
    byGroup.set(group, { n: v.n + 1, last: Math.max(v.last, Date.parse(s.lastActivityAt) || 0) })
    votes.set(project, byGroup)
  }
  const groups = new Map<string, ProjectGroup<P>>()
  for (const p of projects) {
    const byGroup = votes.get(p.name)
    let name = NO_SESSION
    if (byGroup) {
      name = [...byGroup.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)[0]?.[0] ?? NO_SESSION
    }
    const g = groups.get(name) ?? { name, projects: [], week: 0, fourteenDays: 0 }
    g.projects.push(p)
    g.week += p.week.total
    g.fourteenDays += p.fourteenDays.total
    groups.set(name, g)
  }
  const rank = (g: ProjectGroup<P>) => (g.name === NO_SESSION ? 2 : g.name === UNGROUPED ? 1 : 0)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.week - a.week || b.fourteenDays - a.fourteenDays)
}
