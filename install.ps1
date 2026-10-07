#Requires -Version 5.1
<#
ali-kiro installer for Windows — one-command install/upgrade for AI coding assistants.

Usage:
  irm https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File install.ps1 -Yes
  install.ps1 --dry-run
  install.ps1 --yes --only opencode

Notes:
  * `irm | iex` runs the script in the current scope, so NO ExecutionPolicy
    change is required. If you run install.ps1 from a file and your policy
    blocks it, use:  powershell -ExecutionPolicy Bypass -File install.ps1
  * The installer downloads the prebuilt binaries for windows-x64 (Windows on
    ARM runs these via emulation). Node.js LTS is auto-installed only when it
    is missing and the prebuilt binary cannot be used.

Environment overrides (optional):
  ALI_KIRO_REPO    GitHub repo "owner/repo" (default: alisattorov06/ali-kiro)
  ALI_KIRO_HOME    install location         (default: ~\.ali-kiro)
#>

param(
  [Alias('y')]
  [switch]$Yes,
  [Alias('n')]
  [switch]$DryRun,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RemainingArgs
)

$ErrorActionPreference = 'Stop'

# Always use TLS 1.2+ for downloads (some hosts default to an older protocol).
[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo          = if ($env:ALI_KIRO_REPO) { $env:ALI_KIRO_REPO } else { 'alisattorov06/ali-kiro' }
$BaseUrl       = "https://github.com/$Repo"
$RawBase       = "https://raw.githubusercontent.com/$Repo/main"
$ReleasesUrl   = "$BaseUrl/releases/latest/download"
$AliKiroHome   = if ($env:ALI_KIRO_HOME) { $env:ALI_KIRO_HOME } else { Join-Path $HOME '.ali-kiro' }
$BinDir        = Join-Path $AliKiroHome 'bin'
$SrcDir        = Join-Path $AliKiroHome 'src'
$NodeLtsFallback = '22.20.0'
$InstallerVersion = '1.0.0'
$BinaryName    = 'ali-kiro-windows-x64.exe'
$EntryMjs      = 'ali-kiro.mjs'

# Script state (written by Convert-Args)
$script:Yes          = [bool]$Yes
$script:DryRun       = [bool]$DryRun
$script:HelpRun      = $false
$script:VersionRun   = $false
$script:AfterDoubleDash = $false
$script:ToolArgs     = New-Object 'System.Collections.Generic.List[string]'

function Write-Log {
  param([string]$Msg)
  Write-Host "[ali-kiro] $Msg" -ForegroundColor Cyan
}

function Write-Warn {
  param([string]$Msg)
  Write-Host "[ali-kiro] warning: $Msg" -ForegroundColor Yellow
}

function Write-Fatal {
  param([string]$Msg)
  Write-Host "[ali-kiro] error: $Msg" -ForegroundColor Red
  throw 'ali-kiro: install failed'
}

function Show-Help {
  Write-Host @"
ali-kiro installer $InstallerVersion - one-command install/upgrade for AI coding assistants.

Usage:
  irm https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.ps1 | iex
  powershell -ExecutionPolicy Bypass -File install.ps1 [options] [--] [ali-kiro args...]

Options:
  -Yes, -y          assume yes (the installer is non-interactive by default)
  -DryRun, -n       print what would be done without changing anything
  -Version          print the installer version and exit
  -Help, -h         show this help
  ...               everything after -- is passed through to ali-kiro

Any other argument is passed through to ali-kiro, e.g.:
  install.ps1 --only opencode --target C:\scratch

Environment:
  ALI_KIRO_REPO    GitHub repo "owner/repo" (default: alisattorov06/ali-kiro)
  ALI_KIRO_HOME    install location         (default: ~\.ali-kiro)
"@
}

function Convert-Args {
  param([string[]]$Params)
  foreach ($a in $Params) {
    switch -Regex ($a) {
      '^--?y(es)?$'          { $script:Yes = $true }
      '^--?(n|dry[-_]?run)$' { $script:DryRun = $true }
      '^--?(h|help)$'        { $script:HelpRun = $true }
      '^--?version$'         { $script:VersionRun = $true }
      '^--$'                 { $script:AfterDoubleDash = $true }
      default                { $script:ToolArgs.Add($a) }
    }
  }
}

function Invoke-Download {
  # returns $true on success, $false on any failure
  param([string]$Url, [string]$Dest)
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-Sha256 {
  param([string]$Path)
  return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

function Get-NodeLtsVersion {
  # Resolve the current Node.js LTS version from nodejs.org metadata.
  try {
    $json = (Invoke-WebRequest -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -ErrorAction Stop).Content
    $releases = $json | ConvertFrom-Json
    foreach ($r in $releases) {
      if ($r.lts) { return $r.version.TrimStart('v') }
    }
  } catch { }
  return $NodeLtsFallback
}

function Test-NodeSufficient {
  # $true when `node` exists and its major version is >= 18.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  try {
    $ver = (& node --version 2>$null | Out-String).Trim()
    if ($ver -match '^v?([0-9]+)\.') {
      return ([int]$Matches[1] -ge 18)
    }
  } catch { }
  return $false
}

function Test-VerifyChecksum {
  # Verify a downloaded file against SHA-256SUMS when the release publishes one.
  param([string]$FilePath)
  $sumsUrl = "$ReleasesUrl/SHA-256SUMS"
  try {
    $sums = (Invoke-WebRequest -Uri $sumsUrl -UseBasicParsing -ErrorAction Stop).Content
  } catch {
    Write-Warn 'SHA-256SUMS not found for this release - skipping checksum verification.'
    return $true
  }
  $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($BinaryName) } | Select-Object -First 1
  if (-not $line) {
    Write-Warn "no checksum entry for $BinaryName - skipping verification."
    return $true
  }
  $expected = (($line -split '\s+')[0]).ToLowerInvariant()
  $actual   = Get-Sha256 -Path $FilePath
  if ($expected -ne $actual) {
    Write-Warn "checksum mismatch for $BinaryName."
    Write-Warn "  expected: $expected"
    Write-Warn "  actual:   $actual"
    return $false
  }
  Write-Log ("checksum OK ({0}...)" -f $actual.Substring(0, 16))
  return $true
}

function Install-Binary {
  # Download, verify, and stage the prebuilt binary. $true on success.
  if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir -Force | Out-Null }
  $url = "$ReleasesUrl/$BinaryName"
  $tmp = Join-Path $BinDir ".$BinaryName.tmp"
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  Write-Log "downloading $url"
  if (-not (Invoke-Download -Url $url -Dest $tmp)) {
    Write-Warn "binary download failed ($url) - the release may not be published yet; falling back to source."
    return $false
  }
  if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) {
    Write-Warn 'downloaded file was empty; falling back to source.'
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return $false
  }
  if (-not (Test-VerifyChecksum -FilePath $tmp)) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return $false
  }
  Move-Item -Force -Path $tmp -Destination (Join-Path $BinDir $BinaryName) -ErrorAction Stop

  # Assets bundle: release binaries ship without embedded assets, so fetch the
  # assets archive alongside the binary and extract it into $BinDir - assets/
  # then sits beside the exe (see src/core/assets.mjs probe (c)). At runtime
  # ALI_KIRO_ASSETS can point the binary at a different assets location.
  $assetsUrl = "$ReleasesUrl/ali-kiro-assets.tar.gz"
  $assetsTmp = Join-Path $BinDir '.ali-kiro-assets.tar.gz.tmp'
  Remove-Item $assetsTmp -Force -ErrorAction SilentlyContinue
  Write-Log "downloading $assetsUrl"
  if ((Invoke-Download -Url $assetsUrl -Dest $assetsTmp) -and (Test-Path $assetsTmp) -and ((Get-Item $assetsTmp).Length -gt 0)) {
    & tar -xf $assetsTmp -C $BinDir 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Warn 'assets bundle extraction failed - continuing with the binary only.'
    } else {
      Write-Log "assets ready at $(Join-Path $BinDir 'assets')"
    }
    Remove-Item $assetsTmp -Force -ErrorAction SilentlyContinue
  } else {
    Write-Warn "assets bundle download failed ($assetsUrl) - continuing with the binary only."
    Remove-Item $assetsTmp -Force -ErrorAction SilentlyContinue
  }
  return $true
}

