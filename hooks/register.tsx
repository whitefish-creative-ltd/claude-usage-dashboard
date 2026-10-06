import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Aggregate, Plan, Sessions, Settings, Snapshot } from '../types'
import { KEEP_DAYS, SCAN_VERSION, emptyScan, ingest, projectCandidates, projectName, prune, summarize } from './scanner'
import type { FileState, ScanState } from './scanner'
import { drawPane } from './pane'
import {
  DAY,
  DEFAULT_SETTINGS,
  HOUR,
  RANK,
  assignColors,
  dailyBudget,
  dailyUsage,
  findWindow,
  fmtPct,
  fmtCount,
  levelOf,
  parseAppPlan,
  parseSessions,
  planFromRateLimits,
  pushSnapshot,
  relTime,
  todayVsBudget,
} from './logic'
import type { Level } from './logic'

const PANE = 'whitefish-usage-dashboard'

const aggA = atom({ plugin: 'whitefish-usage-dashboard', key: 'agg' } as const, null)
const aggErrorA = atom({ plugin: 'whitefish-usage-dashboard', key: 'aggError' } as const, null)
const planA = atom({ plugin: 'whitefish-usage-dashboard', key: 'plan' } as const, null)
const sessionsA = atom({ plugin: 'whitefish-usage-dashboard', key: 'sessions' } as const, null)
const historyA = atom({ plugin: 'whitefish-usage-dashboard', key: 'history' } as const, [])
const settingsA = atom({ plugin: 'whitefish-usage-dashboard', key: 'settings' } as const, DEFAULT_SETTINGS)
const tabA = atom({ plugin: 'whitefish-usage-dashboard', key: 'tab' } as const, 'overview')
const colorsA = atom({ plugin: 'whitefish-usage-dashboard', key: 'modelColors' } as const, {})
const refreshingA = atom({ plugin: 'whitefish-usage-dashboard', key: 'refreshing' } as const, false)
const bandDismissedA = atom({ plugin: 'whitefish-usage-dashboard', key: 'bandDismissed' } as const, '')
const collapsedA = atom({ plugin: 'whitefish-usage-dashboard', key: 'collapsedGroups' } as const, [])
const aboutA = atom({ plugin: 'whitefish-usage-dashboard', key: 'about' } as const, { version: '', released: '' })

type $T = EngineInterface

// ---------------------------------------------------------------- data

let busy = false
let timer: { cancel: () => void } | null = null
let measureTimer: { cancel: () => void } | null = null
let followUp: { cancel: () => void } | null = null

/** Most characters one refresh reads, so a first scan spreads over several refreshes. */
const READ_BUDGET = 120_000_000
/** Files larger than this are skipped: the plugin can only read whole files. */
const MAX_FILE = 400_000_000
/** Files larger than this are re-read at most once an hour. */
const BIG_FILE = 100_000_000

type ToolResult = { text?: string; status: 'ok' | 'needs-access' | 'unavailable' }

function toolText(r: unknown): string | null {
  const x = r as { deny?: string; isError?: boolean; text?: string; result?: unknown }
  if (!x || x.deny || x.isError) return null
  if (typeof x.text === 'string' && x.text) return x.text
  if (typeof x.result === 'string') return x.result
  if (Array.isArray(x.result)) {
    const t = (x.result as { type?: string; text?: string }[]).filter(b => b.type === 'text').map(b => b.text ?? '')
    if (t.length) return t.join('')
  }
  return x.result === undefined ? null : JSON.stringify(x.result)
}

const CONSENT = 'The user pressed "Connect" on the usage dashboard'

// The four read-only Claude Desktop tools the dashboard uses, each called by its
// fixed name. Without `ask`, a tool that would need the person's permission is
// skipped rather than prompting on every refresh.

