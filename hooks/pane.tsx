import type { ElementTable } from 'claude-code'

import type { Aggregate, Plan, Sessions, Settings, Snapshot, Tab } from '../types'
import { area, bars, donut, heatmap, line, meter, rule, segMeter, smallText, textBar } from './charts'
import {
  DAY,
  HOUR,
  allowanceAt,
  allowanceSteps,
  dailyBudget,
  dailyUsage,
  weekStartOf,
  findWindow,
  fmtPct,
  NO_SESSION,
  fmtCount,
  groupSessionUsage,
  levelOf,
  prettyEntry,
  prettyModel,
  relTime,
  splitSessions,
  todayVsBudget,
} from './logic'
import type { Level, SessionView } from './logic'

/** Readable on both light and dark surfaces, so nothing depends on knowing the theme. */
const WEBSITE = 'https://whitefishcreative.co.uk/'

const TONE: Record<Level, string> = { ok: '#3987e5', amber: '#c98500', red: '#d03b3b' }

export type PaneActions = {
  refresh: (ask?: boolean) => void
  setTab: (tab: Tab) => void
  saveSettings: (patch: Partial<Settings>) => void
  rearm: () => void
  close: () => void
  setCollapsed: (groups: string[]) => void
}

export type PaneData = {
  agg: Aggregate | null
  aggError: string | null
  plan: Plan | null
  sessions: Sessions | null
  history: Snapshot[]
  settings: Settings
  tab: Tab
  colors: Record<string, string>
  refreshing: boolean
  collapsedGroups: string[]
  about: { version: string; released: string }
  now: number
}

