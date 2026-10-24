import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  makeStyles,
  mergeClasses,
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItemRadio,
  Switch,
  Tooltip,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Spinner,
} from '@fluentui/react-components';
import {
  PlayFilled,
  PauseFilled,
  CutRegular,
  ArrowUndoRegular,
  ArrowRedoRegular,
  DeleteRegular,
  ArrowExportUpRegular,
  SubtractRegular,
  MaximizeRegular,
  DismissRegular,
  Speaker2Regular,
  SpeakerMuteRegular,
  KeyboardRegular,
  ZoomInRegular,
} from '@fluentui/react-icons';
import type { EditorSession } from '../../shared/types';
import { Timeline } from './Timeline';
import { ExportDialog } from './ExportDialog';
import { FrameGrabber } from './frameGrabber';
import { ed } from './theme';
import { SPEEDS, fmtLength, fmtTime, keepRanges, makeCut, mergedCuts, skipTarget, type Cut } from './model';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: ed.page,
    color: ed.ink1,
  },
  titlebar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    height: '52px',
    padding: '0 8px 0 20px',
    flexShrink: 0,
  },
  titleText: { display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0, flex: '1 1 auto' },
  fileName: {
    fontFamily: "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
    fontSize: '14px',
    fontWeight: 600,
    color: ed.ink1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileMeta: { fontSize: '12px', color: ed.ink3, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  winBtns: { display: 'flex', gap: '2px', marginLeft: '6px' },
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '4px 20px 16px',
  },
  stage: {
    position: 'relative',
    flex: '1 1 auto',
    minHeight: '160px',
    borderRadius: '12px',
    background: ed.well,
    border: `1px solid ${ed.hairline}`,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: { width: '100%', height: '100%', objectFit: 'contain', display: 'block', cursor: 'pointer' },
  stageMsg: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    alignItems: 'center',
    justifyContent: 'center',
    color: ed.ink3,
    fontSize: '13px',
    textAlign: 'center',
    padding: '24px',
  },
  panel: {
    position: 'relative',
    flexShrink: 0,
    borderRadius: '14px',
    background: ed.surface,
    border: `1px solid ${ed.hairline}`,
    paddingTop: '8px',
  },
  transport: {
    display: 'grid',
    gridTemplateColumns: '1fr auto 1fr',
    alignItems: 'center',
    gap: '12px',
    minHeight: '56px',
    padding: '6px 12px',
    borderTop: `1px dashed ${ed.hairlineStrong}`,
  },
  zoomChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '24px',
    padding: '0 4px 0 10px',
    borderRadius: '999px',
    background: ed.fillSoft,
    color: ed.ink2,
    fontVariantNumeric: 'tabular-nums',
  },
  statusRight: { display: 'flex', alignItems: 'center', gap: '8px' },
  group: { display: 'flex', alignItems: 'center', gap: '4px' },
  right: { justifySelf: 'end' },
  center: { display: 'flex', alignItems: 'center', gap: '14px' },
  playBtn: {
    width: '40px',
    height: '40px',
    minWidth: '40px',
    borderRadius: '999px',
    border: 'none',
    background: ed.ink1,
    color: '#141312',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transitionProperty: 'transform, background',
    transitionDuration: '120ms',
    ':hover': { background: '#ffffff' },
    ':active': { transform: 'scale(0.96)' },
    ':focus-visible': { outline: `2px solid ${ed.ink1}`, outlineOffset: '2px' },
  },
  time: { fontSize: '13px', fontVariantNumeric: 'tabular-nums', color: ed.ink1, minWidth: '150px' },
  timeDur: { color: ed.ink3 },
  markBtn: { fontWeight: 500 },
  markPending: {
    boxShadow: `inset 0 0 0 1px ${ed.pending}`,
    color: ed.pending,
    ':hover': { color: ed.pending },
  },
  kbd: {
    marginLeft: '6px',
    padding: '0 5px',
    borderRadius: '4px',
    fontSize: '11px',
    lineHeight: '16px',
    color: ed.ink3,
    background: ed.fillMed,
  },
  sep: { width: '1px', height: '18px', background: ed.hairlineStrong, margin: '0 6px' },
  speedBtn: { minWidth: '48px', fontVariantNumeric: 'tabular-nums' },
  skip: { fontSize: '13px', color: ed.ink2 },
  status: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    minHeight: '20px',
    fontSize: '12px',
    color: ed.ink3,
    padding: '0 2px',
  },
  statusStrong: { color: ed.ink2, fontVariantNumeric: 'tabular-nums' },
  shortcuts: {
    display: 'grid',
    gridTemplateColumns: 'auto auto',
    columnGap: '24px',
    rowGap: '7px',
    fontSize: '12px',
    color: ed.ink2,
    padding: '4px 2px',
  },
  shortcutKey: { color: ed.ink1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  popover: { padding: '14px 16px', borderRadius: '12px' },
  popTitle: { fontSize: '13px', fontWeight: 600, marginBottom: '10px' },
  confirm: { width: '400px', borderRadius: '14px', background: '#1c1a18', border: `1px solid ${ed.hairlineStrong}` },
});

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['C', 'Start cut, then end cut'],
  ['Esc', 'Cancel cut · deselect'],
  ['Delete', 'Remove selected cut'],
  ['← →', 'Step 0.1s (Shift: 1s)'],
  [', .', 'Step one frame'],
  ['[ ]  \\', 'Slower / faster / 1×'],
  ['M', 'Mute preview'],
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z', 'Redo'],
  ['Scroll', 'Zoom the timeline'],
];

