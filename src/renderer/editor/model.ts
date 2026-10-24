/** Pure editing model: cuts, keep ranges, time formatting. No React here. */

export interface Cut {
  id: number;
  start: number;
  end: number;
}

let nextId = 1;
export function makeCut(start: number, end: number): Cut {
  return { id: nextId++, start: Math.min(start, end), end: Math.max(start, end) };
}

/** Cuts sorted and merged where they touch or overlap. */
export function mergedCuts(cuts: Cut[]): Array<[number, number]> {
  const sorted = cuts.map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The complement of the cuts: what the export keeps. */
export function keepRanges(cuts: Cut[], duration: number): Array<[number, number]> {
  if (!duration) return [];
  const keep: Array<[number, number]> = [];
  let cursor = 0;
  for (const [s, e] of mergedCuts(cuts)) {
    if (s > cursor) keep.push([cursor, Math.min(s, duration)]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration) keep.push([cursor, duration]);
  return keep.filter(([s, e]) => e - s > 0.02);
}

export function keptDuration(cuts: Cut[], duration: number): number {
  return keepRanges(cuts, duration).reduce((a, [s, e]) => a + (e - s), 0);
}

/**
 * Where playback should resume if `t` is inside a cut (chained through
 * touching cuts), else null. Half-open at the end so landing exactly on a
 * cut's end does not re-trigger.
 */
export function skipTarget(cuts: Cut[], t: number): number | null {
  for (const [s, e] of mergedCuts(cuts)) {
    if (t >= s && t < e) return e;
  }
  return null;
}

/** 0:07.25 · 12:03.50 · 1:02:03.5 — tabular, centiseconds when short. */
export function fmtTime(sec: number, precise = true): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = precise ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Human length: "4.2s", "1m 03s". */
export function fmtLength(sec: number): string {
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** A "nice" ruler step giving ~6-9 ticks across `span` seconds. */
export function niceStep(span: number): number {
  const target = span / 7;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  return steps.find((s) => s >= target) ?? 3600;
}

export function fmtTick(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`;
}

export const SPEEDS = [0.5, 1, 1.5, 2, 4] as const;
