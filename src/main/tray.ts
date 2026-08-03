/**
 * Optional macOS menu-bar (status item) with a small context menu — the
 * Dropover-style quick actions the user asked for. Off by default; toggled by
 * the `menuBarIcon` setting, which the main process reconciles by calling
 * createTray/destroyTray.
 *
 * The actions deliberately reuse the existing renderer plumbing rather than
 * duplicating recording logic in the main process: Start/Stop, Pause/Resume and
 * Toggle Drawing all fire the same `hotkey` events the global shortcuts do, so
 * they behave identically and stay correct for whichever engine is running.
 *
 * The icon is an embedded template image (black shape + alpha), so macOS tints
 * it for light/dark menu bars automatically and there is no asset to bundle.
 */

import { Menu, Tray, nativeImage, type NativeImage } from 'electron';

// A hollow "record" ring, generated as a template PNG (see tools; embedded so
// nothing extra has to ship in the app bundle). 16px base + 32px @2x.
const ICON_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAcUlEQVR4nGNgoBGwBOI+IF4FxX1QMYJABoiPAfF/HPgYVA1OzY/xaIbhx7gMQbZ5FZoiGagYsktQgCWaZlwA2RCUMOlDksDpR6gcTF0fLpMJAawupdgAir1AcSCCAEXRCFNEUUKCGUJ2UkYGZGcmkgEAexpYGfy/fnkAAAAASUVORK5CYII=';
const ICON_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA50lEQVR4nO1X0Q3EIAh1EBZxEAfpWg7iIh3kThNJGvNQaj3JXe4l76tFQB6Kzv0xB58ZGvodTmPma8C4OhjKTArHLVO1fYQw4bhlmHV+LHDOPO4612RetjhWakqk3gnqLHLWbFBtqX47O/YqTUjZROUC5ORuSSNj33F+F1IQ3RZFRmVLZ9qJHC5HN5klCr5A6iQIafufHCaSoGEZUOsNRaMAEjVsSRTAjPhaIF19TwBbS2AuQif8vK0NC8wPIvOjuMD0MuIFkDGX4+PXcYHpQMIwHckYpkMpw3Qsv8LsYSIFs/1p9pt4AwhKWcgMXOCGAAAAAElFTkSuQmCC';

export type TrayHotkey = 'toggleRecord' | 'togglePause' | 'toggleDraw';

export interface TrayDeps {
  /** Bring the control window to the front (create it if it was closed). */
  showWindow: () => void;
  /** Fire the same action a global shortcut would. */
  sendHotkey: (action: TrayHotkey) => void;
  /** Open the in-app Settings panel. */
  openSettings: () => void;
  /** e.g. "1.4.0", shown as a disabled label. */
  getVersion: () => string;
  quit: () => void;
}

let tray: Tray | null = null;
let deps: TrayDeps | null = null;
/** Mirrors the renderer's recorder state so labels/enablement stay accurate. */
let recordingState = 'idle';

function trayImage(): NativeImage {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_16}`);
  img.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${ICON_32}` });
  // Template image → macOS renders it monochrome and adapts to the menu bar.
  img.setTemplateImage(true);
  return img;
}

function isActiveTake(state: string): boolean {
  return state === 'recording' || state === 'paused' || state === 'pausing' || state === 'resuming';
}

function rebuildMenu(): void {
  if (!tray || !deps) return;
  const recording = isActiveTake(recordingState);
  const paused = recordingState === 'paused';

  const menu = Menu.buildFromTemplate([
    { label: 'Open Ez Screen Record', click: () => deps?.showWindow() },
    { type: 'separator' },
    {
      label: recording ? 'Stop Recording' : 'Start Recording',
      click: () => deps?.sendHotkey('toggleRecord'),
    },
    {
      label: paused ? 'Resume' : 'Pause',
      enabled: recording,
      click: () => deps?.sendHotkey('togglePause'),
    },
    { label: 'Toggle Drawing', click: () => deps?.sendHotkey('toggleDraw') },
    { type: 'separator' },
    { label: 'Settings…', click: () => deps?.openSettings() },
    { label: `Version ${deps.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit Ez Screen Record', click: () => deps?.quit() },
  ]);
  tray.setContextMenu(menu);
}

/** Create the menu-bar item. No-op if one already exists. */
export function createTray(d: TrayDeps): void {
  if (tray) return;
  deps = d;
  tray = new Tray(trayImage());
  tray.setToolTip('Ez Screen Record');
  // A left-click also opens the menu, matching how utilities like this behave.
  tray.on('click', () => tray?.popUpContextMenu());
  rebuildMenu();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  deps = null;
}

export function isTrayActive(): boolean {
  return tray !== null;
}

/** Keep the menu's labels (Start/Stop, Pause/Resume) in sync with the take. */
export function setTrayRecordingState(state: string): void {
  if (state === recordingState) return;
  recordingState = state;
  if (tray) rebuildMenu();
}
