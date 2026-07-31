import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  makeStyles,
  tokens,
  Button,
  Text,
  Switch,
  Dropdown,
  Option,
  Menu,
  MenuTrigger,
  MenuPopover,
  Toaster,
  useToastController,
  Toast,
  ToastTitle,
  ToastBody,
  ToastTrigger,
  useId,
  Link,
  Divider,
  Tooltip,
} from '@fluentui/react-components';
import {
  RecordRegular,
  StopRegular,
  PauseRegular,
  PlayRegular,
  InkStrokeRegular,
  ImageAddRegular,
  ImageRegular,
  DeleteRegular,
  SettingsRegular,
  PinRegular,
  SubtractRegular,
  DismissRegular,
  FolderOpenRegular,
  VideoRegular,
  VideoOffRegular,
  MicRegular,
  MicOffRegular,
  Speaker2Regular,
  SpeakerOffRegular,
  DesktopRegular,
  QuestionRegular,
} from '@fluentui/react-icons';
import { LayoutStage } from './components/LayoutStage';
import { PillControl } from './components/PillControl';
import { SourceDialog } from './components/SourceDialog';
import { ScreenRecorder } from './lib/recorder';
import {
  DEFAULT_SETTINGS,
  RESOLUTIONS,
  FPS_OPTIONS,
  QUALITY_PRESETS,
  type AppSettings,
  type CaptureEngine,
  type CaptureSource,
  type MediaDevice,
  type QualityPreset,
  type Rect,
  type RecordingState,
  type ResolutionPreset,
} from '../shared/types';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: tokens.colorNeutralBackground3,
  },
  titlebar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    // WinUI title bar height.
    height: '32px',
    paddingLeft: '12px',
    flexShrink: 0,
  },
  titleText: { display: 'flex', alignItems: 'center', gap: '8px' },
  winBtns: { display: 'flex' },
  // flex column with min-height:0 so the scroll area actually shrinks instead
  // of pushing content under the transport bar.
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    // Centre the preview when the window is taller than 16:9 needs, so
    // resizing never leaves a band of empty space under it.
    justifyContent: 'center',
  },
  // Google Meet style control bar.
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    flexShrink: 0,
    position: 'relative',
    zIndex: 1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  roundBtn: {
    width: '40px',
    height: '40px',
    borderRadius: '50%',
    border: 'none',
    background: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground1,
    display: 'grid',
    placeItems: 'center',
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
    ':hover': { background: tokens.colorNeutralBackground4Hover },
  },
  roundBtnActive: {
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  // The primary action sits where Meet puts hang-up: far right, wider, colored.
  primaryBtn: {
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
    ':disabled': { opacity: 0.4, cursor: 'not-allowed' },
  },
  primaryRecord: {
    background: tokens.colorPaletteRedBackground3,
    ':hover': { background: tokens.colorPaletteRedForeground1 },
  },
  primaryStop: {
    background: tokens.colorPaletteRedBackground3,
    ':hover': { background: tokens.colorPaletteRedForeground1 },
  },
  settingsPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px',
    minWidth: '260px',
    maxWidth: '320px',
  },
  imageList: {
    display: 'flex',
    flexDirection: 'column',
  },
  transport: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderRadius: tokens.borderRadiusMedium,
    // Solid rather than a translucent card: the transport must stay legible
    // over whatever the Mica backdrop is showing.
    background: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    flexShrink: 0,
    margin: '0 12px 12px',
    // Sits outside the scroll area, so content can never ride over it.
    position: 'relative',
    zIndex: 1,
  },
  timer: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: '20px',
    fontWeight: 600,
    letterSpacing: '0.5px',
  },
  spacer: { flex: 1 },
  row: { display: 'flex', alignItems: 'center', gap: '8px' },
  rowBetween: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  field: { display: 'grid', gap: '4px', marginBottom: '10px' },
  imageRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px',
    borderRadius: tokens.borderRadiusSmall,
    background: tokens.colorNeutralBackground3,
    marginBottom: '6px',
  },
  thumb: {
    width: '40px',
    height: '28px',
    objectFit: 'cover',
    borderRadius: '3px',
    background: '#000',
    flexShrink: 0,
  },
  name: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  countdown: {
    position: 'fixed',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(0,0,0,0.72)',
    zIndex: 999,
    fontSize: '120px',
    fontWeight: 200,
  },
  hotkeyGrid: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '4px 12px',
    alignItems: 'center',
  },
  kbd: {
    fontFamily: 'Consolas, monospace',
    fontSize: '11px',
    padding: '2px 6px',
    borderRadius: '4px',
    background: tokens.colorNeutralBackground4,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    justifySelf: 'start',
  },
});

/**
 * Collapse the duplicate entries Windows reports for a single physical device.
 *
 * A webcam is typically enumerated once per capture backend (Media Foundation,
 * DirectShow, …) plus a "default"/"communications" alias, so one Brio shows up
 * three or four times. Keying on the cleaned label leaves one entry per real
 * device, preferring the concrete deviceId over the aliases.
 */
