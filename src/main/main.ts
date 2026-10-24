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
import { createTray, destroyTray, isTrayActive, setTrayRecordingState } from './tray';
import {
  ensureScreenPermission,
  openSettingsFor,
  permissionStatus,
  primePermissions,
} from './mac-permissions';
import {
  NativeRecorder,
  listCaptureDevices,
  listDshowAudioDevices,
  listDshowDevices,
  type NativeCameraOptions,
} from './native-recorder';
import { enableDnd, disableDnd, restoreDndOnLaunch } from './dnd';
import { uploadAndShare } from './gofile';
import { openEditor, registerEditor, registerEditorScheme } from './editor';
import { randomUUID } from 'crypto';

const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER = 'http://localhost:5273';

/**
 * The window/taskbar icon.
 *
 * The installer stamps the icon into the .exe itself, so packaged builds get it
 * for free; this is what stops the dev run (and the taskbar grouping) from
 * falling back to Electron's default. Resolved from the app root in dev and
 * from the asar in production.
 */
function appIconPath(): string {
  const candidates = [
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(process.resourcesPath ?? '', 'build', 'icon.ico'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? '';
}

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
function rendererUrl(page: 'index' | 'overlay' | 'camera' | 'toolbar' | 'editor'): string {
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

  const isMac = process.platform === 'darwin';

  controlWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.max(0, Math.round((workArea.width - winWidth) / 2)),
    y: Math.max(0, Math.round((workArea.height - winHeight) / 2)),
    minWidth: 560,
    minHeight: 420,
    show: false,
    // Windows renders its own controls, so a fully frameless window is right.
    // macOS must NOT be frameless: `frame: false` also removes the traffic
    // lights, which are the correct, expected window controls there.
    frame: !isMac,
    icon: appIconPath() || undefined,
    // Deliberately NOT using backgroundMaterial:'mica'. Mica conflicts with
    // setContentProtection — the combination is unstable and lets the window
    // appear in its own capture, producing the recursive-mirror effect. A
    // solid WinUI surface colour is worth far more than the backdrop here,
    // because keeping the recorder out of the recording is the whole point.
    backgroundColor: '#202020',
    transparent: false,
    titleBarStyle: 'hidden',
    // Keep the real macOS traffic lights but centre them vertically in our
    // 32px custom title bar (see App.tsx `titlebar`). Without this they sit at
    // the OS default offset, overlapping the app title.
    ...(isMac ? { trafficLightPosition: { x: 14, y: 9 } } : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      // The browser engine composites every frame on a canvas in THIS window,
      // and a take parks it off-screen — where Chromium clamps setInterval to
      // once per second. That is the whole of the "1fps recording" bug: the
      // frames were never drawn, so no encoder setting could recover them.
      // The three other windows already set this; the one doing the work did
      // not. Necessary but NOT sufficient on its own — see recorder.ts, which
      // drives the compositor from a Worker because an off-screen window is
      // treated as occluded and throttled regardless of this flag.
      backgroundThrottling: false,
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
    // A take may still be running — closing via the native macOS traffic light
    // bypasses the in-app "stop first" prompt. Kill capture NOW so macOS drops
    // the screen-recording indicator instead of showing it after the app is
    // gone from view.
    nativeRecorder?.dispose();
    nativeRecorder = null;
    // The overlays are child concepts; without the controller they are orphaned.
    overlayWindow?.close();
    cameraOverlayWindow?.close();
    toolbarWindow?.close();
    // Closing the controller means quitting. window-all-closed already does
    // this, but only once every hidden window has finished closing; quit
    // explicitly so nothing (a lingering overlay, a busy renderer) can keep the
    // process — and the capture indicator — alive.
    app.quit();
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
    // Nearly-transparent fill rather than pure transparency.
    //
    // A `transparent: true` window on Windows does not reliably clear the
    // previous frame when only part of its content moves: the layered surface
    // keeps the old pixels, so dragging the bubble smeared a second copy at
    // the drag-start position that stayed until a full repaint wiped it (on
    // release). It reads exactly like a duplicated element, which is why it
    // survived several attempts to fix it as a React state bug.
    //
    // An alpha of 1/255 is invisible but non-zero, which is enough to make the
    // compositor treat the whole window as needing a repaint each frame. The
    // drawing overlay never showed this because it redraws its entire canvas.
    // ARGB: alpha 0x01 out of 0xff. Written in hex rather than rgba() so the
    // near-zero alpha is unmistakable and cannot be rounded away.
    backgroundColor: '#01000000',
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

  // Keep the bubble window OUT of the screen capture. The recorder composites
  // the webcam onto its own canvas (see recorder.ts drawCamera), so if the
  // desktop capture also picked up this always-on-top window the take would
  // contain the camera TWICE — the composited copy plus the captured window.
  // Dragging made it obvious: the two copies feed the encoder from different
  // pipelines, so one froze at the pre-drag position in the output file even
  // though the live desktop looked correct. This window is transparent (hence
  // already layered), so WDA_EXCLUDEFROMCAPTURE / setContentProtection sticks.
  if (!process.env.EZ_NO_CONTENT_PROTECTION) {
    cameraOverlayWindow.setContentProtection(true);
  }

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

/**
 * (Re)apply the toolbar's exclusion from screen capture.
 *
 * Called after every show and after every click-through toggle, because both
 * drop the window style the exclusion depends on. Cheap enough to be worth
 * doing defensively rather than reasoning about which call cleared it.
 */
function applyToolbarProtection(): void {
  if (process.env.EZ_NO_CONTENT_PROTECTION) return;
  if (!toolbarWindow || toolbarWindow.isDestroyed()) return;
  if (!toolbarWindow.isVisible()) return;
  toolbarWindow.setContentProtection(hideToolbarFromCapture);
}

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

  // Force the window permanently layered.
  //
  // Electron implements content protection as SetWindowDisplayAffinity with
  // WDA_EXCLUDEFROMCAPTURE, and only keeps it working while the window has
  // WS_EX_LAYERED. `setIgnoreMouseEvents(false)` clears that style — and this
  // window toggles click-through constantly, every time the pointer crosses the
  // bar. Each of those calls silently undid the protection, which is why the
  // toolbar ended up in recordings while the main window (which never toggles
  // click-through) has always stayed out of them.
  //
  // setOpacity makes Electron mark the window layered for good, so its own
  // `if (layered_) ex_style |= WS_EX_LAYERED` re-adds the style on every
  // subsequent call. 0.99 rather than 1.0 because 1.0 is treated as "not
  // transparent" and skips the layered path.
  //
  // Windows-only: this is a workaround for a Win32 style flag. On macOS there
  // is no WS_EX_LAYERED, setContentProtection uses NSWindow sharingType and is
  // unaffected by click-through — so 0.99 would just make the toolbar visibly
  // translucent for no benefit.
  if (process.platform === 'win32') toolbarWindow.setOpacity(0.99);

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

/**
 * @param keepControlWindowAlive
 *   The BROWSER engine composites every frame on a canvas inside the control
 *   window, so that window has to keep rendering for the whole take. A hidden
 *   Electron window is detached from the compositor entirely — `hide()` starves
 *   the canvas regardless of `backgroundThrottling: false`, which only governs
 *   timer throttling for a window that is still being composited. Measured: a
 *   30fps request delivered 13.6 unique fps, and a static-content take looks
 *   like ~1fps.
 *
 *   So for that engine the window is moved OFF-SCREEN instead of hidden: still
 *   composited, still rendering, just not visible. ffmpeg takes are unaffected
 *   — that pipeline runs in its own process — and keep the plain hide().
 */
function enterToolbarMode(keepControlWindowAlive = false) {
  if (!controlWindow || controlWindow.isDestroyed()) return;

  // The window is built at startup and kept hidden, so this is just a show.
  // Creating it here instead meant loading React and the whole Fluent bundle
  // at the moment recording began: the bar took visible seconds to appear, and
  // if anything went wrong there was no way to stop the take at all.
  const win = createToolbarWindow(screen.getPrimaryDisplay());
  win.setBounds(screen.getPrimaryDisplay().bounds);
  win.showInactive();
  // AFTER showInactive, not before: hide() clears the display affinity, and
  // re-applying it while the window is still hidden does not take.
  applyToolbarProtection();
  // Re-assert: another always-on-top window (the camera bubble) may have been
  // shown after this one was created, which would otherwise leave the bar
  // underneath it.
  win.setAlwaysOnTop(true, 'screen-saver');
  // The main window steps aside for the take; the toolbar replaces it.
  if (keepControlWindowAlive) {
    // Keep the window "visible" to Chromium so its canvas compositor keeps
    // running (a hidden window stops compositing), but get it out of the
    // user's sight. Restored in exitToolbarMode.
    if (!controlBoundsBeforeToolbar) controlBoundsBeforeToolbar = controlWindow.getBounds();
    const b = controlBoundsBeforeToolbar;
    if (process.platform === 'darwin') {
      // macOS refuses to move a window fully off-screen — it clamps the bounds
      // to keep part on the desktop, so the -32000 park used on Windows leaves
      // the window squeezed against the screen edge, still visible. Make it
      // fully transparent and click-through instead: the renderer stays live,
      // the user sees nothing, and it stays out of the take.
      controlWindow.setOpacity(0);
      controlWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      // Far enough out that no display can contain it.
      controlWindow.setBounds({ ...b, x: -32000, y: -32000 });
    }
    // Excluded from capture so it cannot appear in the recording even briefly.
    controlWindow.setContentProtection(true);
  } else {
    controlWindow.hide();
  }
}

/** Real bounds of the control window while it is parked off-screen. */
let controlBoundsBeforeToolbar: Electron.Rectangle | null = null;

function exitToolbarMode() {
  if (toolbarWindow && !toolbarWindow.isDestroyed()) {
    toolbarWindow.setIgnoreMouseEvents(true, { forward: true });
    toolbarWindow.hide();
  }
  if (!controlWindow || controlWindow.isDestroyed()) return;
  // Undo however the take hid the window: transparency on macOS, an off-screen
  // park elsewhere.
  if (controlBoundsBeforeToolbar) {
    if (process.platform === 'darwin') {
      controlWindow.setOpacity(1);
      controlWindow.setIgnoreMouseEvents(false);
    } else {
      controlWindow.setBounds(controlBoundsBeforeToolbar);
    }
    controlWindow.setContentProtection(false);
    controlBoundsBeforeToolbar = null;
  }
  controlWindow.show();
  if (!userPinnedOnTop) controlWindow.setAlwaysOnTop(false);
}

/** Bring the control window to the front, recreating it if it was closed. */
function focusControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.show();
    controlWindow.focus();
  } else {
    createControlWindow();
  }
  if (process.platform === 'darwin') app.dock?.show();
}

/**
 * Create or destroy the macOS menu-bar item to match the `menuBarIcon` setting.
 * macOS-only; a no-op elsewhere. Safe to call repeatedly.
 */
function syncTray() {
  if (process.platform !== 'darwin') return;
  const want = loadSettings().menuBarIcon;
  if (want && !isTrayActive()) {
    createTray({
      showWindow: focusControlWindow,
      sendHotkey: (action) => controlWindow?.webContents.send('hotkey', action),
      openSettings: () => {
        focusControlWindow();
        controlWindow?.webContents.send('menu:openSettings');
      },
      getVersion: () => app.getVersion(),
      quit: () => app.quit(),
    });
  } else if (!want && isTrayActive()) {
    destroyTray();
  }
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
    // On macOS, getSources THROWS when Screen Recording permission is denied
    // (rather than returning an empty list), and the rejection propagates all
    // the way to the picker as a bare "No screens found." Swallow it here and
    // let the renderer read the permission status separately, so it can explain
    // what to do instead of silently showing nothing.
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 200 },
        fetchWindowIcons: false,
      });
    } catch (err) {
      console.warn('[sources] getSources failed (likely missing permission)', err);
      return [];
    }

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

  /**
   * Screen-recording permission state, so the picker can distinguish "no
   * sources exist" from "macOS is blocking us". Returns 'granted' on Windows.
   */
  ipcMain.handle('permissions:screenStatus', () => permissionStatus('screen'));

  /** Deep-link into the Screen Recording pane of System Settings (macOS). */
  ipcMain.handle('permissions:openScreenSettings', () => {
    openSettingsFor('screen');
    return true;
  });

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_e, s: AppSettings) => {
    saveSettings(s);
    // The menu-bar toggle lives in these settings, so reconcile after every
    // save — cheap, and it means enabling/disabling it takes effect at once.
    syncTray();
    return true;
  });

  // The renderer owns the recording state (the browser engine records there),
  // so it pushes changes here to keep the tray menu's labels accurate.
  ipcMain.handle('app:recordingState', (_e, state: string) => {
    setTrayRecordingState(state);
    return true;
  });

  // --- Do Not Disturb while recording --------------------------------------
  // The renderer owns the take (the browser engine records there), so it signals
  // the real start/stop of capture. enable is called only when the setting is on;
  // disable is always safe — it no-ops unless a prior enable actually changed DND.
  ipcMain.handle('dnd:enable', async () => {
    await enableDnd((message) => {
      controlWindow?.webContents.send('dnd:hint', message);
    });
    return true;
  });
  ipcMain.handle('dnd:disable', async () => {
    await disableDnd();
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
    // show()/showInactive() drops WS_EX_LAYERED-dependent exclusion, so
    // re-assert it after the window is on screen or the bubble records twice.
    if (!process.env.EZ_NO_CONTENT_PROTECTION) win.setContentProtection(true);
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
    // setIgnoreMouseEvents(false) clears WS_EX_LAYERED, which silently drops the
    // capture exclusion — so grabbing the bubble to drag it would make the
    // duplicate reappear in the take. Re-assert exclusion after every toggle.
    if (!process.env.EZ_NO_CONTENT_PROTECTION) {
      cameraOverlayWindow.setContentProtection(true);
    }
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
  ipcMain.handle('win:setToolbarMode', (_e, on: boolean, keepAlive = false) => {
    if (on) enterToolbarMode(keepAlive);
    else exitToolbarMode();
    return on;
  });

  /** Whether the toolbar is invisible to screen capture during a take. */
  ipcMain.handle('win:setHideFromCapture', (_e, hide: boolean) => {
    hideToolbarFromCapture = hide;
    // Applies immediately when toggled mid-take.
    applyToolbarProtection();
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
    // This call clears WS_EX_LAYERED, which the capture exclusion depends on,
    // so the exclusion has to be put back. The renderer toggles this on every
    // pointer move across the bar, so without this the toolbar reverts to
    // being recordable within a second of the user reaching for it.
    applyToolbarProtection();
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

  // --- Share (GoFile upload) -----------------------------------------------
  /**
   * Stream a finished recording to GoFile and return a shareable link.
   *
   * The local file is never touched, so a failed upload can never lose the
   * recording. GoFile uploads are anonymous — no key or account. Progress is
   * streamed back on 'share:uploadProgress' as bytes are sent.
   */
  ipcMain.handle('share:upload', async (event, filePath: string) => {
    const uploadId = randomUUID();
    try {
      const { viewUrl } = await uploadAndShare(filePath, uploadId, (p) => {
        // The renderer window may have gone away mid-upload; don't send to it.
        if (!event.sender.isDestroyed()) {
          event.sender.send('share:uploadProgress', p);
        }
      });
      return { ok: true, viewUrl };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // --- Native (crisp) capture ---------------------------------------------
  ipcMain.handle('native:available', () => NativeRecorder.isAvailable());
  ipcMain.handle('native:canPause', () => NativeRecorder.canPause());
  ipcMain.handle('native:devices', () => listDshowDevices());
  ipcMain.handle('native:audioDevices', () => listDshowAudioDevices());

  /**
   * Which display ffmpeg should capture, in its own addressing.
   *
   * Windows: ddagrab takes an OUTPUT INDEX, not an Electron display id. The two
   * are different namespaces, so the Electron id is resolved against
   * `screen.getAllDisplays()` and its position in that list is used as the
   * index. Electron enumerates displays in the same order the DXGI adapter
   * does, so position matches output index in practice. (Returning 0 blindly
   * would ignore the chosen monitor and always capture the primary display.)
   *
   * macOS: avfoundation wants its own *device* index, resolved from ffmpeg's
   * device list. Screens share the numbering with cameras there, so index 0 is
   * usually a webcam — hence the lookup rather than a hardcoded 0.
   */
  async function resolveDisplayId(electronDisplayId?: string): Promise<number> {
    if (process.platform !== 'darwin') {
      if (!electronDisplayId) return 0;
      const displays = screen.getAllDisplays();
      const idx = displays.findIndex((d) => String(d.id) === String(electronDisplayId));
      return idx >= 0 ? idx : 0;
    }
    try {
      const { screens } = await listCaptureDevices();
      // Prefer the screen matching the requested display, else the first.
      const match = electronDisplayId
        ? screens.find((s) => String(s.id) === String(electronDisplayId))
        : undefined;
      const id = Number((match ?? screens[0])?.id);
      return Number.isFinite(id) ? id : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Translate a device *name* into whatever this platform's ffmpeg wants.
   *
   * The renderer matches the browser's device label against the ffmpeg device
   * list and sends a name, which is exactly right on Windows — dshow addresses
   * devices by name. avfoundation addresses them by index, so on macOS the name
   * has to be resolved back to one here. Doing it in main keeps the renderer
   * free of platform-specific device addressing.
   */
  async function resolveDeviceId(
    name: string | null | undefined,
    kind: 'audio' | 'video',
  ): Promise<string | null> {
    if (!name) return null;
    if (process.platform !== 'darwin') return name;
    try {
      const devices = (await listCaptureDevices())[kind];
      // The renderer may already have sent an index (it echoes back whatever
      // the device list gave it), so accept that first.
      const byId = devices.find((d) => d.id === name);
      if (byId) return byId.id;

      const needle = name.toLowerCase();
      const byLabel =
        devices.find((d) => d.label.toLowerCase() === needle) ??
        devices.find((d) => d.label.toLowerCase().includes(needle)) ??
        devices.find((d) => needle.includes(d.label.toLowerCase()));
      return byLabel?.id ?? devices[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  ipcMain.handle(
    'native:start',
    async (
      _e,
      opts: {
        fps: number;
        height?: number;
        quality: 'high' | 'balanced' | 'compact';
        micDeviceName?: string | null;
        systemAudioEnabled?: boolean;
        camera?: NativeCameraOptions | null;
        outputDir: string | null;
        /** Electron display id of the chosen screen source. */
        displayId?: string;
      },
    ) => {
      try {
        if (nativeRecorder?.isRecording) {
          return { ok: false, error: 'A recording is already running.' };
        }

        // macOS blocks screen capture until the app is granted permission, and
        // ffmpeg's failure in that case says nothing about permissions. Check
        // first so the user gets the dialog that actually explains it. No-op on
        // Windows.
        if (!(await ensureScreenPermission())) {
          return {
            ok: false,
            error:
              'Screen recording permission is required. Grant it in System Settings, then restart the app.',
          };
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
          micDeviceName: await resolveDeviceId(opts.micDeviceName, 'audio'),
          systemAudioEnabled: opts.systemAudioEnabled,
          camera: opts.camera
            ? {
                ...opts.camera,
                deviceName:
                  (await resolveDeviceId(opts.camera.deviceName, 'video')) ??
                  opts.camera.deviceName,
              }
            : null,
          displayId: await resolveDisplayId(opts.displayId),
        });
        // The moment ffmpeg was launched, not the moment this handler
        // returned — the renderer's clock is anchored to it, and the gap
        // between the two is exactly the startup time the timer used to lose.
        return { ok: true, filePath: outputPath, startedAt: Date.now() - nativeRecorder.elapsedMs };
      } catch (err) {
        nativeRecorder = null;
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  /**
   * Swap inputs mid-take (monitor, microphone).
   *
   * ffmpeg cannot be handed a new device on a running graph, so this splits
   * the take at the change and respawns — the same segment machinery pause
   * uses. Only sent for fields that actually changed; the renderer must not
   * call this on every settings write, since each call costs a real seam.
   */
  ipcMain.handle(
    'native:reconfigure',
    async (_e, patch: { micDeviceName?: string | null; displayId?: string }) => {
      try {
        if (!nativeRecorder) return { ok: false, error: 'Not recording.' };

        const next: Parameters<NativeRecorder['reconfigure']>[0] = {};
        if ('micDeviceName' in patch) {
          next.micDeviceName = await resolveDeviceId(patch.micDeviceName, 'audio');
        }
        if ('displayId' in patch) {
          next.displayId = await resolveDisplayId(patch.displayId);
        }

        await nativeRecorder.reconfigure(next);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: (err as Error).message,
          paused: nativeRecorder?.isPaused ?? false,
        };
      }
    },
  );

  /**
   * Pause/resume the ffmpeg take. Reports the resulting state so the renderer
   * follows what actually happened rather than what it assumed — a failed
   * resume must not leave the UI claiming the take is live.
   */
  ipcMain.handle('native:pause', async () => {
    try {
      if (!nativeRecorder) return { ok: false, error: 'Not recording.' };
      await nativeRecorder.pause();
      return { ok: true, paused: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message, paused: nativeRecorder?.isPaused ?? false };
    }
  });

  ipcMain.handle('native:resume', async () => {
    try {
      if (!nativeRecorder) return { ok: false, error: 'Not recording.' };
      await nativeRecorder.resume();
      return { ok: true, paused: false };
    } catch (err) {
      return { ok: false, error: (err as Error).message, paused: nativeRecorder?.isPaused ?? true };
    }
  });

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

  // Open the recordings folder in the OS file manager. Resolves the saved
  // output dir (falling back to the default) and ensures it exists first, so
  // this works even before the first recording has created the folder.
  ipcMain.handle('shell:openOutputDir', () => {
    const dir = loadSettings().recording.outputDir || defaultOutputDir();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });

  ipcMain.handle('paths:defaultOutputDir', () => defaultOutputDir());

  // The running build's version, so an installed copy can identify itself.
  // Read from Electron rather than importing package.json: in a packaged app
  // the manifest is inside the asar, and app.getVersion() is the value
  // electron-builder actually stamped into the installer and the exe.
  ipcMain.handle('app:version', () => app.getVersion());

  /**
   * The user's Windows accent colour and light/dark preference, so the app
   * themes itself like a native one. getAccentColor returns RRGGBBAA; the alpha
   * is dropped. (Electron marks it macOS-only but it works on Windows too.)
   * Falls back to Windows blue if it throws.
   */
  ipcMain.handle('system:appearance', () => {
    let accent = '#0078d4';
    try {
      const raw = systemPreferences.getAccentColor();
      if (raw && raw.length >= 6) accent = `#${raw.slice(0, 6)}`;
    } catch {
      /* keep the fallback */
    }
    return { accent, dark: nativeTheme.shouldUseDarkColors, platform: process.platform };
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

// The editor's media scheme must be registered before 'ready'.
registerEditorScheme();

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
    // Without an explicit AppUserModelID, Windows groups the taskbar button
    // under Electron's own identity — wrong icon, wrong name, and shortcuts
    // pinned from the installer do not match the running app. Must agree with
    // build.appId in package.json.
    if (process.platform === 'win32') app.setAppUserModelId('com.joket.ezscreenrecord');

    // Guarantee a normal dock presence on macOS. The app was coming up as an
    // accessory (NSApplication UIElement), so its dock icon flashed at launch
    // and then vanished — leaving no way to see or right-click-pin it. Forcing
    // the regular activation policy and showing the dock tile fixes that.
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular');
      app.dock?.show();
    }

    // Grant getDisplayMedia requests using the source the user picked in our own
    // UI. The main recorder path uses the legacy chromeMediaSource constraints
    // and never reaches here; this handler keeps any getDisplayMedia() caller
    // working too. Honour the persisted screen source instead of blindly taking
    // sources[0] — the latter always captured the primary display regardless of
    // what the picker said.
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        const wantedId = loadSettings().recording.screenSourceId;
        const chosen = (wantedId && sources.find((s) => s.id === wantedId)) || sources[0];
        callback({ video: chosen, audio: 'loopback' });
      });
    });

    // Auto-approve mic/camera: the user already chose devices in our own UI.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission));
    });

    registerIpc();
    registerEditor({
      rendererUrl: () => rendererUrl('editor'),
      preloadPath: preloadPath(),
      iconPath: appIconPath(),
      isDev,
      log: (...args) => safeLog('error', ...args),
    });

    // macOS prompts for camera and microphone here, so the user meets those
    // dialogs while setting up rather than at the moment they press record.
    // Screen recording is deliberately not prompted at launch — it is asked for
    // when a recording is actually started. No-op on Windows.
    void primePermissions();

    // If a prior run crashed mid-recording with DND on, put it back now.
    void restoreDndOnLaunch();

    createControlWindow();
    createOverlayWindow();
    // Built up front and kept hidden so pressing record shows it instantly,
    // rather than paying for React and the Fluent bundle mid-take.
    createToolbarWindow(screen.getPrimaryDisplay());
    registerHotkeys();
    // Dev aid: open the editor on a file straight away (EZ_OPEN_EDITOR=<path>).
    if (isDev && process.env.EZ_OPEN_EDITOR) openEditor(process.env.EZ_OPEN_EDITOR);
    // Bring up the menu-bar item if the user has enabled it (macOS only).
    syncTray();

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

  // Final safety net: whatever route the app quits by (Cmd+Q, menu, window
  // close), make sure no capture process outlives it — that is what leaves the
  // macOS screen-recording indicator stuck on after the app is gone.
  app.on('before-quit', () => {
    nativeRecorder?.dispose();
    nativeRecorder = null;
    destroyTray();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => app.quit());
}
