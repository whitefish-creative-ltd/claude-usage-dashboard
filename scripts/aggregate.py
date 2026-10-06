#!/usr/bin/env python3
"""Incrementally aggregates Claude Code token usage from ~/.claude/projects transcripts.

Reads only the bytes appended since the last run (offsets kept in a cache file),
dedupes assistant messages by message id, and prints one JSON document of
aggregates in the machine's local time zone.

Usage: aggregate.py [--since-ms <ms>] [--session-since-ms <ms>] [--sync-dir <path>|default|off]
  since: when the weekly limit last reset; session-since: when the 5-hour window started
  --cwds-stdin: read a JSON list of folders on stdin and answer which project each
  belongs to as "cwdProjects" (the dashboard uses it to map sessions to projects)
  sync-dir: a folder every Mac can see (default: iCloud Drive/Claude Usage). Each Mac
  writes its own records there as <name>-<id>.json and reads every other Mac's.
"""
import glob
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")
CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR", os.path.join(HOME, ".claude"))
PROJECTS = os.path.join(CLAUDE_DIR, "projects")
CACHE_DIR = os.path.join(CLAUDE_DIR, "token-dashboard")
CACHE = os.path.join(CACHE_DIR, "cache.json")
KEEP_DAYS = 15
CACHE_VERSION = 3
ICLOUD = os.path.join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs")
DEFAULT_SYNC = os.path.join(ICLOUD, "Claude Usage")
SYNC_VERSION = 1


def arg(name):
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def machine():
    """This Mac's display name and a stable id (so two Macs with one name never collide)."""
    id_file = os.path.join(CACHE_DIR, "machine-id")
    try:
        with open(id_file) as f:
            mid = f.read().strip()
    except OSError:
        mid = uuid.uuid4().hex[:8]
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(id_file, "w") as f:
            f.write(mid)
    try:
        name = subprocess.run(["/usr/sbin/scutil", "--get", "ComputerName"], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        name = ""
    return (name or os.uname().nodename.split(".")[0] or "This Mac"), mid


def sync(cache, sync_dir, name, mid):
    """Writes this Mac's records to the shared folder and reads every other Mac's.

    Returns [(machine name, records dict, updated ms, is this Mac)] and a status line."""
    own = [(name, cache["recs"], int(time.time() * 1000), True)]
    if not sync_dir:
        return own, None
    if sync_dir == DEFAULT_SYNC and not os.path.isdir(ICLOUD):
        return own, "iCloud Drive isn't turned on for this Mac."
    try:
        os.makedirs(sync_dir, exist_ok=True)
    except OSError as e:
        return own, f"Can't use the sync folder: {e.strerror}"
    safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in name).strip() or "Mac"
    mine = os.path.join(sync_dir, f"{safe}-{mid}.json")
    # Rewrite only when something changed, to keep iCloud traffic down.
    sig = [len(cache["recs"]), max((r[0] for r in cache["recs"].values()), default=0)]
    if cache.get("syncSig") != sig or not os.path.exists(mine):
        tmp = mine + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"version": SYNC_VERSION, "name": name, "id": mid, "updatedAt": int(time.time() * 1000), "recs": cache["recs"]}, f, separators=(",", ":"))
        os.replace(tmp, mine)
        cache["syncSig"] = sig
    out = list(own)
    for path in glob.glob(os.path.join(sync_dir, "*.json")):
        if os.path.abspath(path) == os.path.abspath(mine):
            continue
        try:
            with open(path) as f:
                d = json.load(f)
        except Exception:
            continue  # mid-write, or an iCloud placeholder not downloaded yet
        if d.get("version") != SYNC_VERSION or d.get("id") == mid:
            continue
        out.append((d.get("name") or "Other Mac", d.get("recs") or {}, int(d.get("updatedAt") or 0), False))
    return out, None


def load_cache():
    try:
        with open(CACHE) as f:
            c = json.load(f)
        if c.get("version") == CACHE_VERSION:
            return c
    except Exception:
        pass
    return {"version": CACHE_VERSION, "files": {}, "recs": {}}


def save_cache(c):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f, separators=(",", ":"))
    os.replace(tmp, CACHE)


_project_names = {}


