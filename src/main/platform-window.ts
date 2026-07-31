import { BrowserWindow, nativeTheme, systemPreferences } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Platform-conditional native window chrome.
 *
 * Windows 11 and macOS want *opposite* things from the same options, which is
 * why this can't be one shared config object:
 *
 *  - Mica (Windows) needs `transparent: false` and a fully-transparent ARGB
 *    `backgroundColor`. Setting `transparent: true` drops the window into
 *    WS_EX_LAYERED mode, which kills snapping, shadows and resize handles.
 *  - Vibrancy (macOS) needs the opposite: the background must be genuinely
 *    transparent. Passing the Windows-style '#00000000' string leaves a solid
 *    black fill on macOS, so vibrancy is simply not visible.
 *    See electron/electron#32007 and #31862.
 *
 * Getting this wrong is the single most common reason an Electron app looks
 * "almost native" on one OS and plainly wrong on the other.
 */

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';

/** Height of our custom title bar, in DIPs. Drives traffic-light centring. */
export const TITLEBAR_HEIGHT = 48;

/** macOS traffic lights are 12pt tall; centre them in our title bar. */
const TRAFFIC_LIGHT_HEIGHT = 12;
/** Standard macOS left inset for the traffic lights. */
const TRAFFIC_LIGHT_X = 20;

/**
 * Window options that make the frame itself look native on each OS.
 * Spread this into a BrowserWindow constructor.
 */
export function nativeWindowChrome(): BrowserWindowConstructorOptions {
  if (IS_MAC) {
    return {
      // `hiddenInset` keeps the real traffic lights but removes the title bar,
      // so we draw our own toolbar and still get genuine system buttons.
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: {
        x: TRAFFIC_LIGHT_X,
        y: Math.round(TITLEBAR_HEIGHT / 2 - TRAFFIC_LIGHT_HEIGHT / 2),
      },
      // 'sidebar' is the material real Mac utility panels use. 'under-window'
      // is the other defensible choice; 'fullscreen-ui'/'hud' read as heavier.
      vibrancy: 'sidebar',
      // Keep the backdrop lit even when the window is inactive — a recorder is
      // used *while another app has focus*, so followWindow would grey it out
      // for most of its actual working life.
      visualEffectState: 'active',
      // Deliberately NOT setting backgroundColor: any opaque value defeats
      // vibrancy, and explicitly passing `undefined` also breaks it (#32007).
      transparent: false,
    };
  }

  if (IS_WIN) {
    return {
      titleBarStyle: 'hidden',
      // Mica: the desktop-tinted backdrop Windows 11 apps use. All three of
      // these matter together.
      backgroundColor: '#00000000',
      backgroundMaterial: 'mica',
      transparent: false,
    };
  }

  // Linux and anything else: a plain frameless window with a solid background.
  return {
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3',
  };
}

/**
 * The user's accent colour and light/dark preference.
 *
 * `getAccentColor` returns RRGGBBAA; the alpha is dropped. Electron documents
 * this as macOS-only but it works on Windows too — the try/catch covers the
 * platforms where it genuinely throws (notably Linux).
 *
 * Note the CSS `AccentColor` system keyword is NOT a usable substitute: it is
 * gated to installed-web-app contexts in Chromium, so it does not resolve
 * inside a normal Electron renderer. IPC is the correct path on both OSes.
 */
export function readAppearance(): { accent: string; dark: boolean; platform: string } {
  let accent = IS_MAC ? '#007aff' : '#0078d4';
  try {
    const raw = systemPreferences.getAccentColor();
    if (raw && raw.length >= 6) accent = `#${raw.slice(0, 6)}`;
  } catch {
    /* keep the per-platform fallback */
  }
  return {
    accent,
    dark: nativeTheme.shouldUseDarkColors,
    platform: process.platform,
  };
}

/**
 * macOS-only: real AppKit system colours.
 *
 * These are worth pulling because two of them are what make a sidebar read as
 * genuinely native — macOS uses a *different* selection colour when the window
 * is unfocused, which almost every Electron app gets wrong by using one colour
 * for both. Returns null on non-macOS.
 */
export function readMacSystemColors(): Record<string, string> | null {
  if (!IS_MAC) return null;
  const names = [
    'selected-content-background',
    'unemphasized-selected-content-background',
    'separator',
    'label',
    'secondary-label',
    'tertiary-label',
    'window-background',
    'under-page-background',
    'control-background',
  ] as const;

  const out: Record<string, string> = {};
  for (const name of names) {
    try {
      out[name] = systemPreferences.getColor(name as Parameters<typeof systemPreferences.getColor>[0]);
    } catch {
      /* skip anything this macOS version doesn't expose */
    }
  }
  return out;
}

/**
 * Tell the renderer when the traffic lights appear/disappear, so the title bar
 * can collapse its reserved left inset. Without this, fullscreen shows a large
 * empty gap where the traffic lights used to be. No-op off macOS.
 */
export function trackFullscreen(win: BrowserWindow): void {
  if (!IS_MAC) return;
  const send = (isFullscreen: boolean) => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:fullscreenChanged', isFullscreen);
    }
  };
  win.on('enter-full-screen', () => send(true));
  win.on('leave-full-screen', () => send(false));
}

/**
 * Re-assert the backdrop after a maximize/restore cycle.
 *
 * Frameless Windows 11 windows using `backgroundMaterial` historically lost
 * their Mica (and their rounded corners and shadow) permanently on maximize —
 * electron/electron#41824, fixed by PR #45456. Re-applying on every resize is
 * cheap and keeps older Electron builds correct too. No-op on macOS.
 */
export function keepBackdropAlive(win: BrowserWindow): void {
  if (!IS_WIN) return;
  const reapply = () => {
    if (win.isDestroyed()) return;
    try {
      win.setBackgroundMaterial('mica');
    } catch {
      /* older Electron / pre-22H2 Windows: nothing to restore */
    }
  };
  win.on('maximize', reapply);
  win.on('unmaximize', reapply);
  win.on('restore', reapply);
}