async function callGetUsage($: $T, ask: boolean): Promise<ToolResult> {
  try {
    if (!(await $.tool.list()).some(t => t.name === 'mcp__ccd_session_mgmt__get_usage')) return { status: 'unavailable' }
    if (!ask) {
      const { decision } = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__get_usage', input: {} })
      if (decision !== 'allow') return { status: decision === 'ask' ? 'needs-access' : 'unavailable' }
    }
    const text = toolText(await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_usage', ...(ask ? { consent: CONSENT } : {}) } as never))
    return text ? { text, status: 'ok' } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

async function callListSessions($: $T, ask: boolean): Promise<ToolResult> {
  try {
    if (!(await $.tool.list()).some(t => t.name === 'mcp__ccd_session_mgmt__list_sessions')) return { status: 'unavailable' }
    if (!ask) {
      const { decision } = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__list_sessions', input: { limit: 500, include_archived: true } })
      if (decision !== 'allow') return { status: decision === 'ask' ? 'needs-access' : 'unavailable' }
    }
    const text = toolText(await $.tool.call({ tool: 'mcp__ccd_session_mgmt__list_sessions', limit: 500, include_archived: true, ...(ask ? { consent: CONSENT } : {}) } as never))
    return text ? { text, status: 'ok' } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

async function callGetSession($: $T, ask: boolean): Promise<ToolResult> {
  try {
    if (!(await $.tool.list()).some(t => t.name === 'mcp__ccd_session_mgmt__get_session')) return { status: 'unavailable' }
    if (!ask) {
      const { decision } = await $.tool.check({ tool: 'mcp__ccd_session_mgmt__get_session', input: { session_id: 'self' } })
      if (decision !== 'allow') return { status: decision === 'ask' ? 'needs-access' : 'unavailable' }
    }
    const text = toolText(await $.tool.call({ tool: 'mcp__ccd_session_mgmt__get_session', session_id: 'self', ...(ask ? { consent: CONSENT } : {}) } as never))
    return text ? { text, status: 'ok' } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

async function callListGroups($: $T, ask: boolean): Promise<ToolResult> {
  try {
    if (!(await $.tool.list()).some(t => t.name === 'mcp__ccd_sidebar__list_groups')) return { status: 'unavailable' }
    if (!ask) {
      const { decision } = await $.tool.check({ tool: 'mcp__ccd_sidebar__list_groups', input: {} })
      if (decision !== 'allow') return { status: decision === 'ask' ? 'needs-access' : 'unavailable' }
    }
    const text = toolText(await $.tool.call({ tool: 'mcp__ccd_sidebar__list_groups', ...(ask ? { consent: CONSENT } : {}) } as never))
    return text ? { text, status: 'ok' } : { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}

async function loadPlan($: $T, ask: boolean, now: number): Promise<{ plan: Plan; needsAccess: boolean }> {
  const r = await callGetUsage($, ask)
  if (r.text) {
    const p = parseAppPlan(r.text, now)
    if (p && (p.windows.length || p.note)) return { plan: p, needsAccess: false }
  }
  const usage = await $.session.usage()
  return { plan: planFromRateLimits(usage.rateLimits, now), needsAccess: r.status === 'needs-access' }
}

async function loadSessions($: $T, ask: boolean, now: number): Promise<Sessions> {
  const r = await callListSessions($, ask)
  if (r.status !== 'ok' || !r.text) {
    return {
      status: r.status === 'needs-access' ? 'needs-access' : 'unavailable',
      rows: [],
      note: r.status === 'needs-access' ? 'Allow the dashboard to read your session list.' : 'Session list is only available in the Claude desktop app.',
      at: now,
    }
  }
  // The sidebar's group order; best effort, the list works without it.
  let groupOrder: string[] | undefined
  const g = await callListGroups($, ask)
  if (g.text) {
    try {
      const list = JSON.parse(g.text) as { name?: string; order?: number }[]
      groupOrder = [...list].sort((x, y) => (x.order ?? 0) - (y.order ?? 0)).map(x => x.name ?? '').filter(Boolean)
    } catch {
      groupOrder = undefined
    }
  }
  // The list leaves out the session the dashboard runs in: add it, so its project
  // lands in its own group (otherwise each session sees a different grouping).
  const rows = parseSessions(r.text) ?? []
  const self = await callGetSession($, ask)
  if (self.text) {
    const me = parseSessions(`[${self.text}]`)?.[0]
    if (me?.sessionId && !rows.some(x => x.sessionId === me.sessionId)) rows.unshift(me)
  }
  return { status: 'ok', rows, groupOrder, at: now }
}

/** Where Claude Code and the Claude Desktop app keep their files on this computer. */
async function locations($: $T) {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  const appData = await $.env.get('APPDATA')
  const desktopDirs = [
    `${home}/Library/Application Support/Claude/claude-code-sessions`,
    ...(appData ? [`${appData}/Claude/claude-code-sessions`] : []),
    `${home}/.config/Claude/claude-code-sessions`,
  ]
  return { projects: `${configDir}/projects`, desktopDirs }
}

async function listJsonl($: $T, dir: string): Promise<{ path: string; size: number; mtime: number }[]> {
  const out: { path: string; size: number; mtime: number }[] = []
  let projects: Awaited<ReturnType<typeof $.fs.list>> = []
  try {
    projects = await $.fs.list(dir)
  } catch {
    return out
  }
  for (const p of projects) {
    if (p.kind !== 'dir') continue
    const pdir = `${dir}/${p.name}`
    let entries: Awaited<ReturnType<typeof $.fs.list>> = []
    try {
      entries = await $.fs.list(pdir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.kind === 'file' && e.name.endsWith('.jsonl')) out.push({ path: `${pdir}/${e.name}`, size: e.size, mtime: e.mtimeMs })
      // a session's subagents keep their own files under <session>/subagents
      if (e.kind === 'dir') {
        try {
          for (const s of await $.fs.list(`${pdir}/${e.name}/subagents`)) {
            if (s.kind === 'file' && s.name.endsWith('.jsonl')) out.push({ path: `${pdir}/${e.name}/subagents/${s.name}`, size: s.size, mtime: s.mtimeMs })
          }
        } catch {
          // no subagents
        }
      }
    }
  }
  return out
}

/** Reads what's new in Claude Code's history files into the scan state; true when more is left to read. */
async function scanHistory($: $T, now: number): Promise<{ state: ScanState; more: boolean; skipped: number }> {
  const stored = (await $.store.get('scan')) as ScanState | undefined
  const state = stored && stored.version === SCAN_VERSION ? stored : emptyScan()
  const { projects } = await locations($)
  const cutoff = now - KEEP_DAYS * DAY
  const files = (await listJsonl($, projects)).filter(f => f.mtime >= cutoff)
  const seen = new Set(files.map(f => f.path))
  for (const p of Object.keys(state.files)) if (!seen.has(p)) delete state.files[p]

  let budget = READ_BUDGET
  let more = false
  let skipped = 0
  const cwds = new Set<string>()
  // newest first, so a long first scan shows today's figures soonest
  for (const f of files.sort((a, b) => b.mtime - a.mtime)) {
    const fs0 = state.files[f.path]
    if (fs0 && fs0.size === f.size && fs0.mtime === f.mtime) continue
    if (f.size > MAX_FILE) {
      skipped++
      continue
    }
    if (fs0 && f.size > BIG_FILE && now - fs0.readAt < HOUR) continue
    if (budget <= 0) {
      more = true
      break
    }
    let text: string
    try {
      text = await $.fs.read(f.path)
    } catch {
      continue
    }
    budget -= text.length
    const file: FileState = fs0 && text.length >= fs0.len ? fs0 : { len: 0, size: 0, mtime: 0, readAt: 0, ids: [] }
    const chunk = text.slice(file.len)
    const end = chunk.lastIndexOf('\n')
    if (end >= 0) {
      for (const c of ingest(state, f.path, chunk.slice(0, end + 1), file, cutoff)) cwds.add(c)
      file.len += end + 1
    }
    file.size = f.size
    file.mtime = f.mtime
    file.readAt = now
    state.files[f.path] = file
  }

  // Name each new working folder after its repository: the nearest folder with a .git entry.
  for (const cwd of cwds) {
    if (state.cwdProject[cwd]) continue
    let root: string | undefined
    for (const c of projectCandidates(cwd)) {
      try {
        if (await $.fs.exists(`${c}/.git`)) {
          root = c
          break
        }
      } catch {
        break
      }
    }
    state.cwdProject[cwd] = projectName(cwd, root)
  }

  prune(state, now)
  try {
    await $.store.set('scan', state)
  } catch {
    // over the store's size limit: keep the totals, drop the per-file message ids
    for (const f of Object.values(state.files)) f.ids = []
    try {
      await $.store.set('scan', state)
    } catch {
      // the next refresh reads again
    }
  }
  return { state, more, skipped }
}

/** Claude Desktop's own record of each Code-tab session: its title and the history ids it holds. */
async function desktopSessions($: $T): Promise<NonNullable<Aggregate['desktopSessions']>> {
  const out: NonNullable<Aggregate['desktopSessions']> = []
  const { desktopDirs } = await locations($)
  for (const root of desktopDirs) {
    let accounts: Awaited<ReturnType<typeof $.fs.list>> = []
    try {
      accounts = await $.fs.list(root)
    } catch {
      continue
    }
    for (const a of accounts.filter(x => x.kind === 'dir')) {
      let orgs: Awaited<ReturnType<typeof $.fs.list>> = []
      try {
        orgs = await $.fs.list(`${root}/${a.name}`)
      } catch {
        continue
      }
      for (const o of orgs.filter(x => x.kind === 'dir')) {
        let records: Awaited<ReturnType<typeof $.fs.list>> = []
        try {
          records = await $.fs.list(`${root}/${a.name}/${o.name}`)
        } catch {
          continue
        }
        for (const r of records) {
          if (r.kind !== 'file' || !r.name.startsWith('local_') || !r.name.endsWith('.json')) continue
          try {
            const d = JSON.parse(await $.fs.read(`${root}/${a.name}/${o.name}/${r.name}`)) as {
              sessionId?: string
              title?: string
              cliSessionId?: string
              priorCliSessionIds?: string[]
              isArchived?: boolean
            }
            const ids = [d.cliSessionId, ...(d.priorCliSessionIds ?? [])].filter((x): x is string => typeof x === 'string' && x.length > 0)
            if (d.sessionId && ids.length) out.push({ id: d.sessionId, title: d.title || 'Untitled session', cliIds: ids, isArchived: Boolean(d.isArchived) })
          } catch {
            // a record being written: next refresh
          }
        }
      }
    }
  }
  return out
}

async function loadAggregate($: $T, plan: Plan | null, now: number): Promise<{ agg?: Aggregate; error?: string; more: boolean }> {
  const week = findWindow(plan, 'seven_day')
  const five = findWindow(plan, 'five_hour')
  const since = week?.resetsAt ? Date.parse(week.resetsAt) - 7 * DAY : undefined
  const sessionSince = five?.resetsAt ? Date.parse(five.resetsAt) - 5 * HOUR : undefined
  try {
    const started = await $.clock.now()
    const { state, more, skipped } = await scanHistory($, now)
    const agg: Aggregate = {
      ...summarize(state, now, since, sessionSince),
      desktopSessions: await desktopSessions($),
      scanMs: (await $.clock.now()) - started,
      records: Object.keys(state.buckets).length,
      skippedFiles: skipped,
      isScanning: more,
    }
    return { agg, more }
  } catch (err) {
    return { error: String(err), more: false }
  }
}

async function refresh($: $T, ask = false) {
  if (busy) return
  busy = true
  let more = false
  try {
    await update($, refreshingA, () => true)
    const now = await $.clock.now()
    const settings = await read($, settingsA)

    const { plan } = await loadPlan($, ask, now)
    await update($, planA, () => plan)

    const sessions = await loadSessions($, ask, now)
    await update($, sessionsA, () => sessions)

    const result = await loadAggregate($, plan, now)
    more = result.more
    const agg = result.agg
    if (agg) {
      await update($, aggA, () => agg)
      const prev = await read($, colorsA)
      const colors = assignColors(prev, agg.models.map(m => m.name))
      if (Object.keys(colors).length !== Object.keys(prev).length) {
        await update($, colorsA, () => colors)
        await $.store.set('modelColors', colors)
      }
    }
    await update($, aggErrorA, () => result.error ?? null)

    const history = pushSnapshot(await read($, historyA), plan, now)
    await update($, historyA, () => history)
    await $.store.set('history', history)

    await checkAlerts($, settings, plan, agg ?? (await read($, aggA)), history, now)
  } finally {
    busy = false
    await update($, refreshingA, () => false)
  }
  // A first scan spreads over several refreshes: carry on shortly.
  if (more) {
    followUp?.cancel()
    followUp = $.clock.after(1500, () => void refresh($))
  }
}

// ---------------------------------------------------------------- alerts

type Reading = { id: string; label: string; pct: number; period: string; detail: string }

function readings(settings: Settings, plan: Plan | null, agg: Aggregate | null, history: Snapshot[], now: number): Reading[] {
  const out: Reading[] = []
  const five = findWindow(plan, 'five_hour')
  if (five) out.push({ id: 'five', label: 'Current session', pct: five.percentUsed, period: five.resetsAt ?? '', detail: five.resetsAt ? `resets ${relTime(Date.parse(five.resetsAt), now)}` : '' })
  const today = todayVsBudget(dailyUsage(agg, history, plan, now, settings), settings)
  if (today && agg)
    out.push({
      id: 'day',
      label: "Today's budget",
      pct: today.pctOfBudget,
      period: String(agg.todayStart),
      detail: `${fmtPct(today.used)} of weekly used today · budget ${fmtPct(dailyBudget(settings))}/day${today.isEstimate ? ' (est.)' : ''}`,
    })
  const week = findWindow(plan, 'seven_day')
  if (week) out.push({ id: 'week', label: 'This week', pct: week.percentUsed, period: week.resetsAt ?? '', detail: week.resetsAt ? `resets ${relTime(Date.parse(week.resetsAt), now)}` : '' })
  for (const w of plan?.windows ?? []) {
    if (w.kind.startsWith('model:')) out.push({ id: w.kind, label: `${w.kind.slice(6)} this week`, pct: w.percentUsed, period: w.resetsAt ?? '', detail: '' })
  }
  return out
}

async function checkAlerts($: $T, settings: Settings, plan: Plan | null, agg: Aggregate | null, history: Snapshot[], now: number) {
  const list = readings(settings, plan, agg, history, now)
  const sent = ((await $.store.get('alerts')) ?? {}) as Record<string, { period: string; level: Level }>
  let changed = false
  for (const r of list) {
    const level = levelOf(r.pct, settings)
    const prev = sent[r.id]
    const prevLevel: Level = prev && prev.period === r.period ? prev.level : 'ok'
    if (RANK[level] > RANK[prevLevel]) {
      const msg = `${r.label} usage at ${fmtPct(r.pct)}${level === 'red' ? ' — critical' : ''}`
      $.ui.toast(`${level === 'red' ? '🔴' : '🟠'} ${msg}${r.detail ? ` (${r.detail})` : ''}`, { timeoutMs: 12_000 })
    }
    if (!prev || prev.period !== r.period || prev.level !== level) {
      sent[r.id] = { period: r.period, level }
      changed = true
    }
  }
  if (changed) await $.store.set('alerts', sent)

  if (settings.statusLine && !settings.isClosed) {
    const dot = (l: Level) => (l === 'red' ? '🔴 ' : l === 'amber' ? '🟠 ' : '')
    const parts = list.filter(r => ['five', 'day', 'week'].includes(r.id)).map(r => `${dot(levelOf(r.pct, settings))}${r.id === 'five' ? '5h' : r.id === 'day' ? 'day' : 'wk'} ${fmtPct(r.pct)}`)
    $.ui.status(parts.length ? parts.join(' · ') : undefined)
  } else {
    $.ui.status(undefined)
  }
}

async function restartTimer($: $T) {
  timer?.cancel()
  timer = null
  const s = await read($, settingsA)
  // 0 is manual: no timer, refresh on Refresh or when the dashboard opens.
  if (s.refreshSeconds > 0) timer = $.clock.every(Math.max(15, s.refreshSeconds) * 1000, () => void refresh($))
}

async function saveSettings($: $T, patch: Partial<Settings>) {
  const next = await update($, settingsA, s => {
    const merged = { ...s, ...patch }
    if (merged.red <= merged.amber) merged.red = Math.min(100, merged.amber + 5)
    return merged
  })
  await $.store.set('settings', next)
  if (patch.refreshSeconds !== undefined) await restartTimer($)
  void refresh($)
}

async function closeDashboard($: $T) {
  await saveSettings($, { isClosed: true })
  $.ui.status(undefined)
  await $.ui.close({ id: PANE })
}

// ---------------------------------------------------------------- register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get('settings')) as Partial<Settings> | undefined
    await update($, settingsA, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
    const storedHistory = ((await $.store.get('history')) as Snapshot[] | undefined) ?? []
    await update($, historyA, () => storedHistory)
    const collapsed = (await $.store.get('collapsedGroups')) as string[] | undefined
    if (collapsed) await update($, collapsedA, () => collapsed)
    const colors = (await $.store.get('modelColors')) as Record<string, string> | undefined
    if (colors) await update($, colorsA, () => colors)
    // This release's version from the manifest, and its date from the changelog.
    try {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
      const version = manifest.version ?? ''
      const log = await $.fs.read(`${$.plugin.root}/CHANGELOG.md`)
      const released = new RegExp(`## ${version.replace(/\./g, '\\.')} — (\\d{4}-\\d{2}-\\d{2})`).exec(log)?.[1] ?? ''
      await update($, aboutA, () => ({ version, released }))
    } catch {
      // shown without a version
    }
    await $.command.register({ name: 'usage-dashboard-wfc', description: 'Open the WhiteFish usage dashboard: plan limits, daily budget, tokens and sessions' })
    await restartTimer($)
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'usage-dashboard-wfc' }, async $ => {
    if ((await read($, settingsA)).isClosed) await saveSettings($, { isClosed: false })
    await $.ui.open({ id: PANE, title: 'Claude usage overview' })
    void refresh($)
    // No text: nothing is added to the conversation, so opening it costs no tokens.
    return {}
  })

  // Each model response moves the plan windows: refresh shortly after, once.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits') && (await read($, settingsA)).refreshOnResponse) {
      measureTimer?.cancel()
      measureTimer = $.clock.after(4000, () => void refresh($))
    }
    return next(e)
  })

  // ------------------------------------------------------------ band
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const settings = await read($, settingsA)
    const plan = await read($, planA)
    const agg = await read($, aggA)
    const history = await read($, historyA)
    if (e.props.hasSurvey || !plan || settings.isClosed) return next(e)
    const now = await $.clock.now()
    const all = readings(settings, plan, agg, history, now).filter(r => ['five', 'day', 'week'].includes(r.id))
    const hot = readings(settings, plan, agg, history, now).filter(r => levelOf(r.pct, settings) !== 'ok')
    const sig = hot.map(r => `${r.id}:${levelOf(r.pct, settings)}:${r.period}`).join('|')
    const isAlert = hot.length > 0 && (await read($, bandDismissedA)) !== sig
    if (!isAlert && !settings.showBand) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const short: Record<string, string> = { five: 'Session', day: 'Daily budget', week: 'Week' }
    const worst = hot.some(r => levelOf(r.pct, settings) === 'red') ? 'red' : 'amber'
    const tone = worst === 'red' ? '#d03b3b' : '#c98500'
    return (
      <Box flexDirection="row" gap={2} alignItems="center" justifyContent="space-between">
        {isAlert ? (
          <Text color={tone}>
            {worst === 'red' ? '▲ ' : '△ '}
            {hot.map(r => `${r.label} ${fmtPct(r.pct)} used`).join(' · ')}
          </Text>
        ) : (
          <Text dimColor>{all.map(r => `${short[r.id]} ${fmtPct(r.pct)}`).join(' · ')}</Text>
        )}
        <Box flexDirection="row" gap={1}>
          <Button key="band-open" label="Dashboard" onPress={() => void $.ui.open({ id: PANE, title: 'Claude usage overview' })} />
          {isAlert ? <Button key="band-hide" label="Hide" onPress={() => void update($, bandDismissedA, () => sig)} /> : null}
        </Box>
      </Box>
    )
  })

  // ------------------------------------------------------------ pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [agg, aggError, plan, sessions, history, settings, tab, colors, refreshing, collapsedGroups, about] = await Promise.all([
      read($, aggA),
      read($, aggErrorA),
      read($, planA),
      read($, sessionsA),
      read($, historyA),
      read($, settingsA),
      read($, tabA),
      read($, colorsA),
      read($, refreshingA),
      read($, collapsedA),
      read($, aboutA),
    ])
    const now = await $.clock.now()
    return drawPane($.ui.resolve(e), e.surface, e.props.bodyColumns, { agg, aggError, plan, sessions, history, settings, tab, colors, refreshing, collapsedGroups, about, now }, {
      refresh: ask => void refresh($, ask),
      setTab: id => void update($, tabA, () => id),
      saveSettings: patch => void saveSettings($, patch),
      rearm: () => void $.store.delete('alerts').then(() => refresh($)),
      close: () => void closeDashboard($),
      setCollapsed: groups =>
        void update($, collapsedA, () => groups).then(() => $.store.set('collapsedGroups', groups)),
    })
  })
}
