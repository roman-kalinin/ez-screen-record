import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import type { Cut } from './model';
import { fmtLength, fmtTick, fmtTime, niceStep } from './model';
import { drawCover, type FrameGrabber } from './frameGrabber';
import { ed } from './theme';

const MIN_SPAN = 0.25;
const TRACK_H = 60;

const useStyles = makeStyles({
  root: {
    position: 'relative',
    padding: '6px 16px 14px',
    userSelect: 'none',
  },
  lane: { position: 'relative' },
  ruler: { position: 'relative', height: '22px' },
  tick: {
    position: 'absolute',
    bottom: '4px',
    transform: 'translateX(-50%)',
    fontSize: '11px',
    lineHeight: '14px',
    color: ed.ink3,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
  tickMark: {
    position: 'absolute',
    bottom: 0,
    width: '1px',
    height: '3px',
    background: 'rgba(255,244,230,0.16)',
    pointerEvents: 'none',
  },
  track: {
    position: 'relative',
    height: `${TRACK_H}px`,
    borderRadius: '8px',
    overflow: 'hidden',
    background: ed.well,
    boxShadow: `inset 0 0 0 1px ${ed.hairline}`,
    cursor: 'pointer',
    touchAction: 'none',
  },
  film: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    opacity: 0.5,
    filter: 'saturate(0.55)',
    pointerEvents: 'none',
  },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    background: ed.cut,
    backgroundImage:
      'repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 6px, transparent 6px 12px)',
    boxShadow: `inset 1px 0 0 ${ed.cutEdge}, inset -1px 0 0 ${ed.cutEdge}`,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    ':hover': { background: ed.cutHover },
  },
  bandSelected: {
    background: ed.cutHover,
    boxShadow: `inset 0 0 0 2px ${ed.cutEdge}`,
  },
  bandLabel: {
    marginBottom: '5px',
    padding: '1px 6px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: '15px',
    color: '#fff',
    background: 'rgba(20,10,8,0.55)',
    fontVariantNumeric: 'tabular-nums',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  },
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '12px',
    cursor: 'ew-resize',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    '::after': {
      content: '""',
      width: '4px',
      height: '22px',
      borderRadius: '999px',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
    },
  },
  handleL: { left: '-6px' },
  handleR: { right: '-6px' },
  pending: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '2px',
    marginLeft: '-1px',
    background: ed.pending,
    pointerEvents: 'none',
  },
  pendingFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    background: 'rgba(230,180,80,0.14)',
    pointerEvents: 'none',
  },
  hoverLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '1px',
    background: 'rgba(255,255,255,0.35)',
    pointerEvents: 'none',
  },
  playhead: {
    position: 'absolute',
    top: '14px',
    bottom: 0,
    width: '2px',
    marginLeft: '-1px',
    background: ed.ink1,
    pointerEvents: 'none',
    '::before': {
      content: '""',
      position: 'absolute',
      top: '-2px',
      left: '-4px',
      width: '10px',
      height: '10px',
      borderRadius: '3px',
      background: ed.ink1,
    },
  },
  thumb: {
    position: 'absolute',
    bottom: `calc(100% + 10px)`,
    padding: '4px',
    borderRadius: '10px',
    background: '#1f1d1b',
    border: `1px solid ${ed.hairlineStrong}`,
    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
    pointerEvents: 'none',
    zIndex: 5,
  },
  thumbCanvas: { display: 'block', borderRadius: '6px', background: ed.well },
  thumbTime: {
    textAlign: 'center',
    paddingTop: '4px',
    fontSize: '11px',
    color: ed.ink2,
    fontVariantNumeric: 'tabular-nums',
  },
});

export interface TimelineProps {
  duration: number;
  time: number;
  cuts: Cut[];
  selectedId: number | null;
  pendingStart: number | null;
  view: [number, number] | null;
  onView: (v: [number, number] | null) => void;
  /** final=true on pointer release: the parent does an exact seek. */
  onSeek: (t: number, final: boolean) => void;
  onScrubbing: (active: boolean) => void;
  onSelect: (id: number | null) => void;
  onResizeStart: (id: number) => void;
  onResize: (id: number, side: 'start' | 'end', t: number) => void;
  onResizeEnd: () => void;
  grabber: FrameGrabber | null;
  aspect: number;
}

