/**
 * Website demo shim. Stands in for the Electron preload (`window.ez`) and for
 * the camera, microphone and screen, so the real renderer UI can run inside a
 * plain web page (the landing page embeds it in iframes and drives it with a
 * scripted cursor). Imported before the real entry point; never shipped in the
 * app itself.
 */
import { DEFAULT_SETTINGS, type AppSettings, type CaptureSource } from '../../shared/types';

type Role = 'control' | 'toolbar';
const role: Role = (document.documentElement.dataset.role as Role) || 'control';

// ---------------------------------------------------------------------------
// Message bus between the demo frames (control window <-> toolbar) and the page
// ---------------------------------------------------------------------------
const bus = new BroadcastChannel('ez-demo');
const listeners = new Map<string, Set<(p: any) => void>>();
bus.onmessage = (e) => {
  const { to, channel, payload } = e.data || {};
  if (to !== role) return;
  listeners.get(channel)?.forEach((cb) => cb(payload));
};
const sendTo = (to: Role, channel: string, payload?: unknown) => {
  bus.postMessage({ to, channel, payload });
  return Promise.resolve(true);
};
/** Tell the hosting page about window-level changes (toolbar mode etc.). */
const toPage = (type: string, data?: unknown) => {
  window.parent?.postMessage({ ezDemo: true, type, data }, '*');
  return Promise.resolve(true);
};

// ---------------------------------------------------------------------------
// Fake media: an animated desktop, a webcam and silent audio
// ---------------------------------------------------------------------------
const DESK_W = 1600;
const DESK_H = 1000;

function drawDesktop(ctx: CanvasRenderingContext2D, t: number) {
  const W = DESK_W, H = DESK_H;
  // Wallpaper
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1c2a52');
  g.addColorStop(0.55, '#3a2a63');
  g.addColorStop(1, '#5b2d55');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.25, H * 0.2, 0, W * 0.25, H * 0.2, W * 0.6);
  glow.addColorStop(0, 'rgba(120,150,255,.35)');
  glow.addColorStop(1, 'rgba(120,150,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // An editor window that is being typed into
  const x = 150, y = 110, w = 1300, h = 760;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  roundRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = '#16171d';
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, x, y, w, h, 14);
  ctx.clip();
  ctx.fillStyle = '#20212a';
  ctx.fillRect(x, y, w, 44);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(x + 26 + i * 22, y + 22, 7, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
  ctx.fillStyle = '#8b8d9b';
  ctx.font = '500 17px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('tutorial.ts', x + 104, y + 28);
  // sidebar
  ctx.fillStyle = '#1b1c23';
  ctx.fillRect(x, y + 44, 230, h - 44);
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = i === 2 ? '#3b4170' : '#2a2c38';
    roundRect(ctx, x + 22, y + 78 + i * 38, 120 + ((i * 37) % 70), 12, 6);
    ctx.fill();
  }
  // code lines, typed in over time
  const colors = ['#6c7cff', '#2e3142', '#b26bdc', '#2e3142', '#46a37f', '#2e3142', '#e0a35a', '#2e3142', '#6c7cff', '#2e3142', '#2e3142', '#b26bdc', '#2e3142', '#46a37f'];
  const widths = [260, 520, 380, 610, 220, 470, 300, 560, 340, 420, 640, 280, 500, 360];
  const cycle = 12;
  const progress = ((t / 1000) % cycle) / cycle; // 0..1
  const total = widths.reduce((a, b) => a + b, 0);
  let budget = progress * total * 1.15;
  let cx = 0, cy = 0;
  for (let i = 0; i < widths.length; i++) {
    const ly = y + 86 + i * 44;
    const indent = [0, 40, 40, 80, 80, 40, 0, 40, 80, 80, 40, 0, 40, 0][i];
    const lw = Math.max(0, Math.min(widths[i], budget));
    budget -= widths[i];
    ctx.fillStyle = '#4a4c5c';
    ctx.font = '15px Consolas, monospace';
    ctx.fillText(String(i + 1).padStart(2, ' '), x + 252, ly + 11);
    if (lw > 0) {
      ctx.fillStyle = colors[i];
      roundRect(ctx, x + 300 + indent, ly, lw, 14, 7);
      ctx.fill();
      cx = x + 300 + indent + lw + 6;
      cy = ly - 4;
    }
  }
  // caret
  if (Math.floor(t / 500) % 2 === 0) {
    ctx.fillStyle = '#dfe3ff';
    ctx.fillRect(cx, cy, 3, 22);
  }
  ctx.restore();

  // Taskbar
  ctx.fillStyle = 'rgba(20,20,28,.82)';
  ctx.fillRect(0, H - 56, W, 56);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i === 2 ? '#5d6cf0' : 'rgba(255,255,255,.18)';
    roundRect(ctx, W / 2 - 150 + i * 52, H - 42, 30, 30, 8);
    ctx.fill();
  }
}

