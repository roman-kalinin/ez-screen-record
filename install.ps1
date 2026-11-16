# Ez Screen Record - one-line installer for Windows.
#
#   irm https://roman-kalinin.github.io/ez-screen-record/install.ps1 | iex
#
# Downloads the latest Windows installer from GitHub Releases, installs it for
# the current user (no admin rights needed) and opens the app. Running it again
# updates to the newest version.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = 'roman-kalinin/ez-screen-record'
$AppName = 'Ez Screen Record'

function Say($msg)  { Write-Host '==> ' -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Fail($msg) { Write-Host 'Error: ' -ForegroundColor Red -NoNewline; Write-Host $msg; return }

& {
  Say 'Looking up the latest release...'
  try {
    $release = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$Repo/releases/latest"
  } catch {
    Fail 'Could not reach GitHub. Check your internet connection and try again.'; return
  }

  $asset = $release.assets | Where-Object { $_.name -like '*.exe' } | Select-Object -First 1
  if (-not $asset) { Fail "The latest release ($($release.tag_name)) has no Windows installer yet."; return }

  $installer = Join-Path $env:TEMP $asset.name
  Say "Downloading $AppName $($release.tag_name -replace '^v','')..."
  Invoke-WebRequest -UseBasicParsing $asset.browser_download_url -OutFile $installer

  # The installer can't replace files of a running app.
  Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  Say 'Installing...'
  $p = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0) { Fail "The installer exited with code $($p.ExitCode)."; return }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\$AppName\$AppName.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\ez-screen-record\$AppName.exe")
  )
  $exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

  if ($exe) {
    Say "Opening $AppName..."
    Start-Process -FilePath $exe
  }
  Say "Done. $AppName is in your Start menu and on your desktop."
}