export function Timeline(p: TimelineProps) {
  const s = useStyles();
  const trackRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLCanvasElement>(null);
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const scrubRef = useRef(false);
  const resizeRef = useRef<{ id: number; side: 'start' | 'end' } | null>(null);
  const [dragging, setDragging] = useState(false);

  const lo = p.view ? p.view[0] : 0;
  const span = p.view ? p.view[1] - p.view[0] : p.duration;
  const pct = (t: number) => (span > 0 ? ((t - lo) / span) * 100 : 0);

  // Track width drives the filmstrip tile count.
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const timeAt = useCallback(
    (clientX: number) => {
      const r = trackRef.current!.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return lo + ratio * span;
    },
    [lo, span],
  );

  // --- Filmstrip ------------------------------------------------------------
  const cacheRef = useRef(new Map<string, HTMLCanvasElement>());
  useEffect(() => {
    cacheRef.current.clear();
  }, [p.grabber]);
  useEffect(() => {
    const canvas = filmRef.current;
    const g = p.grabber;
    if (!canvas || !g || !width || !p.duration || span <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const tileW = Math.max(40, Math.round(TRACK_H * (p.aspect || 16 / 9)));
    const n = Math.max(1, Math.ceil(width / tileW));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(TRACK_H * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = ed.well;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Quantise so small view changes reuse cached frames.
    const q = Math.max(0.05, span / n / 2);
    let cancelled = false;
    g.clearQueue();
    for (let i = 0; i < n; i++) {
      const t = Math.min(p.duration - 0.01, Math.round((lo + (i + 0.5) * (span / n)) / q) * q);
      const key = t.toFixed(2);
      const x = Math.round(i * tileW * dpr);
      const w = Math.round(tileW * dpr);
      const h = canvas.height;
      const paint = (src: CanvasImageSource) => {
        if (!cancelled) ctx.drawImage(src, x, 0, w - Math.round(dpr), h);
      };
      const hit = cacheRef.current.get(key);
      if (hit) {
        paint(hit);
        continue;
      }
      g.enqueue(t, (v) => {
        const tile = document.createElement('canvas');
        tile.width = w;
        tile.height = h;
        const tctx = tile.getContext('2d');
        if (!tctx) return;
        drawCover(tctx, v, 0, 0, w, h);
        cacheRef.current.set(key, tile);
        paint(tile);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [p.grabber, width, lo, span, p.duration, p.aspect]);

  // --- Hover preview --------------------------------------------------------
  const thumbW = 184;
  const thumbH = Math.round(thumbW / (p.aspect || 16 / 9));
  useEffect(() => {
    if (!hover || !p.grabber) return;
    const id = window.setTimeout(() => {
      p.grabber?.hover(hover.t, (v) => {
        const c = thumbRef.current;
        if (!c) return;
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== thumbW * dpr) {
          c.width = thumbW * dpr;
          c.height = thumbH * dpr;
        }
        const ctx = c.getContext('2d');
        if (ctx) drawCover(ctx, v, 0, 0, c.width, c.height);
      });
    }, 30);
    return () => window.clearTimeout(id);
  }, [hover, p.grabber, thumbH]);

  // --- Pointer handling -----------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!p.duration || e.button !== 0) return;
    p.onSelect(null);
    scrubRef.current = true;
    setDragging(true);
    trackRef.current?.setPointerCapture(e.pointerId);
    p.onScrubbing(true);
    p.onSeek(timeAt(e.clientX), false);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!p.duration) return;
    const t = timeAt(e.clientX);
    if (resizeRef.current) {
      p.onResize(resizeRef.current.id, resizeRef.current.side, t);
      return;
    }
    if (scrubRef.current) {
      p.onSeek(t, false);
      return;
    }
    const r = trackRef.current!.getBoundingClientRect();
    setHover({ x: e.clientX - r.left, t });
  };
  const endDrag = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      resizeRef.current = null;
      setDragging(false);
      p.onResizeEnd();
    } else if (scrubRef.current) {
      scrubRef.current = false;
      setDragging(false);
      p.onScrubbing(false);
      p.onSeek(timeAt(e.clientX), true);
    }
    try {
      trackRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };
  const startResize = (e: React.PointerEvent, id: number, side: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { id, side };
    setDragging(true);
    setHover(null);
    trackRef.current?.setPointerCapture(e.pointerId);
    p.onResizeStart(id);
  };

  // Wheel: zoom toward the time under the cursor (non-passive to block scroll).
  const viewRef = useRef({ lo, span, duration: p.duration, onView: p.onView });
  viewRef.current = { lo, span, duration: p.duration, onView: p.onView };
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { lo: l, span: sp, duration: d, onView } = viewRef.current;
      if (!d) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const anchor = l + frac * sp;
      const next = Math.max(Math.min(MIN_SPAN, d), Math.min(d, sp * (e.deltaY < 0 ? 0.8 : 1.25)));
      if (next >= d - 1e-6) {
        onView(null);
        return;
      }
      const ns = Math.max(0, Math.min(anchor - frac * next, d - next));
      onView([ns, ns + next]);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- Ruler ----------------------------------------------------------------
  const ticks = useMemo(() => {
    if (!p.duration || span <= 0) return [];
    const step = niceStep(span);
    const out: Array<{ t: number; label: string }> = [];
    for (let t = Math.ceil(lo / step) * step; t <= lo + span + 1e-6; t += step) {
      out.push({ t, label: fmtTick(t, step) });
    }
    return out;
  }, [lo, span, p.duration]);

  const hi = lo + span;
  const playPct = pct(p.time);
  const showThumb = hover && !dragging && p.grabber;
  const rootW = rootRef.current?.clientWidth ?? 0;
  const thumbLeft = hover
    ? Math.max(8, Math.min(rootW - thumbW - 16, hover.x + 16 - thumbW / 2 - 4))
    : 0;

  return (
    <div ref={rootRef} className={s.root}>

      {showThumb && (
        <div className={s.thumb} style={{ left: thumbLeft }}>
          <canvas ref={thumbRef} className={s.thumbCanvas} style={{ width: thumbW, height: thumbH }} />
          <div className={s.thumbTime}>{fmtTime(hover.t)}</div>
        </div>
      )}

      <div className={s.lane}>
        <div className={s.ruler}>
          {ticks.map(({ t, label }) => {
            const x = pct(t);
            if (x < 0 || x > 100) return null;
            return (
              <React.Fragment key={t.toFixed(3)}>
                <div className={s.tick} style={{ left: `clamp(14px, ${x}%, calc(100% - 14px))` }}>
                  {label}
                </div>
                <div className={s.tickMark} style={{ left: `${x}%` }} />
              </React.Fragment>
            );
          })}
        </div>

        <div
          ref={trackRef}
          className={s.track}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => setHover(null)}
        >
          <canvas ref={filmRef} className={s.film} />

          {p.pendingStart != null && (
            <>
              <div
                className={s.pendingFill}
                style={{
                  left: `${Math.max(0, pct(Math.min(p.pendingStart, p.time)))}%`,
                  width: `${Math.max(0, Math.min(100, pct(Math.max(p.pendingStart, p.time))) - Math.max(0, pct(Math.min(p.pendingStart, p.time))))}%`,
                }}
              />
              {pct(p.pendingStart) >= 0 && pct(p.pendingStart) <= 100 && (
                <div className={s.pending} style={{ left: `${pct(p.pendingStart)}%` }} />
              )}
            </>
          )}

          {p.cuts.map((c) => {
            if (c.end <= lo || c.start >= hi) return null;
            const l = pct(c.start);
            const r = pct(c.end);
            const left = Math.max(0, l);
            const w = Math.min(100, r) - left;
            const selected = c.id === p.selectedId;
            return (
              <div
                key={c.id}
                className={mergeClasses(s.band, selected && s.bandSelected)}
                style={{ left: `${left}%`, width: `${w}%` }}
                title={`Cut ${fmtTime(c.start)} – ${fmtTime(c.end)}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  p.onSelect(c.id);
                }}
              >
                {(w / 100) * width > 46 && <span className={s.bandLabel}>−{fmtLength(c.end - c.start)}</span>}
                {selected && l >= 0 && (
                  <div className={mergeClasses(s.handle, s.handleL)} onPointerDown={(e) => startResize(e, c.id, 'start')} />
                )}
                {selected && r <= 100 && (
                  <div className={mergeClasses(s.handle, s.handleR)} onPointerDown={(e) => startResize(e, c.id, 'end')} />
                )}
              </div>
            );
          })}

          {hover && !dragging && <div className={s.hoverLine} style={{ left: hover.x }} />}
        </div>

        {p.duration > 0 && playPct >= 0 && playPct <= 100 && (
          <div className={s.playhead} style={{ left: `${playPct}%` }} />
        )}
      </div>
    </div>
  );
}
