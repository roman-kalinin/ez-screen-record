/**
 * macOS capture permissions (TCC).
 *
 * macOS gates screen, camera and microphone access behind per-app consent, and
 * the failure mode when consent is missing is genuinely bad: ffmpeg's
 * avfoundation input fails with a generic "input/output error" that says
 * nothing about permissions, and Chromium hands back a black stream with no
 * error at all. Asking up front, and explaining what to do, is worth a lot.
 *
 * Screen recording is the awkward one — there is no API to prompt for it. The
 * OS shows its own dialog the first time something actually attempts a capture,
 * and `getMediaAccessStatus('screen')` is the only way to read the result. It
 * also does not take effect until the app is relaunched.
 *
 * All of this is a no-op on Windows.
 */

import { dialog, shell, systemPreferences } from 'electron';

const IS_MAC = process.platform === 'darwin';

/** Deep links into the exact System Settings pane for each permission. */
const SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
} as const;

export type CapturePermission = keyof typeof SETTINGS_PANES;

/**
 * Current permission state.
 *
 * Returns 'granted' on Windows and on macOS versions that predate the relevant
 * consent requirement, so callers can treat 'granted' as "go ahead".
 */
export function permissionStatus(kind: CapturePermission): string {
  if (!IS_MAC) return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus(kind);
  } catch {
    // Unknown media type on an older Electron — assume usable rather than
    // blocking the app over a status check.
    return 'granted';
  }
}

/**
 * Ask for camera or microphone access.
 *
 * Screen recording is deliberately not accepted here: it has no request API.
 * Returns true when access is usable.
 */
export async function requestPermission(kind: 'camera' | 'microphone'): Promise<boolean> {
  if (!IS_MAC) return true;
  if (permissionStatus(kind) === 'granted') return true;
  try {
    return await systemPreferences.askForMediaAccess(kind);
  } catch {
    return false;
  }
}

/** Open the System Settings pane for a permission. */
export function openSettingsFor(kind: CapturePermission): void {
  if (!IS_MAC) return;
  void shell.openExternal(SETTINGS_PANES[kind]);
}

/**
 * Check screen-recording access and, if missing, explain how to grant it.
 *
 * Returns true when recording can proceed. The relaunch instruction is not
 * optional politeness — macOS caches the permission per process, so a grant
 * made while the app is running does not apply until it restarts. Without
 * saying so, users grant access, hit the same error, and conclude the app is
 * broken.
 */
export async function ensureScreenPermission(): Promise<boolean> {
  if (!IS_MAC) return true;
  if (permissionStatus('screen') === 'granted') return true;

  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Open System Settings', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'Ez Screen Record needs permission to record your screen',
    detail:
      'Enable “Ez Screen Record” under Privacy & Security › Screen & System Audio Recording.\n\n' +
      'macOS only applies this permission when the app starts, so quit and reopen ' +
      'Ez Screen Record afterwards.',
  });

  if (response === 0) openSettingsFor('screen');
  return false;
}

/**
 * Warm up permissions shortly after launch.
 *
 * Camera and microphone prompt natively here, so the user meets them while
 * setting up rather than at the moment they press record. Screen recording is
 * only *checked* — prompting for it at launch, before the user has expressed
 * any intent to record, is the kind of thing that gets an app deleted.
 */
export async function primePermissions(): Promise<void> {
  if (!IS_MAC) return;
  // Not awaited together: each shows its own modal system prompt, and firing
  // both at once stacks them.
  await requestPermission('microphone').catch(() => false);
  await requestPermission('camera').catch(() => false);
}
