import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell,
  dialog,
  systemPreferences,
  nativeTheme,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { CaptureSource, AppSettings } from '../shared/types';
import { loadSettings, saveSettings, defaultOutputDir } from './settings';
import { listAllWindows, restoreWindowForCapture } from './window-list';
import { remuxToMp4 } from './remux';
import {
  NativeRecorder,
  listDshowAudioDevices,
  listDshowDevices,
  type NativeCameraOptions,
} from './native-recorder';

const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER = 'http://localhost:5273';

/**
 * Logging that can never take the app down.
 *
 * When the app is launched detached (or its parent terminal closes) stdout and
 * stderr have no reader, and writing to them throws EPIPE. Chromium emits a
 * continuous stream of wgc_capture_session warnings while a screen capture is
 * running, so an unguarded console call is guaranteed to hit this and crash
 * the main process mid-recording.
 */
function safeLog(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
  try {
    console[level](...args);
  } catch {
    /* no reader on the pipe — dropping the message is the correct outcome */
  }
}

// Swallow EPIPE globally too: it can surface from Chromium's own writes, which
// never pass through safeLog.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

let controlWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
/**
 * On-screen camera bubble, shown while recording when the user opts to keep the
 * camera visible on the desktop (so the app preview stays live and ffmpeg
 * captures the bubble as real screen pixels). Deliberately NOT content-
 * protected — being captured is the whole point.
 */
let cameraOverlayWindow: BrowserWindow | null = null;
/** Zoom-style control strip shown while recording. See createToolbarWindow. */
let toolbarWindow: BrowserWindow | null = null;
/** Active ffmpeg-backed recording, when the crisp engine is in use. */
let nativeRecorder: NativeRecorder | null = null;

// Compiled layout is dist-main/main/main.js, so the app root is two levels up.
const APP_ROOT = path.join(__dirname, '..', '..');

/** Resolve a renderer entry to either the dev server or the built file. */
function rendererUrl(page: 'index' | 'overlay' | 'camera' | 'toolbar'): string {
  if (isDev) return `${DEV_SERVER}/${page}.html`;
  return `file://${path.join(APP_ROOT, 'dist', `${page}.html`)}`;
}

function preloadPath(): string {
  return path.join(APP_ROOT, 'dist-main', 'preload', 'preload.js');
}

function createControlWindow() {
  // Place the panel against the right edge of the work area — out of the way
  // of whatever is being demonstrated, and sized in DIPs so it stays compact
  // regardless of the display's scale factor.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  // Landscape: the 16:9 preview is the main content, so the window is sized
  // around it rather than being a tall narrow panel with dead space below.
  // Height = title bar + preview + control bar, near enough.
  const winWidth = Math.min(880, workArea.width - 80);
  const winHeight = Math.round(winWidth * 0.5625) + 130;

  controlWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.max(0, Math.round((workArea.width - winWidth) / 2)),
    y: Math.max(0, Math.round((workArea.height - winHeight) / 2)),
    minWidth: 560,
    minHeight: 420,
    show: false,
    frame: false,
    // Deliberately NOT using backgroundMaterial:'mica'. Mica conflicts with
    // setContentProtection — the combination is unstable and lets the window
    // appear in its own capture, producing the recursive-mirror effect. A
    // solid WinUI surface colour is worth far more than the backdrop here,
    // because keeping the recorder out of the recording is the whole point.
    backgroundColor: '#202020',
    transparent: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Renderer diagnostics, dev only. In production this forwarded Chromium's
  // continuous capture warnings to a pipe with no reader, which is what
  // crashed the app with EPIPE during recording.
  if (isDev) {
    controlWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) safeLog('error', `[renderer] ${message} (${sourceId}:${line})`);
    });
  }
  controlWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    safeLog('error', `[renderer] failed to load: ${desc} (${code})`);
  });
  controlWindow.webContents.on('render-process-gone', (_e, details) => {
    safeLog('error', `[renderer] process gone: ${details.reason}`);
  });

  controlWindow.loadURL(rendererUrl('index'));
  controlWindow.once('ready-to-show', () => {
    // Keep the panel out of every capture by default, so the live preview
    // shows the user's actual desktop instead of an infinite mirror of itself.
    // EZ_NO_CONTENT_PROTECTION disables this for screenshot-based testing.
    if (!process.env.EZ_NO_CONTENT_PROTECTION) {
      controlWindow?.setContentProtection(true);
    }
    controlWindow?.show();
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
    // The overlays are child concepts; without the controller they are orphaned.
    overlayWindow?.close();
    cameraOverlayWindow?.close();
    toolbarWindow?.close();
  });

  // Open external links in the real browser instead of a new Electron window.
  controlWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * The annotation overlay: a transparent, always-on-top, full-desktop window.
 * It starts click-through so it never interferes with normal desktop use, and
 * only accepts input while the user has a drawing tool active.
 */
