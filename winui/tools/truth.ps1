<#
.SYNOPSIS
    Capture what is ACTUALLY on screen, including capture-excluded windows.

.DESCRIPTION
    The app marks its toolbar, palette and overlay with WDA_EXCLUDEFROMCAPTURE
    so they never appear in a recording. That also hides them from ordinary
    screenshots, which made every visual check useless and led to repeatedly
    "fixing" things that were fine and missing things that were not.

    This clears the exclusion on every window of the target process, captures,
    then restores it. What comes back is what the user sees.

.PARAMETER Out
    Output PNG path.

.PARAMETER Process
    Process whose windows should be temporarily made capturable.

.EXAMPLE
    .\truth.ps1 -Out shot.png
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Process = 'EzScreenRecord'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Truth {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    /// Windows whose exclusion we cleared, so it can be put back exactly.
    public static List<IntPtr> Cleared = new List<IntPtr>();

    public static string Unhide(uint targetPid) {
        var log = new StringBuilder();
        Cleared.Clear();
        EnumWindows((h, p) => {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != targetPid || !IsWindowVisible(h)) return true;
            uint aff;
            if (GetWindowDisplayAffinity(h, out aff) && aff != 0) {
                int len = GetWindowTextLength(h);
                var sb = new StringBuilder(len + 1);
                if (len > 0) GetWindowText(h, sb, sb.Capacity);
                SetWindowDisplayAffinity(h, 0);
                Cleared.Add(h);
                log.AppendLine("  unhid: " + sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return log.ToString();
    }

    public static void Rehide() {
        foreach (var h in Cleared) SetWindowDisplayAffinity(h, 0x11);
        Cleared.Clear();
    }
}
'@

$proc = Get-Process -Name $Process -ErrorAction SilentlyContinue | Select-Object -First 1
if ($proc) {
    $unhidden = [Truth]::Unhide([uint32]$proc.Id)
    if ($unhidden) { Write-Host $unhidden -NoNewline }
    # Give DWM a frame to recomposite without the exclusion.
    Start-Sleep -Milliseconds 350
}

try {
    $w = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width
    $h = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
    $x = [System.Windows.Forms.SystemInformation]::VirtualScreen.X
    $y = [System.Windows.Forms.SystemInformation]::VirtualScreen.Y
}
catch {
    Add-Type -AssemblyName System.Windows.Forms
    $w = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width
    $h = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
    $x = [System.Windows.Forms.SystemInformation]::VirtualScreen.X
    $y = [System.Windows.Forms.SystemInformation]::VirtualScreen.Y
}

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)),
    [System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()

if ($proc) { [Truth]::Rehide() }

$dir = Split-Path $Out -Parent
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"{0}  ({1}x{2})" -f (Resolve-Path $Out).Path, $w, $h
