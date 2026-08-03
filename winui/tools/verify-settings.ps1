<#
.SYNOPSIS
    Prove each recording setting actually changes the output.

.DESCRIPTION
    A toggle that flips in the UI and persists to settings.json still tells you
    nothing about whether ffmpeg honoured it. Each case here writes the setting,
    records a short take, and reads the property back off the produced file.

    Runs headless-ish: the app is launched, driven by hotkey, and closed per
    case, so a failure in one case cannot poison the next.
#>
[CmdletBinding()]
param([switch]$KeepFiles)

$ErrorActionPreference = 'Stop'

# keybd_event rather than SendKeys: the app's hotkeys are RegisterHotKey
# globals, served from the real keyboard queue, and SendKeys only posts to the
# focused window.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SKeys {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public static void Tap(byte vk) {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        keybd_event(vk, 0, 2, UIntPtr.Zero);
    }
}
'@
function Tap($vk) { [SKeys]::Tap([byte]$vk) }

$root = Split-Path -Parent $PSCommandPath
$Exe = (Resolve-Path "$root\..\EzScreenRecord\bin\Debug\net9.0-windows10.0.26100.0\win-x64\EzScreenRecord.exe").Path
$Ffmpeg = (Resolve-Path "$root\..\..\resources\ffmpeg\ffmpeg.exe").Path
$SettingsFile = "$env:APPDATA\Ez Screen Record\settings.json"
$OutDir = "$env:USERPROFILE\Videos\Ez Screen Record"

$script:pass = 0; $script:fail = 0; $script:failures = @()
function Check($name, $ok, $detail) {
    if ($ok) { "  [PASS] $name"; $script:pass++ }
    else { "  [FAIL] $name$(if ($detail) { " -- $detail" })"; $script:fail++; $script:failures += $name }
}

function Probe($file) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { (& $Ffmpeg -hide_banner -i $file 2>&1 | Out-String) } finally { $ErrorActionPreference = $old }
}

# Record one take with the given settings mutation applied, return the file.
function RecordWith([scriptblock]$mutate, [int]$seconds = 5) {
    Get-Process EzScreenRecord, ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    foreach ($old in @(Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $old.FullName -Force -ErrorAction SilentlyContinue
    }

    # Settings are read once at startup, so they must be on disk before launch.
    $s = Get-Content $SettingsFile -Raw | ConvertFrom-Json
    & $mutate $s
    $s | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8

    $p = Start-Process $Exe -PassThru
    Start-Sleep -Seconds 9
    Tap 0x78
    Start-Sleep -Seconds ($seconds + 4)   # +4 covers the countdown
    Tap 0x78

    # Wait for the file rather than guessing how long the drain, join and mux
    # take -- a fixed sleep reported "no file produced" for takes that were
    # simply still being written, which looks exactly like a real failure.
    $deadline = 40
    while ($deadline -gt 0) {
        $done = @(Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue |
            Where-Object { $_.Length -gt 100kb })
        # Settled means ffmpeg has released it: the mux renames over the file
        # last, so a readable handle plus no running ffmpeg means finished.
        if ($done -and -not (Get-Process ffmpeg -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 2
        $deadline -= 2
    }

    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Get-Process ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force

    Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
}

$backup = Get-Content $SettingsFile -Raw

try {
    "=== system audio OFF, mic OFF: the file must have no audio track ==="
    $f = RecordWith { param($s)
        $s.recording.systemAudioEnabled = $false
        $s.recording.micEnabled = $false
    }
    if ($f) {
        $i = Probe $f.FullName
        Check "no audio stream when both sources are off" (-not ($i -match 'Audio:')) `
            (($i -split "`n" | Select-String 'Stream #') -join '; ')
    }
    else { Check "no audio stream when both sources are off" $false "no file produced" }

    "=== system audio ON: the file must have an audio track ==="
    $f = RecordWith { param($s)
        $s.recording.systemAudioEnabled = $true
        $s.recording.micEnabled = $false
    }
    if ($f) {
        $i = Probe $f.FullName
        Check "audio stream present with system audio on" ($i -match 'Audio:') ""
    }
    else { Check "audio stream present with system audio on" $false "no file produced" }

    # The enum member is Compact; the JSON converter is camelCase.
    "=== quality preset drives chroma: compact = 4:2:0 ==="
    $f = RecordWith { param($s) $s.recording.quality = 'compact' }
    if ($f) {
        $i = Probe $f.FullName
        Check "compact preset encodes 4:2:0" ($i -match 'yuv420p') `
            (($i -split "`n" | Select-String 'Video:') -join '')
    }
    else { Check "compact preset encodes 4:2:0" $false "no file produced" }

    "=== resolution setting drives output height ==="
    $f = RecordWith { param($s)
        $s.recording.quality = 'high'
        $s.recording.resolution = 'p1080'
    }
    if ($f) {
        $i = Probe $f.FullName
        Check "1080p setting produces a 1080-tall file" ($i -match 'x1080') `
            (($i -split "`n" | Select-String 'Video:') -join '')
    }
    else { Check "1080p setting produces a 1080-tall file" $false "no file produced" }

    # An unknown enum value used to throw during deserialisation and drop the
    # ENTIRE file back to defaults -- camera position, mic, source and all.
    # This file is shared with the Electron build, so that was reachable simply
    # by one version writing a value the other did not know.
    "=== an unreadable value must not wipe the rest of the settings ==="
    Get-Process EzScreenRecord -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $s = Get-Content $SettingsFile -Raw | ConvertFrom-Json
    $s.recording.quality = 'nonsense-value-from-the-future'
    $s.camera.deviceName = 'MarkerCam'
    $s | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8

    $p = Start-Process $Exe -PassThru
    Start-Sleep -Seconds 10
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    $after = Get-Content $SettingsFile -Raw | ConvertFrom-Json
    Check "settings outside the bad section survive" `
        ($after.camera.deviceName -eq 'MarkerCam') `
        "camera.deviceName is now '$($after.camera.deviceName)'"

    "=== camera disabled: no bubble window, take still records ==="
    $f = RecordWith { param($s)
        $s.recording.resolution = 'p1440'
        $s.camera.enabled = $false
    }
    if ($f) {
        $i = Probe $f.FullName
        Check "records fine with the camera off" ($i -match 'Video: h264' -and $f.Length -gt 100kb) `
            ("{0:N2} MB" -f ($f.Length / 1MB))
    }
    else { Check "records fine with the camera off" $false "no file produced" }
}
finally {
    # Kill the app FIRST and let it die: it saves settings on shutdown, so
    # restoring while it is still running just gets overwritten -- which left
    # `quality: compact` behind and failed the next suite's 4:4:4 check.
    Get-Process EzScreenRecord, ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    $backup | Set-Content $SettingsFile -Encoding UTF8
    if (-not $KeepFiles) {
        foreach ($f in @(Get-ChildItem -LiteralPath $OutDir -Filter *.mp4 -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

""
"passed: $script:pass   failed: $script:fail"
if ($script:fail -gt 0) {
    "failing:"; $script:failures | ForEach-Object { "  - $_" }
    exit 1
}

