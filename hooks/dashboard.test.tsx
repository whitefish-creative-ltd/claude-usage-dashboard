import { describe, expect, mock, test } from 'claude-code/testing'

import type { Aggregate, Plan, Snapshot } from '../types'
import { bars } from './charts'
import { DAY, DEFAULT_SETTINGS, NO_SESSION, UNGROUPED, allowanceAt, allowanceSteps, assignColors, groupProjects, dailyBudget, dailyUsage, levelOf, parseAppPlan, prettyModel, todayVsBudget } from './logic'

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

  test('groups projects by the sidebar group most of their sessions use', async () => {
    const proj = (name: string, week: number) => ({ name, week: bucket(week), fourteenDays: bucket(week) })
    const sess = (cwd: string, group: string | undefined, at: string) => ({ sessionId: cwd + at, title: 't', cwd, isRunning: false, isArchived: false, lastActivityAt: at, remoteControlActive: false, group })
    const groups = groupProjects(
      [proj('A', 10), proj('B', 50), proj('C', 5), proj('D', 1)],
      [
        sess('/a', 'Clients', '2026-10-01T00:00:00Z'),
        sess('/a/site', 'Clients', '2026-10-02T00:00:00Z'),
        sess('/a', 'Other', '2026-10-05T00:00:00Z'),
        sess('/b', 'Other', '2026-10-01T00:00:00Z'),
        sess('/c', undefined, '2026-10-01T00:00:00Z'),
      ],
      { '/a': 'A', '/a/site': 'A', '/b': 'B', '/c': 'C' },
    )
    expect(groups.map(g => g.name)).toEqual(['Other', 'Clients', UNGROUPED, NO_SESSION])
    expect(groups[1]?.projects.map(p => p.name)).toEqual(['A'])
    expect(groups[3]?.projects.map(p => p.name)).toEqual(['D'])
  })

  test('charts produce bounded svg', async () => {
    const s = bars({ columns: [[1], [2, 3]], colors: ['#000', '#111'], ref: 2 })
    expect(s.includes('<text')).toBe(false)
    expect(s.startsWith('<svg')).toBe(true)
    expect(s.length < 131072).toBe(true)
  })
})

function richAgg(): Aggregate {
  const a = agg()
  const row = (name: string, n: number) => ({ name, session: bucket(n / 2), today: bucket(n), week: bucket(n * 4), fourteenDays: bucket(n * 10), byModel: { 'claude-opus-5-5': n * 3, 'claude-haiku-4-5-20251001': n } })
  a.hourly = Array.from({ length: 24 }, (_, i) => ({ t: NOW - (23 - i) * 3600_000, byModel: { 'claude-opus-5-5': i * 10 }, ...bucket(i * 10) }))
  a.projects = [row('TerraVitae', 900), row('ClearLoop', 300)]
  a.models = [row('claude-opus-5-5', 900), row('claude-haiku-4-5-20251001', 100)]
  a.entrypoints = [row('claude-desktop', 900), row('cli', 50)]
  a.heatmap = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => d * h))
  return a
}

describe('pane', () => {
  test('draws every tab with data on terminal and desktop', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    on('fs.exists', () => ({ value: true }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(richAgg()), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.list', () => ({ value: [] }))
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
        plugin: 'token-dashboard',
        surface,
        component: 'Pane',
        requestId: 'token-dashboard',
        props: { title: 'Claude usage', isFocused: true, bodyColumns: 100, placement: 'dock' },
      })
      await ui.press({ key: 'refresh' })
      expect(await ui.find({ type: 'Text', text: /Plan usage limits/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude usage overview/ })).toBeDefined()
      if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /Created by WhiteFish/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /85% used/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /this computer only/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Since / })).toBeDefined()
      for (const tab of ['tokens', 'projects', 'models', 'sessions', 'settings', 'overview']) {
        await ui.press({ key: `tab-${tab}` })
        expect(await ui.find({ key: `tab-${tab}` })).toBeDefined()
      }
      if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('shows sidebar group names on the projects tab', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    const a = { ...richAgg(), cwdProjects: { '/x/TerraVitae': 'TerraVitae', '/x/ClearLoop': 'ClearLoop' } }
    on('fs.exists', () => ({ value: true }))
    on('fs.write', () => ({ value: undefined }) as never)
    on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(a), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.list', () => ({ value: [{ name: 'mcp__ccd_session_mgmt__list_sessions', description: '' }] }) as never)
    on('tool.check', () => ({ decision: 'allow' }))
    const rows = [
      { sessionId: 's1', title: 'a', cwd: '/x/TerraVitae', isRunning: false, isArchived: false, lastActivityAt: '2026-10-05T00:00:00Z', group: { name: 'Other Stuff' }, remoteControlActive: false },
      { sessionId: 's2', title: 'b', cwd: '/x/ClearLoop', isRunning: false, isArchived: false, lastActivityAt: '2026-10-05T00:00:00Z', group: { name: 'Clearloop' }, remoteControlActive: false },
    ]
    on('tool.call', { tool: 'mcp__ccd_session_mgmt__list_sessions' }, () => ({ result: JSON.stringify(rows), text: JSON.stringify(rows) }) as never)
    on('session.usage', () => ({ value: { startedAt: 0, context: { contextWindow: 1000000 }, rateLimits: [] } }) as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'token-dashboard', surface, component: 'Pane', requestId: 'token-dashboard', props: { title: 'x', isFocused: true, bodyColumns: 100, placement: 'dock' } })
      await ui.press({ key: 'refresh' })
      await ui.press({ key: 'tab-projects' })
      expect(await ui.find({ key: 'group-toggle-Clearloop' })).toBeDefined()
      expect(await ui.find({ key: 'group-toggle-Other Stuff' })).toBeDefined()
      expect(await ui.find({ key: 'p-ClearLoop' })).toBeDefined()
      await ui.press({ key: 'group-toggle-Clearloop' })
      expect(await ui.find({ key: 'p-ClearLoop' })).toBeUndefined()
      expect(await ui.find({ key: 'p-TerraVitae' })).toBeDefined()
      await ui.press({ key: 'groups-expand' })
      expect(await ui.find({ key: 'p-ClearLoop' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('draws and switches tabs on every surface', async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'token-dashboard',
        surface,
        component: 'Pane',
        requestId: 'token-dashboard',
        props: { title: 'Claude usage', isFocused: true, bodyColumns: 100, placement: 'dock' },
      })
      expect(await ui.find({ key: 'tab-settings' })).toBeDefined()
      await ui.press({ key: 'tab-settings' })
      expect(await ui.find({ key: 'osNotify' })).toBeDefined()
      expect(await ui.find({ type: 'Link' })).toBeDefined()
      await ui.press({ key: 'tab-overview' })
      await ui.unmount()
    }
  })
})