function dedupeDevices(
  devices: MediaDeviceInfo[],
  kind: MediaDeviceKind,
  fallbackLabel: string,
): MediaDevice[] {
  const byLabel = new Map<string, MediaDevice>();

  for (const d of devices) {
    if (d.kind !== kind) continue;

    // Windows prefixes the aliases; strip so they collapse onto the real one.
    const label = (d.label || fallbackLabel)
      .replace(/^(Default|Communications)\s*-\s*/i, '')
      .trim();
    // Drop the trailing hardware id, e.g. "Brio 100 (046d:094c)".
    const key = label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').toLowerCase();

    const isAlias = d.deviceId === 'default' || d.deviceId === 'communications';
    const existing = byLabel.get(key);
    // Keep the first concrete id; only let an alias fill an empty slot.
    if (!existing || (existing.deviceId === 'default' && !isAlias)) {
      byLabel.set(key, { deviceId: d.deviceId, label });
    }
  }

  return [...byLabel.values()];
}

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function App() {
  const s = useStyles();
  const toasterId = useId('toaster');
  const { dispatchToast } = useToastController(toasterId);

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cams, setCams] = useState<MediaDevice[]>([]);
  const [mics, setMics] = useState<MediaDevice[]>([]);
  const [outputDir, setOutputDir] = useState<string>('');
  const [hotkeyConflicts, setHotkeyConflicts] = useState<string[]>([]);
  // Screen/window sources live here now so the picker can list them.
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  /** True while ffmpeg owns the capture devices — the preview must let go. */
  const [captureSuspended, setCaptureSuspended] = useState(false);
  /** dshow device names — ffmpeg addresses devices by name, not id. */
  const [nativeMics, setNativeMics] = useState<string[]>([]);
  const [nativeCams, setNativeCams] = useState<string[]>([]);

  const recorderRef = useRef(new ScreenRecorder());
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirror state into refs so global hotkey handlers always see current values.
  const stateRef = useRef(state);
  stateRef.current = state;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  // Re-entrancy guard for start, and a cancel flag for the countdown loop.
  const startingRef = useRef(false);
  const cancelCountdownRef = useRef(false);
  /** Wall-clock start of an ffmpeg take; the browser recorder times itself. */
  const nativeStartRef = useRef(0);
  // beginRecording is reached from a global hotkey and from a stable callback,
  // so anything it reads must come from a ref — a value captured in the
  // closure would be whatever it was on first render. This bit me: the app
  // silently used the browser encoder because `nativeAvailable` was still
  // false in the captured scope.
  const nativeAvailableRef = useRef(false);
  const camsRef = useRef<MediaDevice[]>([]);
  const micsRef = useRef<MediaDevice[]>([]);
  const nativeCamsRef = useRef<string[]>([]);
  const nativeMicsRef = useRef<string[]>([]);
  const sourcesRef = useRef<CaptureSource[]>([]);
  nativeAvailableRef.current = nativeAvailable;
  camsRef.current = cams;
  micsRef.current = mics;
  nativeCamsRef.current = nativeCams;
  nativeMicsRef.current = nativeMics;
  sourcesRef.current = sources;
  /** True while the on-screen camera bubble (Mode A) is up. */
  const onScreenCameraRef = useRef(false);

  const notify = useCallback(
    (title: string, body?: string, intent: 'success' | 'error' | 'warning' = 'success') => {
      dispatchToast(
        <Toast>
          {/* Every toast is dismissable. Relying on the timeout alone left
              toasts stuck on screen over the controls. */}
          <ToastTitle
            action={
              <ToastTrigger>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<DismissRegular />}
                  aria-label="Dismiss"
                />
              </ToastTrigger>
            }
          >
            {title}
          </ToastTitle>
          {body && <ToastBody>{body}</ToastBody>}
        </Toast>,
        { intent, timeout: intent === 'error' ? 8000 : 4000 },
      );
    },
    [dispatchToast],
  );

  // --- Load persisted settings + enumerate devices ---------------------------
  useEffect(() => {
    (async () => {
      const loadedSettings = await window.ez.getSettings();
      setSettings(loadedSettings);
      setOutputDir(loadedSettings.recording.outputDir || (await window.ez.defaultOutputDir()));
      setLoaded(true);

      // Device labels are only populated after permission is granted, so ask
      // once up front rather than showing a list of blank entries.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch {
        /* user may have no webcam; audio-only still works */
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCams(dedupeDevices(devices, 'videoinput', 'Camera'));
      setMics(dedupeDevices(devices, 'audioinput', 'Microphone'));
    })();
  }, []);

  // Re-enumerate when devices are plugged in or removed.
  useEffect(() => {
    const onChange = async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setCams(dedupeDevices(devices, 'videoinput', 'Camera'));
      setMics(dedupeDevices(devices, 'audioinput', 'Microphone'));
    };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, []);

  // Persist whenever settings change (after the initial load), debounced.
  // Dragging an overlay produces a new settings object per pointer-move, and
  // saving is a synchronous writeFileSync of the whole state — including
  // base64 image data — on the main thread. Writing at pointer rate stalls the
  // app and hammers the disk.
  useEffect(() => {
    if (!loaded) return;
    const id = window.setTimeout(() => window.ez.setSettings(settings), 400);
    return () => window.clearTimeout(id);
  }, [settings, loaded]);

  // Default the camera to the first available device.
  useEffect(() => {
    if (loaded && cams.length > 0 && !settings.camera.deviceId) {
      setSettings((p) => ({ ...p, camera: { ...p.camera, deviceId: cams[0].deviceId } }));
    }
  }, [cams, loaded, settings.camera.deviceId]);

  // Push live overlay geometry changes into an in-progress recording.
  // Push live overlay geometry changes into an in-progress recording.
  useEffect(() => {
    if (state === 'recording' || state === 'paused') {
      void recorderRef.current.updateCamera(settings.camera);
    }
  }, [settings.camera, state]);

  useEffect(() => {
    if (state === 'recording' || state === 'paused') {
      recorderRef.current.updateImages(settings.images);
    }
  }, [settings.images, state]);

  // Sources can be changed mid-take — switch monitor, swap mic — without
  // interrupting the recording.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    const id = settings.recording.screenSourceId;
    if (id) void recorderRef.current.updateScreenSource(id, settings.recording.fps);
  }, [settings.recording.screenSourceId, settings.recording.fps, state]);

  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    void recorderRef.current.updateMicrophone(
      settings.recording.micDeviceId,
      settings.recording.micEnabled,
    );
  }, [settings.recording.micDeviceId, settings.recording.micEnabled, state]);

  // --- Recording control -----------------------------------------------------
  const finishRecording = useCallback(
    async (blob: Blob) => {
      setState('saving');
      try {
        const buf = await blob.arrayBuffer();
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .replace('T', '_')
          .slice(0, 19);
        const name = `recording_${stamp}.${recorderRef.current.fileExtension}`;
        const res = await window.ez.saveRecording(
          buf,
          name,
          settingsRef.current.recording.outputDir,
        );
        if (res.ok && res.filePath) {
          const p = res.filePath;
          dispatchToast(
            <Toast>
              <ToastTitle
                action={
                  <ToastTrigger>
                    <Button
                      appearance="subtle"
                      size="small"
                      icon={<DismissRegular />}
                      aria-label="Dismiss"
                    />
                  </ToastTrigger>
                }
              >
                Recording saved
              </ToastTitle>
              <ToastBody>
                <Link onClick={() => window.ez.revealFile(p)}>Show in folder</Link>
              </ToastBody>
            </Toast>,
            { intent: 'success', timeout: 10000 },
          );
        } else {
          notify('Could not save recording', res.error, 'error');
        }
      } catch (err) {
        notify('Could not save recording', (err as Error).message, 'error');
      } finally {
        setState('idle');
        setElapsed(0);
      }
    },
    [notify, dispatchToast],
  );

  const pushToolbarState = useCallback(() => {
    void window.ez.toolbar.send('toolbar:state', {
      state: stateRef.current,
      drawing: drawingRef.current,
      micEnabled: settingsRef.current.recording.micEnabled,
      micDeviceId: settingsRef.current.recording.micDeviceId,
      mics: micsRef.current,
      cameraEnabled: settingsRef.current.camera.enabled,
      cameraDeviceId: settingsRef.current.camera.deviceId,
      cams: camsRef.current,
      sourceName:
        sourcesRef.current.find(
          (x) => x.id === settingsRef.current.recording.screenSourceId,
        )?.name ?? '',
    });
  }, []);

  const beginRecording = useCallback(async () => {
    const cfg = settingsRef.current.recording;

    // GPU path: ffmpeg captures, composites via libplacebo (Vulkan) and
    // encodes in 4:4:4. Used whenever it is available, since it is strictly
    // better than the browser encoder — the fallback exists only for machines
    // without a suitable ffmpeg build.
    if (nativeAvailableRef.current) {
      const micName = cfg.micEnabled
        ? nativeMicsRef.current.find((n) =>
            n.toLowerCase().includes(
              (micsRef.current.find((m) => m.deviceId === cfg.micDeviceId)?.label ?? '')
                .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
                .toLowerCase(),
            ),
          ) ?? nativeMicsRef.current[0]
        : null;

      // Match the selected webcam to its dshow name — ffmpeg addresses
      // devices by name, the browser by id.
      const camLabel = camsRef.current
        .find((c) => c.deviceId === settingsRef.current.camera.deviceId)
        ?.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
        .trim();
      const camName =
        settingsRef.current.camera.enabled && camLabel
          ? nativeCamsRef.current.find((n) => n.toLowerCase().includes(camLabel.toLowerCase())) ??
            nativeCamsRef.current[0]
          : null;

      const cam = settingsRef.current.camera;

      // There is exactly one way the camera is recorded: it renders in an
      // always-on-top window on the desktop, and the screen capture picks it up
      // as ordinary pixels. Nothing composites it.
      //
      // This is not a mode, it is the only thing that works. ffmpeg's libplacebo
      // blend is a framesync filter — it emits one output frame per synchronised
      // set of inputs, so the slowest input paces the whole graph. A webcam is
      // typically 30fps and drops to ~15 in dim light, which dragged 60fps takes
      // down to ~21 genuinely-unique frames per second and 120fps takes to ~13.
      // Every escape route was measured and none worked, because gating is what
      // the filter is designed to do.
      //
      // Keeping the bubble on the desktop also means the webcam's rate never
      // touches the recording clock, the preview never has to give up the
      // camera, and the bubble can be dragged mid-take with what you see being
      // exactly what lands in the file.
      const onScreenCamera = Boolean(camName);
      onScreenCameraRef.current = onScreenCamera;

      if (onScreenCamera) {
        // Put the bubble on the display that is actually being recorded.
        const src = sourcesRef.current.find((x) => x.id === cfg.screenSourceId);
        await window.ez.cameraOverlay.show(src?.displayId);
        await window.ez.cameraOverlay.send('cameraOverlay:config', cam);
      }

      // Put the toolbar up BEFORE ffmpeg starts capturing.
      //
      // Doing it afterwards left the bar visible to the capture for the first
      // moments of the take: recordings began with the toolbar on screen
      // showing 00:00, even though it is content-protected. Protection is
      // applied when the window is created, but the window still has to be
      // shown and composited, and ffmpeg was already running by then.
      stateRef.current = 'recording';
      pushToolbarState();
      void window.ez.toolbar.send('toolbar:elapsed', 0);
      await window.ez.window.setToolbarMode(true);

      const res = await window.ez.native.start({
        fps: cfg.fps,
        height: cfg.resolution === 'source' ? undefined : Number(cfg.resolution),
        quality: cfg.quality,
        micDeviceName: micName,
        // Always null: the bubble is already on the desktop and the screen
        // capture records it. Handing the camera to ffmpeg as well would both
        // duplicate it and re-introduce the framesync gate.
        camera: null,
        outputDir: cfg.outputDir,
      });

      if (!res.ok) {
        // Put everything back — the toolbar is already up at this point.
        stateRef.current = 'idle';
        void window.ez.window.setToolbarMode(false);
        void window.ez.cameraOverlay.hide();
        notify('Could not start recording', res.error, 'error');
        setState('idle');
        return;
      }
      nativeStartRef.current = Date.now();
      setState('recording');
      return;
    }

    try {
      await recorderRef.current.start(settingsRef.current, {
        onTick: setElapsed,
        onStop: finishRecording,
        onError: (e) => {
          notify('Recording error', e.message, 'error');
          setState('idle');
        },
      });
      setState('recording');
    } catch (err) {
      notify('Could not start recording', (err as Error).message, 'error');
      setState('idle');
    }
  }, [finishRecording, notify]);

  const startWithCountdown = useCallback(async () => {
    // Guard against re-entry: React state is async, so two fast clicks (or
    // hotkey presses) would both see state==='idle' and start two concurrent
    // recordings on the same recorder instance, orphaning the first one's
    // streams and timers.
    if (startingRef.current || stateRef.current !== 'idle') return;
    if (!settingsRef.current.recording.screenSourceId) {
      notify('Pick a source first', 'Choose a screen or window to record.', 'warning');
      return;
    }

    startingRef.current = true;
    cancelCountdownRef.current = false;
    try {
      const secs = settingsRef.current.recording.countdownSeconds;
      if (secs > 0) {
        setState('countdown');
        for (let i = secs; i > 0; i--) {
          if (cancelCountdownRef.current) {
            setCountdown(0);
            setState('idle');
            return;
          }
          setCountdown(i);
          await new Promise((r) => setTimeout(r, 1000));
        }
        setCountdown(0);
        // One last check — the user may have cancelled on the final tick.
        if (cancelCountdownRef.current) {
          setState('idle');
          return;
        }
      }
      await beginRecording();
    } finally {
      startingRef.current = false;
    }
  }, [beginRecording, notify]);

  const stopRecording = useCallback(async () => {
    // During the countdown there is no recorder yet — cancel the pending start
    // instead, otherwise Stop is silently ignored and recording begins anyway.
    if (stateRef.current === 'countdown') {
      cancelCountdownRef.current = true;
      return;
    }

    if (nativeStartRef.current) {
      setState('saving');
      const res = await window.ez.native.stop();
      nativeStartRef.current = 0;
      if (res.ok && res.filePath) {
        const p = res.filePath;
        dispatchToast(
          <Toast>
            <ToastTitle
              action={
                <ToastTrigger>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<DismissRegular />}
                    aria-label="Dismiss"
                  />
                </ToastTrigger>
              }
            >
              Recording saved
            </ToastTitle>
            <ToastBody>
              <Link onClick={() => window.ez.revealFile(p)}>Show in folder</Link>
            </ToastBody>
          </Toast>,
          { intent: 'success', timeout: 10000 },
        );
      } else {
        notify('Could not save recording', res.error, 'error');
      }
      // ffmpeg has exited; take the bubble down and put the window back.
      setCaptureSuspended(false);
      if (onScreenCameraRef.current) {
        onScreenCameraRef.current = false;
        void window.ez.cameraOverlay.hide();
      }
      void window.ez.window.setToolbarMode(false);
      setState('idle');
      setElapsed(0);
      return;
    }

    recorderRef.current.stop();
  }, [dispatchToast, notify]);

  const togglePause = useCallback(() => {
    const rec = recorderRef.current;
    if (rec.state === 'recording') {
      rec.pause();
      setState('paused');
    } else if (rec.state === 'paused') {
      rec.resume();
      setState('recording');
    }
  }, []);

  const toggleRecord = useCallback(() => {
    const cur = stateRef.current;
    if (cur === 'idle') startWithCountdown();
    // 'countdown' included so the hotkey can abort a pending start.
    else if (cur === 'recording' || cur === 'paused' || cur === 'countdown') stopRecording();
  }, [startWithCountdown, stopRecording]);

  // --- Annotation overlay ----------------------------------------------------
  const toggleDrawing = useCallback(async () => {
    const next = !drawingRef.current;
    setDrawing(next);
    if (next) {
      await window.ez.overlay.show();
      await window.ez.overlay.send('overlay:setActive', true);
    } else {
      // Turning off clears the canvas and hides the window, so the overlay can
      // never be left holding input.
      await window.ez.overlay.send('overlay:setActive', false);
      await window.ez.overlay.send('overlay:clear');
      await window.ez.overlay.hide();
    }
  }, []);

  const clearDrawing = useCallback(() => {
    window.ez.overlay.send('overlay:clear');
  }, []);

  // The overlay can exit draw mode itself (Esc or its ✕ button).
  useEffect(() => window.ez.on('control:drawModeChanged', (v: boolean) => setDrawing(v)), []);

  // Keep main's copy of the capture-visibility flag in step, including when it
  // is toggled mid-take.
  useEffect(() => {
    if (!loaded) return;
    void window.ez.window.setHideFromCapture(settings.recording.hideToolbarFromCapture);
  }, [settings.recording.hideToolbarFromCapture, loaded]);

  // --- Recording toolbar -----------------------------------------------------
  // The toolbar runs in its own window (so its menus are not clipped), which
  // means it holds no state of its own — everything it renders is pushed here,
  // and everything it does comes back as a command.
  const activeSourceName =
    sources.find((x) => x.id === settings.recording.screenSourceId)?.name ?? '';

  // Deliberately split in two, and `elapsed` is NOT a dependency here.
  //
  // The elapsed timer ticks 5x a second, and sending the whole state object —
  // including both full device lists — on every tick meant an IPC round trip
  // and a re-render of the toolbar window 5x a second, for the entire take.
  // That showed up in recordings as a ~300ms stall every ~0.5s, right through.
  // This effect now fires only when something a human changed actually changes.
  // The toolbar asks for state when it mounts; without this it would render
  // nothing until the next change happened to be pushed.
  useEffect(() => window.ez.on('toolbar:requestState', () => pushToolbarState()), [
    pushToolbarState,
  ]);

  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    void window.ez.toolbar.send('toolbar:state', {
      state,
      drawing,
      micEnabled: settings.recording.micEnabled,
      micDeviceId: settings.recording.micDeviceId,
      mics,
      cameraEnabled: settings.camera.enabled,
      cameraDeviceId: settings.camera.deviceId,
      cams,
      sourceName: activeSourceName,
    });
  }, [
    state,
    drawing,
    settings.recording.micEnabled,
    settings.recording.micDeviceId,
    settings.camera.enabled,
    settings.camera.deviceId,
    mics,
    cams,
    activeSourceName,
  ]);

  // The clock goes over on its own, as a bare number, once a second — the
  // toolbar only renders whole seconds, so 5x a second bought nothing.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    void window.ez.toolbar.send('toolbar:elapsed', Math.floor(elapsed / 1000));
  }, [Math.floor(elapsed / 1000), state]);

  // The on-screen bubble is draggable in place; mirror its geometry back so the
  // app preview and the desktop bubble never disagree.
  useEffect(
    () =>
      window.ez.on('control:cameraRect', (rect: Rect) =>
        setSettings((p) => ({ ...p, camera: { ...p.camera, rect } })),
      ),
    [],
  );

  // Push camera changes (enabled, shape, mirror, shadow, device, rect) into the
  // bubble while a take runs, so edits are live on the real desktop too.
  //
  // Driven by the CURRENT camera setting rather than a flag captured at record
  // start: turning the camera off and on again mid-take left that flag false,
  // so the config stopped being sent and the bubble never came back.
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;

    if (settings.camera.enabled && settings.camera.deviceId) {
      if (!onScreenCameraRef.current) {
        // Re-enabled mid-take: the window was hidden on the way out, so it has
        // to be shown again before it will render anything.
        onScreenCameraRef.current = true;
        const src = sourcesRef.current.find(
          (x) => x.id === settingsRef.current.recording.screenSourceId,
        );
        void window.ez.cameraOverlay.show(src?.displayId);
      }
      void window.ez.cameraOverlay.send('cameraOverlay:config', settings.camera);
    } else if (onScreenCameraRef.current) {
      onScreenCameraRef.current = false;
      void window.ez.cameraOverlay.hide();
    }
  }, [settings.camera, state]);

  // Main reports any shortcut another app already owns.
  useEffect(() => window.ez.on('hotkeyConflict', (list: string[]) => setHotkeyConflicts(list)), []);

  // Is the high-quality ffmpeg path usable on this machine?
  useEffect(() => {
    window.ez.native.available().then(async (ok) => {
      setNativeAvailable(ok);
      if (!ok) return;
      const { audio, video } = await window.ez.native.devices();
      setNativeMics(audio);
      setNativeCams(video);
    });
  }, []);

  // ffmpeg records out-of-process, so the elapsed timer is driven here.
  useEffect(() => {
    if (state !== 'recording' || !nativeStartRef.current) return;
    const id = window.setInterval(() => {
      if (nativeStartRef.current) setElapsed(Date.now() - nativeStartRef.current);
    }, 200);
    return () => window.clearInterval(id);
  }, [state]);

  // --- Capture sources -------------------------------------------------------
  const refreshSources = useCallback(async () => {
    setSourcesLoading(true);
    let list: CaptureSource[] = [];
    try {
      list = await window.ez.listSources();
    } finally {
      setSourcesLoading(false);
    }
    setSources(list);

    // Drop a saved source that no longer exists. A window id persisted from a
    // previous session points at a window that has since closed, and recording
    // then fails with nothing shown to the user — the record button appears to
    // do nothing at all.
    const saved = settingsRef.current.recording.screenSourceId;
    if (saved && list.length > 0 && !list.some((x) => x.id === saved)) {
      const fallback = list.find((x) => x.kind === 'screen');
      setSettings((p) => ({
        ...p,
        recording: { ...p.recording, screenSourceId: fallback?.id ?? null },
      }));
      return;
    }

    // Default to the primary screen so the app is usable immediately.
    if (!settingsRef.current.recording.screenSourceId) {
      const first = list.find((x) => x.kind === 'screen');
      if (first) {
        setSettings((p) => ({
          ...p,
          recording: { ...p.recording, screenSourceId: first.id },
        }));
      }
    }
  }, []);

  useEffect(() => {
    refreshSources();
  }, [refreshSources]);

  // --- Global hotkeys --------------------------------------------------------
  useEffect(() => {
    return window.ez.on('hotkey', (action: string) => {
      if (action === 'toggleRecord') toggleRecord();
      else if (action === 'togglePause') togglePause();
      else if (action === 'toggleDraw') toggleDrawing();
      else if (action === 'clearDraw') clearDrawing();
    });
  }, [toggleRecord, togglePause, toggleDrawing, clearDrawing]);

  // Commands coming back from the toolbar window.
  useEffect(() => {
    const offs = [
      window.ez.on('toolbar:stop', () => stopRecording()),
      window.ez.on('toolbar:togglePause', () => togglePause()),
      window.ez.on('toolbar:toggleDraw', () => toggleDrawing()),
      window.ez.on('toolbar:pickSource', () => {
        refreshSources();
        setSourceDialogOpen(true);
        // The picker lives in the main window, which is hidden during a take.
        void window.ez.window.setToolbarMode(false);
      }),
      window.ez.on('toolbar:setMicEnabled', (v: boolean) =>
        setSettings((p) => ({ ...p, recording: { ...p.recording, micEnabled: v } })),
      ),
      window.ez.on('toolbar:setMicDevice', (id: string) =>
        setSettings((p) => ({ ...p, recording: { ...p.recording, micDeviceId: id } })),
      ),
      window.ez.on('toolbar:setCameraEnabled', (v: boolean) =>
        setSettings((p) => ({ ...p, camera: { ...p.camera, enabled: v } })),
      ),
      window.ez.on('toolbar:setCameraDevice', (id: string) =>
        setSettings((p) => ({ ...p, camera: { ...p.camera, deviceId: id } })),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [stopRecording, togglePause, toggleDrawing, refreshSources]);

  // --- Image overlays --------------------------------------------------------
  const addImages = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const src = reader.result as string;
        // Size the initial rect to the image's own aspect ratio.
        const probe = new Image();
        probe.onload = () => {
          const aspect = probe.width / probe.height;
          const w = 0.22;
          const h = (w * (16 / 9)) / aspect; // stage is 16:9
          setSettings((p) => ({
            ...p,
            images: [
              ...p.images,
              {
                id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                name: file.name,
                src,
                rect: { x: 0.04, y: 0.06, w, h: Math.min(h, 0.6) },
                opacity: 1,
                visible: true,
              },
            ],
          }));
        };
        probe.src = src;
      };
      reader.readAsDataURL(file);
    });
  };

  const updateImage = (id: string, patch: Partial<AppSettings['images'][number]>) =>
    setSettings((p) => ({
      ...p,
      images: p.images.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    }));

  const removeImage = (id: string) =>
    setSettings((p) => ({ ...p, images: p.images.filter((i) => i.id !== id) }));

  const setCameraRect = useCallback(
    (rect: Rect) => setSettings((p) => ({ ...p, camera: { ...p.camera, rect } })),
    [],
  );
  const setImageRect = useCallback(
    (id: string, rect: Rect) =>
      setSettings((p) => ({
        ...p,
        images: p.images.map((i) => (i.id === id ? { ...i, rect } : i)),
      })),
    [],
  );


  const busy = state === 'recording' || state === 'paused' || state === 'countdown';
  const activeSource = sources.find((x) => x.id === settings.recording.screenSourceId);

  return (
    <div className={s.root}>
      {/* Top-end: bottom-end sat directly over the record/stop button, and a
          toast that outstayed its timeout blocked the primary action. */}
      <Toaster toasterId={toasterId} position="top-end" offset={{ vertical: 40 }} />

      {/* Title bar ------------------------------------------------------- */}
      <div className={`${s.titlebar} titlebar`}>
        <div className={s.titleText}>
          {state === 'recording' && <div className="rec-dot" />}
          <Text size={200} weight="semibold">
            Ez Screen Record
          </Text>
        </div>
        <div className={`${s.winBtns} no-drag`}>
          <Button
            appearance="subtle"
            size="small"
            icon={<PinRegular />}
            title={pinned ? 'Unpin from top' : 'Keep on top'}
            style={pinned ? { color: tokens.colorBrandForeground1 } : undefined}
            onClick={() => {
              const next = !pinned;
              setPinned(next);
              window.ez.window.setAlwaysOnTop(next);
            }}
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<SubtractRegular />}
            onClick={() => window.ez.window.minimize()}
            title="Minimize"
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<DismissRegular />}
            onClick={() => window.ez.window.close(busy)}
            title="Close"
          />
        </div>
      </div>

      {/* Stage ------------------------------------------------------------ */}
      <div className={s.body}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addImages(e.target.files);
            e.target.value = '';
          }}
        />

        {/* Unmounted during a take. The window is hidden behind the toolbar
            then, so the preview cannot be seen anyway, and leaving it mounted
            means a second capture of the very display ffmpeg is recording.
            (It was NOT the cause of the periodic stalls — that was dshow's
            audio buffer, see native-recorder.ts — but it is still pure waste
            while invisible.) */}
        {!(state === 'recording' || state === 'paused') && (
        <LayoutStage
          screenSourceId={settings.recording.screenSourceId}
          camera={settings.camera}
          images={settings.images}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onCameraRect={setCameraRect}
          onImageRect={setImageRect}
          onCameraShape={(shape) => setSettings((p) => ({ ...p, camera: { ...p.camera, shape } }))}
          onCameraMirror={(mirrored) =>
            setSettings((p) => ({ ...p, camera: { ...p.camera, mirrored } }))
          }
          suspendCapture={captureSuspended}
        />
        )}

        {settings.images.length > 0 && (
          <div className={s.imageList}>
            {settings.images.map((img) => (
              <div key={img.id} className={s.imageRow}>
                <img className={s.thumb} src={img.src} alt="" />
                <Text size={200} className={s.name} title={img.name}>
                  {img.name}
                </Text>
                <Switch
                  checked={img.visible}
                  onChange={(_e, d) => updateImage(img.id, { visible: d.checked })}
                  title="Visible"
                />
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<DeleteRegular />}
                  onClick={() => removeImage(img.id)}
                  title="Remove"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Control bar. Google Meet layout: pill split-buttons for devices,
          round icon buttons for actions, primary action far right. -------- */}
      <div className={s.controlBar}>
        <PillControl
          label="Microphone"
          onIcon={<MicRegular />}
          offIcon={<MicOffRegular />}
          enabled={settings.recording.micEnabled}
          onToggle={(v) =>
            setSettings((p) => ({ ...p, recording: { ...p.recording, micEnabled: v } }))
          }
          options={mics.map((m) => ({ id: m.deviceId, label: m.label }))}
          selectedId={settings.recording.micDeviceId}
          onSelect={(id) =>
            setSettings((p) => ({ ...p, recording: { ...p.recording, micDeviceId: id } }))
          }
        />

        <PillControl
          label="Camera"
          onIcon={<VideoRegular />}
          offIcon={<VideoOffRegular />}
          enabled={settings.camera.enabled}
          onToggle={(v) => setSettings((p) => ({ ...p, camera: { ...p.camera, enabled: v } }))}
          options={cams.map((c) => ({ id: c.deviceId, label: c.label }))}
          selectedId={settings.camera.deviceId}
          onSelect={(id) => setSettings((p) => ({ ...p, camera: { ...p.camera, deviceId: id } }))}
        />

        {/* Screen share — opens a visual picker; window titles alone are
            not enough to tell windows apart. */}
        <Tooltip
          content={activeSource ? `Recording: ${activeSource.name}` : 'Choose what to record'}
          relationship="label"
          withArrow
        >
          <button
            className={`${s.roundBtn} ${activeSource ? s.roundBtnActive : ''}`}
            aria-label="Choose what to record"
            onClick={() => {
              refreshSources();
              setSourceDialogOpen(true);
            }}
          >
            <DesktopRegular fontSize={20} />
          </button>
        </Tooltip>

        <Tooltip content="Add image overlay" relationship="label" withArrow>
          <button className={s.roundBtn} onClick={() => fileInputRef.current?.click()}>
            <ImageAddRegular fontSize={20} />
          </button>
        </Tooltip>

        {/* Drawing only appears once a take is running. */}
        {busy && state !== 'countdown' && (
          <Tooltip content="Draw on screen (Ctrl+Shift+D)" relationship="label" withArrow>
            <button
              className={`${s.roundBtn} ${drawing ? s.roundBtnActive : ''}`}
              onClick={toggleDrawing}
            >
              <InkStrokeRegular fontSize={20} />
            </button>
          </Tooltip>
        )}

        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Tooltip content="Settings" relationship="label" withArrow>
              <button className={s.roundBtn} aria-label="Settings">
                <SettingsRegular fontSize={20} />
              </button>
            </Tooltip>
          </MenuTrigger>
          <MenuPopover>
            <div className={s.settingsPanel}>
              <Text size={200} weight="semibold">
                Quality
              </Text>
              <Dropdown
                size="small"
                disabled={busy}
                value={
                  QUALITY_PRESETS.find((q) => q.value === settings.recording.quality)?.label ??
                  'Best'
                }
                selectedOptions={[settings.recording.quality]}
                onOptionSelect={(_e, d) =>
                  setSettings((p) => ({
                    ...p,
                    recording: {
                      ...p.recording,
                      quality: (d.optionValue as QualityPreset) ?? 'high',
                    },
                  }))
                }
              >
                {QUALITY_PRESETS.map((q) => (
                  <Option key={q.value} value={q.value}>
                    {q.label}
                  </Option>
                ))}
              </Dropdown>
              {!nativeAvailable && (
                <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  ffmpeg with libplacebo was not found — falling back to the browser
                  encoder, which produces softer text.
                </Text>
              )}

              <Divider />

              <Text size={200} weight="semibold">
                Resolution
              </Text>
              <Dropdown
                size="small"
                disabled={busy}
                value={
                  RESOLUTIONS.find((r) => r.value === settings.recording.resolution)?.label ??
                  'Same as source'
                }
                selectedOptions={[settings.recording.resolution]}
                onOptionSelect={(_e, d) =>
                  setSettings((p) => ({
                    ...p,
                    recording: {
                      ...p.recording,
                      resolution: (d.optionValue as ResolutionPreset) ?? 'source',
                    },
                  }))
                }
              >
                {RESOLUTIONS.map((r) => (
                  <Option key={r.value} value={r.value}>
                    {r.label}
                  </Option>
                ))}
              </Dropdown>

              <Text size={200} weight="semibold">
                Frame rate
              </Text>
              <Dropdown
                size="small"
                disabled={busy}
                value={`${settings.recording.fps} fps`}
                selectedOptions={[String(settings.recording.fps)]}
                onOptionSelect={(_e, d) =>
                  setSettings((p) => ({
                    ...p,
                    recording: { ...p.recording, fps: Number(d.optionValue) || 30 },
                  }))
                }
              >
                {FPS_OPTIONS.map((f) => (
                  <Option key={f} value={String(f)}>
                    {f === 120 ? '120 fps (demanding)' : `${f} fps`}
                  </Option>
                ))}
              </Dropdown>

              <Text size={200} weight="semibold">
                Countdown
              </Text>
              <Dropdown
                size="small"
                disabled={busy}
                value={
                  settings.recording.countdownSeconds === 0
                    ? 'Off'
                    : `${settings.recording.countdownSeconds}s`
                }
                selectedOptions={[String(settings.recording.countdownSeconds)]}
                onOptionSelect={(_e, d) =>
                  setSettings((p) => ({
                    ...p,
                    recording: {
                      ...p.recording,
                      countdownSeconds: Number(d.optionValue) || 0,
                    },
                  }))
                }
              >
                {[0, 3, 5, 10].map((c) => (
                  <Option key={c} value={String(c)}>
                    {c === 0 ? 'Off' : `${c}s`}
                  </Option>
                ))}
              </Dropdown>

              <Switch
                checked={settings.camera.shadow}
                label="Camera drop shadow"
                onChange={(_e, d) =>
                  setSettings((p) => ({ ...p, camera: { ...p.camera, shadow: d.checked } }))
                }
              />

              <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                While recording, the camera appears on your desktop where you can drag and
                resize it, and lands in the video exactly as you see it.
              </Text>

              <Divider />

              <Switch
                checked={settings.recording.hideToolbarFromCapture}
                label="Hide the toolbar from the recording"
                onChange={(_e, d) =>
                  setSettings((p) => ({
                    ...p,
                    recording: { ...p.recording, hideToolbarFromCapture: d.checked },
                  }))
                }
              />
              <Text size={100} style={{ color: tokens.colorNeutralForeground3, marginTop: '-4px' }}>
                {settings.recording.hideToolbarFromCapture
                  ? 'The toolbar stays visible to you but never appears in the video. It is also hidden from Zoom and Teams shares while recording.'
                  : 'The toolbar is recorded along with everything else on screen.'}
              </Text>

              <Divider />

              <Text size={200} weight="semibold">
                Save to
              </Text>
              <div className={s.row}>
                <Text
                  size={100}
                  className={s.name}
                  title={outputDir}
                  style={{ color: tokens.colorNeutralForeground3 }}
                >
                  {outputDir}
                </Text>
                <Button
                  size="small"
                  icon={<FolderOpenRegular />}
                  onClick={async () => {
                    const dir = await window.ez.chooseOutputDir();
                    if (dir) {
                      setOutputDir(dir);
                      setSettings((p) => ({
                        ...p,
                        recording: { ...p.recording, outputDir: dir },
                      }));
                    }
                  }}
                >
                  Change
                </Button>
              </div>
            </div>
          </MenuPopover>
        </Menu>

        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Tooltip content="Keyboard shortcuts" relationship="label" withArrow>
              <button className={s.roundBtn} aria-label="Keyboard shortcuts">
                <QuestionRegular fontSize={20} />
              </button>
            </Tooltip>
          </MenuTrigger>
          <MenuPopover>
            <div className={s.settingsPanel}>
              <div className={s.hotkeyGrid}>
                <span className={s.kbd}>Ctrl+Shift+F9</span>
                <Text size={200}>Record / stop</Text>
                <span className={s.kbd}>Ctrl+Shift+F10</span>
                <Text size={200}>Pause / resume</Text>
                <span className={s.kbd}>Ctrl+Shift+D</span>
                <Text size={200}>Draw</Text>
                <span className={s.kbd}>Ctrl+Shift+E</span>
                <Text size={200}>Erase all</Text>
              </div>
              {hotkeyConflicts.length > 0 && (
                <Text size={100} style={{ color: tokens.colorPaletteRedForeground1 }}>
                  In use by another app: {hotkeyConflicts.join(', ')}
                </Text>
              )}
              <Divider />
              <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
                While drawing — P pen · H highlighter · A arrow · R rect · O ellipse · E eraser ·
                Ctrl+Z undo · Esc done
              </Text>
            </div>
          </MenuPopover>
        </Menu>

        <div className={s.spacer} />

        {/* Elapsed time only once there is something to time. */}
        {busy && state !== 'countdown' && <Text className={s.timer}>{formatTime(elapsed)}</Text>}

        {/* Primary action, in the hang-up position. */}
        {state === 'idle' || state === 'saving' ? (
          <Tooltip content="Start recording (Ctrl+Shift+F9)" relationship="label" withArrow>
            <button
              className={`${s.primaryBtn} ${s.primaryRecord}`}
              onClick={startWithCountdown}
              disabled={state === 'saving' || !settings.recording.screenSourceId}
              aria-label="Start recording"
            >
              <RecordRegular fontSize={22} />
            </button>
          </Tooltip>
        ) : (
          <>
            {state !== 'countdown' && (
              <Tooltip
                content={state === 'paused' ? 'Resume' : 'Pause'}
                relationship="label"
                withArrow
              >
                <button className={s.roundBtn} onClick={togglePause}>
                  {state === 'paused' ? (
                    <PlayRegular fontSize={20} />
                  ) : (
                    <PauseRegular fontSize={20} />
                  )}
                </button>
              </Tooltip>
            )}
            <Tooltip content="Stop recording (Ctrl+Shift+F9)" relationship="label" withArrow>
              <button
                className={`${s.primaryBtn} ${s.primaryStop}`}
                onClick={stopRecording}
                aria-label="Stop recording"
              >
                <StopRegular fontSize={22} />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      <SourceDialog
        open={sourceDialogOpen}
        onOpenChange={setSourceDialogOpen}
        sources={sources}
        loading={sourcesLoading}
        value={settings.recording.screenSourceId}
        onChange={async (id) => {
          // A minimized window has nothing to capture until it is restored;
          // do that before it becomes the selected source. `id` is null when
          // the user clears the selection.
          const picked = id ? sources.find((x) => x.id === id) : undefined;
          if (picked?.minimized && id) {
            const ok = await window.ez.restoreWindow(id);
            if (!ok) {
              notify(
                'Could not restore that window',
                'Open it manually, then press Refresh.',
                'warning',
              );
              return;
            }
            // Its thumbnail and real source id only exist once it is back.
            await refreshSources();
          }
          setSettings((p) => ({ ...p, recording: { ...p.recording, screenSourceId: id } }));
        }}
        onRefresh={refreshSources}
      />

      {countdown > 0 && <div className={s.countdown}>{countdown}</div>}
    </div>
  );
}
