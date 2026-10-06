import { describe, expect, mock, test } from 'claude-code/testing'

import type { Aggregate, Plan, Snapshot } from '../types'
import { bars } from './charts'
import { emptyScan, ingest, projectCandidates, projectName, summarize } from './scanner'
import { DAY, DEFAULT_SETTINGS, NO_SESSION, allowanceAt, allowanceSteps, assignColors, groupSessionUsage, dailyBudget, dailyUsage, levelOf, parseAppPlan, prettyModel, todayVsBudget } from './logic'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const TODAY = Date.parse('2026-10-06T00:00:00Z')

const bucket = (total: number) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: total, total, messages: 1 })

function agg(): Aggregate {
  const daily = Array.from({ length: 14 }, (_, i) => {
    const t = TODAY - (13 - i) * DAY
    return { t, date: new Date(t).toISOString().slice(0, 10), byModel: { 'claude-opus-5-5': 100 }, ...bucket(100) }
  })
  return {
    generatedAt: NOW,
    todayStart: TODAY,
    tzOffsetMinutes: 0,
    weekStart: TODAY - 3 * DAY,
    sessionStart: NOW - 3600_000,
    totals: { lastHour: bucket(1), session: bucket(50), today: bucket(100), week: bucket(400), fourteenDays: bucket(1400) },
    hourly: [],
    daily,
    // budget days from the reset (window resets 2026-10-09 00:00, so it started 2026-10-02 00:00)
    weekDays: Array.from({ length: 7 }, (_, i) => ({ t: Date.parse('2026-10-02T00:00:00Z') + i * DAY, byModel: {}, ...bucket(i < 5 ? 100 : 0) })),
    projects: [],
    models: [],
    entrypoints: [],
    heatmap: [],
    scanMs: 1,
    records: 1,
  }
}

const APP = JSON.stringify({
  plan: {
    status: 'ok',
    plan: 'Max',
    windows: [
      { label: '5-hour limit', percentUsed: 83, resetsAt: '2026-10-06T14:00:00Z' },
      { label: 'Weekly · all models', percentUsed: 40, resetsAt: '2026-10-09T00:00:00Z' },
      { label: 'Weekly · Fable', percentUsed: 5, resetsAt: '2026-10-09T00:00:00Z' },
    ],
  },
})

