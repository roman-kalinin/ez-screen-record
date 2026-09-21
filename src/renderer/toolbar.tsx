import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FluentProvider,
  makeStyles,
  tokens,
  Text,
  Tooltip,
  Spinner,
} from '@fluentui/react-components';
import {
  // FILLED transport icons, deliberately.
  //
  // The Regular variants are a thin outline that all but disappears on this
  // dark bar sitting over arbitrary desktop content. Stop/Pause/Play are the
  // controls that must be readable mid-take at a glance, so they use the
  // solid forms; the secondary controls stay Regular so the primaries lead.
  StopFilled,
  PauseFilled,
  PlayFilled,
  InkStrokeRegular,
  MicRegular,
  MicOffRegular,
  VideoRegular,
  VideoOffRegular,
  DesktopRegular,
  ReOrderDotsVerticalRegular,
  ChevronRightRegular,
  ChevronLeftRegular,
} from '@fluentui/react-icons';
import { PillControl } from './components/PillControl';
import { buildTheme, DEFAULT_ACCENT } from './theme';
import type { MediaDevice, RecordingState } from '../shared/types';

/**
 * The recording toolbar (the Zoom screen-share bar).
 *
 * It lives in its own window that spans the whole display, transparent except
 * for the bar. That matters: the first attempt shrank the control window to a
 * 68px strip, and every dropdown, tooltip and picker opened INSIDE it and was
 * clipped, because a BrowserWindow cannot draw outside its own bounds. With a
 * full-size window the menus have somewhere to go.
 *
 * The window is click-through everywhere; only the bar opts back in, so the
 * rest of the desktop stays usable while recording.
 */

declare global {
  interface Window {
    ez: import('../preload/preload').EzApi;
  }
}

const useStyles = makeStyles({
  root: {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'none',
  },
  bar: {
    position: 'absolute',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px 8px 6px',
    borderRadius: '32px',
    background: 'rgba(28,28,32,0.97)',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
    // Only the bar takes input; the surrounding window stays click-through.
    pointerEvents: 'auto',
  },
  recDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#ff3b30',
    flexShrink: 0,
    // Pulse while live. A steady dot and a paused dot look the same at a
    // glance, and this bar is glanced at, not read.
    animationName: {
      '0%, 100%': { opacity: 1 },
      '50%': { opacity: 0.35 },
    },
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
  },
  /** Amber and still: held, not recording, and not hung. */
  recDotPaused: {
    background: '#ffb020',
    animationName: 'none',
  },
  pausedBadge: {
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '0.4px',
    color: '#ffb020',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  /** The timer dims while held so a frozen clock reads as intentional. */
  timerPaused: {
    color: '#ffb020',
  },
  /** Amber fill on the pause button itself — the control states its own mode. */
  roundBtnPaused: {
    background: 'rgba(255,176,32,0.22)',
    color: '#ffb020',
    ':hover': { background: 'rgba(255,176,32,0.32)' },
  },
  /**
   * Drag grip. The bar cannot use `-webkit-app-region: drag` — this window
   * spans the whole display, so dragging it would move the window, not the
   * bar, and the bar's position within it would never change. The grip
   * repositions the bar inside the window instead.
   */
  grip: {
    display: 'grid',
    placeItems: 'center',
    width: '18px',
    height: '32px',
    flexShrink: 0,
    cursor: 'grab',
    color: 'rgba(255,255,255,0.45)',
    ':hover': { color: 'rgba(255,255,255,0.85)' },
  },
  gripDragging: { cursor: 'grabbing' },
  roundBtn: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255,255,255,0.10)',
    color: '#fff',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    ':hover': { background: 'rgba(255,255,255,0.18)' },
  },
  roundBtnActive: {
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  stopBtn: {
    width: '58px',
    height: '40px',
    borderRadius: '20px',
    border: 'none',
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    color: '#fff',
    padding: 0,
    flexShrink: 0,
    background: tokens.colorPaletteRedBackground3,
    ':hover': { background: tokens.colorPaletteRedForeground1 },
  },
  timer: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: '18px',
    fontWeight: 600,
    letterSpacing: '0.5px',
    color: '#fff',
    minWidth: '58px',
    textAlign: 'center',
    // "Starting…" is wider than a timestamp and must not be clipped.
    whiteSpace: 'nowrap',
  },
  divider: {
    width: '1px',
    height: '26px',
    background: 'rgba(255,255,255,0.16)',
    flexShrink: 0,
  },
  /**
   * The expand/collapse handle. Slim and low-contrast so it reads as chrome,
   * not another control competing with pause/stop.
   */
  expander: {
    display: 'grid',
    placeItems: 'center',
    width: '22px',
    height: '32px',
    border: 'none',
    background: 'transparent',
    color: 'rgba(255,255,255,0.55)',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    borderRadius: '8px',
    ':hover': { color: '#fff', background: 'rgba(255,255,255,0.10)' },
  },
});

