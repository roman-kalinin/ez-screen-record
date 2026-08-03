<#
.SYNOPSIS
    Build and package the WinUI version of Ez Screen Record.

.DESCRIPTION
    Publishes a self-contained, unpackaged build and stages the bundled ffmpeg
    next to it. Unpackaged (rather than MSIX) is deliberate: an MSIX identity
    runs the app in an AppContainer, which blocks the arbitrary-path file writes
    a recorder needs to save into the user's Videos folder.

.PARAMETER Ffmpeg
    Path to the ffmpeg.exe to bundle. Defaults to the slim build produced by
    tools/build-ffmpeg-slim.sh, falling back to the Electron app's copy.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Configuration Debug -SkipFfmpeg
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',

    [string]$Ffmpeg,

    [switch]$SkipFfmpeg
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$project = Join-Path $root 'EzScreenRecord\EzScreenRecord.csproj'
$output = Join-Path $root "dist\$Configuration"

Write-Host "==> Publishing ($Configuration)" -ForegroundColor Cyan
dotnet publish $project -c $Configuration -r win-x64 --self-contained true -o $output
if ($LASTEXITCODE -ne 0) { throw "publish failed with exit code $LASTEXITCODE" }

if (-not $SkipFfmpeg) {
    if (-not $Ffmpeg) {
        $candidates = @(
            (Join-Path $root '..\resources\ffmpeg\ffmpeg.exe')
        )
        $Ffmpeg = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    }

    if ($Ffmpeg -and (Test-Path $Ffmpeg)) {
        $dest = Join-Path $output 'ffmpeg'
        New-Item -ItemType Directory -Force $dest | Out-Null
        Copy-Item $Ffmpeg (Join-Path $dest 'ffmpeg.exe') -Force

        $mb = (Get-Item (Join-Path $dest 'ffmpeg.exe')).Length / 1MB
        Write-Host ("==> Bundled ffmpeg: {0:N1} MB" -f $mb) -ForegroundColor Cyan
    }
    else {
        Write-Warning "No ffmpeg found to bundle. The app will fall back to PATH."
        Write-Warning "Build a slim one with tools/build-ffmpeg-slim.sh, or pass -Ffmpeg <path>."
    }
}

$size = (Get-ChildItem $output -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("==> Output: {0}" -f $output) -ForegroundColor Green
Write-Host ("==> Total size: {0:N1} MB" -f $size) -ForegroundColor Green
