$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content -Raw -LiteralPath (Join-Path $here 'config.json') | ConvertFrom-Json
$stateDir = Join-Path $here '.runtime'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $config.systemRoot)) {
  throw "System root not found: $($config.systemRoot)"
}

$health = $null
try { $health = Invoke-RestMethod -Uri $config.healthUrl -TimeoutSec 2 } catch {}
if (-not $health.ok) {
  $logOut = Join-Path $stateDir 'backend.out.log'
  $logErr = Join-Path $stateDir 'backend.err.log'
  $backend = Start-Process -FilePath $config.nodeExecutable -ArgumentList 'backend/server.js' -WorkingDirectory $config.systemRoot -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru
  Set-Content -LiteralPath (Join-Path $stateDir 'backend.pid') -Value $backend.Id
}

$webUrl = "http://127.0.0.1:$($config.webPort)/prototype-holo-core.html"
$webReady = $false
try { $response = Invoke-WebRequest -UseBasicParsing -Uri $webUrl -TimeoutSec 2; $webReady = $response.StatusCode -eq 200 } catch {}
if (-not $webReady) {
  $logOut = Join-Path $stateDir 'web.out.log'
  $logErr = Join-Path $stateDir 'web.err.log'
  $web = Start-Process -FilePath $config.nodeExecutable -ArgumentList 'tools/serve-docs.js' -WorkingDirectory $config.systemRoot -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr -PassThru
  Set-Content -LiteralPath (Join-Path $stateDir 'web.pid') -Value $web.Id
}

$deadline = (Get-Date).AddSeconds(20)
do {
  try { $health = Invoke-RestMethod -Uri $config.healthUrl -TimeoutSec 2 } catch { $health = $null }
  if ($health.ok) { break }
  Start-Sleep -Milliseconds 400
} while ((Get-Date) -lt $deadline)

if (-not $health.ok) {
  throw "Backend startup timed out. Check logs under $stateDir."
}

Start-Process $config.workbenchUrl
Write-Host 'Tunnel inspection system started.' -ForegroundColor Green
Write-Host "API: $($config.healthUrl)"
Write-Host "Workbench: $($config.workbenchUrl)"