def project_name(cwd):
    """The repository a working directory belongs to, so sub-folders and worktrees roll up.

    `/x/App/.claude/worktrees/agent-1/src` → App; `/x/App/site` → App when App is the git root."""
    if cwd in _project_names:
        return _project_names[cwd]
    path = cwd.rstrip("/")
    for marker in ("/.claude/worktrees/", "/.worktrees/", "/worktrees/"):
        if marker in path:
            path = path.split(marker, 1)[0]
    root = None
    probe = path
    while probe and probe != HOME and probe != "/":
        if os.path.exists(os.path.join(probe, ".git")):
            root = probe
            break
        probe = os.path.dirname(probe)
    name = os.path.basename(root or path) or "unknown"
    _project_names[cwd] = name
    return name


def parse_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def scan(cache):
    now = time.time()
    cutoff = now - KEEP_DAYS * 86400
    files = cache["files"]
    recs = cache["recs"]
    seen_paths = set()
    for path in glob.iglob(os.path.join(PROJECTS, "**", "*.jsonl"), recursive=True):
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        seen_paths.add(path)
        meta = files.get(path, {"o": 0})
        off = meta["o"] if st.st_size >= meta["o"] else 0
        if off == st.st_size:
            continue
        with open(path, "rb") as f:
            f.seek(off)
            chunk = f.read()
        end = chunk.rfind(b"\n")
        if end < 0:
            continue
        for raw in chunk[: end + 1].splitlines():
            if b'"usage"' not in raw or b'"assistant"' not in raw:
                continue
            try:
                d = json.loads(raw)
            except Exception:
                continue
            if d.get("type") != "assistant":
                continue
            m = d.get("message") or {}
            u = m.get("usage") or {}
            model = m.get("model") or "unknown"
            if model == "<synthetic>" or not u:
                continue
            key = m.get("id") or d.get("requestId") or d.get("uuid")
            ts = parse_ts(d.get("timestamp", ""))
            if not key or ts is None or ts < cutoff:
                continue
            cwd = d.get("cwd") or ""
            project = project_name(cwd) if cwd else "unknown"
            recs[key] = [
                int(ts),
                project,
                model,
                d.get("entrypoint") or "unknown",
                int(u.get("input_tokens") or 0),
                int(u.get("output_tokens") or 0),
                int(u.get("cache_creation_input_tokens") or 0),
                int(u.get("cache_read_input_tokens") or 0),
                1 if d.get("isSidechain") else 0,
            ]
        files[path] = {"o": off + end + 1}
    for p in list(files):
        if p not in seen_paths:
            del files[p]
    for k in [k for k, r in recs.items() if r[0] < cutoff]:
        del recs[k]