function useLocalBool(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    const raw = localStorage.getItem(key);
    return raw == null ? initial : raw === '1';
  });
  return [
    v,
    (nv: boolean) => {
      localStorage.setItem(key, nv ? '1' : '0');
      setV(nv);
    },
  ];
}

export function EditorApp() {
  const s = useStyles();
  const [session, setSession] = useState<EditorSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);
  const [aspect, setAspect] = useState(16 / 9);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const [skipCuts, setSkipCuts] = useLocalBool('ez-editor-skip-cuts', true);

  const [cuts, setCuts] = useState<Cut[]>([]);
  const [past, setPast] = useState<Cut[][]>([]);
  const [future, setFuture] = useState<Cut[][]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [view, setView] = useState<[number, number] | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [grabber, setGrabber] = useState<FrameGrabber | null>(null);
  const exportedCutsRef = useRef<Cut[] | null>(null);
  const scrubbingRef = useRef(false);
  const lastSeekRef = useRef(0);
  const dragOriginRef = useRef<Cut[] | null>(null);

  // Mirror state for the global key handler.
  const st = useRef({ cuts, past, future, selectedId, pendingStart, time, duration, speed, muted, exportOpen });
  st.current = { cuts, past, future, selectedId, pendingStart, time, duration, speed, muted, exportOpen };

  const info = session?.info ?? null;
  const fps = info?.fps || 30;

  // --- Load session ---------------------------------------------------------
  useEffect(() => {
    window.ez.editor.session().then((sess) => {
      if (!sess) {
        setLoadError('This editor window has no recording attached.');
        return;
      }
      setSession(sess);
      document.title = `${sess.fileName} — Ez Screen Record`;
      if (sess.info?.duration) setDuration(sess.info.duration);
      if (sess.info?.width && sess.info.height) setAspect(sess.info.width / sess.info.height);
    });
  }, []);

  useEffect(() => {
    if (!session) return;
    const g = new FrameGrabber(session.mediaUrl);
    setGrabber(g);
    return () => g.dispose();
  }, [session]);

  // --- History --------------------------------------------------------------
  const commit = useCallback((next: Cut[], prev?: Cut[]) => {
    const before = prev ?? st.current.cuts;
    setPast((p) => [...p.slice(-199), before]);
    setFuture([]);
    setCuts(next);
  }, []);
  const undo = useCallback(() => {
    const { past: p, cuts: c } = st.current;
    if (!p.length) return;
    setPast(p.slice(0, -1));
    setFuture((f) => [c, ...f]);
    setCuts(p[p.length - 1]);
    setSelectedId(null);
  }, []);
  const redo = useCallback(() => {
    const { future: f, cuts: c } = st.current;
    if (!f.length) return;
    setFuture(f.slice(1));
    setPast((p) => [...p, c]);
    setCuts(f[0]);
    setSelectedId(null);
  }, []);

  // --- Playback -------------------------------------------------------------
  const seek = useCallback((t: number, exact = true) => {
    const v = videoRef.current;
    const d = st.current.duration || v?.duration || 0;
    const clamped = Math.max(0, Math.min(t, d ? d - 0.001 : t));
    setTime(clamped);
    if (!v) return;
    const now = performance.now();
    // During a drag the picture follows at ~15Hz; every <video> seek decodes
    // from a keyframe, and asking faster only queues them up.
    if (exact || now - lastSeekRef.current > 66) {
      lastSeekRef.current = now;
      v.currentTime = clamped;
    }
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || !st.current.duration) return;
    if (v.paused) {
      if (v.currentTime >= st.current.duration - 0.05) v.currentTime = 0;
      void v.play();
    } else v.pause();
  }, []);

  // rAF loop while playing: smooth playhead + skip-cuts preview. timeupdate
  // only fires ~4x/s, far too coarse to catch a cut boundary cleanly.
  const skipRef = useRef(skipCuts);
  skipRef.current = skipCuts;
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (!v) return;
      let t = v.currentTime;
      if (skipRef.current && !scrubbingRef.current) {
        const target = skipTarget(st.current.cuts, t);
        if (target != null) {
          if (target >= st.current.duration - 0.03) {
            v.pause();
            t = st.current.duration;
          } else {
            v.currentTime = target + 0.01;
            t = target + 0.01;
          }
        }
      }
      if (!scrubbingRef.current) setTime(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  // Keep the playhead on-screen while playing zoomed in.
  useEffect(() => {
    if (!view || !playing) return;
    const span = view[1] - view[0];
    if (time < view[0] || time > view[1] - span * 0.05) {
      const ns = Math.max(0, Math.min(time - span * 0.1, duration - span));
      setView([ns, ns + span]);
    }
  }, [time, view, playing, duration]);

  // --- Cuts -----------------------------------------------------------------
  const markToggle = useCallback(() => {
    const { pendingStart: ps, time: t, cuts: c } = st.current;
    if (!st.current.duration) return;
    if (ps == null) {
      setPendingStart(t);
      setSelectedId(null);
      return;
    }
    setPendingStart(null);
    if (Math.abs(t - ps) < 0.05) return;
    const cut = makeCut(ps, t);
    commit([...c, cut]);
  }, [commit]);

  const deleteSelected = useCallback(() => {
    const { selectedId: id, cuts: c } = st.current;
    if (id == null) return;
    commit(c.filter((x) => x.id !== id));
    setSelectedId(null);
  }, [commit]);

  const onResizeStart = useCallback((_id: number) => {
    dragOriginRef.current = st.current.cuts;
    videoRef.current?.pause();
  }, []);
  const onResize = useCallback(
    (id: number, side: 'start' | 'end', t: number) => {
      const MIN = 0.05;
      const d = st.current.duration;
      let edge = t;
      setCuts((cs) =>
        cs.map((c) => {
          if (c.id !== id) return c;
          if (side === 'start') {
            edge = Math.max(0, Math.min(t, c.end - MIN));
            return { ...c, start: edge };
          }
          edge = Math.min(d, Math.max(t, c.start + MIN));
          return { ...c, end: edge };
        }),
      );
      // Show the frame at the edge being dragged.
      lastEdgeRef.current = edge;
      seek(edge, false);
    },
    [seek],
  );
  const lastEdgeRef = useRef<number | null>(null);
  const onResizeEnd = useCallback(() => {
    if (lastEdgeRef.current != null) seek(lastEdgeRef.current, true);
    lastEdgeRef.current = null;
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (origin && origin !== st.current.cuts) {
      setPast((p) => [...p.slice(-199), origin]);
      setFuture([]);
    }
  }, [seek]);

  // --- Keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (st.current.exportOpen) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      // Let Fluent menus/dropdowns own their keys.
      if ((e.target as HTMLElement)?.closest?.('[role="menu"],[role="listbox"],[role="dialog"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod || e.altKey) return;
      const { time: t } = st.current;
      const step = e.shiftKey ? 1 : 0.1;
      const stepSpeed = (dir: number) => {
        let i = SPEEDS.indexOf(st.current.speed as (typeof SPEEDS)[number]);
        if (i < 0) i = 1;
        setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + dir))]);
      };
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seek(t - step);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seek(t + step);
          break;
        case ',':
          seek(t - 1 / fps);
          break;
        case '.':
          seek(t + 1 / fps);
          break;
        case 'Home':
          seek(0);
          break;
        case 'End':
          seek(st.current.duration);
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          markToggle();
          break;
        case '[':
          stepSpeed(-1);
          break;
        case ']':
          stepSpeed(1);
          break;
        case '\\':
          setSpeed(1);
          break;
        case 'm':
        case 'M':
          setMuted(!st.current.muted);
          break;
        case 'Delete':
        case 'Backspace':
          if (st.current.selectedId != null) {
            e.preventDefault();
            deleteSelected();
          }
          break;
        case 'Escape':
          if (st.current.selectedId != null) setSelectedId(null);
          else setPendingStart(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, togglePlay, seek, markToggle, deleteSelected, fps]);

  // --- Derived --------------------------------------------------------------
  const keep = useMemo(() => keepRanges(cuts, duration), [cuts, duration]);
  const merged = useMemo(() => mergedCuts(cuts), [cuts]);
  const removed = merged.reduce((a, [st0, en]) => a + (Math.min(en, duration) - st0), 0);
  const finalLen = Math.max(0, duration - removed);
  const dirty = cuts.length > 0 && exportedCutsRef.current !== cuts;
  const selectedCut = cuts.find((c) => c.id === selectedId) ?? null;

  const requestClose = () => {
    if (dirty) setConfirmClose(true);
    else void window.ez.editor.window('close');
  };

  const meta = info
    ? `${fmtLength(info.duration)} · ${info.width}×${info.height}${info.hasAudio ? '' : ' · no audio'}`
    : session
      ? ''
      : '';

  return (
    <div className={s.root}>
      {/* Title bar -------------------------------------------------------- */}
      <div className={`${s.titlebar} titlebar`}>
        <div className={s.titleText}>
          <span className={s.fileName}>{session?.fileName ?? 'Loading…'}</span>
          <span className={s.fileMeta}>{meta}</span>
        </div>
        <div className="no-drag">
          <Button
            appearance="primary"
            icon={<ArrowExportUpRegular />}
            disabled={!session?.info || !duration}
            onClick={() => {
              videoRef.current?.pause();
              setExportOpen(true);
            }}
          >
            Export
          </Button>
        </div>
        <div className={`${s.winBtns} no-drag titlebar-winctl`}>
          <Button appearance="subtle" size="small" icon={<SubtractRegular />} title="Minimize" onClick={() => void window.ez.editor.window('minimize')} />
          <Button appearance="subtle" size="small" icon={<MaximizeRegular />} title="Maximize" onClick={() => void window.ez.editor.window('maximize')} />
          <Button appearance="subtle" size="small" icon={<DismissRegular />} title="Close" onClick={requestClose} />
        </div>
      </div>

      <div className={s.body}>
        {/* Preview ------------------------------------------------------- */}
        <div className={s.stage}>
          {session && (
            <video
              ref={videoRef}
              className={s.video}
              src={session.mediaUrl}
              preload="auto"
              crossOrigin="anonymous"
              onClick={togglePlay}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (Number.isFinite(v.duration) && v.duration > 0) setDuration((d) => d || v.duration);
                if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
                v.playbackRate = speed;
              }}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                setPlaying(false);
                if (videoRef.current && !scrubbingRef.current) setTime(videoRef.current.currentTime);
              }}
              onEnded={() => setPlaying(false)}
              onSeeked={() => {
                if (!playing && !scrubbingRef.current && videoRef.current) setTime(videoRef.current.currentTime);
              }}
              onError={() => setLoadError('This recording could not be played.')}
            />
          )}
          {!session && !loadError && (
            <div className={s.stageMsg}>
              <Spinner size="small" />
            </div>
          )}
          {loadError && <div className={s.stageMsg}>{loadError}</div>}
        </div>

        <div className={s.panel}>
          {/* Timeline ------------------------------------------------------- */}
          <Timeline
            duration={duration}
            time={time}
            cuts={cuts}
            selectedId={selectedId}
            pendingStart={pendingStart}
            view={view}
            onView={setView}
            onSeek={(t, final) => seek(t, final)}
            onScrubbing={(a) => {
              scrubbingRef.current = a;
              if (a) videoRef.current?.pause();
            }}
            onSelect={setSelectedId}
            onResizeStart={onResizeStart}
            onResize={onResize}
            onResizeEnd={onResizeEnd}
            grabber={grabber}
            aspect={aspect}
          />

          {/* Transport ------------------------------------------------------ */}
          <div className={s.transport}>
            <div className={s.group}>
              <Tooltip content={pendingStart == null ? 'Mark the start of a part to remove (C)' : 'Mark where the cut ends (C)'} relationship="label">
                <Button
                  className={mergeClasses(s.markBtn, pendingStart != null && s.markPending)}
                  appearance="subtle"
                  icon={<CutRegular />}
                  onClick={markToggle}
                  disabled={!duration}
                >
                  {pendingStart == null ? 'Mark cut' : 'End cut here'}
                  <span className={s.kbd}>C</span>
                </Button>
              </Tooltip>
              {pendingStart != null && (
                <Button appearance="subtle" size="small" onClick={() => setPendingStart(null)}>
                  Cancel
                </Button>
              )}
              {selectedCut && (
                <Button appearance="subtle" icon={<DeleteRegular />} onClick={deleteSelected}>
                  Remove cut
                </Button>
              )}
            </div>

            <div className={s.center}>
              <button className={s.playBtn} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} disabled={!duration}>
                {playing ? <PauseFilled fontSize={18} /> : <PlayFilled fontSize={18} style={{ marginLeft: 2 }} />}
              </button>
              <span className={s.time}>
                {fmtTime(time)} <span className={s.timeDur}>/ {fmtTime(duration)}</span>
              </span>
            </div>

            <div className={mergeClasses(s.group, s.right)}>
              <Tooltip content="Undo (Ctrl+Z)" relationship="label">
                <Button appearance="subtle" icon={<ArrowUndoRegular />} disabled={!past.length} onClick={undo} />
              </Tooltip>
              <Tooltip content="Redo (Ctrl+Shift+Z)" relationship="label">
                <Button appearance="subtle" icon={<ArrowRedoRegular />} disabled={!future.length} onClick={redo} />
              </Tooltip>
              <div className={s.sep} />
              <Menu
                checkedValues={{ speed: [String(speed)] }}
                onCheckedValueChange={(_e, d) => setSpeed(Number(d.checkedItems[0]))}
              >
                <MenuTrigger disableButtonEnhancement>
                  <Tooltip content="Playback speed ([ ])" relationship="label">
                    <Button appearance="subtle" className={s.speedBtn}>
                      {speed}×
                    </Button>
                  </Tooltip>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {SPEEDS.map((v) => (
                      <MenuItemRadio key={v} name="speed" value={String(v)}>
                        {v}×
                      </MenuItemRadio>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              <Tooltip content={muted ? 'Unmute preview (M)' : 'Mute preview (M)'} relationship="label">
                <Button
                  appearance="subtle"
                  icon={muted ? <SpeakerMuteRegular /> : <Speaker2Regular />}
                  onClick={() => setMuted(!muted)}
                />
              </Tooltip>
              <div className={s.sep} />
              <Tooltip content="Jump over cut parts while playing, so you hear the result" relationship="description">
                <Switch
                  className={s.skip}
                  label="Skip cuts"
                  labelPosition="before"
                  checked={skipCuts}
                  onChange={(_e, d) => setSkipCuts(d.checked)}
                />
              </Tooltip>
            </div>
          </div>

        </div>

        {/* Status ---------------------------------------------------------- */}
        <div className={s.status}>
          <span>
            {cuts.length === 0 ? (
              'Press C where an unwanted part starts, and C again where it ends.'
            ) : (
              <>
                <span className={s.statusStrong}>
                  {cuts.length} cut{cuts.length === 1 ? '' : 's'}
                </span>
                {' · '}
                {fmtLength(removed)} removed{' · '}
                <span className={s.statusStrong}>{fmtLength(finalLen)}</span> final
                {selectedCut ? ' · drag the white handles to adjust' : ''}
              </>
            )}
          </span>
          <div className={s.statusRight}>
          {view ? (
            <span className={s.zoomChip}>
              <ZoomInRegular fontSize={13} />
              {fmtTime(view[0], false)}–{fmtTime(view[1], false)} · {(duration / (view[1] - view[0])).toFixed(1)}×
              <Button appearance="subtle" size="small" icon={<DismissRegular fontSize={12} />} aria-label="Reset zoom" title="Show the whole video" onClick={() => setView(null)} style={{ minWidth: 20, height: 20, padding: 0 }} />
            </span>
          ) : (
            duration > 0 && <span>Scroll on the timeline to zoom</span>
          )}
          <Popover withArrow positioning="above-end">
            <PopoverTrigger disableButtonEnhancement>
              <Button appearance="subtle" size="small" icon={<KeyboardRegular />}>
                Shortcuts
              </Button>
            </PopoverTrigger>
            <PopoverSurface className={s.popover}>
              <div className={s.popTitle}>Keyboard shortcuts</div>
              <div className={s.shortcuts}>
                {SHORTCUTS.map(([k, d]) => (
                  <React.Fragment key={k}>
                    <span className={s.shortcutKey}>{k}</span>
                    <span>{d}</span>
                  </React.Fragment>
                ))}
              </div>
            </PopoverSurface>
          </Popover>
          </div>
        </div>
      </div>

      {session && (
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          session={session}
          keep={keep}
          cutCount={merged.length}
          onExported={() => {
            exportedCutsRef.current = st.current.cuts;
          }}
        />
      )}

      <Dialog open={confirmClose} onOpenChange={(_e, d) => setConfirmClose(d.open)}>
        <DialogSurface className={s.confirm}>
          <DialogBody>
            <DialogTitle>Close without exporting?</DialogTitle>
            <DialogContent>Your cuts are not saved anywhere until you export. The original recording stays as it is.</DialogContent>
            <DialogActions>
              <Button appearance="subtle" onClick={() => setConfirmClose(false)}>
                Keep editing
              </Button>
              <Button appearance="primary" onClick={() => void window.ez.editor.window('close')}>
                Close editor
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