describe('logic', () => {
  test('parses the app usage card into windows', async () => {
    const plan = parseAppPlan(APP, NOW) as Plan
    expect(plan.plan).toBe('Max')
    expect(plan.windows.map(w => w.kind)).toEqual(['five_hour', 'seven_day', 'model:Fable'])
  })

  test('levels follow the configured thresholds', async () => {
    expect(levelOf(79.9, DEFAULT_SETTINGS)).toBe('ok')
    expect(levelOf(80, DEFAULT_SETTINGS)).toBe('amber')
    expect(levelOf(90, DEFAULT_SETTINGS)).toBe('red')
    expect(levelOf(85, { ...DEFAULT_SETTINGS, amber: 60, red: 85 })).toBe('red')
  })

  test('daily budget divides the week by working days', async () => {
    expect(dailyBudget({ ...DEFAULT_SETTINGS, workDays: 5 })).toBe(20)
    expect(Math.round(dailyBudget({ ...DEFAULT_SETTINGS, workDays: 7 }) * 100) / 100).toBe(14.29)
  })

  test('estimates per-day usage from token share without snapshots', async () => {
    const plan = parseAppPlan(APP, NOW) as Plan
    const days = dailyUsage(agg(), [], plan, NOW)
    // window started Oct 2 00:00: budget days Oct 2..6 have equal tokens → 8% each
    expect(days.length).toBe(5)
    expect(days.every(d => d.isEstimate)).toBe(true)
    expect(Math.round(days[4].pct)).toBe(8)
    const today = todayVsBudget(days, DEFAULT_SETTINGS)
    expect(Math.round(today?.pctOfBudget ?? 0)).toBe(40)
  })

  test('uses snapshots for an exact reading of today', async () => {
    const plan = parseAppPlan(APP, NOW) as Plan
    const wr = '2026-10-09T00:00:00Z'
    const history: Snapshot[] = [
      { t: TODAY - 60_000, w: 22, wr, f: 0 },
      { t: TODAY + 3600_000, w: 30, wr, f: 10 },
    ]
    const today = todayVsBudget(dailyUsage(agg(), history, plan, NOW), DEFAULT_SETTINGS)
    expect(today?.isEstimate).toBe(false)
    expect(today?.used).toBe(18) // 40 now − 22 at midnight
    expect(today?.pctOfBudget).toBe(90)
  })

  test('budget days count 24 hours from the reset; only the first workDays add budget', async () => {
    // Reset Tuesday 03:00: day 1 is Tue 03:00–Wed 03:00.
    const start = Date.parse('2026-10-06T03:00:00Z')
    const steps = allowanceSteps(start, { ...DEFAULT_SETTINGS, workDays: 5 })
    expect(allowanceAt(steps, start + 1)).toBe(20) // day 1 (Tue)
    expect(allowanceAt(steps, start + DAY - 1)).toBe(20) // still day 1 at Wed 02:59
    expect(allowanceAt(steps, start + DAY)).toBe(40) // day 2 starts Wed 03:00
    expect(allowanceAt(steps, start + 4 * DAY + 1)).toBe(100) // day 5 (Sat)
    expect(allowanceAt(steps, start + 6 * DAY + 1)).toBe(100) // days 6–7 are off
    const plan = parseAppPlan(APP, NOW) as Plan
    const days = dailyUsage(agg(), [], plan, NOW, { ...DEFAULT_SETTINGS, workDays: 4 })
    expect(days.map(d => d.isWorkDay)).toEqual([true, true, true, true, false])
  })

  test('model colors follow the model, never its rank', async () => {
    const a = assignColors({}, ['claude-opus-5-5', 'claude-haiku-4-5-20251001'])
    const b = assignColors(a, ['claude-aardvark-1', 'claude-opus-5-5'])
    expect(b['claude-opus-5-5']).toBe(a['claude-opus-5-5'])
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(prettyModel('claude-opus-5')).toBe('Opus 5')
  })

  test('lists usage per desktop session, titled and grouped as in the sidebar', async () => {
    const row = (name: string, project: string, week: number) => ({ name, project, session: bucket(0), today: bucket(0), week: bucket(week), fourteenDays: bucket(week), byModel: { 'claude-opus-5-5': week } })
    const a = {
      ...agg(),
      sessions: [row('c1', 'TerraVitae', 10), row('c0', 'TerraVitae', 5), row('c2', 'ClearLoop', 50), row('c3', 'hoelio', 7), row('c4', 'hoelio', 3)],
      desktopSessions: [
        { id: 'd1', title: 'Terra Vitae - Build', cliIds: ['c1', 'c0'], isArchived: false },
        { id: 'd2', title: '1.8.0', cliIds: ['c2'], isArchived: false },
        { id: 'd9', title: 'No usage', cliIds: ['c9'], isArchived: false },
      ],
    }
    const sess = (id: string, group?: string) => ({ sessionId: id, title: 't', cwd: '/x', isRunning: false, isArchived: false, lastActivityAt: '2026-10-05T00:00:00Z', remoteControlActive: false, group })
    const groups = groupSessionUsage(a, [sess('d1', 'Terra Vitae'), sess('d2', 'Clearloop')], ['Terra Vitae', 'Clearloop'])
    expect(groups.map(g => g.name)).toEqual(['Terra Vitae', 'Clearloop', NO_SESSION])
    expect(groups[0]?.projects[0]?.title).toBe('Terra Vitae - Build')
    expect(groups[0]?.projects[0]?.week.total).toBe(15) // both of its Claude Code ids
    expect(groups[2]?.projects.map(p => [p.title, p.week.total])).toEqual([['hoelio', 10]])
  })

  test('charts produce bounded svg', async () => {
    const s = bars({ columns: [[1], [2, 3]], colors: ['#000', '#111'], ref: 2 })
    expect(s.includes('<text')).toBe(false)
    expect(s.startsWith('<svg')).toBe(true)
    expect(s.length < 131072).toBe(true)
  })
})

// A fake computer: one project with one history file, and the desktop app's record of its session.
const HOME = '/home/u'
const PROJECTS = `${HOME}/.claude/projects`
const DESKTOP = `${HOME}/Library/Application Support/Claude/claude-code-sessions`