function formatTime(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Everything the toolbar needs, pushed from the control window. */
interface ToolbarState {
  state: RecordingState;
  drawing: boolean;
  micEnabled: boolean;
  micDeviceId: string | null;
  mics: MediaDevice[];
  cameraEnabled: boolean;
  cameraDeviceId: string | null;
  cams: MediaDevice[];
  sourceName: string;
  /**
   * Whether the engine recording this take can pause at all. The ffmpeg path
   * needs the concat demuxer to rejoin the segments a pause creates; without
   * it the button is hidden rather than offered and then failing.
   */
  canPause?: boolean;
}

function Toolbar() {
  const s = useStyles();
  const [st, setSt] = useState<ToolbarState | null>(null);
  const [seconds, setSeconds] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  /** Bar position within the full-screen window. null = default (top centre). */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  /**
   * The bar starts collapsed to a minimal strip — rec dot, timer, pause, stop —
   * so it sits lightly over the user's content. Hover or the chevron expands it
   * to reveal the mic/camera/source/draw controls; it re-collapses ~2s after
   * the pointer leaves, unless a menu it opened is still up.
   */
  const [collapsed, setCollapsed] = useState(true);
  const collapseTimer = useRef<number | null>(null);

  const cancelCollapse = useCallback(() => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, []);

  /** Arm the idle re-collapse. A no-op while a menu/tooltip holds it open. */
  const scheduleCollapse = useCallback(() => {
    cancelCollapse();
    collapseTimer.current = window.setTimeout(() => setCollapsed(true), 2000);
  }, [cancelCollapse]);

  const expand = useCallback(() => {
    cancelCollapse();
    setCollapsed(false);
  }, [cancelCollapse]);

  const onGripDown = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return;
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onGripMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const bar = barRef.current;
    if (!drag || !bar) return;
    const r = bar.getBoundingClientRect();
    // Keep the bar fully on screen; it is the only way to stop a take.
    const x = Math.min(Math.max(e.clientX - drag.dx, 0), window.innerWidth - r.width);
    const y = Math.min(Math.max(e.clientY - drag.dy, 0), window.innerHeight - r.height);
    setPos({ x, y });
  };

  const onGripUp = () => {
    dragRef.current = null;
    setDragging(false);
  };

  // State and clock arrive separately so the once-a-second tick does not carry
  // the device lists with it — see the note in App.tsx.
  useEffect(() => window.ez.on('toolbar:state', (next: ToolbarState) => setSt(next)), []);

  // Ask for the current state on mount. The control window only pushes when
  // something changes, so a toolbar that came up after the last push would sit
  // there rendering nothing — with no way to stop the recording.
  useEffect(() => {
    void window.ez.control.send('toolbar:requestState');
  }, []);
  useEffect(
    () => window.ez.on('toolbar:elapsed', (seconds: number) => setSeconds(seconds)),
    [],
  );

  /**
   * Grant input while the pointer is over the bar OR any popup it opened.
   *
   * Menus render in a portal outside the bar's DOM subtree, so a plain
   * enter/leave on the bar would revoke input the moment the pointer moved
   * onto a dropdown — making every menu unclickable. Hit-testing the whole
   * document at the pointer instead covers both.
   */
  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      // Fluent renders menus and tooltips into a portal at the document root, so
      // `[data-ui]` alone would miss them. Anything that is not the transparent
      // backdrop counts as UI.
      const overUi = Boolean(
        el && (el.closest('[data-ui]') || el.closest('[data-portal]') ||
               el.closest('.fui-MenuPopover') || el.closest('.fui-Tooltip')),
      );
      void window.ez.toolbar.setInteractive(overUi);

      // Hover expands; leaving arms the idle re-collapse. Reuses the same
      // hit-test so hovering a dropdown the bar opened keeps it expanded.
      if (overUi) expand();
      else scheduleCollapse();
    },
    [expand, scheduleCollapse],
  );

  useEffect(() => {
    window.addEventListener('mousemove', onMouseMove);
    return () => window.removeEventListener('mousemove', onMouseMove);
  }, [onMouseMove]);

  // While a menu is open the pointer may leave the bar entirely; keep input
  // granted until it closes, or the menu cannot be used. Also hold the bar
  // expanded for the menu's lifetime, and re-arm the collapse once it closes.
  const holdInteractive = useCallback(
    (open: boolean) => {
      if (open) {
        void window.ez.toolbar.setInteractive(true);
        expand();
      } else {
        scheduleCollapse();
      }
    },
    [expand, scheduleCollapse],
  );

  // Clear a pending collapse timer if the component goes away mid-countdown.
  useEffect(() => cancelCollapse, [cancelCollapse]);

  if (!st) return null;

  const send = (channel: string, payload?: unknown) =>
    void window.ez.control.send(channel, payload);

  // `pausing`/`resuming` are the in-between states of an ffmpeg take. They
  // read as held so the bar responds on the click rather than on completion.
  const transitioning = st.state === 'pausing' || st.state === 'resuming';
  const paused = st.state === 'paused' || transitioning;
  const heldLabel =
    st.state === 'pausing' ? 'Pausing…' : st.state === 'resuming' ? 'Resuming…' : 'Paused';

  // Finalising the file: MediaRecorder flushes, the blob is written, then
  // ffmpeg remuxes. On a long take that is seconds of real work, and a bar
  // still showing a running clock and a live stop button read as a hang.
  const saving = st.state === 'saving';

  return (
    <div className={s.root}>
      <div
        className={s.bar}
        ref={barRef}
        data-ui
        style={
          pos
            ? { left: `${pos.x}px`, top: `${pos.y}px` }
            : // Default: top centre, like Zoom's share bar.
              { left: '50%', top: '14px', transform: 'translateX(-50%)' }
        }
      >
        <Tooltip content="Drag to move" relationship="label" withArrow>
          <div
            className={`${s.grip} ${dragging ? s.gripDragging : ''}`}
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
          >
            <ReOrderDotsVerticalRegular fontSize={18} />
          </div>
        </Tooltip>

        <div className={`${s.recDot} ${paused ? s.recDotPaused : ''}`} />
        {paused && <Text className={s.pausedBadge}>{heldLabel}</Text>}

        {/*
          Secondary controls. Hidden while collapsed so the bar is just the
          essentials (rec dot, timer, pause, stop). Saving is terminal — there
          is nothing left to configure — so they stay hidden then regardless.
        */}
        {!collapsed && !saving && (
          <>
            <PillControl
              label="Microphone"
              onIcon={<MicRegular />}
              offIcon={<MicOffRegular />}
              enabled={st.micEnabled}
              onToggle={(v) => send('toolbar:setMicEnabled', v)}
              options={st.mics.map((m) => ({ id: m.deviceId, label: m.label }))}
              selectedId={st.micDeviceId}
              onSelect={(id) => send('toolbar:setMicDevice', id)}
            />

            <PillControl
              label="Camera"
              onIcon={<VideoRegular />}
              offIcon={<VideoOffRegular />}
              enabled={st.cameraEnabled}
              onToggle={(v) => send('toolbar:setCameraEnabled', v)}
              options={st.cams.map((c) => ({ id: c.deviceId, label: c.label }))}
              selectedId={st.cameraDeviceId}
              onSelect={(id) => send('toolbar:setCameraDevice', id)}
            />

            <Tooltip
              content={st.sourceName ? `Recording: ${st.sourceName}` : 'Change source'}
              relationship="label"
              withArrow
              onVisibleChange={(_e, d) => holdInteractive(d.visible)}
            >
              <button className={s.roundBtn} onClick={() => send('toolbar:pickSource')}>
                <DesktopRegular fontSize={20} />
              </button>
            </Tooltip>

            <Tooltip
              content="Draw on screen (Ctrl+Shift+D)"
              relationship="label"
              withArrow
              onVisibleChange={(_e, d) => holdInteractive(d.visible)}
            >
              <button
                className={`${s.roundBtn} ${st.drawing ? s.roundBtnActive : ''}`}
                onClick={() => send('toolbar:toggleDraw')}
              >
                <InkStrokeRegular fontSize={20} />
              </button>
            </Tooltip>
          </>
        )}

        <div className={s.divider} />

        {st.state === 'starting' ? (
          <Text className={`${s.timer} ${s.timerPaused}`}>Starting…</Text>
        ) : saving ? (
          <Text className={`${s.timer} ${s.timerPaused}`}>Saving…</Text>
        ) : (
          <Text className={`${s.timer} ${paused ? s.timerPaused : ''}`}>{formatTime(seconds)}</Text>
        )}

        {/* Pause is meaningless once the take has ended. */}
        {st.canPause !== false && !saving && (
          <Tooltip
            content={transitioning ? heldLabel : paused ? 'Resume' : 'Pause'}
            relationship="label"
            withArrow
            onVisibleChange={(_e, d) => holdInteractive(d.visible)}
          >
            <button
              className={`${s.roundBtn} ${paused ? s.roundBtnPaused : ''}`}
              onClick={() => send('toolbar:togglePause')}
              disabled={transitioning}
              aria-label={paused ? 'Resume recording' : 'Pause recording'}
              aria-pressed={paused}
              aria-busy={transitioning}
            >
              {paused ? <PlayFilled fontSize={20} /> : <PauseFilled fontSize={20} />}
            </button>
          </Tooltip>
        )}

        <Tooltip
          content={saving ? 'Saving the recording…' : 'Stop recording (Ctrl+Shift+F9)'}
          relationship="label"
          withArrow
          onVisibleChange={(_e, d) => holdInteractive(d.visible)}
        >
          <button
            className={s.stopBtn}
            onClick={() => send('toolbar:stop')}
            // A second stop while the first is still finalising would run the
            // whole teardown twice.
            disabled={saving}
            aria-label={saving ? 'Saving the recording' : 'Stop recording'}
            aria-busy={saving}
          >
            {saving ? <Spinner size="tiny" /> : <StopFilled fontSize={22} />}
          </button>
        </Tooltip>

        {/*
          Expand/collapse handle, kept at the trailing edge so it never shifts
          the primary controls. Hidden while saving — nothing left to reveal.
          Hover already expands via onMouseMove; this is the explicit toggle.
        */}
        {!saving && (
          <Tooltip
            content={collapsed ? 'Show controls' : 'Hide controls'}
            relationship="label"
            withArrow
          >
            <button
              className={s.expander}
              onClick={() => (collapsed ? expand() : setCollapsed(true))}
              aria-label={collapsed ? 'Show controls' : 'Hide controls'}
              aria-expanded={!collapsed}
            >
              {collapsed ? (
                <ChevronRightRegular fontSize={16} />
              ) : (
                <ChevronLeftRegular fontSize={16} />
              )}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/**
 * The bar is always dark regardless of the system theme — it sits over the
 * user's own content, and a light strip there is glaring.
 */
function Root() {
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  useEffect(() => {
    window.ez.appearance().then((a) => setAccent(a.accent));
  }, []);
  return (
    <FluentProvider theme={buildTheme(accent, true)}>
      <Toolbar />
    </FluentProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
