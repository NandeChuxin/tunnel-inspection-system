param([Parameter(Mandatory=$true)][int]$ProcessId,[Parameter(Mandatory=$true)][string]$OutputPath,[long]$WindowHandle=0)
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Capture {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
Add-Type -AssemblyName System.Drawing
$p=Get-Process -Id $ProcessId
$h=if($WindowHandle -ne 0){[IntPtr]$WindowHandle}else{$p.MainWindowHandle}
$best=[IntPtr]::Zero; $bestArea=0
$cb=[Win32Capture+EnumWindowsProc]{ param($wh,$lp)
  $procId=0; [Win32Capture]::GetWindowThreadProcessId($wh,[ref]$procId)|Out-Null
  if($procId -eq $ProcessId -and [Win32Capture]::IsWindowVisible($wh)){
    $rr=New-Object Win32Capture+RECT
    if([Win32Capture]::GetWindowRect($wh,[ref]$rr)){
      $area=($rr.Right-$rr.Left)*($rr.Bottom-$rr.Top)
      if($area -gt $script:bestArea){$script:bestArea=$area;$script:best=$wh}
    }
  }
  return $true
}
if($WindowHandle -eq 0){
  [Win32Capture]::EnumWindows($cb,[IntPtr]::Zero)|Out-Null
  if($best -ne [IntPtr]::Zero){$h=$best}
}
if($h -eq 0){throw 'Process has no main window'}
[Win32Capture]::ShowWindow($h,3)|Out-Null
[Win32Capture]::SetForegroundWindow($h)|Out-Null
Start-Sleep -Milliseconds 800
$r=New-Object Win32Capture+RECT
if(-not [Win32Capture]::GetWindowRect($h,[ref]$r)){throw 'GetWindowRect failed'}
$w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
Write-Output "RECT=$($r.Left),$($r.Top),$($r.Right),$($r.Bottom) SIZE=$w x $hh"
if($w -le 0 -or $hh -le 0){throw 'Invalid window rectangle'}
$bmp=New-Object Drawing.Bitmap $w,$hh
$g=[Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left,$r.Top,0,0,$bmp.Size)
$bmp.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $OutputPath
