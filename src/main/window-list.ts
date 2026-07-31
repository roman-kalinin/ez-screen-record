/**
 * Listing and un-minimizing windows that Chromium refuses to enumerate.
 *
 * `desktopCapturer.getSources` drops minimized windows before the picker ever
 * sees them — WebRTC's shared enumeration filter is literally
 * `if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) skip`, which is why Google
 * Meet, Teams and every Electron app behave the same way. Toggling the WGC
 * capturer flags does nothing, because the filter runs during enumeration,
 * above whichever capture backend is selected.
 *
 * That filter is only about ENUMERATION though, and we are free not to use it.
 * A minimized window genuinely cannot be captured — DWM stops compositing it,
 * so there is no surface and no amount of API choice conjures one — but it can
 * be restored first. The trick that makes this pleasant is DWMWA_CLOAK, whose
 * documentation says: "Cloaks the window such that it is not visible to the
 * user. The window is still composed by DWM." So the window can be restored
 * while cloaked, which hides the restore animation, then uncloaked to capture.
 *
 * Teams, by comparison, simply freezes the shared frame when a window is
 * minimized, and OBS refuses to list such windows at all.
 */

import { execFile } from 'child_process';

export interface ListedWindow {
  /** HWND as a decimal string; matches CaptureSource.id's window:<hwnd>:0 form. */
  handle: string;
  title: string;
  minimized: boolean;
}

/**
 * Enumerate top-level windows, including minimized ones.
 *
 * Implemented with a short PowerShell script rather than a native addon so it
 * works in every build of the app, including where the optional native
 * accelerator is absent.
 */
export function listAllWindows(): Promise<ListedWindow[]> {
  // Windows-only by construction. On macOS `desktopCapturer` already returns
  // minimized windows, so there is nothing to supplement — returning empty lets
  // the caller fall through to Chromium's list rather than merging garbage.
  if (process.platform !== 'win32') return Promise.resolve([]);

  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class EzWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
}
"@
$out = New-Object System.Collections.ArrayList
$cb = [EzWin+EnumProc]{
  param($h, $p)
  if (-not [EzWin]::IsWindowVisible($h)) { return $true }
  $len = [EzWin]::GetWindowTextLength($h)
  if ($len -eq 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [void][EzWin]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  # Tool windows are palettes and popups, not things anyone means to record.
  $ex = [EzWin]::GetWindowLong($h, -20)
  if (($ex -band 0x00000080) -ne 0 -and ($ex -band 0x00040000) -eq 0) { return $true }
  # DWMWA_CLOAKED: UWP keeps invisible ghost windows around that would
  # otherwise flood the list.
  $cloaked = 0
  [void][EzWin]::DwmGetWindowAttribute($h, 14, [ref]$cloaked, 4)
  if ($cloaked -ne 0) { return $true }
  [void]$out.Add([pscustomobject]@{
    handle = $h.ToInt64().ToString()
    title = $title
    minimized = [bool][EzWin]::IsIconic($h)
  })
  return $true
}
[void][EzWin]::EnumWindows($cb, [IntPtr]::Zero)
$out | ConvertTo-Json -Compress
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        try {
          const parsed = JSON.parse(stdout);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            rows
              .filter((r) => r && r.handle && r.title)
              .map((r) => ({
                handle: String(r.handle),
                title: String(r.title),
                minimized: Boolean(r.minimized),
              })),
          );
        } catch {
          resolve([]);
        }
      },
    );
  });
}

/**
 * Bring a minimized window back so it can be captured, without the user
 * watching it fly out of the taskbar.
 *
 * Cloak first so the restore is invisible, restore with SW_SHOWNOACTIVATE so
 * focus is not stolen from whatever the user is doing, give DWM a moment to
 * compose a frame, then uncloak. The cloak hides the transition; it is not
 * meant to persist, and the window must be genuinely visible to DWM for
 * capture to produce frames.
 *
 * Falls back to a plain visible restore: some apps decline to repaint while
 * cloaked, and a window the user can see beats a black rectangle.
 */
export function restoreWindowForCapture(handle: string): Promise<boolean> {
  // See listAllWindows: the minimized-window problem this works around is
  // specific to WebRTC's enumeration filter on Windows.
  if (process.platform !== 'win32') return Promise.resolve(false);

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EzRestore {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
}
"@
$h = [IntPtr]::new([int64]${handle})
if (-not [EzRestore]::IsIconic($h)) { 'ok'; exit }
$on = 1; $off = 0
# DWMWA_CLOAK = 13
[void][EzRestore]::DwmSetWindowAttribute($h, 13, [ref]$on, 4)
# SW_SHOWNOACTIVATE = 4 — restore without taking focus.
[void][EzRestore]::ShowWindow($h, 4)
Start-Sleep -Milliseconds 180
[void][EzRestore]::DwmSetWindowAttribute($h, 13, [ref]$off, 4)
if ([EzRestore]::IsIconic($h)) {
  # The app refused to come back while cloaked; restore it visibly instead.
  [void][EzRestore]::ShowWindow($h, 9)   # SW_RESTORE
}
if ([EzRestore]::IsIconic($h)) { 'failed' } else { 'ok' }
`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(!err && stdout.includes('ok')),
    );
  });
}
