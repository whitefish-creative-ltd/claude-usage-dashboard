import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Aggregate, Plan, Sessions, SessionRow, Settings, Snapshot } from '../types'
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
  fmtTokens,
  levelOf,
  parseAppPlan,
  parseSessions,
  planFromRateLimits,
  pushSnapshot,
  relTime,
  todayVsBudget,
} from './logic'
import type { Level } from './logic'

const PANE = 'token-dashboard'
const USAGE_TOOL = 'mcp__ccd_session_mgmt__get_usage'
const SESSIONS_TOOL = 'mcp__ccd_session_mgmt__list_sessions'
const GROUPS_TOOL = 'mcp__ccd_sidebar__list_groups'
const SESSION_TOOL = 'mcp__ccd_session_mgmt__get_session'

const aggA = atom({ plugin: 'token-dashboard', key: 'agg' } as const, null)
const aggErrorA = atom({ plugin: 'token-dashboard', key: 'aggError' } as const, null)
const planA = atom({ plugin: 'token-dashboard', key: 'plan' } as const, null)
const sessionsA = atom({ plugin: 'token-dashboard', key: 'sessions' } as const, null)
const historyA = atom({ plugin: 'token-dashboard', key: 'history' } as const, [])
const settingsA = atom({ plugin: 'token-dashboard', key: 'settings' } as const, DEFAULT_SETTINGS)
const tabA = atom({ plugin: 'token-dashboard', key: 'tab' } as const, 'overview')
const colorsA = atom({ plugin: 'token-dashboard', key: 'modelColors' } as const, {})
const refreshingA = atom({ plugin: 'token-dashboard', key: 'refreshing' } as const, false)
const bandDismissedA = atom({ plugin: 'token-dashboard', key: 'bandDismissed' } as const, '')
const collapsedA = atom({ plugin: 'token-dashboard', key: 'collapsedGroups' } as const, [])

type $T = EngineInterface

// ---------------------------------------------------------------- data

let python: string | null = null
let busy = false
let timer: { cancel: () => void } | null = null
let measureTimer: { cancel: () => void } | null = null

async function findPython($: $T): Promise<string | null> {
  if (python) return python
  for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    try {
      if (await $.fs.exists(p)) return (python = p)
    } catch {
      // not readable here: try the next
    }
  }
  return null
}

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

/** Calls one of the desktop app's read-only tools, without raising a dialog unless `ask`. */
const toolTrace: Record<string, string> = {}

async function appTool($: $T, tool: string, input: Record<string, unknown>, ask: boolean): Promise<{ text?: string; status: 'ok' | 'needs-access' | 'unavailable' }> {
  try {
    const tools = await $.tool.list()
    if (!tools.some(t => t.name === tool)) {
      toolTrace[tool] = 'not listed'
      return { status: 'unavailable' }
    }
    if (!ask) {
      const { decision, reason } = await $.tool.check({ tool, input })
      toolTrace[tool] = `check: ${decision}${reason ? ` (${reason})` : ''}`
      if (decision === 'deny') return { status: 'unavailable' }
      if (decision === 'ask') return { status: 'needs-access' }
    }
    const r = await $.tool.call({ tool, ...input, ...(ask ? { consent: 'The user pressed "Connect app data" on the usage dashboard' } : {}) } as never)
    const text = toolText(r)
    const x = r as { deny?: string; isError?: boolean }
    toolTrace[tool] = text ? `ok (${text.length} chars)` : `no text${x.deny ? `: deny ${x.deny}` : ''}${x.isError ? ': error' : ''}`
    return text ? { text, status: 'ok' } : { status: 'unavailable' }
  } catch (err) {
    toolTrace[tool] = `threw: ${String(err)}`
    return { status: 'unavailable' }
  }
}

async function loadPlan($: $T, ask: boolean, now: number): Promise<{ plan: Plan; needsAccess: boolean }> {
  const r = await appTool($, USAGE_TOOL, {}, ask)
  if (r.text) {
    const p = parseAppPlan(r.text, now)
    if (p && (p.windows.length || p.note)) return { plan: p, needsAccess: false }
  }
  const usage = await $.session.usage()
  return { plan: planFromRateLimits(usage.rateLimits, now), needsAccess: r.status === 'needs-access' }
}

async function loadSessions($: $T, ask: boolean, now: number): Promise<Sessions> {
  const r = await appTool($, SESSIONS_TOOL, { limit: 500, include_archived: true }, ask)
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
  const g = await appTool($, GROUPS_TOOL, {}, ask)
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
  const self = await appTool($, SESSION_TOOL, { session_id: 'self' }, ask)
  if (self.text) {
    const me = parseSessions(`[${self.text}]`)?.[0]
    if (me?.sessionId && !rows.some(x => x.sessionId === me.sessionId)) rows.unshift(me)
  }
  return { status: 'ok', rows, groupOrder, at: now }
}

