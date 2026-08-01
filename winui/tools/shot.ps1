<#
.SYNOPSIS
    Screenshot a window (or the whole desktop) so UI work can be checked visually.

.DESCRIPTION
    Written because "the app launched" is not evidence that the app works. Every
    UI change should be looked at, not assumed.

    Uses PrintWindow with PW_RENDERFULLCONTENT for a specific window, which
    captures it even when partly covered, and falls back to a full-screen grab.

.PARAMETER Title
    Substring of the target window's title. Omit to capture the whole desktop.

.PARAMETER Process
    Restrict the search to windows owned by this process name. Worth using:
    matching on title alone happily picked an Explorer window whose path
    contained the app's name.

.PARAMETER Out
    Output PNG path.

.EXAMPLE
    .\shot.ps1 -Title "Ez Screen Record" -Out shot.png
    .\shot.ps1 -Out desktop.png
#>
[CmdletBinding()]
param(
    [string]$Title,
    [string]$Process,
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class ShotNative {
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindByTitle(string needle) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(h, sb, sb.Capacity);
            if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@ -ReferencedAssemblies System.Drawing, System.Drawing.Primitives

if ($Process) {
    # Process-scoped lookup, which is unambiguous. MainWindowHandle only covers
    # the primary window, so secondary windows (toolbar, overlay) are matched by
    # title within the same process.
    $procs = @(Get-Process -Name $Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 })
    if ($procs.Count -eq 0) { throw "No running process '$Process' with a window" }

    $hwnd = if ($Title) {
        ($procs | Where-Object { $_.MainWindowTitle -like "*$Title*" } |
            Select-Object -First 1).MainWindowHandle
    }
    else {
        $procs[0].MainWindowHandle
    }
    if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) {
        throw "No window in '$Process' matching '$Title'"
    }
}
elseif ($Title) {
    $hwnd = [ShotNative]::FindByTitle($Title)
    if ($hwnd -eq [IntPtr]::Zero) { throw "No visible window matching '$Title'" }
}

if ($hwnd) {

    # Bring it forward so the capture shows it as the user would see it.
    [void][ShotNative]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400

    $r = New-Object ShotNative+RECT
    [void][ShotNative]::GetWindowRect($hwnd, [ref]$r)
    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -le 0 -or $h -le 0) { throw "Window has no size" }

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $dc = $g.GetHdc()
    # PW_RENDERFULLCONTENT (2): required for DWM-composited windows, which is
    # all of them; without it most come back solid black.
    [void][ShotNative]::PrintWindow($hwnd, $dc, 2)
    $g.ReleaseHdc($dc)
    $g.Dispose()
}
else {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $g.Dispose()
}

$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"{0}  ({1}x{2})" -f (Resolve-Path $Out).Path, $bmp.Width, $bmp.Height
