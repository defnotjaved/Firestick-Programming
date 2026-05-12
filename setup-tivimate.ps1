param(
  [string]$Ips = "",
  [string]$Bouquet = "Trini Classic1",
  [string]$AccountPrefix = "gadgetbaytt",
  [int]$AccountStartIndex = 1,
  [int]$Sub = 12,
  [string]$Country = "ALL",
  [string]$OutputDir = "C:\apkapps",
  [string]$DownloaderCode = "272483",
  [string]$ServerUrl = "",
  [string]$PortalMap = "",
  [string]$AccountsFile = "",
  [int]$WaitForAuthMinutes = 0,
  [switch]$Parallel,
  [switch]$Fresh,
  [switch]$SkipCreateAccounts,
  [switch]$SkipInstall,
  [switch]$SkipLogin
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 18+ is required. Install Node and rerun this script."
}

$ipList = @($Ips -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($Parallel -and $ipList.Count -gt 1) {
  if (-not $AccountsFile -and -not $SkipCreateAccounts) {
    throw "-Parallel account creation is intentionally blocked. Create accounts first or pass -AccountsFile so each device gets the intended saved account."
  }
  $jobs = @()
  foreach ($ip in $ipList) {
    $childArgs = @(
      "-ExecutionPolicy", "Bypass",
      "-File", $PSCommandPath,
      "-Ips", $ip,
      "-Bouquet", $Bouquet,
      "-AccountPrefix", $AccountPrefix,
      "-AccountStartIndex", "$AccountStartIndex",
      "-Sub", "$Sub",
      "-Country", $Country,
      "-OutputDir", $OutputDir,
      "-DownloaderCode", $DownloaderCode,
      "-WaitForAuthMinutes", "$WaitForAuthMinutes"
    )
    if ($ServerUrl) { $childArgs += @("-ServerUrl", $ServerUrl) }
    if ($PortalMap) { $childArgs += @("-PortalMap", $PortalMap) }
    if ($AccountsFile) { $childArgs += @("-AccountsFile", $AccountsFile) }
    if ($Fresh) { $childArgs += "-Fresh" }
    if ($SkipCreateAccounts) { $childArgs += "-SkipCreateAccounts" }
    if ($SkipInstall) { $childArgs += "-SkipInstall" }
    if ($SkipLogin) { $childArgs += "-SkipLogin" }

    $jobs += Start-Job -Name "tivimate-$ip" -ScriptBlock {
      param($argsForPowerShell)
      & powershell @argsForPowerShell
      exit $LASTEXITCODE
    } -ArgumentList (, $childArgs)
  }

  $failed = $false
  while (($jobs | Where-Object State -eq "Running").Count -gt 0) {
    foreach ($job in $jobs) {
      Receive-Job -Job $job
    }
    Start-Sleep -Seconds 2
  }
  foreach ($job in $jobs) {
    Receive-Job -Job $job
    if ($job.State -ne "Completed") { $failed = $true }
  }
  Remove-Job -Job $jobs -Force
  if ($failed) { exit 1 }
  exit 0
}

$argsList = @(
  "$PSScriptRoot\src\setup-tivimate.js",
  "--ips", $Ips,
  "--bouquet", $Bouquet,
  "--account-prefix", $AccountPrefix,
  "--account-start-index", "$AccountStartIndex",
  "--sub", "$Sub",
  "--country", $Country,
  "--output-dir", $OutputDir,
  "--downloader-code", $DownloaderCode,
  "--wait-for-auth-minutes", "$WaitForAuthMinutes"
)
if ($ServerUrl) { $argsList += @("--server-url", $ServerUrl) }
if ($PortalMap) { $argsList += @("--portal-map", $PortalMap) }
if ($AccountsFile) { $argsList += @("--accounts-file", $AccountsFile) }
if ($Fresh) { $argsList += "--fresh" }
if ($SkipCreateAccounts) { $argsList += "--skip-create-accounts" }
if ($SkipInstall) { $argsList += "--skip-install" }
if ($SkipLogin) { $argsList += "--skip-login" }

& $node.Source @argsList
exit $LASTEXITCODE
