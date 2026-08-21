/**
 * "Do Not Disturb while recording" — best-effort OS notification suppression.
 *
 * Enabled from the renderer at the moment capture actually begins (guarded by
 * `recording.doNotDisturbWhileRecording`) and disabled when the take stops.
 * Nothing here may ever throw into a recording path: DND is a nicety, not a
 * requirement, so every OS call is wrapped and failures are logged, never
 * propagated.
 *
 * ## Windows
 * Flip HKCU `NOC_GLOBAL_SETTING_TOASTS_ENABLED` to 0 to suppress every toast,
 * restoring the value captured before we touched it (or DELETING it if it was
 * absent, which is the true default). WpnUserService reads the key live, so the
 * change takes hold for new toasts immediately. No admin needed.
 *
 * ## macOS
 * Run a user-created Shortcut by a fixed name (`shortcuts run`). We cannot
 * create Focus shortcuts headlessly, so if the shortcut is missing we surface a
 * ONE-TIME setup hint and carry on — recording is never blocked. To avoid
 * clobbering a Focus the user already had on, we best-effort read the Focus
 * assertions file before enabling; if a Focus is already active we leave it
 * alone and do not turn it off on stop.
 *
 * ## Crash safety
 * Before mutating anything we persist `{ modified, prior }` to a small state
 * file in userData. `restoreDndOnLaunch()` reads it at startup and, if a prior
 * run left DND modified (i.e. it crashed mid-recording), restores the captured
 * state and clears the flag.
 */
import { app } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

/** Fixed names the code calls; the user creates Shortcuts with these names. */
export const MAC_DND_ON_SHORTCUT = 'Ez Screen Record — DND On';
export const MAC_DND_OFF_SHORTCUT = 'Ez Screen Record — DND Off';

const WIN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const WIN_VALUE = 'NOC_GLOBAL_SETTING_TOASTS_ENABLED';

/**
 * Persisted crash-safety snapshot.
 * - `prior` on Windows: the DWORD value before we suppressed (0 or 1), or null
 *   if the value was absent (restore = delete).
 * - `prior` on macOS: not meaningful (we only ever toggle what we turned on),
 *   kept null; `modified` alone tells us to turn DND off on restore.
 */
interface DndState {
  modified: boolean;
  platform: 'win32' | 'darwin' | string;
  prior: number | null;
}

let stateFilePath: string | null = null;
function statePath(): string {
  if (!stateFilePath) stateFilePath = path.join(app.getPath('userData'), 'dnd-state.json');
  return stateFilePath;
}

function log(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
  try {
    console[level]('[dnd]', ...args);
  } catch {
    /* no reader on the pipe */
  }
}

function writeState(state: DndState): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state), 'utf8');
  } catch (err) {
    log('warn', 'could not write state file', err);
  }
}

function readState(): DndState | null {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    return JSON.parse(raw) as DndState;
  } catch {
    return null; // absent or unreadable — nothing to restore
  }
}

function clearState(): void {
  try {
    fs.rmSync(statePath(), { force: true });
  } catch (err) {
    log('warn', 'could not clear state file', err);
  }
}