function Install-Node {
  # Auto-install Node.js LTS via winget, falling back to the official .msi.
  $ver = Get-NodeLtsVersion
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Log 'installing Node.js LTS via winget (OpenJS.NodeJS.LTS)'
    & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>$null | Out-Null
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path    = "$machinePath;$userPath;$env:Path"
    if (Test-NodeSufficient) { return $true }
    Write-Warn 'winget did not put Node.js on PATH - falling back to the official .msi installer.'
  }

  $msi = Join-Path $AliKiroHome "node-v$ver-x64.msi"
  New-Item -ItemType Directory -Path $AliKiroHome -Force | Out-Null
  $url = "https://nodejs.org/dist/v$ver/node-v$ver-x64.msi"
  Write-Log "downloading $url"
  if (-not (Invoke-Download -Url $url -Dest $msi)) {
    Write-Warn "failed to download Node.js ($url). Install it manually from https://nodejs.org and re-run."
    return $false
  }
  Write-Log "installing Node.js $ver (.msi, silent)"
  $proc = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  if ($proc.ExitCode -ne 0) {
    Write-Warn "msiexec returned exit code $($proc.ExitCode). Install Node.js from https://nodejs.org and re-run."
    return $false
  }
  $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path    = "$machinePath;$userPath;$env:Path"
  return $true
}

