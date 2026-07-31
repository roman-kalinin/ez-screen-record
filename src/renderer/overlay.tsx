import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DrawTool } from '../shared/types';
import './styles/overlay.css';

declare global {
  interface Window {
    ez: import('../preload/preload').EzApi;
  }
}

interface Stroke {
  tool: DrawTool;
  color: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000'];
const TOOLS: Array<{ id: DrawTool; label: string; glyph: string }> = [
  { id: 'pen', label: 'Pen (P)', glyph: '✏️' },
  { id: 'highlighter', label: 'Highlighter (H)', glyph: '🖍️' },
  { id: 'arrow', label: 'Arrow (A)', glyph: '↗' },
  { id: 'rect', label: 'Rectangle (R)', glyph: '▭' },
  { id: 'ellipse', label: 'Ellipse (O)', glyph: '◯' },
  { id: 'eraser', label: 'Eraser (E)', glyph: '⌫' },
];

function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(false);
  const [tool, setTool] = useState<DrawTool>('pen');
  const [color, setColor] = useState('#ff3b30');
  const [width, setWidth] = useState(4);
  const [toolbarPos, setToolbarPos] = useState({ x: 24, y: 24 });

  // Committed strokes plus the one currently being drawn.
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);
  const drawingRef = useRef(false);
  const draggingToolbar = useRef<{ dx: number; dy: number } | null>(null);

  // Keep latest tool settings available inside stable event handlers.
  const settingsRef = useRef({ tool, color, width });
  settingsRef.current = { tool, color, width };

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    const ctx = canvas.getContext('2d');
    ctx?.scale(dpr, dpr);
    redraw();
  }, []);

  const drawStroke = (ctx: CanvasRenderingContext2D, s: Stroke) => {
    if (s.points.length === 0) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;

    if (s.tool === 'highlighter') {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = s.width * 4;
    }

    const first = s.points[0];
    const last = s.points[s.points.length - 1];

    if (s.tool === 'pen' || s.tool === 'highlighter') {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      // Quadratic smoothing through midpoints removes the polyline look.
      for (let i = 1; i < s.points.length - 1; i++) {
        const mid = {
          x: (s.points[i].x + s.points[i + 1].x) / 2,
          y: (s.points[i].y + s.points[i + 1].y) / 2,
        };
        ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, mid.x, mid.y);
      }
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    } else if (s.tool === 'rect') {
      ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
    } else if (s.tool === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(
        (first.x + last.x) / 2,
        (first.y + last.y) / 2,
        Math.abs(last.x - first.x) / 2,
        Math.abs(last.y - first.y) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    } else if (s.tool === 'arrow') {
      const head = Math.max(12, s.width * 3.5);
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      // Shorten the shaft so it doesn't poke through the arrowhead.
      const endX = last.x - Math.cos(angle) * head * 0.6;
      const endY = last.y - Math.sin(angle) * head * 0.6;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(
        last.x - head * Math.cos(angle - Math.PI / 6),
        last.y - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        last.x - head * Math.cos(angle + Math.PI / 6),
        last.y - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  };

  const redrawRafRef = useRef(0);

  /**
   * Repaint the whole canvas, coalesced to one paint per animation frame.
   *
   * Pointer events fire faster than the display refreshes (often 2-4x on a
   * high-polling-rate mouse), and each repaint walks every stroke. Painting
   * synchronously per event is what made drawing feel laggy; batching to a
   * frame keeps the stroke smooth no matter how dense the input.
   */
  const redraw = useCallback(() => {
    if (redrawRafRef.current) return;
    redrawRafRef.current = requestAnimationFrame(() => {
      redrawRafRef.current = 0;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of strokesRef.current) drawStroke(ctx, s);
      if (currentRef.current) drawStroke(ctx, currentRef.current);
    });
  }, []);

  /** Erase any stroke whose path passes near the cursor. */
  const eraseAt = (x: number, y: number) => {
    const radius = 18;
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter(
      (s) => !s.points.some((p) => Math.hypot(p.x - x, p.y - y) < radius),
    );
    if (strokesRef.current.length !== before) redraw();
  };

  useEffect(() => {
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resize]);

  // Toggle whether the window swallows mouse events. When inactive the whole
  // desktop stays usable; when active we capture input for drawing.
  useEffect(() => {
    window.ez.overlay.setInteractive(active);
    // Focus on activate so key handlers (Esc, tool letters) actually fire —
    // the window is shown with showInactive() to avoid stealing focus.
    if (active) window.ez.overlay.focus();
  }, [active]);

  // Commands relayed from the control window.
  useEffect(() => {
    const offSet = window.ez.on('overlay:setActive', (v: boolean) => {
      // Entering draw mode always starts from a clean canvas — leftover
      // strokes from a previous session must never reappear.
      if (v) {
        strokesRef.current = [];
        currentRef.current = null;
        drawingRef.current = false;
        redraw();
      }
      setActive(v);
    });
    const offClear = window.ez.on('overlay:clear', () => {
      strokesRef.current = [];
      currentRef.current = null;
      redraw();
    });
    const offTool = window.ez.on('overlay:setTool', (t: DrawTool) => setTool(t));
    return () => {
      offSet();
      offClear();
      offTool();
    };
  }, [redraw]);

  // Keyboard shortcuts while the overlay has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      const map: Record<string, DrawTool> = {
        p: 'pen',
        h: 'highlighter',
        a: 'arrow',
        r: 'rect',
        o: 'ellipse',
        e: 'eraser',
      };
      const key = e.key.toLowerCase();
      if (map[key]) {
        setTool(map[key]);
      } else if (key === 'escape') {
        // Esc means "I'm done" — leave draw mode and wipe the canvas so the
        // next annotation starts clean and nothing lingers on the recording.
        strokesRef.current = [];
        currentRef.current = null;
        redraw();
        setActive(false);
        window.ez.overlay.hide();
        window.ez.control.send('control:drawModeChanged', false);
      } else if (key === 'z' && (e.ctrlKey || e.metaKey)) {
        strokesRef.current.pop();
        redraw();
      } else if (key === 'delete' || key === 'backspace') {
        strokesRef.current = [];
        redraw();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, redraw]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    const { tool: t, color: c, width: w } = settingsRef.current;
    if (t === 'eraser') {
      drawingRef.current = true;
      eraseAt(e.clientX, e.clientY);
      return;
    }
    drawingRef.current = true;
    currentRef.current = { tool: t, color: c, width: w, points: [{ x: e.clientX, y: e.clientY }] };
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || !drawingRef.current) return;
    if (settingsRef.current.tool === 'eraser') {
      eraseAt(e.clientX, e.clientY);
      return;
    }
    const cur = currentRef.current;
    if (!cur) return;
    if (cur.tool === 'pen' || cur.tool === 'highlighter') {
      // getCoalescedEvents returns the points the browser merged into this
      // one event, so fast strokes keep their detail instead of going angular.
      const native = e.nativeEvent as PointerEvent;
      const merged =
        typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      if (merged.length > 1) {
        for (const m of merged) cur.points.push({ x: m.clientX, y: m.clientY });
      } else {
        cur.points.push({ x: e.clientX, y: e.clientY });
      }
    } else {
      // Shapes only need an origin and the live cursor position.
      cur.points[1] = { x: e.clientX, y: e.clientY };
    }
    redraw();
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (currentRef.current && currentRef.current.points.length > 1) {
      strokesRef.current.push(currentRef.current);
    }
    currentRef.current = null;
    redraw();
  };

  // Toolbar dragging so it never blocks the thing being demonstrated.
  const onToolbarDown = (e: React.PointerEvent) => {
    draggingToolbar.current = { dx: e.clientX - toolbarPos.x, dy: e.clientY - toolbarPos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onToolbarMove = (e: React.PointerEvent) => {
    const d = draggingToolbar.current;
    if (!d) return;
    setToolbarPos({ x: e.clientX - d.dx, y: e.clientY - d.dy });
  };
  const onToolbarUp = () => {
    draggingToolbar.current = null;
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        className="overlay-canvas"
        style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />

      {active && (
        <div
          className="overlay-toolbar"
          style={{ left: toolbarPos.x, top: toolbarPos.y }}
          onPointerMove={onToolbarMove}
          onPointerUp={onToolbarUp}
        >
          <div className="drag-handle" onPointerDown={onToolbarDown} title="Drag toolbar">
            ⠿
          </div>

          <div className="tool-group">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tool-btn ${tool === t.id ? 'is-active' : ''}`}
                onClick={() => setTool(t.id)}
                title={t.label}
              >
                {t.glyph}
              </button>
            ))}
          </div>

          <div className="divider" />

          <div className="tool-group">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${color === c ? 'is-active' : ''}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title={c}
              />
            ))}
          </div>

          <div className="divider" />

          <input
            className="width-slider"
            type="range"
            min={2}
            max={24}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            title={`Thickness: ${width}px`}
          />

          <div className="divider" />

          <button
            className="tool-btn"
            title="Clear all (Del)"
            onClick={() => {
              strokesRef.current = [];
              redraw();
            }}
          >
            🗑
          </button>
          <button
            className="tool-btn close"
            title="Done — exit and clear (Esc)"
            onClick={() => {
              strokesRef.current = [];
              currentRef.current = null;
              redraw();
              setActive(false);
              window.ez.overlay.hide();
              window.ez.control.send('control:drawModeChanged', false);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Overlay />);
