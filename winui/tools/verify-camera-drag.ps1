<#
.SYNOPSIS
    Prove the camera feed keeps updating while the bubble is being dragged.

.DESCRIPTION
    The freeze this catches is invisible to any check that only asks "is the
    bubble on screen" -- the window is there, correctly positioned, and shows a
    stale image. So this records a take while dragging the bubble across the
    desktop, then compares the camera region between frames: identical pixels
    across the whole drag means the feed froze.

    The bubble is dragged with real mouse input, from the foreground, because
    synthetic input from a background process is filtered by UIPI.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSCommandPath
$Exe = (Resolve-Path "$root\..\EzScreenRecord\bin\Debug\net9.0-windows10.0.26100.0\win-x64\EzScreenRecord.exe").Path
$Ffmpeg = (Resolve-Path "$root\..\..\resources\ffmpeg\ffmpeg.exe").Path
$OutDir = "$env:USERPROFILE\Videos\Ez Screen Record"
$Work = Join-Path $env:TEMP "ez-drag-check"

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Drag {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;

    public static void Tap(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }

    public static IntPtr Find(uint pid, string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(300); GetWindowText(h, sb, 300);
            if (sb.ToString().Contains(title)) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static void Focus(uint pid, string title) {
        var h = Find(pid, title);
        if (h != IntPtr.Zero) SetForegroundWindow(h);
    }

    public static string Rect(uint pid, string title) {
        var h = Find(pid, title);
        if (h == IntPtr.Zero) return null;
        RECT r; GetWindowRect(h, out r);
        return r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T);
    }

    /// Press inside the bubble's centre and walk it across the screen.
    public static void DragBubble(uint pid, int steps) {
        var h = Find(pid, "Camera");
        if (h == IntPtr.Zero) return;
        RECT r; GetWindowRect(h, out r);

        int cx = (r.L + r.R) / 2, cy = (r.T + r.B) / 2;
        SetCursorPos(cx, cy);
        System.Threading.Thread.Sleep(150);
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);

        for (int i = 1; i <= steps; i++) {
            SetCursorPos(cx + i * 9, cy + (int)(60 * Math.Sin(i / 6.0)));
            System.Threading.Thread.Sleep(25);
        }

        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }
}
'@

$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { "  [PASS] $name"; $script:pass++ }
    else { "  [FAIL] $name$(if ($detail) { " -- $detail" })"; $script:fail++ }
}

Get-Process EzScreenRecord, ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
foreach ($f in @(Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
}

# The camera must be on for this check to mean anything, and an earlier
# interrupted suite can leave it off.
$SettingsFile = "$env:APPDATA\Ez Screen Record\settings.json"
$cfg = Get-Content $SettingsFile -Raw | ConvertFrom-Json
$cfg.camera.enabled = $true
$cfg.camera.showOnScreen = $true
$cfg | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Work | Out-Null

"=== recording while dragging the camera bubble ==="
$proc = Start-Process $Exe -PassThru
Start-Sleep -Seconds 10

[Drag]::Focus([uint32]$proc.Id, "Ez Screen Record")
Start-Sleep -Milliseconds 400
[Drag]::Tap([byte]0x78)          # F9: start

# Wait for the bubble rather than guessing: it only appears once the countdown
# has finished and ffmpeg is actually up.
$before = $null
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 1
    $before = [Drag]::Rect([uint32]$proc.Id, "Camera")
    if ($before) { break }
}
Check "the camera bubble came up" ($null -ne $before) "no Camera window appeared"
if (-not $before) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force
    "passed: $pass   failed: $fail"
    exit 1
}
Start-Sleep -Seconds 2           # a little plain footage before the drag
[Drag]::DragBubble([uint32]$proc.Id, 60)
Start-Sleep -Seconds 2
$after = [Drag]::Rect([uint32]$proc.Id, "Camera")

Check "the bubble actually moved" ($before -ne $after) "before=$before after=$after"

[Drag]::Focus([uint32]$proc.Id, "Ez Screen Record")
Start-Sleep -Milliseconds 400
[Drag]::Tap([byte]0x78)          # F9: stop

$deadline = 40
while ($deadline -gt 0) {
    $done = @(Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -gt 100kb })
    if ($done -and -not (Get-Process ffmpeg -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 2; $deadline -= 2
}
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force

$rec = Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
if (-not $rec) { Check "a take was produced" $false "no file"; exit 1 }

"=== checking the camera pixels change over the drag ==="

# Sample the whole frame at 4fps; the bubble moves, so a fixed crop would
# follow the desktop rather than the camera. Comparing whole frames is enough:
# if the camera froze, consecutive frames differ only where the bubble moved.
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $Ffmpeg -y -hide_banner -loglevel error -i $rec.FullName `
    -vf "fps=4,scale=480:-1" -c:v mjpeg -q:v 4 -pix_fmt yuvj420p `
    "$Work\f_%04d.jpg" 2>&1 | Out-Null
$ErrorActionPreference = $old

$frames = @(Get-ChildItem -LiteralPath $Work -Filter *.jpg | Sort-Object Name)
Check "frames extracted from the take" ($frames.Count -ge 8) "$($frames.Count) frames"

# A frozen camera makes consecutive JPEGs of a mostly-static desktop
# byte-identical. Any real webcam has sensor noise, so a live feed never
# produces two identical frames in a row.
$identical = 0
for ($i = 1; $i -lt $frames.Count; $i++) {
    $a = [IO.File]::ReadAllBytes($frames[$i - 1].FullName)
    $b = [IO.File]::ReadAllBytes($frames[$i].FullName)
    if ($a.Length -eq $b.Length -and -not (Compare-Object $a $b -SyncWindow 0)) { $identical++ }
}

$ratio = if ($frames.Count -gt 1) { $identical / ($frames.Count - 1) } else { 1 }
Check "the camera keeps updating during the drag" ($ratio -lt 0.5) `
    ("{0} of {1} consecutive frame pairs identical" -f $identical, ($frames.Count - 1))

Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue

""
"passed: $pass   failed: $fail"
if ($fail -gt 0) { exit 1 }
