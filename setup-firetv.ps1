param(
  [string]$Manifest = "$PSScriptRoot\firetv-apps.json",
  [string]$ApkDir = "",
  [string]$Device = "",
  [string]$FireTvIp = "",
  [ValidateSet("unattended", "guarded", "install-only")]
  [string]$Mode = "unattended",
  [switch]$SkipInstall,
  [switch]$SkipInitialize,
  [switch]$SkipArrange,
  [switch]$AllowMissing
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 18+ is required. Install Node and rerun this script."
}

$argsList = @("$PSScriptRoot\src\setup-firetv.js", "--manifest", $Manifest, "--mode", $Mode)
if ($ApkDir) { $argsList += @("--apk-dir", $ApkDir) }
if ($Device) { $argsList += @("--device", $Device) }
if ($FireTvIp) { $argsList += @("--firetv-ip", $FireTvIp) }
if ($SkipInstall) { $argsList += "--skip-install" }
if ($SkipInitialize) { $argsList += "--skip-initialize" }
if ($SkipArrange) { $argsList += "--skip-arrange" }
if ($AllowMissing) { $argsList += "--allow-missing" }

& $node.Source @argsList
exit $LASTEXITCODE