def empty():
    return {"input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "total": 0, "messages": 0}


def add(b, r):
    b["input"] += r[4]
    b["output"] += r[5]
    b["cacheWrite"] += r[6]
    b["cacheRead"] += r[7]
    b["total"] += r[4] + r[5] + r[6] + r[7]
    b["messages"] += 1


def aggregate(sources, since, session_since):
    now = time.time()
    local_now = datetime.now().astimezone()
    today = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_ts = today.timestamp()
    hour0 = local_now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=23)
    hour0_ts = hour0.timestamp()
    day0 = today - timedelta(days=13)
    day0_ts = day0.timestamp()
    week_ts = since if since else today_ts - 6 * 86400
    session_ts = session_since if session_since else now - 5 * 3600

    hourly = [{"t": int((hour0 + timedelta(hours=i)).timestamp() * 1000), "byModel": {}, **empty()} for i in range(24)]
    days = []
    for i in range(14):
        d = day0 + timedelta(days=i)
        days.append({"date": d.strftime("%Y-%m-%d"), "t": int(d.timestamp() * 1000), "byModel": {}, **empty()})
    # Budget days: seven 24-hour slots counted from the weekly reset.
    week_days = [{"t": int((week_ts + i * 86400) * 1000), "byModel": {}, **empty()} for i in range(7)]
    totals = {"lastHour": empty(), "session": empty(), "today": empty(), "week": empty(), "fourteenDays": empty()}
    projects, models, entries, machines = {}, {}, {}, {}
    heat = [[0] * 24 for _ in range(7)]  # weekday x hour, last 14 days

    def every():
        for name, recs, _, _ in sources:
            for r in recs.values():
                yield name, r

    for mname, r in every():
        ts = r[0]
        if ts < day0_ts:
            continue
        tot = r[4] + r[5] + r[6] + r[7]
        add(totals["fourteenDays"], r)
        lt = datetime.fromtimestamp(ts)
        heat[lt.weekday()][lt.hour] += tot
        di = int((ts - day0_ts) // 86400)
        # DST-safe day index
        while di < 13 and ts >= days[di + 1]["t"] / 1000:
            di += 1
        while di > 0 and ts < days[di]["t"] / 1000:
            di -= 1
        if 0 <= di < 14:
            add(days[di], r)
            days[di]["byModel"][r[2]] = days[di]["byModel"].get(r[2], 0) + tot
        if ts >= hour0_ts:
            hi = int((ts - hour0_ts) // 3600)
            if 0 <= hi < 24:
                add(hourly[hi], r)
                hourly[hi]["byModel"][r[2]] = hourly[hi]["byModel"].get(r[2], 0) + tot
        if ts >= now - 3600:
            add(totals["lastHour"], r)
        is_today = ts >= today_ts
        is_week = ts >= week_ts
        is_session = ts >= session_ts
        if is_week:
            wi = int((ts - week_ts) // 86400)
            if 0 <= wi < 7:
                add(week_days[wi], r)
                week_days[wi]["byModel"][r[2]] = week_days[wi]["byModel"].get(r[2], 0) + tot
        if is_session:
            add(totals["session"], r)
        if is_today:
            add(totals["today"], r)
        if is_week:
            add(totals["week"], r)
        for table, name in ((projects, r[1]), (models, r[2]), (entries, r[3]), (machines, mname)):
            row = table.setdefault(name, {"name": name, "session": empty(), "today": empty(), "week": empty(), "fourteenDays": empty(), "byModel": {}, "machines": []})
            if mname not in row["machines"]:
                row["machines"].append(mname)
            add(row["fourteenDays"], r)
            if is_session:
                add(row["session"], r)
            if is_today:
                add(row["today"], r)
            if is_week:
                add(row["week"], r)
                row["byModel"][r[2]] = row["byModel"].get(r[2], 0) + tot

    def ranked(t):
        return sorted(t.values(), key=lambda x: (x["week"]["total"], x["fourteenDays"]["total"]), reverse=True)

    return {
        "generatedAt": int(now * 1000),
        "todayStart": int(today_ts * 1000),
        "tzOffsetMinutes": int(local_now.utcoffset().total_seconds() // 60),
        "weekStart": int(week_ts * 1000),
        "sessionStart": int(session_ts * 1000),
        "totals": totals,
        "hourly": hourly,
        "daily": days,
        "weekDays": week_days,
        "projects": ranked(projects),
        "machines": [
            {**row, "updatedAt": next((u for n, _, u, _ in sources if n == row["name"]), 0), "isThis": next((t for n, _, _, t in sources if n == row["name"]), False)}
            for row in ranked(machines)
        ]
        + [
            {"name": n, "session": empty(), "today": empty(), "week": empty(), "fourteenDays": empty(), "byModel": {}, "machines": [n], "updatedAt": u, "isThis": t}
            for n, _, u, t in sources
            if n not in machines
        ],
        "models": ranked(models),
        "entrypoints": ranked(entries),
        "heatmap": heat,
    }


def main():
    since = None
    if "--since-ms" in sys.argv:
        try:
            since = int(sys.argv[sys.argv.index("--since-ms") + 1]) / 1000
        except Exception:
            since = None
    session_since = None
    if "--session-since-ms" in sys.argv:
        try:
            session_since = int(sys.argv[sys.argv.index("--session-since-ms") + 1]) / 1000
        except Exception:
            session_since = None
    sync_arg = arg("--sync-dir") or "off"
    sync_dir = None if sync_arg == "off" else (DEFAULT_SYNC if sync_arg == "default" else os.path.expanduser(sync_arg))
    cache = load_cache()
    started = time.time()
    scan(cache)
    name, mid = machine()
    sources, sync_note = sync(cache, sync_dir, name, mid)
    save_cache(cache)
    out = aggregate(sources, since, session_since)
    out["sync"] = {"dir": sync_dir, "note": sync_note, "machines": len(sources)}
    if "--cwds-stdin" in sys.argv:
        try:
            cwds = json.load(sys.stdin)
        except Exception:
            cwds = []
        out["cwdProjects"] = {c: project_name(c) for c in cwds if isinstance(c, str) and c}
    out["scanMs"] = int((time.time() - started) * 1000)
    out["records"] = len(cache["recs"])
    json.dump(out, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