function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;

  // Span the entire virtual desktop so drawing works across multiple monitors.
  const displays = screen.getAllDisplays();
  const bounds = displays.reduce(
    (acc, d) => ({
      x: Math.min(acc.x, d.bounds.x),
      y: Math.min(acc.y, d.bounds.y),
      right: Math.max(acc.right, d.bounds.x + d.bounds.width),
      bottom: Math.max(acc.bottom, d.bounds.y + d.bounds.height),
    }),
    { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
  );

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.right - bounds.x,
    height: bounds.bottom - bounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    // `toolbar` keeps it out of the alt-tab ring on Windows.
    type: 'toolbar',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  overlayWindow.loadURL(rendererUrl('overlay'));
  // Sit above fullscreen apps and the taskbar.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Start fully click-through; the renderer toggles this as tools activate.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // SAFETY: this window covers the entire desktop and is not alt-tabbable, so
  // if it were ever left swallowing mouse input the machine would be unusable
  // until the app was killed from Task Manager. Force click-through back on at
  // every point where the renderer might have lost track of the flag.
  const forceClickThrough = () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  };
  overlayWindow.webContents.on('did-finish-load', forceClickThrough);
  overlayWindow.webContents.on('render-process-gone', forceClickThrough);
  overlayWindow.webContents.on('unresponsive', forceClickThrough);
  overlayWindow.on('hide', forceClickThrough);

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

/** Re-fit the overlay if the monitor layout changes mid-session. */
function refitOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const b = displays.reduce(
    (acc, d) => ({
      x: Math.min(acc.x, d.bounds.x),
      y: Math.min(acc.y, d.bounds.y),
      right: Math.max(acc.right, d.bounds.x + d.bounds.width),
      bottom: Math.max(acc.bottom, d.bounds.y + d.bounds.height),
    }),
    { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
  );
  overlayWindow.setBounds({
    x: b.x,
    y: b.y,
    width: b.right - b.x,
    height: b.bottom - b.y,
  });
}

/**
 * The on-screen camera window. Modelled on the drawing overlay — transparent,
 * always-on-top, click-through — but crucially it is NOT content-protected, so
 * ffmpeg's screen capture records the camera bubble. It covers a single display
 * (the one being recorded) rather than the whole virtual desktop, so the bubble
 * lands in the recording's coordinate space.
 */
