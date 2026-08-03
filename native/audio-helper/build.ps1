# Build ez-audio-loopback.exe, the WASAPI system-audio helper for the crisp
# engine. Standalone Win32 exe (no node-gyp): compiled once and bundled next to
# ffmpeg. Requires the MSVC toolchain (cl.exe) on PATH — run from a
# "Developer PowerShell for VS" or after vcvars64.bat.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here 'loopback.cpp'
$out = Join-Path $here 'ez-audio-loopback.exe'

if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe not found. Run from a Developer PowerShell for VS (or run vcvars64.bat first)."
}

Push-Location $here
try {
    & cl.exe /nologo /std:c++17 /EHsc /O2 /W3 `
        /Fe:$out $src `
        ole32.lib
    if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }
    Write-Host "Built $out"
} finally {
    Pop-Location
    # cl leaves an .obj next to the source; drop it.
    Get-ChildItem $here -Filter '*.obj' | Remove-Item -Force -ErrorAction SilentlyContinue
}
