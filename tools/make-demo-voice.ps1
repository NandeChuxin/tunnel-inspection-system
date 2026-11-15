param(
  [Parameter(Mandatory=$true)][string]$JsonPath,
  [Parameter(Mandatory=$true)][string]$OutputDir
)

Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw -Encoding UTF8 -LiteralPath $JsonPath | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

foreach ($item in $items) {
  $out = Join-Path $OutputDir ($item.id + '.wav')
  $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $speaker.SelectVoice('Microsoft Huihui Desktop')
  $speaker.Rate = -1
  $speaker.Volume = 100
  $speaker.SetOutputToWaveFile($out)
  $speaker.Speak([string]$item.text)
  $speaker.Dispose()
  Write-Output $out
}