async function loadAggregate($: $T, plan: Plan | null, cwds: string[]): Promise<{ agg?: Aggregate; error?: string }> {
  const py = await findPython($)
  if (!py) return { error: 'python3 not found (looked in /opt/homebrew/bin, /usr/local/bin, /usr/bin).' }
  const week = findWindow(plan, 'seven_day')
  const five = findWindow(plan, 'five_hour')
  const since = week?.resetsAt ? Date.parse(week.resetsAt) - 7 * DAY : undefined
  const sessionSince = five?.resetsAt ? Date.parse(five.resetsAt) - 5 * HOUR : undefined
  const argv = [
    py,
    `${$.plugin.root}/scripts/aggregate.py`,
    ...(since ? ['--since-ms', String(since)] : []),
    ...(sessionSince ? ['--session-since-ms', String(sessionSince)] : []),
    '--cwds-stdin',
  ]
  try {
    const r = await $.process.run(argv, { timeoutMs: 180_000, stdin: JSON.stringify(cwds) })
    if (r.exitCode !== 0) return { error: r.stderr.trim().split('\n').pop() || `aggregate.py exited ${r.exitCode}` }
    return { agg: JSON.parse(r.stdout) as Aggregate }
  } catch (err) {
    return { error: String(err) }
  }
}

async function refresh($: $T, ask = false) {
  if (busy) return
  busy = true
  try {
    await update($, refreshingA, () => true)
    const now = await $.clock.now()
    const settings = await read($, settingsA)

    const { plan } = await loadPlan($, ask, now)
    await update($, planA, () => plan)

    const sessions = await loadSessions($, ask, now)
    await update($, sessionsA, () => sessions)

    const cwds = [...new Set(sessions.rows.map(row => row.cwd).filter(Boolean))]
    const { agg, error } = await loadAggregate($, plan, cwds)
    if (agg) {
      await update($, aggA, () => agg)
      const prev = await read($, colorsA)
      const colors = assignColors(prev, agg.models.map(m => m.name))
      if (Object.keys(colors).length !== Object.keys(prev).length) {
        await update($, colorsA, () => colors)
        await $.store.set('modelColors', colors)
      }
    }
    await update($, aggErrorA, () => error ?? null)

    const history = pushSnapshot(await read($, historyA), plan, now)
    await update($, historyA, () => history)
    await $.store.set('history', history)

    await checkAlerts($, settings, plan, agg ?? (await read($, aggA)), history, now)

    // What the last refresh saw, for troubleshooting.
    try {
      const home = $.plugin.root.split('/.claude/')[0]
      await $.fs.write(
        `${home}/.claude/token-dashboard/status.json`,
        JSON.stringify({ at: now, tools: toolTrace, plan: plan.source, sessions: sessions.status, sessionRows: sessions.rows.length, cwdProjects: Object.keys(agg?.cwdProjects ?? {}).length, aggError: error ?? null }, null, 2),
      )
    } catch {
      // diagnostics are best effort
    }
  } finally {
    busy = false
    await update($, refreshingA, () => false)
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

async function notifyOs($: $T, title: string, body: string) {
  const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  try {
    await $.process.run(['/usr/bin/osascript', '-e', `display notification "${q(body)}" with title "${q(title)}"`], { timeoutMs: 5000 })
  } catch {
    // not macOS, or notifications blocked: the toast still showed
  }
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
      if (settings.osNotify) await notifyOs($, 'Claude usage', `${msg}${r.detail ? `. ${r.detail}` : ''}`)
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

async function openSession($: $T, row: SessionRow) {
  if (!row.link) return $.ui.toast('This session has no app link (links are turned off for your organization).')
  const r = await $.process.run(['/usr/bin/open', row.link], { timeoutMs: 10_000 })
  if (r.exitCode !== 0) $.ui.toast(`Could not open ${row.title}`)
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
    await $.command.register({ name: 'usage-dashboard', description: 'Open the Claude usage dashboard (tokens, limits, budget, sessions)' })
    await restartTimer($)
    void refresh($)
    return next(e)
  })

  on('command.run', { command: 'usage-dashboard' }, async $ => {
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
    const [agg, aggError, plan, sessions, history, settings, tab, colors, refreshing, collapsedGroups] = await Promise.all([
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
    ])
    const now = await $.clock.now()
    return drawPane($.ui.resolve(e), e.surface, e.props.bodyColumns, { agg, aggError, plan, sessions, history, settings, tab, colors, refreshing, collapsedGroups, now }, {
      refresh: ask => void refresh($, ask),
      setTab: id => void update($, tabA, () => id),
      saveSettings: patch => void saveSettings($, patch),
      openSession: row => void openSession($, row),
      rearm: () => void $.store.delete('alerts').then(() => refresh($)),
      close: () => void closeDashboard($),
      setCollapsed: groups =>
        void update($, collapsedA, () => groups).then(() => $.store.set('collapsedGroups', groups)),
    })
  })
}
