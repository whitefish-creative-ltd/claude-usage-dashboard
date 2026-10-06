# Changelog

## 1.7.1 — 2026-10-06

- Fixed the daily budget jumping between two values (e.g. 77% ↔ 84%): when the app's usage reading dropped out for a moment, the dashboard used this session's own reading, which can lag a point behind. It now uses the app's last reading (if under 15 minutes old), and a fallback never shows less than the app last said for the same week
- Fixed reset times that drift by fractions of a second being treated as different weeks, which made today's figure switch between exact and estimated, saved far more readings than needed, and could repeat alerts

## 1.7.0 — 2026-10-06

- Opening the dashboard asks for app access straight away when it isn't connected (once a session, and not after you've disconnected), instead of waiting for you to find Connect

## 1.6.0 — 2026-10-06

- Settings → App access shows **● Connected** with a **Disconnect** button once the dashboard can read your plan limits and session list from the Claude app, and **Connect** only when it can't (or you've turned it off)
- Disconnecting stops the dashboard calling the app's tools; it carries on with this session's limit readings and Claude Code's local files

## 1.5.0 — 2026-10-06

- Sessions tab shows which sessions are open from Claude Code's own live status: **Working now** (Claude is replying) and **Waiting for you**, then Remote Control and **Recent** closed sessions. The app's own "running" flag missed sessions that were working
- Works without app access too: open sessions show even before you press Connect

## 1.4.1 — 2026-10-06

- Plan limits no longer go blank when the app can't read them for a moment: the dashboard uses this session's own reading, or the last good one with its age
- The daily budget waits for a weekly reset time instead of guessing the week (which could wrongly call today a day off)

## 1.4.0 — 2026-10-06

- Renamed to **WhiteFish Usage Dashboard** (plugin `whitefish-usage-dashboard`); existing installs of `token-dashboard` move across automatically
- The command is now `/usage-dashboard-wfc`, so it can't clash with another plugin's command
- Settings and the dashboard's saved readings start fresh after the rename

## 1.3.0 — 2026-10-06

- Works on macOS, Windows and Linux with nothing to install: the history scanner is now built into the plugin instead of a Python script
- The plugin no longer runs any programs or writes any files; the README lists everything it reads and calls
- The "Today" row reads "Since 3 AM · 20% of daily budget used"
- History files over 400 MB are skipped (the dashboard says how many)
- Removed macOS-only extras: system notifications (in-app pop-ups and the warning bar remain) and the Open buttons on the Sessions tab

## 1.2.0 — 2026-10-06

- Settings → Refresh: choose how often the figures update (30 seconds to 30 minutes, or Manual), and whether to update after each Claude reply

## 1.1.1 — 2026-10-06

- Fixed the session you're in being listed under "Ungrouped" (the app's session list leaves it out), which made the Projects tab differ between sessions

## 1.1.0 — 2026-10-06

- Projects now lists each project by its name in the Claude Desktop sidebar, under the group it's filed in there, so every session of the dashboard shows the same grouping. Terminal-only usage is listed by folder under "Terminal and other"
- Settings → Close hides the dashboard, the bar above the prompt and the status line; `/usage-dashboard` brings them back
- Fixed "Couldn't read local history" when several Claude sessions refreshed at the same moment
- Shorter, plainer descriptions on every section

## 1.0.2 — 2026-10-06

- Group names are bold blue headings again, with a Hide/Show control on the right instead of an arrow

## 1.0.1 — 2026-10-06

- Project groups use the names exactly as they appear in the Claude Desktop sidebar, not in capitals
- Groups follow the sidebar's order
- Each project is filed under the group of its most recently active session, so moving a session to a new group moves its project too

## 1.0.0 — 2026-10-06

First release.

- Plan usage limits for the whole account (current session, weekly, per model) with amber and red alerts, toasts, macOS notifications and a status-line summary
- Daily budget: the weekly limit ÷ working days, in 24-hour budget days counted from the weekly reset, with today's used vs available and the week's allowance
- Token usage on this computer by hour, budget day, project (grouped by sidebar group, collapsible) and model, counted since each limit last reset
- Sessions running, awaiting you, and on Remote Control
- Usage bar above the prompt with a Dashboard button; opening the dashboard uses no tokens
