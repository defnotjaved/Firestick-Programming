param(
  [string]$Manifest = "$PSScriptRoot\firetv-apps.json",
  [string]$OutputDir = "",
  [switch]$DryRun,
  [switch]$IncludeOptional,
  [switch]$AllowAlternateSearch,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 18+ is required. Install Node and rerun this script."
}

$argsList = @("$PSScriptRoot\src\download-apks.js", "--manifest", $Manifest)
if ($OutputDir) { $argsList += @("--output", $OutputDir) }
if ($DryRun) { $argsList += "--dry-run" }
if ($IncludeOptional) { $argsList += "--include-optional" }
if ($AllowAlternateSearch) { $argsList += "--allow-alternate-search" }
if ($Force) { $argsList += "--force" }

& $node.Source @argsList
exit $LASTEXITCODE
