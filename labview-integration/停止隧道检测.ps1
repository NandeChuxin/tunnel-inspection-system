$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stateDir = Join-Path $here '.runtime'
foreach ($name in @('backend.pid', 'web.pid')) {
  $pidFile = Join-Path $stateDir $name
  if (-not (Test-Path -LiteralPath $pidFile)) { continue }
  $processId = [int](Get-Content -Raw -LiteralPath $pidFile)
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') {
    Stop-Process -Id $processId
    Write-Host "Stopped process $processId"
  }
  Remove-Item -LiteralPath $pidFile -Force
}

