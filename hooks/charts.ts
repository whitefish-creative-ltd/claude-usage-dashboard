// SVG marks only — no text, axes or gridlines inside the images. Labels and
// legends are drawn by the pane as app text, so charts follow the app's own
// typography and theme. Neutral marks use translucent grey, which reads on
// light and dark surfaces alike.

const W = 600
const TRACK = 'rgba(128,128,128,.22)'
const RULE = 'rgba(128,128,128,.55)'

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}">${body}</svg>`

/** A rect rounded at the top only (the data end), square on the baseline. */
function topRounded(x: number, y: number, w: number, h: number, fill: string, r: number) {
  if (h <= 0) return ''
  r = Math.min(r, w / 2, h)
  if (r <= 0) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`
  return `<path d="M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z" fill="${fill}"/>`
}

/** A line of small grey text (the app's text can't be resized; an image can). */
export function smallText(text: string, size = 10): string {
  const w = Math.ceil(text.length * size * 0.56) + 4
  const h = Math.ceil(size * 1.4)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><text x="0" y="${size}" style="font:${size}px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#8b8a85">${esc(text)}</text></svg>`
}

/** A donut: `used` of `total`, the rest a faint track; past `total` the overrun wraps in `over`. */
export function donut(used: number, total: number, color: string, over: string, size = 120): string {
  const r = size / 2 - 9
  const c = 2 * Math.PI * r
  const frac = total > 0 ? used / total : 0
  const main = Math.min(1, frac)
  const extra = Math.max(0, Math.min(1, frac - 1))
  const arc = (f: number, stroke: string) =>
    f > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${stroke}" stroke-width="14" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" stroke-linecap="${f < 1 ? 'round' : 'butt'}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''
  const body =
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${TRACK}" stroke-width="14"/>` + arc(main, frac > 1 ? over : color) + arc(extra, over)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`
}

export type AreaArgs = {
  /** filled areas drawn in order; points are fractions (x across the window, y of the scale) */
  series: { color: string; points: [number, number][]; opacity?: number; line?: boolean; dashed?: boolean }[]
  /** a vertical marker at this x fraction (now) */
  marker?: number
  height?: number
}

/** Area chart: filled areas over a faint baseline; no text. */
export function area(a: AreaArgs): string {
  const H = a.height ?? 110
  const pad = 3
  const sx = (x: number) => Math.max(0, Math.min(1, x)) * W
  const sy = (y: number) => H - 1 - Math.max(0, Math.min(1, y)) * (H - pad - 1)
  let body = `<rect x="0" y="${H - 1}" width="${W}" height="1" fill="${TRACK}"/>`
  for (const s of a.series) {
    if (s.points.length < 2) continue
    const top = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('')
    const first = s.points[0] as [number, number]
    const last = s.points[s.points.length - 1] as [number, number]
    body += `<path d="${top}L${sx(last[0]).toFixed(1)},${H - 1}L${sx(first[0]).toFixed(1)},${H - 1}Z" fill="${s.color}" fill-opacity="${s.opacity ?? 0.35}"/>`
    if (s.line !== false) body += `<path d="${top}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"${s.dashed ? ' stroke-dasharray="5 5"' : ''}/>`
  }
  if (a.marker !== undefined) body += `<line x1="${sx(a.marker)}" x2="${sx(a.marker)}" y1="0" y2="${H - 1}" stroke="${RULE}" stroke-width="1" stroke-dasharray="2 3"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`
}

/** A hairline divider. */
export function rule(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 1" width="${W}" height="1"><rect x="0" y="0" width="${W}" height="1" fill="${TRACK}"/></svg>`
}

/** A thin rounded meter, as the app's usage page draws one. */
export function meter(pct: number, color: string): string {
  return segMeter([{ value: Math.max(0, Math.min(100, pct)), color }], 100)
}

