<#
.SYNOPSIS
    Drive the real app through real scenarios and check the RESULTS.

.DESCRIPTION
    Written because "it builds" and "it launched" repeatedly passed while the
    app was visibly broken. Every check here exercises a feature the way a user
    does -- global hotkeys, real windows -- and then inspects what came out:
    the recorded file, the window geometry, the pixels on screen.

    Screenshots alone are useless for this app: the toolbar, palette and camera
    bubble carry WDA_EXCLUDEFROMCAPTURE and are absent from any capture. Window
    handles and ffprobe output are the ground truth instead.

.EXAMPLE
    .\verify.ps1
#>
[CmdletBinding()]
param(
    [string]$Exe,
    [string]$Ffmpeg
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

# $PSScriptRoot is not available in param() defaults under Windows PowerShell,
# so resolve here. Start-Process also refuses a path containing "\..\", hence
# Resolve-Path rather than plain concatenation.
$root = Split-Path -Parent $PSCommandPath
if (-not $Exe) {
    $Exe = "$root\..\EzScreenRecord\bin\Debug\net9.0-windows10.0.26100.0\win-x64\EzScreenRecord.exe"
}
if (-not $Ffmpeg) { $Ffmpeg = "$root\..\..\resources\ffmpeg\ffmpeg.exe" }
$Exe = (Resolve-Path $Exe).Path
$Ffmpeg = (Resolve-Path $Ffmpeg).Path

$script:pass = 0
$script:fail = 0
$script:failures = @()

function Check($name, $ok, $detail) {
    if ($ok) {
        "  [PASS] $name"
        $script:pass++
    }
    else {
        "  [FAIL] $name$(if ($detail) { " -- $detail" })"
        $script:fail++
        $script:failures += $name
    }
}

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class V {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    public delegate bool EnumProc(IntPtr h, IntPtr p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R2, B; }

    /// Visible windows of a process, as "title|x|y|w|h".
    public static string[] Windows(uint pid) {
        var list = new System.Collections.Generic.List<string>();
        EnumWindows((h, p) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h); if (len == 0) return true;
            var sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
            RECT r; GetWindowRect(h, out r);
            list.Add(sb + "|" + r.L + "|" + r.T + "|" + (r.R2 - r.L) + "|" + (r.B - r.T));
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
'@

function AppWindows { [V]::Windows([uint32]$script:proc.Id) }
function HasWindow($needle) { @(AppWindows | Where-Object { $_ -like "*$needle*" }).Count -gt 0 }
function WindowSize($needle) {
    $w = AppWindows | Where-Object { $_ -like "*$needle*" } | Select-Object -First 1
    if (-not $w) { return $null }
    $p = $w -split '\|'
    [pscustomobject]@{ X = [int]$p[1]; Y = [int]$p[2]; W = [int]$p[3]; H = [int]$p[4] }
}
# keybd_event, not SendKeys.
#
# The app's hotkeys are RegisterHotKey globals, which are served from the real
# keyboard input queue. SendKeys posts WM_KEYDOWN to the focused window, which
# those never see -- F8 silently did nothing here while working perfectly by
# hand, and that read as an app bug for a whole debugging round.
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
// Not "Keys": System.Windows.Forms.Keys is already in scope and [Keys]::Tap
// would bind to that enum instead.
public class EzKeys {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    public static void Tap(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        keybd_event(vk, 0, 2 /* KEYEVENTF_KEYUP */, UIntPtr.Zero);
    }

    /// Raise the app's main window. Synthetic input from a non-foreground
    /// process is filtered by UIPI, so without this every hotkey is silently
    /// dropped -- which reads exactly like a broken app.
    public static void Focus(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner != pid || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(300); GetWindowText(h, sb, 300);
            if (sb.ToString() == "Ez Screen Record") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        if (found != IntPtr.Zero) SetForegroundWindow(found);
    }
}
'@

function Key($k) {
    $vk = switch ($k) { '{F8}' { 0x77 } '{F9}' { 0x78 } '{F10}' { 0x79 } }
    if (-not $vk) { throw "verify.ps1: no virtual-key mapping for '$k'" }

    # Re-assert foreground before every key: the app hides its main window
    # during a take and shows the toolbar instead, so focus moves around.
    [EzKeys]::Focus([uint32]$script:proc.Id)
    Start-Sleep -Milliseconds 300
    [EzKeys]::Tap([byte]$vk)
    Start-Sleep -Milliseconds 600
}
# `ffmpeg -i` with no output always exits 1 and writes the stream table to
# stderr, which is exactly what we want to read. Suppress the failure so
# $ErrorActionPreference='Stop' does not abort the run on a successful probe.
function Probe($file) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { (& $Ffmpeg -hide_banner -i $file 2>&1 | Out-String) }
    finally { $ErrorActionPreference = $old }
}

# --- Clean slate ------------------------------------------------------------

Get-Process EzScreenRecord, ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$outDir = "$env:USERPROFILE\Videos\Ez Screen Record"
New-Item -ItemType Directory -Force $outDir | Out-Null
Get-ChildItem $outDir -Filter *.mp4 -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

"=== launch ==="
$script:proc = Start-Process $Exe -PassThru
Start-Sleep -Seconds 10
Check "app starts and stays running" (-not $script:proc.HasExited) "exit code $($script:proc.ExitCode)"
Check "main window is up" (HasWindow "Ez Screen Record") ""

"=== recording ==="
Key "{F9}"
Start-Sleep -Seconds 5

Check "toolbar appears while recording" (HasWindow "toolbar") ""
$bar = WindowSize "toolbar"
Check "toolbar is bar-sized, not full-screen" ($bar -and $bar.W -lt 900 -and $bar.H -lt 120) `
    "$(if ($bar) { "$($bar.W)x$($bar.H)" } else { 'not found' })"
Check "main window hides during a take" (-not (HasWindow "Ez Screen Record|")) ""
Check "camera bubble appears" (HasWindow "Camera") ""
Check "ffmpeg is running" (@(Get-Process ffmpeg -ErrorAction SilentlyContinue).Count -ge 1) ""

"=== pause / resume ==="
$before = @(Get-ChildItem $outDir -Filter *.mp4 -ErrorAction SilentlyContinue).Count
Key "{F10}"
Start-Sleep -Seconds 4
Check "pause ends the current segment (ffmpeg not running)" `
    (@(Get-Process ffmpeg -ErrorAction SilentlyContinue).Count -eq 0) ""

Key "{F10}"
Start-Sleep -Seconds 4
Check "resume starts a new segment" `
    (@(Get-Process ffmpeg -ErrorAction SilentlyContinue).Count -ge 1) ""

"=== stop and inspect the file ==="
Key "{F9}"
Start-Sleep -Seconds 20

Check "main window returns after the take" (HasWindow "Ez Screen Record") ""
Check "toolbar is gone" (-not (HasWindow "toolbar")) ""
Check "camera bubble is gone" (-not (HasWindow "Camera")) ""
Check "no orphaned ffmpeg" (@(Get-Process ffmpeg -ErrorAction SilentlyContinue).Count -eq 0) ""

$files = @(Get-ChildItem $outDir -Filter *.mp4 -ErrorAction SilentlyContinue)
Check "exactly one output file (segments were joined)" ($files.Count -eq 1) `
    "found $($files.Count): $($files.Name -join ', ')"

if ($files.Count -ge 1) {
    $rec = $files | Sort-Object LastWriteTime | Select-Object -Last 1
    Check "file is not empty" ($rec.Length -gt 100kb) ("{0:N2} MB" -f ($rec.Length / 1MB))

    $info = Probe $rec.FullName
    Check "has a video stream" ($info -match 'Video: h264') ""
    Check "video is 4:4:4 (quality promise)" ($info -match 'High 4:4:4') ""
    Check "has an audio stream" ($info -match 'Audio:') ""

    $secs = 0
    if ($info -match 'Duration: (\d+):(\d+):([\d.]+)') {
        $secs = [int]$Matches[1] * 3600 + [int]$Matches[2] * 60 + [double]$Matches[3]
        # ~9s of recording split by a ~4s pause. Paused time must NOT be in the
        # file: if it is, the duration lands near 17s instead of near 9s.
        Check "paused time is excluded from the duration" ($secs -lt 14) `
            ("{0:N1}s" -f $secs)
    }

    # The duration in the header is NOT proof the file plays. A concat of
    # segments with mismatched SPS/PPS reports the full length while
    # everything after the first pause decodes to nothing -- silently, with
    # no ffmpeg error. Decoding to a frame count is the only honest check.
    $dec = "$env:TEMP\ez-verify-frames"
    Remove-Item $dec -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $dec | Out-Null
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $Ffmpeg -y -hide_banner -loglevel error -i $rec.FullName `
        -map 0:v -vf "fps=1,scale=160:-1" -c:v mjpeg -q:v 20 `
        "$dec\f_%03d.jpg" 2>&1 | Out-Null
    $ErrorActionPreference = $old
    $frames = @(Get-ChildItem $dec -Filter *.jpg -ErrorAction SilentlyContinue).Count
    Remove-Item $dec -Recurse -Force -ErrorAction SilentlyContinue

    # One frame per second of a file that decodes end to end.
    Check "the whole file decodes, including past the pause" `
        ($frames -ge [math]::Floor($secs) - 1) `
        "$frames decodable seconds of $([math]::Round($secs,1))s"
}

"=== leftovers ==="
Check "no stray .part files" `
    (@(Get-ChildItem $outDir -Filter "*.part*.mp4" -ErrorAction SilentlyContinue).Count -eq 0) ""
Check "no stray .joined/.mixed files" `
    (@(Get-ChildItem $outDir -Filter "*.joined.mp4" -ErrorAction SilentlyContinue).Count +
     @(Get-ChildItem $outDir -Filter "*.mixed.mp4" -ErrorAction SilentlyContinue).Count -eq 0) ""
Check "no leftover system-audio wav" `
    (@(Get-ChildItem $env:TEMP -Filter "ez-sysaudio-*.wav" -ErrorAction SilentlyContinue).Count -eq 0) ""

"=== drawing overlay ==="
Key "{F8}"
Start-Sleep -Seconds 3
Check "drawing overlay opens" (HasWindow "drawing") ""
Check "tool palette opens" (HasWindow "tools") ""
Key "{F8}"
Start-Sleep -Seconds 2
Check "overlay closes again" (-not (HasWindow "drawing")) ""

Get-Process EzScreenRecord, ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force

""
"passed: $script:pass   failed: $script:fail"
if ($script:fail -gt 0) {
    "failing:"
    $script:failures | ForEach-Object { "  - $_" }
    exit 1
}
