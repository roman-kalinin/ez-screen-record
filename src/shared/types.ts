/** Shared contract between the main process, preload bridge and renderers. */

export interface CaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  /** Present for screens, absent for windows. */
  displayId?: string;
  kind: 'screen' | 'window';
  /**
   * The window is minimized, so it has no thumbnail and cannot be captured
   * until it is restored. Selecting one restores it first.
   */
  minimized?: boolean;
}

export interface MediaDevice {
  deviceId: string;
  label: string;
}

/** Normalised (0..1) rect relative to the capture surface, so overlay
 *  positions survive a change in output resolution. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OverlayShape = 'rounded' | 'circle' | 'square';

export interface CameraOverlay {
  enabled: boolean;
  deviceId: string | null;
  rect: Rect;
  shape: OverlayShape;
  mirrored: boolean;
  /** Drop shadow behind the overlay. */
  shadow: boolean;
  /**
   * Show the camera as a real, draggable window on the desktop while recording,
   * instead of letting ffmpeg composite it internally. ON by default.
   *
   * When on: the webcam is opened once by the renderer (so the app's preview
   * stays live and fully editable during a take) and mirrored into an
   * always-on-top overlay window that ffmpeg's screen capture picks up — the
   * same trick the drawing tool uses. The bubble is then visible on the real
   * desktop and can be dragged/resized in place, live.
   *
   * When off, ffmpeg composites the camera itself. That costs BOTH hard rules
   * and is why this defaults to on: the preview is suspended for the take, and
   * ffmpeg's blend is framesync'd, so the webcam's rate paces the whole
   * recording — a 30fps camera (15fps in dim light) pulled 60fps takes down to
   * ~21 unique fps and 120fps takes to ~13. Only turn it off if the camera
   * bubble must not be visible on the real desktop, and expect the frame rate
   * to follow the webcam.
   */
  showOnScreen: boolean;
  /**
   * Set once `showOnScreen` has been migrated to its new default. Without this
   * the migration would re-apply on every load and the user could never turn
   * the setting back off. Internal; not shown in the UI.
   */
  showOnScreenMigrated?: boolean;
}

export interface ImageOverlay {
  id: string;
  name: string;
  /** data: URL of the loaded image. */
  src: string;
  rect: Rect;
  opacity: number;
  visible: boolean;
}

export type DrawTool = 'pen' | 'highlighter' | 'arrow' | 'rect' | 'ellipse' | 'eraser';

export interface DrawSettings {
  tool: DrawTool;
  color: string;
  width: number;
}

/** Output height in pixels; `source` keeps the capture's native resolution. */
export type ResolutionPreset = 'source' | '2160' | '1440' | '1080' | '720';

/**
 * Which capture engine to use.
 *
 * `overlay` composites the webcam and images live in the browser, but is bound
 * by Chromium's encoder: about 12 Mbps at 1440p, 4:2:0 only, and no way to
 * raise it. `crisp` hands capture to ffmpeg (Desktop Duplication + NVENC or
 * x264 in 4:4:4), which measured 46.4 dB PSNR against 36.3 dB for the same
 * source — the difference between legible and mushy screen text. The cost is
 * that ffmpeg grabs the raw desktop, so it cannot burn in overlays.
 */
export type CaptureEngine = 'overlay' | 'crisp';

export const CAPTURE_ENGINES: Array<{
  value: CaptureEngine;
  label: string;
  detail: string;
}> = [
  {
    value: 'crisp',
    label: 'Best quality — whole screen only',
    detail:
      'ffmpeg captures the desktop in 4:4:4 (46.4 dB PSNR against 36.3 for the browser). ' +
      'Cannot record a single window, and changing source or pausing costs about two seconds ' +
      'while it restarts.',
  },
  {
    value: 'overlay',
    label: 'Flexible — windows, seamless switching',
    detail:
      'Chromium captures, the way Google Meet does. Records a single window, and switching ' +
      'source mid-take is instant with no break in the video. The encoder caps around ' +
      '12 Mbps at 1440p in 4:2:0, so fine text is softer.',
  },
];

export type QualityPreset = 'high' | 'balanced' | 'compact';

export interface RecordingSettings {
  screenSourceId: string | null;
  micDeviceId: string | null;
  micEnabled: boolean;
  systemAudioEnabled: boolean;
  fps: number;
  resolution: ResolutionPreset;
  countdownSeconds: number;
  engine: CaptureEngine;
  quality: QualityPreset;
  /** Where finished recordings are written. */
  outputDir: string | null;
  /**
   * Keep the recording toolbar out of the video.
   *
   * On by default — the recorder's own chrome has no place in a tutorial. The
   * catch is that Windows applies content protection to EVERY capture, so the
   * toolbar also disappears from Zoom/Teams shares while recording, which is
   * why this is a setting rather than always-on.
   */
  hideToolbarFromCapture: boolean;
  /**
   * Silence OS notifications while a take is actually recording, restoring the
   * user's prior state when it stops. Off by default. On Windows this flips the
   * global toast setting; on macOS it runs a user-created "Do Not Disturb"
   * Shortcut. Crash-safe: a run that dies mid-take is restored on next launch.
   */
  doNotDisturbWhileRecording: boolean;
}

/**
 * How much data per pixel — a different axis from RESOLUTIONS, which sets how
 * many pixels there are.
 *
 * These map to CRF and chroma subsampling: 16/4:4:4, 20/4:4:4, 23/4:2:0. A
 * 1440p compact file and a 720p best file can be the same size while failing
 * in opposite ways — one is big but mushy, the other small but sharp. Chroma
 * is the part that matters most for screen text, which is why only the
 * smallest preset drops to 4:2:0.
 */
