export type TokenBucket = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
  messages: number
}

export type TimeBucket = TokenBucket & { t: number; byModel: Record<string, number> }
export type DayBucket = TimeBucket & { date: string }

export type RankedRow = {
  name: string
  session: TokenBucket
  today: TokenBucket
  week: TokenBucket
  fourteenDays: TokenBucket
  byModel: Record<string, number>
}

/** What scripts/aggregate.py prints. */
export type Aggregate = {
  generatedAt: number
  todayStart: number
  tzOffsetMinutes: number
  /** When the weekly limit last reset (or 7 days back without a reading). */
  weekStart: number
  /** When the current 5-hour window started (or 5 hours back without a reading). */
  sessionStart: number
  totals: { lastHour: TokenBucket; session: TokenBucket; today: TokenBucket; week: TokenBucket; fourteenDays: TokenBucket }
  hourly: TimeBucket[]
  daily: DayBucket[]
  /** Seven 24-hour budget days counted from the weekly reset (weekStart). */
  weekDays?: TimeBucket[]
  projects: RankedRow[]
  models: RankedRow[]
  entrypoints: RankedRow[]
  heatmap: number[][]
  scanMs: number
  records: number
  /** Usage per Claude Code session id, with the project folder it ran in. */
  sessions?: (RankedRow & { project: string })[]
  /** Claude Desktop's own session records: sidebar title and the Claude Code ids it holds. */
  desktopSessions?: { id: string; title: string; cliIds: string[]; isArchived: boolean }[]
  /** Which project each session folder belongs to (when asked with --cwds-stdin). */
  cwdProjects?: Record<string, string>
}

export type PlanWindow = {
  /** five_hour, seven_day, or model:<name> for a per-model weekly window. */
  kind: string
  label: string
  percentUsed: number
  resetsAt?: string
}

export type Plan = {
  source: 'app' | 'session' | 'none'
  plan?: string
  windows: PlanWindow[]
  extraUsageEnabled?: boolean
  note?: string
  at: number
}

export type SessionRow = {
  sessionId: string
  title: string
  cwd: string
  isRunning: boolean
  isArchived: boolean
  lastActivityAt: string
  link?: string
  remoteControlActive: boolean
  group?: string
}

export type Sessions = {
  status: 'ok' | 'needs-access' | 'unavailable'
  rows: SessionRow[]
  /** The sidebar's custom groups, in sidebar order (absent when the app didn't say). */
  groupOrder?: string[]
  note?: string
  at: number
}

/** One reading of the weekly window, kept to derive per-day usage. */
export type Snapshot = { t: number; w: number; wr: string; f: number }

export type Settings = {
  workDays: number
  amber: number
  red: number
  awaitingHours: number
  /** Seconds between refreshes; 0 refreshes only on demand. */
  refreshSeconds: number
  /** Refresh a few seconds after each Claude response. */
  refreshOnResponse: boolean
  osNotify: boolean
  statusLine: boolean
  /** The slim usage bar above the prompt, with a button that opens the dashboard. */
  showBand: boolean
  /** Closed from Settings: no pane, bar or status line until /usage-dashboard opens it again. */
  isClosed: boolean
}

export type Tab = 'overview' | 'tokens' | 'projects' | 'models' | 'sessions' | 'settings'

declare module 'claude-code' {
  interface PluginState {
    'token-dashboard': {
      agg: Aggregate | null
      aggError: string | null
      plan: Plan | null
      sessions: Sessions | null
      history: Snapshot[]
      settings: Settings
      tab: Tab
      modelColors: Record<string, string>
      refreshing: boolean
      bandDismissed: string
      /** Sidebar groups folded shut on the Projects tab. */
      collapsedGroups: string[]
    }
  }
}