function createCameraOverlayWindow(display: Electron.Display): BrowserWindow {
  if (cameraOverlayWindow && !cameraOverlayWindow.isDestroyed()) {
    cameraOverlayWindow.setBounds(display.bounds);
    return cameraOverlayWindow;
  }

  cameraOverlayWindow = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    type: 'toolbar',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  cameraOverlayWindow.loadURL(rendererUrl('camera'));
  cameraOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  cameraOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Start click-through; the renderer enables interaction only over the bubble.
  cameraOverlayWindow.setIgnoreMouseEvents(true, { forward: true });

  // Same safety net as the drawing overlay: never leave a desktop-covering
  // window swallowing input if the renderer loses track of the flag.
  const forceClickThrough = () => {
    if (cameraOverlayWindow && !cameraOverlayWindow.isDestroyed()) {
      cameraOverlayWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  };
  cameraOverlayWindow.webContents.on('render-process-gone', forceClickThrough);
  cameraOverlayWindow.webContents.on('unresponsive', forceClickThrough);
  cameraOverlayWindow.on('hide', forceClickThrough);

  cameraOverlayWindow.on('closed', () => {
    cameraOverlayWindow = null;
  });

  return cameraOverlayWindow;
}

/**
 * Whether the toolbar is hidden from screen capture during a take.
 *
 * On by default: the recorder's own chrome has no business appearing in a
 * tutorial. The cost is that content protection applies to EVERY capture, so
 * the toolbar also vanishes from Zoom/Teams shares while recording — which is
 * why this is exposed as a setting rather than hardcoded.
 */
let hideToolbarFromCapture = true;

/** Whether the user pinned the window, so toolbar mode does not un-pin it. */
let userPinnedOnTop = false;

/**
 * The recording toolbar: a transparent, full-width, always-on-top strip that
 * hosts the Zoom-style control bar while a take is running.
 *
 * It is a SEPARATE window rather than the control window resized down, and the
 * reason is popups. A 68px-tall window clips everything it renders — dropdowns
 * opened inside it, tooltips, the source picker — because a BrowserWindow
 * cannot draw outside its own bounds. Giving the toolbar a window that spans
 * the display and is transparent everywhere except the bar itself lets menus
 * and tooltips lay out normally in the empty space around it.
 *
 * Click-through by default, so the transparent area never swallows input; the
 * renderer opts the bar back in.
 */
function createToolbarWindow(display: Electron.Display): BrowserWindow {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.setBounds(display.bounds);
    return toolbarWindow;
  }

  toolbarWindow = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    type: 'toolbar',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  toolbarWindow.loadURL(rendererUrl('toolbar'));
  toolbarWindow.setAlwaysOnTop(true, 'screen-saver');
  toolbarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toolbarWindow.setIgnoreMouseEvents(true, { forward: true });

  const forceClickThrough = () => {
    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
      toolbarWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  };
  toolbarWindow.webContents.on('render-process-gone', forceClickThrough);
  toolbarWindow.webContents.on('unresponsive', forceClickThrough);
  toolbarWindow.on('hide', forceClickThrough);

  toolbarWindow.on('closed', () => {
    toolbarWindow = null;
  });

  return toolbarWindow;
}

function enterToolbarMode() {
  if (!controlWindow || controlWindow.isDestroyed()) return;

  const win = createToolbarWindow(screen.getPrimaryDisplay());
  if (!process.env.EZ_NO_CONTENT_PROTECTION) {
    win.setContentProtection(hideToolbarFromCapture);
  }
  win.showInactive();
  // The main window steps aside for the take; the toolbar replaces it.
  controlWindow.hide();
}

