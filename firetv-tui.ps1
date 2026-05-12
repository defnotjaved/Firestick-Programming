param(
  [string]$Manifest = "$PSScriptRoot\firetv-apps.json"
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js 18+ is required. Install Node and rerun this script."
}

& $node.Source "$PSScriptRoot\src\tui.js" --manifest $Manifest
exit $LASTEXITCODE
