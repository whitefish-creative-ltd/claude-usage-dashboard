# Changelog

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
