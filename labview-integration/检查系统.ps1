$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -Raw -LiteralPath (Join-Path $here 'config.json') | ConvertFrom-Json
$ok = $true

function Show-Check($name, $pass, $detail) {
  if ($pass) { Write-Host "[PASS] $name - $detail" -ForegroundColor Green }
  else { Write-Host "[FAIL] $name - $detail" -ForegroundColor Red; $script:ok = $false }
}

$node = Get-Command $config.nodeExecutable -ErrorAction SilentlyContinue
Show-Check 'Node.js' ($null -ne $node) $(if ($node) { (& $node.Source --version) } else { 'not found' })
Show-Check 'System root' (Test-Path -LiteralPath $config.systemRoot) $config.systemRoot
Show-Check 'Backend entry' (Test-Path -LiteralPath (Join-Path $config.systemRoot 'backend/server.js')) 'backend/server.js'
Show-Check 'Frontend entry' (Test-Path -LiteralPath (Join-Path $config.systemRoot 'docs/prototype-holo-core.html')) 'docs/prototype-holo-core.html'

try {
  $health = Invoke-RestMethod -Uri $config.healthUrl -TimeoutSec 2
  Show-Check 'Backend API' ([bool]$health.ok) $config.healthUrl
} catch {
  Show-Check 'Backend API' $false 'not running; run the start script first'
}

if (-not $ok) { exit 1 }