function drawCamera(ctx: CanvasRenderingContext2D, t: number) {
  const W = 640, H = 360;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#4b5a80');
  g.addColorStop(1, '#2a3048');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // soft window light
  const l = ctx.createRadialGradient(W * 0.8, H * 0.1, 0, W * 0.8, H * 0.1, W * 0.7);
  l.addColorStop(0, 'rgba(255,220,180,.35)');
  l.addColorStop(1, 'rgba(255,220,180,0)');
  ctx.fillStyle = l;
  ctx.fillRect(0, 0, W, H);
  // a person, breathing and nodding a little
  const bob = Math.sin(t / 700) * 4;
  const tilt = Math.sin(t / 1300) * 0.05;
  ctx.save();
  ctx.translate(W / 2, H * 0.48 + bob);
  ctx.rotate(tilt);
  ctx.fillStyle = '#c99a7d';
  ctx.beginPath();
  ctx.ellipse(0, 0, 58, 70, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3b2a22';
  ctx.beginPath();
  ctx.ellipse(0, -38, 62, 40, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#2f3a5c';
  ctx.beginPath();
  ctx.ellipse(W / 2, H + 40 + bob / 2, 170, 120, 0, Math.PI, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function animatedCanvas(w: number, h: number, draw: (c: CanvasRenderingContext2D, t: number) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const start = performance.now();
  // setInterval rather than rAF: keeps drawing when the frame is hidden.
  draw(ctx, 0);
  setInterval(() => draw(ctx, performance.now() - start), 1000 / 30);
  return canvas;
}

let desktopCanvas: HTMLCanvasElement | null = null;
let cameraCanvas: HTMLCanvasElement | null = null;
const getDesktop = () => (desktopCanvas ??= animatedCanvas(DESK_W, DESK_H, drawDesktop));
const getCamera = () => (cameraCanvas ??= animatedCanvas(640, 360, drawCamera));
/** The page draws the same desktop behind the demo windows. */
(window as any).__ezDesktopCanvas = getDesktop;

let audioCtx: AudioContext | null = null;
function silentAudioTrack(): MediaStreamTrack {
  audioCtx ??= new AudioContext();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  const dest = audioCtx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  return dest.stream.getAudioTracks()[0];
}

function fakeStream(constraints: any): MediaStream {
  const out = new MediaStream();
  const v = constraints?.video;
  if (v) {
    const isDesktop = v.mandatory?.chromeMediaSource === 'desktop' || constraints.__display;
    const canvas = isDesktop ? getDesktop() : getCamera();
    canvas.captureStream(30).getVideoTracks().forEach((t) => out.addTrack(t));
  }
  if (constraints?.audio) out.addTrack(silentAudioTrack());
  return out;
}

const md = navigator.mediaDevices as MediaDevices;
md.getUserMedia = async (c?: MediaStreamConstraints) => fakeStream(c);
md.getDisplayMedia = async (c?: DisplayMediaStreamOptions) => fakeStream({ ...(c as any), __display: true });
md.enumerateDevices = async () =>
  [
    { deviceId: 'cam-1', kind: 'videoinput', label: 'Integrated Webcam', groupId: 'g1' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'Microphone (USB Audio)', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d })) as unknown as MediaDeviceInfo[];

// No real encoding in the demo: a stand-in MediaRecorder that hands back a
// small placeholder blob, so a take "saves" without burning CPU on the page.
class DemoMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  state: RecordingState = 'inactive';
  mimeType: string;
  stream: MediaStream;
  ondataavailable: ((e: BlobEvent) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onstart: ((e: Event) => void) | null = null;
  onpause: ((e: Event) => void) | null = null;
  onresume: ((e: Event) => void) | null = null;
  private timer: number | undefined;
  constructor(stream: MediaStream, opts?: MediaRecorderOptions) {
    super();
    this.stream = stream;
    this.mimeType = opts?.mimeType || 'video/webm';
  }
  private emitData() {
    const e = new Event('dataavailable') as BlobEvent;
    Object.defineProperty(e, 'data', { value: new Blob([new Uint8Array(4096)], { type: this.mimeType }) });
    this.ondataavailable?.(e);
    this.dispatchEvent(e);
  }
  private fire(name: 'start' | 'stop' | 'pause' | 'resume') {
    const e = new Event(name);
    (this as any)['on' + name]?.(e);
    this.dispatchEvent(e);
  }
  start(timeslice = 1000) {
    this.state = 'recording';
    this.timer = window.setInterval(() => this.state === 'recording' && this.emitData(), timeslice);
    this.fire('start');
  }
  pause() {
    this.state = 'paused';
    this.fire('pause');
  }
  resume() {
    this.state = 'recording';
    this.fire('resume');
  }
  requestData() {
    this.emitData();
  }
  stop() {
    if (this.state === 'inactive') return;
    clearInterval(this.timer);
    this.emitData();
    this.state = 'inactive';
    setTimeout(() => this.fire('stop'), 0);
  }
}
(window as any).MediaRecorder = DemoMediaRecorder;

// ---------------------------------------------------------------------------
// The preload API
// ---------------------------------------------------------------------------
function thumb(): string {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 200;
  c.getContext('2d')!.drawImage(getDesktop(), 0, 0, 320, 200);
  return c.toDataURL('image/jpeg', 0.8);
}

const SOURCES = (): CaptureSource[] => [
  { id: 'screen:1:0', name: 'Entire screen', kind: 'screen', displayId: '1', thumbnailDataUrl: thumb() },
  { id: 'window:2:0', name: 'tutorial.ts - Editor', kind: 'window', thumbnailDataUrl: thumb() },
];

// The story the page tells starts with everything switched off.
const settings: AppSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
settings.recording.micEnabled = false;
settings.recording.systemAudioEnabled = false;
settings.camera.enabled = false;
settings.recording.countdownSeconds = 3;
settings.recording.outputDir = 'C:\\Users\\you\\Videos\\Ez Screen Record';

const ok = () => Promise.resolve(true);
const api = {
  listSources: async () => SOURCES(),
  restoreWindow: ok,
  permissions: { screenStatus: async () => 'granted', openScreenSettings: ok },
  getSettings: async () => settings,
  setSettings: ok,
  setRecordingState: ok,
  overlay: { show: ok, hide: ok, setInteractive: ok, focus: ok, send: ok },
  control: { send: (ch: string, p?: unknown) => sendTo('control', ch, p) },
  toolbar: {
    setInteractive: ok,
    send: (ch: string, p?: unknown) => sendTo('toolbar', ch, p),
  },
  cameraOverlay: { show: ok, hide: ok, setInteractive: ok, send: ok },
  window: {
    minimize: ok,
    close: ok,
    setAlwaysOnTop: ok,
    setToolbarMode: (on: boolean) => toPage('toolbarMode', on),
    setHideFromCapture: ok,
    setCaptureHidden: ok,
  },
  saveRecording: async (_buf: ArrayBuffer, name: string) => {
    toPage('saved');
    return { ok: true, filePath: `C:\\Users\\you\\Videos\\Ez Screen Record\\${name.replace(/\.webm$/i, '.mp4')}` };
  },
  native: {
    available: async () => false,
    canPause: async () => false,
    audioDevices: async () => [],
    devices: async () => ({ audio: [], video: [] }),
    start: async () => ({ ok: false }),
    stop: async () => ({ ok: false }),
    reconfigure: async () => ({ ok: false }),
    pause: async () => ({ ok: false, paused: false }),
    resume: async () => ({ ok: false, paused: false }),
  },
  dnd: { enable: ok, disable: ok },
  share: { upload: async () => ({ ok: false, error: 'Not available in the demo' }) },
  editor: {
    open: ok,
    session: async () => null,
    chooseOutput: async () => null,
    export: async () => ({ ok: false }),
    cancelExport: ok,
    window: async () => {},
  },
  chooseOutputDir: async () => null,
  defaultOutputDir: async () => settings.recording.outputDir!,
  appVersion: async () => '1.5.1',
  appearance: async () => ({ accent: '#0078d4', dark: true, platform: 'win32' }),
  revealFile: ok,
  openPath: ok,
  openOutputFolder: async () => '',
  on: (channel: string, cb: (p: any) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(cb);
    return () => {
      listeners.get(channel)?.delete(cb);
    };
  },
};

(window as any).ez = api;