function line(id: string, sid: string, at: string, cwd: string, read: number) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: sid,
    cwd,
    entrypoint: 'claude-desktop',
    timestamp: at,
    message: { id, model: 'claude-opus-5-5', role: 'assistant', usage: { input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: read } },
  })
}
const HISTORY = [
  line('m1', 'c1', '2026-10-06T09:00:00Z', '/x/TerraVitae', 1000),
  line('m1', 'c1', '2026-10-06T09:00:00Z', '/x/TerraVitae', 1000), // same message written twice
  line('m2', 'c1', '2026-10-06T11:30:00Z', '/x/TerraVitae/site', 2000),
  line('m3', 'c2', '2026-10-05T15:00:00Z', '/x/ClearLoop', 4000),
].join('\n') + '\n'

type On = Parameters<Parameters<typeof test>[1]>[1]

function fakeComputer(on: On) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }) as never)
  const entry = (name: string, kind: 'file' | 'dir', size = 0) => ({ name, kind, size, mtimeMs: NOW - 60_000, isLink: false })
  const dirs: Record<string, ReturnType<typeof entry>[]> = {
    [PROJECTS]: [entry('-x-TerraVitae', 'dir')],
    [`${PROJECTS}/-x-TerraVitae`]: [entry('c1.jsonl', 'file', HISTORY.length)],
    [DESKTOP]: [entry('acct', 'dir')],
    [`${DESKTOP}/acct`]: [entry('org', 'dir')],
    [`${DESKTOP}/acct/org`]: [entry('local_s1.json', 'file', 100), entry('local_s2.json', 'file', 100)],
  }
  const files: Record<string, string> = {
    [`${PROJECTS}/-x-TerraVitae/c1.jsonl`]: HISTORY,
    [`${DESKTOP}/acct/org/local_s1.json`]: JSON.stringify({ sessionId: 's1', title: 'Terra Vitae - Build', cliSessionId: 'c1' }),
    [`${DESKTOP}/acct/org/local_s2.json`]: JSON.stringify({ sessionId: 's2', title: '1.8.0', cliSessionId: 'c2', priorCliSessionIds: [] }),
  }
  on('fs.list', ($, e) => (dirs[e.path] ? { value: dirs[e.path] } : { deny: 'no such folder' }) as never)
  on('fs.read', ($, e) => (e.path.endsWith('plugin.json') ? { value: '{"version":"9.9.9"}' } : e.path.endsWith('CHANGELOG.md') ? { value: '## 9.9.9 — 2026-10-06\n' } : files[e.path] !== undefined ? { value: files[e.path] } : { deny: 'no such file' }) as never)
  on('fs.exists', ($, e) => ({ value: e.path === '/x/TerraVitae/.git' }) as never)
}

describe('scanner', () => {
  test('reads history into buckets once, names projects by repository, sums per session', async () => {
    const state = emptyScan()
    const file = { len: 0, size: 0, mtime: 0, readAt: 0, ids: [] as string[] }
    const cwds = ingest(state, '/p/c1.jsonl', HISTORY, file, NOW - 15 * DAY)
    expect([...cwds].sort()).toEqual(['/x/ClearLoop', '/x/TerraVitae', '/x/TerraVitae/site'])
    state.cwdProject['/x/TerraVitae'] = projectName('/x/TerraVitae', '/x/TerraVitae')
    state.cwdProject['/x/TerraVitae/site'] = projectName('/x/TerraVitae/site', '/x/TerraVitae')
    state.cwdProject['/x/ClearLoop'] = projectName('/x/ClearLoop', undefined)
    const s = summarize(state, NOW, NOW - 2 * DAY, NOW - 2 * 3_600_000)
    expect(s.totals.fourteenDays.messages).toBe(3) // the duplicate line counted once
    expect(s.totals.today.total).toBe(100 + 1000 + 100 + 2000)
    expect(s.totals.session.total).toBe(2100) // only m2 is inside the 5-hour window
    expect(s.projects.map(p => p.name)).toEqual(['ClearLoop', 'TerraVitae']) // by tokens this week
    expect(s.sessions?.find(x => x.name === 'c1')?.project).toBe('TerraVitae')
    expect(projectCandidates('/x/App/.claude/worktrees/agent-1/src')[0]).toBe('/x/App')
  })
})