function exitToolbarMode() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.setIgnoreMouseEvents(true, { forward: true });
    toolbarWindow.hide();
  }
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.show();
  if (!userPinnedOnTop) controlWindow.setAlwaysOnTop(false);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('sources:list', async (): Promise<CaptureSource[]> => {
    // NOTE: minimized windows are absent from this list, and that is
    // Chromium's behaviour rather than something we filter. A minimized window
    // has no composited pixels, so the capturer cannot enumerate or record it.
    // Verified on a desktop with 8 open windows: 4 were minimized and only the
    // other 4 were returned. Neither the WGC feature flags nor disabling them
    // changes this. The user-facing fix is to say so in the picker rather than
    // silently show a short list — restore the window and refresh.
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });

    const listed = sources
      // Filter out our own windows so the user can't record the recorder.
      .filter((s) => !/^Ez Screen Record/.test(s.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        displayId: s.display_id || undefined,
        kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
        minimized: false,
      }));

    // Add back the minimized windows Chromium dropped. They have no thumbnail
    // (nothing is composited while minimized) and are marked so the picker can
    // show them differently; selecting one restores it first.
    const seen = new Set(
      listed.map((s) => s.id.split(':')[1]).filter(Boolean),
    );
    for (const win of await listAllWindows()) {
      if (!win.minimized) continue;
      if (seen.has(win.handle)) continue;
      if (/^Ez Screen Record/.test(win.title)) continue;
      listed.push({
        id: `window:${win.handle}:0`,
        name: win.title,
        thumbnailDataUrl: '',
        displayId: undefined,
        kind: 'window' as const,
        minimized: true,
      });
    }

    return listed;
  });

  /** Un-minimize a window so it can be captured. See window-list.ts. */
  ipcMain.handle('sources:restoreWindow', async (_e, sourceId: string) => {
    const handle = sourceId.split(':')[1];
    if (!handle) return false;
    return restoreWindowForCapture(handle);
  });

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, s: AppSettings) => {
    saveSettings(s);
    return true;
  });

  // --- Overlay control -----------------------------------------------------
  ipcMain.handle('overlay:show', () => {
    const win = createOverlayWindow();
    refitOverlay();
    win.showInactive(); // never steal focus from what the user is demoing
    return true;
  });

  /** Focus the overlay so it receives key events (Esc, tool shortcuts). */
  ipcMain.handle('overlay:focus', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    overlayWindow.focus();
    return true;
  });

  ipcMain.handle('overlay:hide', () => {
    // Restore click-through before hiding, never after — if the hide fails we
    // must not be left with an input-swallowing window.
    overlayWindow?.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow?.hide();
    return true;
  });

  /** Toggle whether the overlay swallows mouse input (drawing) or passes it
   *  through (normal desktop use). */
  ipcMain.handle('overlay:setInteractive', (_e, interactive: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    if (interactive) overlayWindow.focus();
    return true;
  });

  /** Relay messages from the control window into the overlay renderer. */
  ipcMain.handle('overlay:send', (_e, channel: string, payload: unknown) => {
    overlayWindow?.webContents.send(channel, payload);
    return true;
  });

  /** Relay from overlay back to the controller (e.g. draw-mode exited). */
  ipcMain.handle('control:send', (_e, channel: string, payload: unknown) => {
    controlWindow?.webContents.send(channel, payload);
    return true;
  });

  // --- On-screen camera overlay --------------------------------------------
  /**
   * Show the camera bubble on the recorded display. `displayId` matches the
   * capture source; we fall back to the primary display if it can't be
   * resolved (e.g. a window source rather than a whole screen).
   */
  ipcMain.handle('cameraOverlay:show', (_e, displayId?: string) => {
    const displays = screen.getAllDisplays();
    const target =
      (displayId && displays.find((d) => String(d.id) === String(displayId))) ||
      screen.getPrimaryDisplay();
    const win = createCameraOverlayWindow(target);
    win.showInactive(); // never steal focus from what's being demonstrated
    return true;
  });

  ipcMain.handle('cameraOverlay:hide', () => {
    // Restore click-through before hiding, never after.
    cameraOverlayWindow?.setIgnoreMouseEvents(true, { forward: true });
    cameraOverlayWindow?.hide();
    return true;
  });

  /** Toggle whether the camera overlay swallows mouse input. The renderer turns
   *  this on only while the pointer is over the bubble (so the rest of the
   *  desktop stays usable), and off again on leave. */
  ipcMain.handle('cameraOverlay:setInteractive', (_e, interactive: boolean) => {
    if (!cameraOverlayWindow || cameraOverlayWindow.isDestroyed()) return false;
    cameraOverlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    return true;
  });

  /** Relay control -> camera overlay (camera config + rect updates). */
  ipcMain.handle('cameraOverlay:send', (_e, channel: string, payload: unknown) => {
    cameraOverlayWindow?.webContents.send(channel, payload);
    return true;
  });

  /**
   * Hide the control panel from the capture while recording, so the recorder
   * itself never appears in the tutorial. setContentProtection makes the
   * window invisible to screen capture without hiding it from the user —
   * so the transport controls stay usable mid-take.
   */
  ipcMain.handle('win:setCaptureHidden', (_e, hidden: boolean) => {
    controlWindow?.setContentProtection(hidden);
    return hidden;
  });

  // --- Window chrome -------------------------------------------------------
  ipcMain.handle('win:minimize', () => controlWindow?.minimize());

  /**
   * Closing mid-recording would destroy the renderer with buffered chunks
   * still unwritten, losing the whole take silently. Ask first.
   */
  ipcMain.handle('win:close', async (_e, isRecording: boolean) => {
    if (isRecording && controlWindow) {
      const { response } = await dialog.showMessageBox(controlWindow, {
        type: 'warning',
        buttons: ['Keep recording', 'Discard and quit'],
        defaultId: 0,
        cancelId: 0,
        title: 'Recording in progress',
        message: 'A recording is still running.',
        detail: 'Quitting now discards it. Stop the recording first to save it.',
      });
      if (response === 0) return false;
    }
    controlWindow?.close();
    return true;
  });
  ipcMain.handle('win:setAlwaysOnTop', (_e, flag: boolean) => {
    userPinnedOnTop = flag;
    controlWindow?.setAlwaysOnTop(flag);
    return flag;
  });

  /** Collapse to / restore from the recording toolbar. */
  ipcMain.handle('win:setToolbarMode', (_e, on: boolean) => {
    if (on) enterToolbarMode();
    else exitToolbarMode();
    return on;
  });

  /** Whether the toolbar is invisible to screen capture during a take. */
  ipcMain.handle('win:setHideFromCapture', (_e, hide: boolean) => {
    hideToolbarFromCapture = hide;
    if (toolbarWindow && !toolbarWindow.isDestroyed() &&
        !process.env.EZ_NO_CONTENT_PROTECTION) {
      // Applies immediately when toggled mid-take.
      toolbarWindow.setContentProtection(hide);
    }
    return hide;
  });

  /**
   * Let the toolbar swallow input only where it actually draws. The window
   * spans the display so its popups are not clipped, so the transparent
   * remainder must stay click-through or the desktop becomes unusable.
   */
  ipcMain.handle('toolbar:setInteractive', (_e, interactive: boolean) => {
    if (!toolbarWindow || toolbarWindow.isDestroyed()) return false;
    toolbarWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    return true;
  });

  /** Relay control window -> toolbar (state, settings, device lists). */
  ipcMain.handle('toolbar:send', (_e, channel: string, payload: unknown) => {
    toolbarWindow?.webContents.send(channel, payload);
    return true;
  });

  // --- Saving --------------------------------------------------------------
  ipcMain.handle(
    'recording:save',
    async (_e, buffer: ArrayBuffer, suggestedName: string, outputDir: string | null) => {
      try {
        const dir = outputDir || defaultOutputDir();
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, suggestedName);
        fs.writeFileSync(filePath, Buffer.from(buffer));

        // Give the renderer the finished path only after remuxing, so the
        // "Show in folder" link always points at the file that survives.
        const finalPath = await remuxToMp4(filePath);
        return { ok: true, filePath: finalPath };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  // --- Native (crisp) capture ---------------------------------------------
  ipcMain.handle('native:available', () => NativeRecorder.isAvailable());
  ipcMain.handle('native:devices', () => listDshowDevices());
  ipcMain.handle('native:audioDevices', () => listDshowAudioDevices());

  ipcMain.handle(
    'native:start',
    async (
      _e,
      opts: {
        fps: number;
        height?: number;
        quality: 'high' | 'balanced' | 'compact';
        micDeviceName?: string | null;
        camera?: NativeCameraOptions | null;
        outputDir: string | null;
      },
    ) => {
      try {
        if (nativeRecorder?.isRecording) {
          return { ok: false, error: 'A recording is already running.' };
        }
        const dir = opts.outputDir || defaultOutputDir();
        const stamp = new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .replace('T', '_')
          .slice(0, 19);
        const outputPath = path.join(dir, `recording_${stamp}.mp4`);

        nativeRecorder = new NativeRecorder();
        await nativeRecorder.start({
          outputPath,
          fps: opts.fps,
          height: opts.height,
          quality: opts.quality,
          micDeviceName: opts.micDeviceName ?? null,
          camera: opts.camera ?? null,
        });
        return { ok: true, filePath: outputPath };
      } catch (err) {
        nativeRecorder = null;
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('native:stop', async () => {
    try {
      if (!nativeRecorder) return { ok: false, error: 'Not recording.' };
      const filePath = await nativeRecorder.stop();
      nativeRecorder = null;
      return { ok: true, filePath };
    } catch (err) {
      nativeRecorder = null;
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('dialog:chooseOutputDir', async () => {
    if (!controlWindow) return null;
    const res = await dialog.showOpenDialog(controlWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose where recordings are saved',
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('shell:revealFile', (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p));

  ipcMain.handle('paths:defaultOutputDir', () => defaultOutputDir());

  /**
   * The user's Windows accent colour and light/dark preference, so the app
   * themes itself like a native one. getAccentColor returns RRGGBBAA — the
   * alpha is dropped. (Electron's docs mark this macOS-only; it does work on
   * Windows, but fall back to Windows blue if it ever throws.)
   */
  ipcMain.handle('system:appearance', () => {
    let accent = '#0078d4';
    try {
      const raw = systemPreferences.getAccentColor();
      if (raw && raw.length >= 6) accent = `#${raw.slice(0, 6)}`;
    } catch {
      /* keep the fallback */
    }
    return { accent, dark: nativeTheme.shouldUseDarkColors };
  });
}

/** Global hotkeys work even when the app is not focused — essential while
 *  the user is demoing another application. */
function registerHotkeys() {
  const send = (action: string) => () => controlWindow?.webContents.send('hotkey', action);

  // One consistent Ctrl+Shift prefix, all left-hand reachable:
  //  - Win+* is reserved by the OS, Ctrl+Alt+* collides with AltGr on
  //    international layouts, and Alt+Shift+* fights the language switcher.
  //  - Bare F-keys are unusable: F10 opens the menu bar in every Win32 app,
  //    F9 is Excel recalc, and F8/F9/F10 are debugger step keys.
  //  - F-keys for the transport (hard to hit by accident), letters for
  //    drawing (frequent, mnemonic: D=draw, E=erase).
  const bindings: Array<[string, string]> = [
    ['CommandOrControl+Shift+F9', 'toggleRecord'],
    ['CommandOrControl+Shift+F10', 'togglePause'],
    ['CommandOrControl+Shift+D', 'toggleDraw'],
    ['CommandOrControl+Shift+E', 'clearDraw'],
  ];

  const failed: string[] = [];
  for (const [accel, action] of bindings) {
    if (!globalShortcut.register(accel, send(action))) failed.push(accel);
  }

  // Panic key: Esc always restores click-through, whatever state the overlay
  // renderer thinks it is in. It must also reset the renderer's own state —
  // otherwise `active` stays true, the next show() never re-grants mouse
  // input, and the old strokes are still on the canvas.
  globalShortcut.register('Escape', () => {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
      overlayWindow.webContents.send('overlay:setActive', false);
      overlayWindow.webContents.send('overlay:clear');
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.hide();
      controlWindow?.webContents.send('control:drawModeChanged', false);
    }
  });
  // Surface conflicts in the UI rather than failing silently.
  if (failed.length) {
    controlWindow?.webContents.on('did-finish-load', () => {
      controlWindow?.webContents.send('hotkeyConflict', failed);
    });
  }
}

// A screen capture that briefly fails to produce a frame is normal and
// self-correcting; Chromium logs it every frame regardless. Quieten it so it
// cannot flood the pipe.
app.commandLine.appendSwitch('log-level', '3');

// Last line of defence: an unhandled EPIPE anywhere must not show the user a
// crash dialog mid-recording.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE') return;
  safeLog('error', '[main] uncaught exception', err);
});

// Single instance — a second launch focuses the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controlWindow) {
      if (controlWindow.isMinimized()) controlWindow.restore();
      controlWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Grant getDisplayMedia requests using the source the renderer already
    // picked. The renderer uses the legacy chromeMediaSource constraints path,
    // but this handler keeps newer Electron versions working too.
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      });
    });

    // Auto-approve mic/camera: the user already chose devices in our own UI.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission));
    });

    registerIpc();
    createControlWindow();
    createOverlayWindow();
    registerHotkeys();

    // Fires for both light/dark switches and accent-colour changes.
    nativeTheme.on('updated', () => {
      let accent = '#0078d4';
      try {
        const raw = systemPreferences.getAccentColor();
        if (raw && raw.length >= 6) accent = `#${raw.slice(0, 6)}`;
      } catch {
        /* keep the fallback */
      }
      controlWindow?.webContents.send('appearanceChanged', {
        accent,
        dark: nativeTheme.shouldUseDarkColors,
      });
    });

    screen.on('display-added', refitOverlay);
    screen.on('display-removed', refitOverlay);
    screen.on('display-metrics-changed', refitOverlay);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
    });
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
