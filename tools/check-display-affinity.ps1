<#
.SYNOPSIS
  Reads back GetWindowDisplayAffinity for every top-level window of a process,
  so you can confirm which windows are actually excluded from screen capture.

.DESCRIPTION
  Electron's setContentProtection(true) calls SetWindowDisplayAffinity(hwnd,
  WDA_EXCLUDEFROMCAPTURE). This script reads the flag back from the OS, which is
  the only ground truth -- Electron will happily report success for a call that
  the OS later reset (e.g. after win.hide(), see electron/electron#45844).

  Affinity values:
    0x00  WDA_NONE               -> fully capturable
    0x01  WDA_MONITOR            -> captured as a BLACK rectangle
    0x11  WDA_EXCLUDEFROMCAPTURE -> genuinely absent from capture (Win10 2004+)

  Also dumps the extended window styles, because WS_EX_LAYERED is load-bearing:
  Electron sets it as part of content protection, and SetIgnoreMouseEvents(false)
  strips it back off.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\check-display-affinity.ps1

.EXAMPLE
  # Watch live while you start a recording, to catch the flag being reset:
  .\tools\check-display-affinity.ps1 -Watch

.EXAMPLE
  .\tools\check-display-affinity.ps1 -ProcessName chrome
#>
[CmdletBinding()]
param(
    # Process(es) to inspect. Defaults to Electron dev + a packaged build.
    [string[]] $ProcessName = @('electron', 'Ez Screen Record', 'ez-screen-record'),

    # Inspect one specific HWND instead of scanning processes. Accepts decimal
    # or 0x-prefixed hex.
    [string] $Hwnd,

    # Re-poll every -IntervalMs until Ctrl+C. Use this to catch the exact moment
    # the affinity flips (e.g. on hide/show or setIgnoreMouseEvents).
    [switch] $Watch,

    [int] $IntervalMs = 1000,

    # Include windows with no title. Off by default: Electron creates many
    # invisible helper/message-only windows that are pure noise.
    [switch] $IncludeUntitled
)

$ErrorActionPreference = 'Stop'

if (-not ('Win32.WinAffinity' -as [type])) {
    Add-Type -Namespace Win32 -Name WinAffinity -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);

[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool IsWindowVisible(IntPtr hWnd);

[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

[DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongPtrW")]
public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

[DllImport("user32.dll", SetLastError = true, EntryPoint = "GetWindowLongW")]
public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
'@
}

# GetWindowLongPtrW does not exist in 32-bit user32; fall back transparently.
function Get-ExStyle {
    param([IntPtr] $H)
    try {
        if ([IntPtr]::Size -eq 8) {
            return [uint64][Win32.WinAffinity]::GetWindowLongPtr64($H, -20)
        }
        return [uint64][uint32][Win32.WinAffinity]::GetWindowLong32($H, -20)
    } catch {
        return [uint64]0
    }
}

function Get-WindowText {
    param([IntPtr] $H)
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32.WinAffinity]::GetWindowTextW($H, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Get-WindowClass {
    param([IntPtr] $H)
    $sb = New-Object System.Text.StringBuilder 256
    [void][Win32.WinAffinity]::GetClassNameW($H, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Format-Affinity {
    param([uint32] $Value)
    switch ($Value) {
        0x00 { 'WDA_NONE               (CAPTURABLE)' }
        0x01 { 'WDA_MONITOR            (captured as BLACK box)' }
        0x11 { 'WDA_EXCLUDEFROMCAPTURE (protected)' }
        default { ('0x{0:X2} (unknown)' -f $Value) }
    }
}

# Only the ex-styles that actually matter for this investigation.
$exStyleFlags = [ordered]@{
    'WS_EX_TOPMOST'     = 0x00000008
    'WS_EX_TRANSPARENT' = 0x00000020
    'WS_EX_TOOLWINDOW'  = 0x00000080
    'WS_EX_LAYERED'     = 0x00080000
    'WS_EX_NOACTIVATE'  = 0x08000000
}

function Format-ExStyle {
    param([uint64] $Ex)
    $set = foreach ($k in $exStyleFlags.Keys) {
        if ($Ex -band $exStyleFlags[$k]) { $k }
    }
    if ($set) { $set -join ' | ' } else { '(none of interest)' }
}

function Get-AffinityReport {
    $rows = New-Object System.Collections.Generic.List[object]

    if ($Hwnd) {
        $raw = if ($Hwnd -match '^0x') { [Convert]::ToInt64($Hwnd, 16) } else { [int64]$Hwnd }
        $handles = @([IntPtr]$raw)
        $owner = '(explicit -Hwnd)'
        foreach ($h in $handles) {
            $rows.Add((New-AffinityRow -H $h -Owner $owner))
        }
        return $rows
    }

    $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if (-not $procs) {
        Write-Warning ("No running process matched: {0}" -f ($ProcessName -join ', '))
        Write-Warning "Pass -ProcessName <name> (no .exe) or -Hwnd <handle>."
        return $rows
    }

    foreach ($p in $procs) {
        # MainWindowHandle only ever exposes ONE window per process, which is
        # useless here -- we need every top-level window. Walk the whole
        # top-level chain and filter by owning PID instead.
        foreach ($h in Get-TopLevelWindowsForPid -TargetPid $p.Id) {
            $rows.Add((New-AffinityRow -H $h -Owner ("{0} (pid {1})" -f $p.ProcessName, $p.Id)))
        }
    }
    return $rows
}

# EnumWindows via P/Invoke needs a delegate, which is awkward to marshal from
# PowerShell. GetWindow(GW_HWNDFIRST/GW_HWNDNEXT) walks the same z-ordered
# top-level list with no callback required.
function Get-TopLevelWindowsForPid {
    param([int] $TargetPid)

    $result = New-Object System.Collections.Generic.List[IntPtr]

    # Start at the true head of the top-level z-order list. Seeding from a
    # window owned by the target process and rewinding is NOT equivalent: the
    # list head reached that way is only the head as far as that window's own
    # position allows, and hidden (show:false) windows may not be reachable.
    # GetDesktopWindow + GW_CHILD gives the real first top-level window.
    $desktop = [Win32.NativeMethods]::GetDesktopWindow()
    $cur = [Win32.WinAffinity]::GetWindow($desktop, 5)  # GW_CHILD

    $guard = 0
    while ($cur -ne [IntPtr]::Zero -and $guard -lt 10000) {
        $guard++
        $wpid = 0
        [void][Win32.NativeMethods]::GetWindowThreadProcessId($cur, [ref]$wpid)
        if ($wpid -eq $TargetPid) { $result.Add($cur) | Out-Null }
        $cur = [Win32.WinAffinity]::GetWindow($cur, 2)  # GW_HWNDNEXT
    }
    return $result
}

if (-not ('Win32.NativeMethods' -as [type])) {
    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern int GetWindowThreadProcessId(IntPtr hWnd, ref int lpdwProcessId);

[DllImport("user32.dll", SetLastError = true)]
public static extern IntPtr GetDesktopWindow();
'@
}

function New-AffinityRow {
    param([IntPtr] $H, [string] $Owner)

    $aff = [uint32]0
    $ok = [Win32.WinAffinity]::GetWindowDisplayAffinity($H, [ref]$aff)
    $err = if ($ok) { '' } else { ('GetWindowDisplayAffinity failed (err {0})' -f [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    $ex = Get-ExStyle -H $H

    [pscustomobject]@{
        Hwnd      = ('0x{0:X}' -f [int64]$H)
        Owner     = $Owner
        Title     = Get-WindowText -H $H
        Class     = Get-WindowClass -H $H
        Visible   = [Win32.WinAffinity]::IsWindowVisible($H)
        Affinity  = Format-Affinity -Value $aff
        Protected = ($aff -eq 0x11)
        ExStyle   = Format-ExStyle -Ex $ex
        Error     = $err
    }
}

function Show-Report {
    $rows = Get-AffinityReport
    if (-not $IncludeUntitled) {
        $rows = $rows | Where-Object { $_.Title -ne '' }
    }

    Write-Host ''
    Write-Host ('=== Window display affinity @ {0} ===' -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor Cyan

    if (-not $rows) {
        Write-Host 'No matching windows found. Try -IncludeUntitled.' -ForegroundColor Yellow
        return
    }

    foreach ($r in $rows) {
        $color = if ($r.Protected) { 'Green' } else { 'Red' }
        Write-Host ''
        Write-Host ('  {0}  "{1}"' -f $r.Hwnd, $r.Title) -ForegroundColor White
        Write-Host ('    class    : {0}' -f $r.Class)
        Write-Host ('    visible  : {0}' -f $r.Visible)
        Write-Host ('    affinity : {0}' -f $r.Affinity) -ForegroundColor $color
        Write-Host ('    exstyle  : {0}' -f $r.ExStyle)
        if ($r.Error) { Write-Host ('    ERROR    : {0}' -f $r.Error) -ForegroundColor Yellow }
    }
    Write-Host ''
}

if ($Watch) {
    Write-Host 'Watching... start/stop a recording now. Ctrl+C to stop.' -ForegroundColor Cyan
    while ($true) {
        Show-Report
        Start-Sleep -Milliseconds $IntervalMs
    }
} else {
    Show-Report
}