export const QUALITY_PRESETS: Array<{
  value: QualityPreset;
  label: string;
  detail: string;
}> = [
  {
    value: 'high',
    label: 'Best — visually lossless',
    detail: 'Full colour detail. Text stays razor sharp. Largest files.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    detail: 'Full colour detail, roughly half the size. Text still sharp.',
  },
  {
    value: 'compact',
    label: 'Smallest file',
    detail: 'Reduced colour detail — fine for video, softens small text.',
  },
];

export const RESOLUTIONS: Array<{ value: ResolutionPreset; label: string }> = [
  { value: 'source', label: 'Same as source' },
  { value: '2160', label: '4K · 2160p' },
  { value: '1440', label: 'QHD · 1440p' },
  { value: '1080', label: 'Full HD · 1080p' },
  { value: '720', label: 'HD · 720p' },
];

export const FPS_OPTIONS = [24, 30, 60, 120] as const;

/**
 * Bitrate is derived from resolution and frame rate rather than exposed
 * directly — "8 Mbps" means nothing to most people, while "1080p" does.
 *
 * Screen content needs far more bitrate than camera footage at the same
 * resolution: sharp text and UI edges are exactly what H.264's DCT handles
 * worst, and under-allocating produces the soft, smeared text that makes a
 * tutorial unreadable. 0.35 bits per pixel per frame is a screen-capture
 * target (~39 Mbps at 1440p30); typical video guidance of ~0.1 bpp assumes
 * photographic content and is much too low here.
 */
export function bitrateFor(height: number, fps: number): number {
  const width = Math.round((height * 16) / 9);
  // Frame rate scales sub-linearly — consecutive frames are highly redundant,
  // so doubling fps does not need double the bitrate.
  const fpsFactor = Math.sqrt(fps / 30);
  const raw = width * height * 30 * 0.35 * fpsFactor;
  // Measured: Chromium's encoder treats this as a ceiling it rarely reaches
  // (about 12 Mbps delivered against a 40 Mbps request at 1440p), and it
  // spends less on static content. Asking high is free — the encoder simply
  // uses what it needs — so the ceiling is set generously rather than tightly.
  return Math.round(Math.min(Math.max(raw, 8_000_000), 200_000_000));
}

/** One-click share of a finished recording via GoFile. Anonymous, no account. */
export interface ShareSettings {
  /** Auto-upload finished recordings and copy the share link. */
  autoUpload: boolean;
}

export interface AppSettings {
  recording: RecordingSettings;
  camera: CameraOverlay;
  images: ImageOverlay[];
  draw: DrawSettings;
  /**
   * Show a macOS menu-bar icon with quick actions (Start/Stop, Pause, Toggle
   * Drawing, Settings, Quit). Off by default; macOS-only.
   */
  menuBarIcon: boolean;
  share: ShareSettings;
}

/**
 * `pausing` and `resuming` are the in-between states of a native take.
 *
 * ffmpeg cannot pause: each pause finalises a segment and each resume spawns a
 * fresh process, so both take a moment. Without a state for that moment the
 * button simply looked dead — the click registered but nothing changed until
 * the operation completed.
 */
export type RecordingState =
  | 'idle'
  | 'countdown'
  /**
   * ffmpeg has been asked to start but has not confirmed frames yet. The
   * toolbar is already up (it must be, so it stays out of the capture), so
   * without this state the bar sat there reading 00:00 as though nothing was
   * happening — which is exactly what a slow start looked like.
   */
  | 'starting'
  | 'recording'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'saving';

/**
 * Is a take under way? True for the paused and transitional states too — the
 * recorder exists and holds its devices throughout, so live-edit pushes and
 * mid-take UI must all treat these the same as `recording`.
 */
export function isActiveTake(s: RecordingState): boolean {
  return (
    s === 'recording' ||
    s === 'starting' ||
    s === 'paused' ||
    s === 'pausing' ||
    s === 'resuming'
  );
}

export interface SaveResult {
  ok: boolean;
  filePath?: string;
  error?: string;
  /**
   * Epoch ms at which capture actually began, for a native start. The renderer
   * anchors its clock here rather than to when the IPC call returned, so the
   * startup period is counted rather than lost.
   */
  startedAt?: number;
}

/** Hotkey actions registered globally so they work while other apps are focused. */
export type HotkeyAction = 'toggleRecord' | 'togglePause' | 'toggleDraw' | 'clearDraw';

export const DEFAULT_SETTINGS: AppSettings = {
  recording: {
    screenSourceId: null,
    micDeviceId: null,
    micEnabled: true,
    systemAudioEnabled: true,
    fps: 30,
    resolution: 'source',
    countdownSeconds: 3,
    // Default to the browser ('overlay') engine: it is the most stable across
    // platforms — it records single windows, switches source mid-take with no
    // seam, and does not depend on the OS hardware-encoder path that makes the
    // ffmpeg engine stutter on some machines (notably macOS/VideoToolbox).
    // Switch to 'crisp' for maximum text sharpness when capturing a whole
    // screen on a machine whose ffmpeg encode keeps up in real time.
    engine: 'overlay',
    quality: 'high',
    outputDir: null,
    hideToolbarFromCapture: true,
    doNotDisturbWhileRecording: false,
  },
  camera: {
    enabled: true,
    deviceId: null,
    // Bottom-right, inset from both edges. A 16:9 camera box in normalised
    // coords: w 0.22 against h 0.22*(16/9) ≈ 0.39 renders as a true rectangle.
    rect: { x: 0.74, y: 0.55, w: 0.22, h: 0.39 },
    shape: 'rounded',
    mirrored: true,
    shadow: true,
    showOnScreen: true,
  },
  images: [],
  draw: {
    tool: 'pen',
    color: '#ff3b30',
    width: 4,
  },
  menuBarIcon: false,
  share: {
    autoUpload: false,
  },
};