describe('pane', () => {
  test('draws every tab from a scanned history on terminal and desktop', async ($, on) => {
    fakeComputer(on)
    // The app's usage card can't read the limits right now: the session's own figures stand in.
    on('tool.list', () => ({ value: [{ name: 'mcp__ccd_session_mgmt__get_usage', description: '' }] }) as never)
    on('tool.check', () => ({ decision: 'allow' }))
    const unavailable = JSON.stringify({ plan: { status: 'unavailable', plan: 'Max', note: 'Plan limits apply, but the numbers could not be read just now.' } })
    on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_usage' }, () => ({ result: unavailable, text: unavailable }) as never)
    on('session.usage', () => ({ value: {
      startedAt: 0,
      context: { contextWindow: 1000000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-06T14:00:00Z' },
        { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-10-09T00:00:00Z' },
      ],
    } }) as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'whitefish-usage-dashboard',
        surface,
        component: 'Pane',
        requestId: 'whitefish-usage-dashboard',
        props: { title: 'Claude usage', isFocused: true, bodyColumns: 100, placement: 'dock' },
      })
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ type: 'Text', text: /Plan usage limits/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude usage overview/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /85% used/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude Code tokens on this computer/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Since / })).toBeDefined()
      for (const tab of ['tokens', 'projects', 'models', 'sessions', 'settings', 'overview']) {
        await ui.press({ key: `tab-${tab}` })
        expect(await ui.find({ key: `tab-${tab}` })).toBeDefined()
      }
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows projects by desktop session name under sidebar groups', async ($, on) => {
    fakeComputer(on)
    const rows = [
      { sessionId: 's1', title: 'a', cwd: '/x/TerraVitae', isRunning: false, isArchived: false, lastActivityAt: '2026-10-05T00:00:00Z', group: { name: 'Other Stuff' }, remoteControlActive: false },
      { sessionId: 's2', title: 'b', cwd: '/x/ClearLoop', isRunning: false, isArchived: false, lastActivityAt: '2026-10-05T00:00:00Z', group: { name: 'Clearloop' }, remoteControlActive: false },
    ]
    on('tool.list', () => ({ value: [{ name: 'mcp__ccd_session_mgmt__list_sessions', description: '' }, { name: 'mcp__ccd_session_mgmt__get_session', description: '' }] }) as never)
    on('tool.check', () => ({ decision: 'allow' }))
    // The list excludes the current session (s2); get_session('self') supplies it.
    on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({ result: JSON.stringify(rows.slice(0, 1)), text: JSON.stringify(rows.slice(0, 1)) }) as never)
    on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_session' }, () => ({ result: JSON.stringify(rows[1]), text: JSON.stringify(rows[1]) }) as never)
    on('session.usage', () => ({ value: { startedAt: 0, context: { contextWindow: 1000000 }, rateLimits: [] } }) as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'whitefish-usage-dashboard', surface, component: 'Pane', requestId: 'whitefish-usage-dashboard', props: { title: 'x', isFocused: true, bodyColumns: 100, placement: 'dock' } })
      await ui.press({ key: 'refresh' })
      await ui.press({ key: 'tab-projects' })
      expect(await ui.find({ type: 'Text', text: /^Other Stuff$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Terra Vitae - Build$/ })).toBeDefined()
      expect(await ui.find({ key: 'p-s1' })).toBeDefined()
      expect(await ui.find({ key: 'group-toggle-Other Stuff' })).toBeDefined()
      await ui.press({ key: 'group-toggle-Other Stuff' })
      expect(await ui.find({ key: 'p-s1' })).toBeUndefined()
      await ui.press({ key: 'groups-expand' })
      expect(await ui.find({ key: 'p-s1' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('draws and switches tabs on every surface', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'whitefish-usage-dashboard',
        surface,
        component: 'Pane',
        requestId: 'whitefish-usage-dashboard',
        props: { title: 'Claude usage', isFocused: true, bodyColumns: 100, placement: 'dock' },
      })
      expect(await ui.find({ key: 'tab-settings' })).toBeDefined()
      await ui.press({ key: 'tab-settings' })
      expect(await ui.find({ key: 'statusLine' })).toBeDefined()
      expect(await ui.find({ key: 'close-dashboard' })).toBeDefined()
      expect(await ui.find({ key: 'refreshOnResponse' })).toBeDefined()
      await ui.press({ key: 'tab-overview' })
      await ui.unmount()
    }
  })
})
