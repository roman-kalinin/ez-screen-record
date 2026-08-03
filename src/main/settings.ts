import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types';

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function defaultOutputDir(): string {
  return path.join(app.getPath('videos'), 'Ez Screen Record');
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Merge field-by-field so settings written by an older version still load
    // once new keys are added.
    const camera = { ...DEFAULT_SETTINGS.camera, ...(parsed.camera ?? {}) };

    // One-time migration. `showOnScreen` shipped defaulting to false, which put
    // every camera take on ffmpeg's framesync'd composite — the webcam's rate
    // then paced the whole recording (a 30fps camera dragged 60fps takes to ~21
    // unique fps). Nobody chose that deliberately; it was simply the old
    // default, so a persisted `false` from before this key was user-facing is
    // upgraded rather than preserved.
    if (parsed.camera && parsed.camera.showOnScreenMigrated !== true) {
      camera.showOnScreen = true;
      camera.showOnScreenMigrated = true;
    }

    return {
      recording: { ...DEFAULT_SETTINGS.recording, ...(parsed.recording ?? {}) },
      camera,
      images: Array.isArray(parsed.images) ? parsed.images : [],
      draw: { ...DEFAULT_SETTINGS.draw, ...(parsed.draw ?? {}) },
      menuBarIcon: parsed.menuBarIcon ?? DEFAULT_SETTINGS.menuBarIcon,
    };
  } catch {
    return { ...DEFAULT_SETTINGS, recording: { ...DEFAULT_SETTINGS.recording } };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    // Images carry data: URLs which can be large; keep them but cap the count
    // so the settings file cannot grow without bound.
    const trimmed: AppSettings = { ...settings, images: settings.images.slice(0, 12) };
    // Write to a temp file then rename: rename is atomic, so an interrupted
    // save can never leave a half-written settings.json that fails to parse
    // and silently resets the user's layout to defaults.
    const target = settingsPath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed), 'utf-8');
    fs.renameSync(tmp, target);
  } catch (err) {
    // Guarded: writing to a pipe with no reader throws EPIPE, and this runs on
    // every settings change — an unguarded log here would crash the app.
    try {
      console.error('[settings] save failed', err);
    } catch {
      /* ignore */
    }
  }
}
