/** Shared contract between the main process, preload bridge and renderers. */

export interface CaptureSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  /** Present for screens, absent for windows. */
  displayId?: string;
  kind: 'screen' | 'window';
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
 * raise it. `crisp` hands capture to ffmpeg (Desktop Duplication + x264 CRF in
 * 4:4:4), which measured 45.0 dB PSNR against 36.4 dB for the same source —
 * the difference between legible and mushy screen text. The cost is that
 * ffmpeg grabs the raw desktop, so it cannot burn in overlays.
 */
export type CaptureEngine = 'overlay' | 'crisp';

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
}

export const QUALITY_PRESETS: Array<{ value: QualityPreset; label: string }> = [
  { value: 'high', label: 'Best — visually lossless' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'compact', label: 'Smallest file' },
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

export interface AppSettings {
  recording: RecordingSettings;
  camera: CameraOverlay;
  images: ImageOverlay[];
  draw: DrawSettings;
}

export type RecordingState = 'idle' | 'countdown' | 'recording' | 'paused' | 'saving';

export interface SaveResult {
  ok: boolean;
  filePath?: string;
  error?: string;
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
    // Default to the browser pipeline: the webcam overlay is the app's whole
    // point, and 'crisp' cannot composite it.
    engine: 'overlay',
    quality: 'high',
    outputDir: null,
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
  },
  images: [],
  draw: {
    tool: 'pen',
    color: '#ff3b30',
    width: 4,
  },
};