function Ensure-Source {
  # Obtain the source checkout at $SrcDir (git clone, or tarball via tar.exe).
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    if (Test-Path (Join-Path $SrcDir '.git')) {
      Write-Log "updating existing source checkout at $SrcDir"
      Push-Location $SrcDir
      try {
        & git fetch --depth 1 origin main 2>$null | Out-Null
        & git reset --hard origin/main 2>$null | Out-Null
      } catch { }
      Pop-Location
      return $true
    }
    Write-Log "cloning $BaseUrl into $SrcDir"
    if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir -ErrorAction SilentlyContinue }
    & git clone --depth 1 "https://github.com/$Repo.git" $SrcDir 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Warn "git clone failed - falling back to the source tarball."
  }

  if (Test-Path (Join-Path $SrcDir $EntryMjs)) {
    Write-Log "using existing source at $SrcDir (install git to enable updates)"
    return $true
  }
  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Write-Fatal 'tar.exe was not found; install git or 7-Zip and re-run.'
    return $false
  }
  $tarball = Join-Path $AliKiroHome 'ali-kiro-main.tar.gz'
  New-Item -ItemType Directory -Path $AliKiroHome -Force | Out-Null
  Write-Warn 'git not found - downloading the source tarball instead'
  Remove-Item $tarball -Force -ErrorAction SilentlyContinue
  $tarUrl = "https://codeload.github.com/$Repo/tar.gz/refs/heads/main"
  if (-not (Invoke-Download -Url $tarUrl -Dest $tarball)) {
    Write-Fatal "failed to download the source tarball ($tarUrl)."
    return $false
  }
  if (Test-Path $SrcDir) { Remove-Item -Recurse -Force $SrcDir -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $SrcDir -Force | Out-Null
  & tar -xzf $tarball -C $SrcDir --strip-components=1 2>$null
  Remove-Item $tarball -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path (Join-Path $SrcDir $EntryMjs))) {
    Write-Fatal "ali-kiro.mjs not found after extracting the source - is $Repo ready?"
    return $false
  }
  return $true
}

function Start-FromSource {
  if (-not (Test-NodeSufficient)) {
    Write-Log 'Node.js >= 18 was not found - installing Node.js LTS.'
    if (-not (Install-Node)) {
      Write-Fatal 'could not install Node.js. Install it from https://nodejs.org and re-run.'
    }
  }
  if (-not (Test-NodeSufficient)) {
    Write-Fatal 'Node.js is still unavailable after the install attempt. Install it from https://nodejs.org and re-run.'
  }
  Write-Log ('using node {0}' -f ((& node --version 2>$null | Out-String).Trim()))
  if (-not (Ensure-Source)) { return }
  Write-Log 'launching ali-kiro from source'
  Push-Location $SrcDir
  $argsArr = [string[]]$script:ToolArgs.ToArray()
  & node (Join-Path $SrcDir $EntryMjs) @argsArr
  $code = $LASTEXITCODE
  Pop-Location
  exit $code
}

function Show-Plan {
  # Dry-run report: prints what would happen without changing anything.
  Write-Host ''
  Write-Host "ali-kiro installer $InstallerVersion - dry run (nothing will be changed)"
  Write-Host ''
  Write-Host "  Home directory : $AliKiroHome"
  Write-Host '  Platform       : windows-x64'
  if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host ('  Node.js        : {0}' -f ((& node --version 2>$null | Out-String).Trim()))
  } else {
    Write-Host '  Node.js        : not found (would auto-install Node.js LTS)'
  }
  Write-Host '  Downloader     : Invoke-WebRequest (TLS 1.2+)'
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host '  Git            : yes'
  } else {
    Write-Host '  Git            : no (would use the source tarball)'
  }
  Write-Host ''
  Write-Host '  Planned steps:'
  Write-Host '    1. Download the prebuilt binary from:'
  Write-Host "         $ReleasesUrl/$BinaryName"
  Write-Host "       into $BinDir (verified against SHA-256SUMS when present)."
  Write-Host "       Then download and extract ali-kiro-assets.tar.gz into $(Join-Path $BinDir 'assets') beside the exe."
  Write-Host ("    2. Launch ali-kiro with arguments: {0}" -f ($script:ToolArgs -join ' '))
  Write-Host "       (if the binary is unavailable or fails, fall back to 'node $EntryMjs' from $SrcDir)"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '       (Node.js is missing - the installer would install Node.js LTS first)'
  }
  Write-Host ''
  Write-Host '  Nothing was installed or modified.'
}

function Invoke-Main {
  param([string[]]$Remaining)
  Convert-Args -Params $Remaining
  if ($script:HelpRun)    { Show-Help; return }
  if ($script:VersionRun) { Write-Host "ali-kiro installer $InstallerVersion"; return }

  Write-Log "ali-kiro installer $InstallerVersion for windows-x64"
  if ($script:Yes) { Write-Log '--yes set: proceeding automatically' }

  if ($script:DryRun) { Show-Plan; return }

  if (Install-Binary) {
    $exe = Join-Path $BinDir $BinaryName
    Write-Log "prebuilt binary ready at $exe"
    Write-Log 'launching ali-kiro...'
    $argsArr = [string[]]$script:ToolArgs.ToArray()
    try {
      & $exe @argsArr
      exit $LASTEXITCODE
    } catch {
      Write-Warn "failed to execute the prebuilt binary ($exe): $($_.Exception.Message) - falling back to source."
    }
  }

  Start-FromSource
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
Invoke-Main -Remaining $RemainingArgs