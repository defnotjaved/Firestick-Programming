param(
  [string]$Ips = "",
  [string]$Bouquet = "Trini Classic1",
  [string]$AccountPrefix = "gadgetbaytt",
  [int]$Sub = 12,
  [string]$Country = "ALL",
  [string]$OutputDir = "C:\apkapps",
  [switch]$SkipCreateAccounts,
  [switch]$SkipAppStore,
  [switch]$SkipLogin
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 18+ is required. Install Node and rerun this script."
}

$argsList = @(
  "$PSScriptRoot\src\setup-iptv-smarters.js",
  "--ips", $Ips,
  "--bouquet", $Bouquet,
  "--account-prefix", $AccountPrefix,
  "--sub", "$Sub",
  "--country", $Country,
  "--output-dir", $OutputDir
)
if ($SkipCreateAccounts) { $argsList += "--skip-create-accounts" }
if ($SkipAppStore) { $argsList += "--skip-appstore" }
if ($SkipLogin) { $argsList += "--skip-login" }

& $node.Source @argsList
exit $LASTEXITCODE