/** Draws the pane from the surface's element table (the caller resolves it). */
export function drawPane(els: ElementTable, surface: string, bodyColumns: number | undefined, d: PaneData, act: PaneActions) {
  const { Box, Text, Button, Link } = els
  const Select = 'Select' in els ? els.Select : undefined
  // The terminal's table answers Svg with a fragment that draws nothing: use text there.
  const Svg = surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
  const { agg, plan, sessions, history, settings, tab, colors, now } = d
  const credit = `Created by WhiteFish Creative Limited${d.about.version ? ` · v${d.about.version}` : ''}`

  const cols = bodyColumns ?? 80
  const barW = Math.max(8, Math.min(30, Math.floor(cols / 3)))
  const color = (m: string) => colors[m] ?? '#9085e9'
  const days = dailyUsage(agg, history, plan, now, settings)
  const budget = dailyBudget(settings)
  const tz = (agg?.tzOffsetMinutes ?? 0) * 60_000
  const weekday = (t: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(t + tz + 12 * HOUR).getUTCDay()] as string
  const clock = (t: number) => {
    const x = new Date(t + tz)
    const hr = x.getUTCHours()
    const m = x.getUTCMinutes()
    return `${hr % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${hr < 12 ? 'AM' : 'PM'}`
  }
  const resets = (iso?: string) => {
    if (!iso) return ''
    const t = Date.parse(iso)
    return t - now < DAY ? `Resets at ${clock(t)}` : `Resets ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(t + tz).getUTCDay()]} ${clock(t)}`
  }

  const resetStart = weekStartOf(plan, agg)
  const work = Math.min(7, Math.max(1, settings.workDays))
  // Budget days run 24 hours from the weekly reset; the first `work` of them are working days.
  const workDayNames =
    resetStart === undefined
      ? `the first ${work} day${work > 1 ? 's' : ''} after the weekly reset`
      : work === 7
        ? 'every day'
        : `${weekday(resetStart)}–${weekday(resetStart + (work - 1) * DAY)}, from ${clock(resetStart)}`

  // ---------------------------------------------------------- building blocks

  const section = (title: string, note: string | null, ...children: unknown[]) => (
    <Box flexDirection="column" marginTop={2}>
      <Text bold>{title}</Text>
      {note ? <Text dimColor>{note}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  )

  const bar = (pct: number, tone: string, alt: string) =>
    Svg ? <Svg source={meter(pct, tone)} alt={alt} /> : <Text color={tone}>{textBar(pct, barW)}</Text>

  /** The usage page's row: name and reset on the left, a thin bar, "N% used" on the right. */
  const limitRow = (key: string, title: string, sub: string, pct: number | undefined, opts: { estimate?: boolean } = {}) => {
    const level = levelOf(pct, settings)
    const right = pct === undefined ? 'No reading' : `${fmtPct(pct)} used`
    return (
      <Box key={key} flexDirection="row" alignItems="center" gap={2} marginBottom={1}>
        <Box flexDirection="column" width="34%" flexShrink={0}>
          <Text>{title}</Text>
          {sub ? <Text dimColor>{sub}</Text> : null}
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {bar(pct ?? 0, TONE[level], `${title}: ${right}`)}
        </Box>
        <Box width="18%" flexShrink={0} justifyContent="flex-end">
          <Text color={level === 'ok' ? undefined : TONE[level]} dimColor={level === 'ok'} bold={level !== 'ok'}>
            {level === 'red' ? '▲ ' : level === 'amber' ? '△ ' : ''}
            {right}
            {opts.estimate ? '*' : ''}
          </Text>
        </Box>
      </Box>
    )
  }

  /** A ranked row: name on the left, a bar scaled to the largest, value on the right. */
  const rankRow = (key: string, title: string, sub: string, value: number, max: number, tone: string, segments?: { value: number; color: string }[]) => (
    <Box key={key} flexDirection="row" alignItems="center" gap={2} marginBottom={1}>
      <Box flexDirection="column" width="34%" flexShrink={0}>
        <Text wrap="truncate-end">{title}</Text>
        {sub ? <Text dimColor wrap="truncate-end">{sub}</Text> : null}
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {segments && Svg ? (
          <Svg source={segMeter(segments, max)} alt={`${title}: ${fmtCount(value)}`} />
        ) : (
          bar(max > 0 ? (value / max) * 100 : 0, tone, `${title}: ${fmtCount(value)}`)
        )}
      </Box>
      <Box width="18%" flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{fmtCount(value)}</Text>
      </Box>
    </Box>
  )

  const stat = (label: string, value: string, sub?: string) => (
    <Box flexDirection="column" flexGrow={1}>
      <Text dimColor>{label}</Text>
      <Text bold>{value}</Text>
      {sub ? <Text dimColor>{sub}</Text> : null}
    </Box>
  )

  const legend = (items: { name: string; color: string; dashed?: boolean }[]) =>
    items.length > 1 ? (
      <Box flexDirection="row" gap={2} flexWrap="wrap" marginBottom={1}>
        {items.map(i => (
          <Text key={`lg-${i.name}`}>
            <Text color={i.color}>{i.dashed ? '┄ ' : '● '}</Text>
            <Text dimColor>{i.name}</Text>
          </Text>
        ))}
      </Box>
    ) : null

  /** An image of marks with its labels, legend and caption drawn as app text. */
  const chart = (source: string, alt: string, o: { labels?: string[]; legend?: { name: string; color: string; dashed?: boolean }[]; caption?: string } = {}) =>
    Svg ? (
      <Box flexDirection="column">
        {o.legend ? legend(o.legend) : null}
        <Svg source={source} alt={alt} />
        {o.labels ? (
          <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
            {o.labels.map((l, i) => (
              <Text key={`ax-${i}`} dimColor>
                {l}
              </Text>
            ))}
          </Box>
        ) : null}
        {o.caption ? <Text dimColor>{o.caption}</Text> : null}
      </Box>
    ) : null

  const modelLegend = () => (agg?.models ?? []).filter(m => m.fourteenDays.total > 0).map(m => ({ name: prettyModel(m.name), color: color(m.name) }))
  const dayLabels = agg ? [0, 4, 9].map(i => `${weekday(agg.daily[i]?.t ?? now)} ${agg.daily[i]?.date.slice(8) ?? ''}`).concat('Today') : []
  const peak = (vals: number[]) => vals.reduce((best, v, i) => (v > (vals[best] ?? 0) ? i : best), 0)

  // ---------------------------------------------------------- header

  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['tokens', 'Activity'],
    ['projects', 'Projects'],
    ['models', 'Models'],
    ['sessions', 'Sessions'],
    ['settings', 'Settings'],
  ]
  const updated = agg?.isScanning ? 'Reading your history…' : d.refreshing ? 'Refreshing…' : agg ? `Updated ${relTime(agg.generatedAt, now)}` : 'Loading…'
  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="column">
          <Text bold>Claude usage overview</Text>
          <Text dimColor>
            {plan?.plan ? `${plan.plan} plan · ` : ''}
            {updated}
          </Text>
        </Box>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => act.refresh()} />
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
        {tabs.map(([id, label], i) => (
          <Button key={`tab-${id}`} label={label} hotkey={String(i + 1)} variant={tab === id ? 'primary' : 'secondary'} onPress={() => act.setTab(id)} />
        ))}
      </Box>
    </Box>
  )

  // ---------------------------------------------------------- shared pieces

  const five = findWindow(plan, 'five_hour')
  const week = findWindow(plan, 'seven_day')
  const today = todayVsBudget(days, settings)
  const modelWindows = plan?.windows.filter(w => w.kind.startsWith('model:')) ?? []
  const needsAccess = sessions?.status === 'needs-access'

  const limits = section(
    'Plan usage limits',
    'Your plan’s limits, across all your devices.',
    limitRow('l-five', 'Current session', resets(five?.resetsAt) || '5-hour window', five?.percentUsed),
    limitRow(
      'l-day',
      'Today',
      today ? `Since ${clock(days.find(x => x.isToday)?.t ?? now)} · ${fmtPct(today.pctOfBudget)} of daily budget used` : 'Daily budget · needs a weekly reading',
      today?.pctOfBudget,
      { estimate: today?.isEstimate },
    ),
    limitRow('l-week', 'This week', resets(week?.resetsAt), week?.percentUsed),
    ...modelWindows.map(w => limitRow(`l-${w.kind}`, `${w.kind.slice(6)} this week`, `Separate weekly limit · ${resets(w.resetsAt)}`, w.percentUsed)),
    today?.isEstimate ? <Text dimColor>* Today is estimated until the dashboard has watched a full day; it sharpens as it records readings.</Text> : null,
    plan?.note ? <Text dimColor>{plan.note}</Text> : null,
    needsAccess ? (
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text dimColor>Per-model limits and your session list need one-time access.</Text>
        <Button key="connect" label="Connect" variant="primary" onPress={() => act.refresh(true)} />
      </Box>
    ) : null,
  )

  const budgetChart = (() => {
    if (!days.length || !today) return null
    const used = today.used
    const left = budget - used
    const isOver = left < 0
    const level = levelOf(today.pctOfBudget, settings)
    const tone = TONE[level]
    const weekEnd = week?.resetsAt ? Date.parse(week.resetsAt) : (days[0]?.t ?? now) + 7 * DAY
    const weekStart = weekEnd - 7 * DAY
    const fx = (t: number) => (t - weekStart) / (7 * DAY)
    // Allowance builds a budget's worth per day up to 100%; used is the running total.
    // Each working day's budget becomes available as that day starts.
    const steps = allowanceSteps(weekStart, settings)
    const allowance = steps.map(([t, v]) => [fx(t), v / 100] as [number, number])
    const isDayOff = !(days.find(x => x.isToday)?.isWorkDay ?? true)
    let run = 0
    const usedPts: [number, number][] = [[0, 0]]
    for (const x of days) {
      run += x.pct
      usedPts.push([fx(Math.min(x.t + DAY, now)), run / 100])
    }
    const availableNow = allowanceAt(steps, now)
    const stat2 = (label: string, value: string, sub: string, color?: string) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>{label}</Text>
        <Text bold color={color}>
          {value}
        </Text>
        <Text dimColor>{sub}</Text>
      </Box>
    )
    return section(
      'Daily budget',
      `Weekly limit ÷ ${work} working days: ${fmtPct(budget)} a day.${isDayOff ? ' Today is a day off.' : ''}${today.isEstimate ? ' Today is an estimate.' : ''}`,
      <Box flexDirection="row" gap={3} alignItems="center" flexWrap="wrap">
        {Svg ? <Svg source={donut(used, budget, tone, TONE.red)} alt={`Today: ${fmtPct(today.pctOfBudget)} of the daily budget used`} width={120} height={120} /> : null}
        <Box flexDirection="column">
          {stat2('Used today', `${fmtPct(today.pctOfBudget)} of budget`, `${fmtPct(used)} of the weekly limit`, level === 'ok' ? undefined : tone)}
          {stat2(isOver ? 'Over budget by' : 'Available today', fmtPct(Math.abs(left)), 'of the weekly limit', isOver ? TONE.red : undefined)}
        </Box>
      </Box>,
      Svg
        ? chart(
            area({
              series: [
                { color: '#8b8a85', points: allowance, opacity: 0.12, dashed: true },
                { color: '#3987e5', points: usedPts, opacity: 0.35 },
              ],
              marker: fx(now),
              height: 110,
            }),
            'This week: allowance available so far against usage',
            {
              legend: [
                { name: 'Used', color: '#3987e5' },
                { name: `Available (${workDayNames})`, color: '#8b8a85', dashed: true },
              ],
              labels: Array.from({ length: 8 }, (_, i) => weekday(weekStart + i * DAY)),
              caption: `This week: ${fmtPct(run)} used of ${fmtPct(availableNow)} available so far`,
            },
          )
        : limitRow('b-week', 'This week', `${fmtPct(availableNow)} available so far`, availableNow > 0 ? (run / availableNow) * 100 : 0),
    )
  })()

  const sinceSession = agg ? `Since ${clock(agg.sessionStart)}` : ''
  const sinceWeek = agg ? `Since ${weekday(agg.weekStart)} ${clock(agg.weekStart)}` : ''
  const localNote = 'Claude Code tokens on this computer.'

  // ---------------------------------------------------------- tabs

  let body: unknown
  if (tab === 'overview') {
    const split = sessions ? splitSessions(sessions.rows, sessions.live ?? [], settings, now) : null
    body = (
      <Box flexDirection="column">
        {limits}
        {budgetChart}
        {agg &&
          section(
            'This computer',
            localNote,
            <Box flexDirection="row" gap={3} flexWrap="wrap">
              {stat('Current session', fmtCount(agg.totals.session.total), sinceSession)}
              {stat('Today', fmtCount(agg.totals.today.total), `${agg.totals.today.messages} responses`)}
              {stat('This week', fmtCount(agg.totals.week.total), sinceWeek)}
              {split ? stat('Sessions', `${split.working.length} working`, `${split.waiting.length} waiting for you`) : null}
            </Box>,
          )}
        {agg &&
          Svg &&
          section(
            'Tokens per hour',
            'Last 24 hours, by model.',
            (() => {
              const totals = agg.hourly.map(hb => hb.total)
              const p = peak(totals)
              const ids = agg.models.map(m => m.name)
              return chart(
                bars({
                  columns: agg.hourly.map(hb => ids.map(m => hb.byModel[m] ?? 0)),
                  colors: ids.map(color),
                  titles: agg.hourly.map(hb => `${clock(hb.t)}: ${fmtCount(hb.total)}`),
                  height: 72,
                }),
                'Tokens per hour for the last 24 hours',
                {
                  legend: modelLegend(),
                  labels: [0, 6, 12, 18].map(i => clock(agg.hourly[i]?.t ?? now)).concat('Now'),
                  caption: totals[p] ? `Peak ${fmtCount(totals[p] as number)} at ${clock(agg.hourly[p]?.t ?? now)}` : 'No activity in the last 24 hours',
                },
              )
            })(),
          )}
      </Box>
    )
  } else if (tab === 'tokens' && agg) {
    const t = agg.totals
    const typeRows = (b: typeof t.week) => [
      rankRow('k-read', 'Cache reads', 'Context re-read from cache', b.cacheRead, b.total, '#3987e5'),
      rankRow('k-write', 'Cache writes', 'New context cached', b.cacheWrite, b.total, '#d95926'),
      rankRow('k-out', 'Output', 'Written by Claude', b.output, b.total, '#199e70'),
      rankRow('k-in', 'Input', 'Uncached input', b.input, b.total, '#c98500'),
    ]
    body = (
      <Box flexDirection="column">
        {section(
          'This computer',
          localNote,
          <Box flexDirection="row" gap={3} flexWrap="wrap">
            {stat('Current session', fmtCount(t.session.total), sinceSession)}
            {stat('Today', fmtCount(t.today.total), `${t.today.messages} responses`)}
            {stat('This week', fmtCount(t.week.total), sinceWeek)}
            {stat('Last 14 days', fmtCount(t.fourteenDays.total))}
          </Box>,
        )}
        {Svg &&
          section(
            'Tokens per day',
            'Last 14 days, by model.',
            chart(
              bars({
                columns: agg.daily.map(x => agg.models.map(m => x.byModel[m.name] ?? 0)),
                colors: agg.models.map(m => color(m.name)),
                titles: agg.daily.map(x => `${weekday(x.t)} ${x.date.slice(5)}: ${fmtCount(x.total)}`),
                height: 80,
              }),
              'Tokens per day by model',
              { legend: modelLegend(), labels: dayLabels, caption: `Busiest: ${weekday(agg.daily[peak(agg.daily.map(x => x.total))]?.t ?? now)} with ${fmtCount(Math.max(...agg.daily.map(x => x.total)))}` },
            ),
          )}
        {Svg &&
          week?.resetsAt &&
          section(
            'Weekly limit over time',
            'Weekly limit used against your working-day pace.',
            (() => {
              const end = Date.parse(week.resetsAt as string)
              const start = end - 7 * DAY
              const pts = history.filter(s => s.wr === week.resetsAt).map(s => [s.t, s.w] as [number, number])
              const fx = (t: number) => (t - start) / (7 * DAY)
              const used: [number, number][] = [[0, 0], ...pts.map(([t, w]) => [fx(t), w / 100] as [number, number])]
              if (!pts.length) used.push([fx(now), week.percentUsed / 100])
              const paceSteps = allowanceSteps(start, settings)
              const pace = allowanceAt(paceSteps, now)
              return chart(
                line({
                  series: [
                    { color: '#3987e5', points: used, title: `${fmtPct(week.percentUsed)} used` },
                    { color: '#3987e5', points: paceSteps.map(([t, v]) => [fx(t), v / 100] as [number, number]), dashed: true },
                  ],
                  refs: [
                    { y: settings.amber / 100, color: TONE.amber },
                    { y: settings.red / 100, color: TONE.red },
                  ],
                  height: 90,
                }),
                'Weekly limit used over the current window',
                {
                  legend: [
                    { name: 'Used', color: '#3987e5' },
                    { name: `Budget pace · ${workDayNames}`, color: '#8b8a85', dashed: true },
                    { name: `${settings.amber}% / ${settings.red}%`, color: TONE.amber, dashed: true },
                  ],
                  labels: Array.from({ length: 8 }, (_, i) => weekday(start + i * DAY)),
                  caption: `Now ${fmtPct(week.percentUsed)} · budget pace says ${fmtPct(pace)} by now`,
                },
              )
            })(),
          )}
        {section('Token types this week', 'Tokens since the weekly reset, by type.', ...typeRows(t.week))}
        {agg.skippedFiles ? <Text dimColor>{agg.skippedFiles} history file{agg.skippedFiles === 1 ? ' is' : 's are'} over 400 MB and not counted.</Text> : null}
        {Svg &&
          section(
            'When you work',
            'Tokens by weekday and hour, last 14 days.',
            chart(heatmap(agg.heatmap), 'Tokens by weekday and hour', { legend: undefined }),
          )}
      </Box>
    )
  } else if (tab === 'projects' && agg) {
    const sessionRows = sessions?.status === 'ok' ? sessions.rows : []
    const groups = groupSessionUsage(agg, sessionRows, sessions?.groupOrder)
    const rows = groups.flatMap(g => g.projects)
    const max = Math.max(0, ...rows.map(p => p.week.total))
    const projectRow = (p: (typeof rows)[number]) =>
      rankRow(
        `p-${p.key}`,
        p.title,
        `${p.project}${p.isArchived ? ' · archived' : ''} · today ${fmtCount(p.today.total)}`,
        p.week.total,
        max,
        '#3987e5',
        agg.models.map(m => ({ value: p.byModel[m.name] ?? 0, color: color(m.name) })),
      )
    body = (
      <Box flexDirection="column">
        {section(
          'Projects',
          `Tokens per project since the weekly reset, on this computer.`,
          rows.length === 0 ? <Text dimColor>No Claude Code usage in the last 14 days.</Text> : legend(modelLegend()),
          needsAccess ? (
            <Box flexDirection="row" gap={2} alignItems="center">
              <Text dimColor>Connect to show your sidebar groups.</Text>
              <Button key="connect" label="Connect" variant="primary" onPress={() => act.refresh(true)} />
            </Box>
          ) : null,
        )}
        {groups.length > 1 ? (
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="groups-collapse" label="Collapse all" plain onPress={() => act.setCollapsed(groups.map(g => g.name))} />
            <Button key="groups-expand" label="Expand all" plain onPress={() => act.setCollapsed([])} />
          </Box>
        ) : null}
        {groups.map(g => {
          const isOpen = !d.collapsedGroups.includes(g.name)
          const toggle = () => act.setCollapsed(isOpen ? [...d.collapsedGroups, g.name] : d.collapsedGroups.filter(n => n !== g.name))
          return (
            <Box key={`group-${g.name}`} flexDirection="column" marginTop={2}>
              {Svg ? <Svg source={rule()} alt="" /> : <Text dimColor>{'─'.repeat(Math.max(10, Math.min(60, cols - 4)))}</Text>}
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1} marginBottom={isOpen ? 1 : 0}>
                <Text bold color="#3987e5">
                  {g.name}
                </Text>
                <Box flexDirection="row" gap={2} alignItems="center">
                  <Text dimColor>
                    {g.projects.length} project{g.projects.length === 1 ? '' : 's'} · {fmtCount(g.week)} this week
                  </Text>
                  <Button key={`group-toggle-${g.name}`} plain label={isOpen ? 'Hide' : 'Show'} onPress={toggle} />
                </Box>
              </Box>
              {isOpen ? g.projects.map(projectRow) : null}
            </Box>
          )
        })}
      </Box>
    )
  } else if (tab === 'models' && agg) {
    const ms = agg.models.filter(m => m.fourteenDays.total > 0)
    const mMax = Math.max(0, ...ms.map(m => m.week.total))
    const es = agg.entrypoints.filter(x => x.week.total > 0)
    const eMax = es[0]?.week.total ?? 0
    body = (
      <Box flexDirection="column">
        {modelWindows.length > 0 &&
          section('Model limits', 'Weekly limits per model, across all your devices.', ...modelWindows.map(w => limitRow(`m-${w.kind}`, w.kind.slice(6), resets(w.resetsAt), w.percentUsed)))}
        {section(
          'Models this week',
          'Tokens per model since the weekly reset, on this computer.',
          ...ms.map(m => rankRow(`mm-${m.name}`, prettyModel(m.name), `Current session ${fmtCount(m.session.total)} · output ${fmtCount(m.week.output)}`, m.week.total, mMax, color(m.name))),
        )}
        {Svg &&
          section(
            'Model mix per day',
            'Tokens per day by model, last 14 days.',
            chart(
              bars({
                columns: agg.daily.map(x => ms.map(m => x.byModel[m.name] ?? 0)),
                colors: ms.map(m => color(m.name)),
                titles: agg.daily.map(x => `${weekday(x.t)} ${x.date.slice(5)}: ${ms.map(m => `${prettyModel(m.name)} ${fmtCount(x.byModel[m.name] ?? 0)}`).join(', ')}`),
                height: 80,
              }),
              'Tokens per day by model',
              { legend: modelLegend(), labels: dayLabels },
            ),
          )}
        {section(
          'Where Claude Code ran',
          'Tokens per Claude Code app since the weekly reset, on this computer.',
          ...es.map(x => rankRow(`e-${x.name}`, prettyEntry(x.name), `Current session ${fmtCount(x.session.total)}`, x.week.total, eMax, '#199e70')),
        )}
      </Box>
    )
  } else if (tab === 'sessions') {
    const split = sessions ? splitSessions(sessions.rows, sessions.live ?? [], settings, now) : null
    const list = (title: string, rows: SessionView[], empty: string) =>
      section(
        `${title} · ${rows.length}`,
        null,
        rows.length === 0 ? <Text dimColor>{empty}</Text> : null,
        ...rows.slice(0, 25).map(r => (
          <Box key={`${title}-${r.sessionId}`} flexDirection="column" marginBottom={1}>
            <Text wrap="truncate-end">
              {r.title}
              {r.remoteControlActive ? '  · Remote Control' : ''}
            </Text>
            <Text dimColor wrap="truncate-end">
              {r.cwd.split(/[\\/]/).pop()} · {r.group ?? 'Ungrouped'} · {relTime(Date.parse(r.lastActivityAt), now)}
            </Text>
          </Box>
        )),
      )
    body = split ? (
      <Box flexDirection="column">
        {list('Working now', split.working, 'Claude isn’t working on anything right now.')}
        {list('Waiting for you', split.waiting, 'No open sessions are waiting for you.')}
        {list('Remote Control', split.remote, 'No sessions are served over Remote Control.')}
        {sessions?.status === 'ok' ? list('Recent', split.recent, `No other sessions in the last ${settings.awaitingHours}h.`) : null}
        {needsAccess ? (
          <Box flexDirection="row" gap={2} alignItems="center">
            <Text dimColor>Connect to add titles, groups, Remote Control and recent sessions.</Text>
            <Button key="connect" label="Connect" variant="primary" onPress={() => act.refresh(true)} />
          </Box>
        ) : null}
      </Box>
    ) : (
      section('Sessions', 'Loading…')
    )
  } else if (tab === 'settings') {
    const pick = (key: string, value: number, values: number[], fmt: (n: number) => string, onSelect: (v: number) => void) =>
      Select ? (
        <Select key={key} value={String(value)} options={values.map(v => ({ value: String(v), label: fmt(v) }))} onSelect={v => onSelect(Number(v))} />
      ) : (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {values.map(v => (
            <Button key={`${key}-${v}`} label={fmt(v)} variant={v === value ? 'primary' : 'secondary'} onPress={() => onSelect(v)} />
          ))}
        </Box>
      )
    const field = (label: string, hint: string, control: unknown) => (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={2} marginBottom={1}>
        <Box flexDirection="column" flexShrink={1}>
          <Text>{label}</Text>
          <Text dimColor>{hint}</Text>
        </Box>
        <Box flexShrink={0}>{control}</Box>
      </Box>
    )
    body = (
      <Box flexDirection="column">
        {section(
          'Refresh',
          null,
          field(
            'Refresh every',
            'How often the figures update. Manual updates only when you press Refresh or open the dashboard.',
            pick('refresh', settings.refreshSeconds, [0, 30, 60, 120, 300, 600, 900, 1800], n => (n === 0 ? 'Manual' : n < 60 ? `${n} seconds` : n === 60 ? '1 minute' : `${n / 60} minutes`), v => act.saveSettings({ refreshSeconds: v })),
          ),
          field(
            'After each response',
            'Update a few seconds after each Claude reply.',
            <Button key="refreshOnResponse" label={settings.refreshOnResponse ? 'On' : 'Off'} onPress={() => act.saveSettings({ refreshOnResponse: !settings.refreshOnResponse })} />,
          ),
        )}
        {section(
          'Budget',
          null,
          field('Working days', `Budget days run 24 hours from your weekly reset; the first ${work} are working days (${workDayNames}). Each adds ${fmtPct(budget)} of the weekly limit.`, pick('workDays', settings.workDays, [1, 2, 3, 4, 5, 6, 7], n => `${n} day${n > 1 ? 's' : ''}`, v => act.saveSettings({ workDays: v }))),
        )}
        {section(
          'Alerts',
          'Warning levels for the session, daily and weekly limits.',
          field('Amber at', 'First warning.', pick('amber', settings.amber, [50, 60, 70, 75, 80, 85], n => `${n}%`, v => act.saveSettings({ amber: v }))),
          field('Red at', 'Must be above amber.', pick('red', settings.red, [70, 80, 85, 90, 95, 100], n => `${n}%`, v => act.saveSettings({ red: v }))),
          field('Status line', 'Shows 5h · day · week at a glance.', <Button key="statusLine" label={settings.statusLine ? 'On' : 'Off'} onPress={() => act.saveSettings({ statusLine: !settings.statusLine })} />),
          field('Usage bar above the prompt', 'Live figures and a button that opens this dashboard, with no tokens used.', <Button key="showBand" label={settings.showBand ? 'On' : 'Off'} onPress={() => act.saveSettings({ showBand: !settings.showBand })} />),
          field('Re-arm alerts', 'Alert again for levels already reached.', <Button key="reset-alerts" label="Re-arm" onPress={() => act.rearm()} />),
        )}
        {section(
          'Data',
          null,
          field('Recent sessions', 'Closed sessions active within this time.', pick('awaiting', settings.awaitingHours, [1, 4, 12, 24, 72], n => `${n}h`, v => act.saveSettings({ awaitingHours: v }))),
          field('App access', 'Plan limits per model and your session list.', <Button key="connect" label="Connect" onPress={() => act.refresh(true)} />),
        )}
        {section(
          'Dashboard',
          null,
          field('Close the dashboard', 'Hides the dashboard, the bar above the prompt and the status line. Open it again with /usage-dashboard-wfc.', <Button key="close-dashboard" label="Close" onPress={() => act.close()} />),
        )}
        {section(
          'About',
          null,
          <Text>
            Created by <Link href={WEBSITE} label="WhiteFish Creative Limited" />
          </Text>,
          <Text dimColor>
            Version {d.about.version}{d.about.released ? ` · released ${new Date(`${d.about.released}T12:00:00Z`).toUTCString().slice(5, 16)}` : ''}
          </Text>,
        )}
      </Box>
    )
  } else {
    body = section('Loading', d.aggError ?? 'Reading your Claude Code history… the first scan takes a few seconds.')
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {header}
      {d.aggError && tab !== 'settings' ? <Text color={TONE.red}>Couldn’t read local history: {d.aggError}</Text> : null}
      {body}
      <Box flexDirection="row" justifyContent="flex-start" marginTop={3}>
        {Svg ? <Svg source={smallText(credit)} alt={credit} /> : <Text dimColor>{credit}</Text>}
      </Box>
    </Box>
  )
}
