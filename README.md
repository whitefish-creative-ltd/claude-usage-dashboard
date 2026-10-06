<p align="center">
  <a href="https://whitefishcreative.co.uk/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/wfc-logo-white.svg">
      <img src="assets/wfc-logo.svg" alt="WhiteFish Creative" width="160">
    </picture>
  </a>
</p>

<h1 align="center">WhiteFish Usage Dashboard</h1>

<p align="center">
  <strong>See where your Claude plan goes — before you hit the limit.</strong><br>
  A dashboard for Claude Code and the Claude Desktop app: plan limits, a daily budget, alerts, and token usage by hour, day, project and model.
</p>

<p align="center">
  <img alt="Version 1.5.0" src="https://img.shields.io/badge/version-1.5.0-0A4E75">
  <img alt="Claude Code 2.1.286+" src="https://img.shields.io/badge/Claude%20Code-2.1.286%2B-569CBE">
  <img alt="macOS, Windows and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-808285">
  <a href="LICENSE"><img alt="Licence: PolyForm Internal Use 1.0.0" src="https://img.shields.io/badge/licence-PolyForm%20Internal%20Use-0A4E75"></a>
</p>

---

## Why

Claude's plans have a 5-hour limit and a weekly limit, and it's easy to burn through a week's allowance in two busy days. This dashboard keeps the numbers in front of you while you work: how much of each limit you've used, how much of **today's share** of the week is left, and which projects and models are using it.

## Features

### Plan usage limits
- **Current session** (5-hour window), **this week**, and any **per-model weekly limits**, with reset times — for your whole account, every device included.
- **Amber and red alerts** (80% and 90% by default) as in-app pop-ups, a warning bar above the prompt and a status-line summary. Each alert fires once per limit period.

### Daily budget
- Your weekly limit split evenly across the days you work: with 5 working days, each day gets **20%** of the week.
- Budget days run **24 hours from your weekly reset**, so they line up with how Claude counts. The first *N* budget days are your working days; the rest add nothing.
- **Today:** a donut of used vs available, turning amber and red as you approach and pass your budget.
- **This week:** an area chart of the allowance you've earned so far against what you've actually used.

### Token usage
- Tokens per **hour** (last 24 hours) and per **day** (last 14 days), split by model.
- **Projects**: usage per project, titled and grouped exactly as in your Claude Desktop sidebar, with collapsible groups. Claude Code used from the terminal is listed per folder.
- **Models** and **where Claude Code ran** (desktop app, terminal, SDK).
- Totals **since the current session started** and **since the weekly reset**, plus a weekday × hour heat map of when you work.

### Sessions
- Open sessions **working now** and **waiting for you**, sessions served over **Remote Control**, and **recent** sessions.

### Always to hand
- A slim bar above the prompt: `Session 6% · Daily budget 12% · Week 2%`, with a **Dashboard** button.
- Opening the dashboard runs no Claude turn, so it **uses no tokens**.
- Follows your light or dark theme.

## Install

In your terminal:

```bash
claude plugin marketplace add whitefish-creative-ltd/claude-usage-dashboard
claude plugin install whitefish-usage-dashboard@whitefish-creative
```

Or in a Claude Code session, run `/plugin marketplace add whitefish-creative-ltd/claude-usage-dashboard`, then `/plugin install whitefish-usage-dashboard@whitefish-creative`.

Start a new session, or run `/reload-plugins` in an open one.

## Getting started

1. Open the dashboard with **`/usage-dashboard-wfc`**, or the **Dashboard** button above the prompt.
2. The first time, press **Connect** and allow access. This lets the dashboard read your per-model limits and your session list from the Claude Desktop app. It only reads; it never changes anything.
3. Go to **Settings** and set your **working days**, alert levels and the rest.

## How the numbers work

| Figure | Where it comes from | Covers |
| --- | --- | --- |
| Plan usage limits | The same figures as Claude's own usage page | Your whole account: every computer, the mobile app and claude.ai chat |
| Daily budget | The weekly limit, recorded as it changes through the day | Your whole account |
| Tokens, projects, models | Claude Code's history files on this computer | Claude Code on this computer only |

A few things worth knowing:

- **Chat and the mobile app** count towards your plan limits, but they don't keep per-project records anywhere a dashboard can read, so they don't appear in the token breakdowns.
- **Today's budget is exact** once the dashboard has been running for a day. Until then it's estimated from this computer's share of activity and marked with an asterisk.
- **Token totals include cache reads**, which dominate long sessions. The Activity tab breaks totals into input, output, cache writes and cache reads.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Working days | 5 | How many budget days, counted from your weekly reset, share the weekly limit |
| Amber at / Red at | 80% / 90% | Alert levels for the 5-hour window, today's budget and the weekly limits |
| Status line | On | Shows `5h · day · wk` in the status line |
| Usage bar above the prompt | On | The slim bar with the **Dashboard** button (alerts still show when it's off) |
| Recent sessions | 12h | How far back the Sessions tab lists closed sessions |
| Refresh every | 1 minute | How often the figures update: 30 seconds to 30 minutes, or Manual (only when you press Refresh or open the dashboard) |
| After each response | On | Also updates a few seconds after each Claude reply |
| Close the dashboard | — | Hides the dashboard, the bar and the status line until you run `/usage-dashboard-wfc` |

## Requirements

- **Claude Desktop** with Claude Code **2.1.286** or later, or the **Claude Code CLI 2.1.287** or later
- **macOS, Windows or Linux**. Nothing else to install.
- A **Pro or Max** plan for the plan-limit figures
- Per-model limits and the session list need the **Claude Desktop** app

## Privacy

Everything stays on your computer. Nothing is sent anywhere: the dashboard makes no network requests, runs no programs and writes no files. The next section lists everything it reads and calls.

## What the dashboard does on your computer

**Files it reads** (read-only; it never changes them)
- Claude Code's history: the `.jsonl` files in `~/.claude/projects/` (or `$CLAUDE_CONFIG_DIR/projects/`), including each session's `subagents/` folder, from the last 15 days. The plugin can only read whole files, so it reads your conversations in passing, but it keeps only the usage figures on each reply: model, token counts, time, working folder and session id. History files over 400 MB are skipped.
- Claude Desktop's session records: `claude-code-sessions/*/*/local_*.json` in the Claude app's data folder (`~/Library/Application Support/Claude` on macOS, `%APPDATA%\Claude` on Windows, `~/.config/Claude` on Linux), for each session's sidebar title and the history it belongs to.
- Claude Code's live session files: the numbered `.json` files in `~/.claude/sessions/`, which say which sessions are open and whether Claude is working or waiting for you. The `.key` files beside them are never read.
- Whether a working folder's parents contain a `.git` entry, to name projects after their repository.
- Its own `.claude-plugin/plugin.json` and `CHANGELOG.md`, for the version and release date shown in Settings.
- The environment variables `HOME`, `USERPROFILE`, `APPDATA` and `CLAUDE_CONFIG_DIR`, to find those folders.

**What it stores**
- Running totals in 10-minute buckets, how far it has read each history file, your settings and the weekly-limit readings, in Claude Code's own storage for plugins. Nothing else is written.

**Claude Desktop tools it calls** (all read-only; it calls them itself, not Claude)
- `mcp__ccd_session_mgmt__get_usage` — your plan's usage limits, as on Claude's usage page.
- `mcp__ccd_session_mgmt__list_sessions` and `mcp__ccd_session_mgmt__get_session` (`self`) — your sessions' titles, folders, sidebar groups and whether they're running.
- `mcp__ccd_sidebar__list_groups` — your sidebar groups' names and order.

They're called on each refresh (every minute by default; see **Settings → Refresh**). Each is checked first and skipped if it would ask your permission; pressing **Connect** calls them once with your go-ahead so you can allow them.

**What it hooks**
- `session.start` — loads your settings and registers `/usage-dashboard-wfc`.
- `command.run` — answers only its own `/usage-dashboard-wfc` command, which opens the dashboard and adds nothing to the conversation.
- `session.measure` — notices when your plan's usage changes after a reply, to refresh a few seconds later.
- `ui.render` — draws the dashboard pane and the bar above the prompt.

**What it never does**: call Claude or any model, send data off your computer, run programs or shell commands, change files or settings outside its own storage, or keep any of your prompts or Claude's replies.

## Updating

New releases reach you when the version number changes — see [CHANGELOG.md](CHANGELOG.md). To update now:

```bash
claude plugin update whitefish-usage-dashboard@whitefish-creative
```

To update automatically, open `/plugin` → **Marketplaces** → **whitefish-creative** → **Enable auto-update**.

## Troubleshooting

- **`/usage-dashboard-wfc` isn't listed:** start a new session or run `/reload-plugins`. Run `/plugin` and check the dashboard appears under installed plugins.
- **No per-model limits or sessions:** open **Settings → App access** and press **Connect**. These need the Claude Desktop app.
- **"Reading your history…":** the first scan works through the last 15 days of history over a few refreshes; figures fill in as it goes.
- **Usage under "Terminal and other":** Claude Code used from the terminal, or from a desktop session that has since been deleted, listed by folder.
- **Hiding it:** Settings → **Close** hides the dashboard, the bar above the prompt and the status line. `/usage-dashboard-wfc` brings it back.

## Development

```bash
git clone git@github.com:whitefish-creative-ltd/claude-usage-dashboard.git
cd claude-usage-dashboard
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx` — events, refresh loop, alerts, the bar above the prompt
- `hooks/pane.tsx` — the dashboard
- `hooks/charts.ts` — SVG charts (no text inside, so they follow the app's theme)
- `hooks/logic.ts` — budget, grouping and parsing logic
- `hooks/scanner.ts` — reads Claude Code's history into 10-minute buckets and summarises them
- `hooks/dashboard.test.tsx` — tests, including a run against a fake history
- `./release.sh <version>` sets the version in `plugin.json` and the README badge, and starts a dated entry in `CHANGELOG.md`. Bump it for every release, or installed copies won't update.
- To try changes without releasing, start Claude Code with `claude --plugin-dir .` from the repository.

## Licence

The source is available under the [PolyForm Internal Use License 1.0.0](LICENSE). In short:

- **You can** read the code, use the dashboard for yourself and in your business, and change it for your own use.
- **You can't** distribute it or modified versions of it, publish it in another marketplace, or package it as your own.
- **The WhiteFish Creative name and logo** aren't covered by the licence. See [TRADEMARKS.md](TRADEMARKS.md).

This is a source-available licence, not an open-source one. The summary above is for convenience; the [LICENSE](LICENSE) text is what applies. Contributions are welcome under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- Combining usage from several computers

---

<p align="center">
  <a href="https://whitefishcreative.co.uk/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/wfc-logo-white.svg">
      <img src="assets/wfc-logo.svg" alt="WhiteFish Creative" width="64">
    </picture>
  </a><br>
  Designed and built by <a href="https://whitefishcreative.co.uk/"><strong>WhiteFish Creative Limited</strong></a>
</p>