/** A thin rounded meter split into segments (a total by model), scaled to `max`. */
export function segMeter(segments: { value: number; color: string }[], max: number): string {
  const H = 6
  let body = `<rect x="0" y="0" width="${W}" height="${H}" rx="${H / 2}" fill="${TRACK}"/>`
  const shown = segments.filter(s => s.value > 0)
  const total = shown.reduce((n, s) => n + s.value, 0)
  if (max > 0 && total > 0) {
    const full = Math.max(H, (W * Math.min(total, max)) / max)
    body += `<clipPath id="c"><rect x="0" y="0" width="${full}" height="${H}" rx="${H / 2}"/></clipPath><g clip-path="url(#c)">`
    let x = 0
    shown.forEach((s, i) => {
      const w = (full * s.value) / total
      body += `<rect x="${x}" y="0" width="${Math.max(0, w - (i < shown.length - 1 ? 2 : 0))}" height="${H}" fill="${s.color}"/>`
      x += w
    })
    body += '</g>'
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>`
}

export type BarsArgs = {
  /** per column, the stacked segment values in `colors` order */
  columns: number[][]
  colors: string[]
  /** hover text per column */
  titles?: string[]
  /** a dashed reference line at this value (a budget) */
  ref?: number
  /** columns drawn lighter (estimated values) */
  faded?: boolean[]
  height?: number
}

/** Column chart: thin rounded columns on a faint baseline; no text. */
export function bars(a: BarsArgs): string {
  const H = a.height ?? 72
  const n = a.columns.length
  const totals = a.columns.map(c => c.reduce((s, v) => s + v, 0))
  const max = Math.max(1e-9, ...totals, (a.ref ?? 0) * 1.15)
  const step = W / Math.max(1, n)
  const bw = Math.max(2, Math.min(28, step * 0.62))
  const top = 4
  const plotH = H - top - 1
  let body = `<rect x="0" y="${H - 1}" width="${W}" height="1" fill="${TRACK}"/>`
  a.columns.forEach((col, i) => {
    const x = i * step + (step - bw) / 2
    let y = H - 1
    const segs = col.map((v, k) => ({ v, c: a.colors[k] ?? RULE })).filter(s => s.v > 0)
    let g = ''
    segs.forEach((s, k) => {
      const h = (plotH * s.v) / max
      const isTop = k === segs.length - 1
      const gap = !isTop && h > 3 ? 1.5 : 0
      g += isTop ? topRounded(x, y - h, bw, h, s.c, 3) : `<rect x="${x}" y="${y - h + gap}" width="${bw}" height="${Math.max(0, h - gap)}" fill="${s.c}"/>`
      y -= h
    })
    if (totals[i] === 0) g += `<rect x="${x}" y="${H - 3}" width="${bw}" height="2" rx="1" fill="${TRACK}"/>`
    body += a.faded?.[i] ? `<g opacity=".45">${g}</g>` : g
  })
  if (a.ref !== undefined) {
    const y = H - 1 - (plotH * a.ref) / max
    body += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${RULE}" stroke-width="1.5" stroke-dasharray="4 4"/>`
  }
  return svg(H, body)
}

export type LineArgs = {
  /** points as fractions: x 0..1 across the window, y 0..1 of the scale */
  series: { color: string; points: [number, number][]; dashed?: boolean; title?: string }[]
  /** horizontal guides at these fractions */
  refs?: { y: number; color: string }[]
  height?: number
}

/** Line chart: 2px lines, an end dot, faint guides; no text. */
export function line(a: LineArgs): string {
  const H = a.height ?? 90
  const pad = 5
  const sx = (x: number) => pad + Math.max(0, Math.min(1, x)) * (W - pad * 2)
  const sy = (y: number) => H - pad - Math.max(0, Math.min(1, y)) * (H - pad * 2)
  let body = `<rect x="0" y="${H - 1}" width="${W}" height="1" fill="${TRACK}"/>`
  for (const r of a.refs ?? []) body += `<line x1="0" x2="${W}" y1="${sy(r.y)}" y2="${sy(r.y)}" stroke="${r.color}" stroke-opacity=".6" stroke-width="1" stroke-dasharray="2 4"/>`
  for (const s of a.series) {
    if (!s.points.length) continue
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('')
    body += `<path d="${d}" fill="none" stroke="${s.dashed ? RULE : s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="5 5"' : ''}/>`
    if (!s.dashed) {
      const [lx, ly] = s.points[s.points.length - 1] as [number, number]
      body += `<circle cx="${sx(lx)}" cy="${sy(ly)}" r="4" fill="${s.color}">${s.title ? `<title>${esc(s.title)}</title>` : ''}</circle>`
    }
  }
  return svg(H, body)
}

const HEAT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95']

/**
 * Weekday × hour heat map as one image. Its few labels are mid-grey, which
 * reads on light and dark alike; the image itself has no background.
 */
export function heatmap(grid: number[][]): string {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const left = 34
  const cw = (W - left) / 24
  const ch = 16
  const gap = 3
  const H = 7 * (ch + gap) + 16
  const max = Math.max(0, ...grid.flat())
  let body = ''
  grid.forEach((row, d) => {
    const y = d * (ch + gap)
    body += `<text x="0" y="${y + 12}">${days[d]}</text>`
    row.forEach((v, h) => {
      const fill = v <= 0 || max <= 0 ? TRACK : (HEAT[Math.min(HEAT.length - 1, Math.floor(Math.sqrt(v / max) * HEAT.length * 0.999))] as string)
      body += `<rect x="${left + h * cw + 1.5}" y="${y}" width="${cw - 3}" height="${ch}" rx="3" fill="${fill}"/>`
    })
  })
  for (const h of [0, 6, 12, 18, 23]) body += `<text x="${left + h * cw + cw / 2}" y="${H - 2}" text-anchor="middle">${String(h).padStart(2, '0')}:00</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><style>text{font:11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#8b8a85}</style>${body}</svg>`
}

/** Unicode bar for the terminal surface. */
export function textBar(pct: number, width = 20): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function sparkline(values: number[]): string {
  const ticks = '▁▂▃▄▅▆▇█'
  const max = Math.max(1, ...values)
  return values.map(v => (v <= 0 ? ' ' : ticks[Math.min(7, Math.floor((v / max) * 7.999))])).join('')
}