/** Promise wrapper over execFile; never rejects — resolves with the outcome. */
function run(
  file: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

// --- Windows ---------------------------------------------------------------

/** Read the current toast setting: 0/1, or null when the value is absent. */
async function winGetPrior(): Promise<number | null> {
  const res = await run('reg.exe', ['query', WIN_KEY, '/v', WIN_VALUE]);
  if (!res.ok) return null; // value absent → default-on, restore = delete
  const m = res.stdout.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
  if (!m) return null;
  return parseInt(m[1], 16);
}

async function winSuppress(): Promise<void> {
  await run('reg.exe', ['add', WIN_KEY, '/v', WIN_VALUE, '/t', 'REG_DWORD', '/d', '0', '/f']);
}

async function winRestore(prior: number | null): Promise<void> {
  if (prior === null) {
    await run('reg.exe', ['delete', WIN_KEY, '/v', WIN_VALUE, '/f']);
  } else {
    await run('reg.exe', [
      'add',
      WIN_KEY,
      '/v',
      WIN_VALUE,
      '/t',
      'REG_DWORD',
      '/d',
      String(prior),
      '/f',
    ]);
  }
}

// --- macOS -----------------------------------------------------------------

/**
 * Best-effort: is a Focus already active? Reading the private assertions file
 * is fragile by design, so any failure is treated as "not active" — the worst
 * case is that we toggle our own DND, which we then correctly turn off.
 */
function macFocusAlreadyActive(): boolean {
  try {
    const p = path.join(os.homedir(), 'Library', 'DoNotDisturb', 'DB', 'Assertions.json');
    const raw = fs.readFileSync(p, 'utf8');
    const json = JSON.parse(raw) as {
      data?: Array<{ storeAssertionRecords?: unknown[] }>;
    };
    return Boolean(
      json.data?.some(
        (d) => Array.isArray(d.storeAssertionRecords) && d.storeAssertionRecords.length > 0,
      ),
    );
  } catch {
    return false;
  }
}

/** Whether we have already shown the one-time "create the Shortcut" hint. */
let macHintShown = false;

async function macRunShortcut(name: string): Promise<boolean> {
  const res = await run('shortcuts', ['run', name]);
  return res.ok;
}

// --- Public API ------------------------------------------------------------

/**
 * Called when a take actually starts (guard on the setting is the caller's).
 * Captures prior state, persists the crash flag, then suppresses notifications.
 *
 * @param onHint optional callback used on macOS to surface a one-time hint when
 *   the required Shortcut is missing. Never blocks.
 */
export async function enableDnd(onHint?: (message: string) => void): Promise<void> {
  try {
    // Already modified (e.g. two starts without an intervening stop)? Leave the
    // original captured state in place and do nothing.
    const existing = readState();
    if (existing?.modified) return;

    if (process.platform === 'win32') {
      const prior = await winGetPrior();
      // If already suppressed, still record modified:false so stop() leaves it
      // suppressed. Persist BEFORE mutating for crash safety.
      writeState({ modified: true, platform: 'win32', prior });
      await winSuppress();
      return;
    }

    if (process.platform === 'darwin') {
      // Don't clobber a Focus the user already turned on.
      if (macFocusAlreadyActive()) {
        log('log', 'a Focus is already active — leaving it alone');
        return;
      }
      writeState({ modified: true, platform: 'darwin', prior: null });
      const ok = await macRunShortcut(MAC_DND_ON_SHORTCUT);
      if (!ok) {
        // The shortcut is missing/failed — undo the crash flag (we changed
        // nothing) and guide the user once. Never block recording.
        clearState();
        if (!macHintShown) {
          macHintShown = true;
          const msg =
            `To auto-enable Do Not Disturb, create two Shortcuts named ` +
            `"${MAC_DND_ON_SHORTCUT}" and "${MAC_DND_OFF_SHORTCUT}" ` +
            `(each a single "Set Focus → Do Not Disturb" action, On and Off).`;
          log('warn', msg);
          onHint?.(msg);
        }
      }
      return;
    }
  } catch (err) {
    log('error', 'enableDnd failed', err);
  }
}

/** Called when the take stops. Restores prior state and clears the crash flag. */
export async function disableDnd(): Promise<void> {
  try {
    const state = readState();
    if (!state?.modified) return; // nothing to undo

    if (state.platform === 'win32') {
      await winRestore(state.prior);
    } else if (state.platform === 'darwin') {
      await macRunShortcut(MAC_DND_OFF_SHORTCUT);
    }
    clearState();
  } catch (err) {
    log('error', 'disableDnd failed', err);
  }
}

/**
 * Startup recovery: if a prior run left DND modified (it crashed mid-take),
 * restore the captured state and clear the flag. Safe no-op otherwise.
 */
export async function restoreDndOnLaunch(): Promise<void> {
  try {
    const state = readState();
    if (!state?.modified) return;
    log('warn', 'restoring DND left modified by a prior run');
    if (state.platform === 'win32') {
      await winRestore(state.prior);
    } else if (state.platform === 'darwin') {
      await macRunShortcut(MAC_DND_OFF_SHORTCUT);
    }
    clearState();
  } catch (err) {
    log('error', 'restoreDndOnLaunch failed', err);
  }
}
