param([Parameter(Mandatory=$true)][long]$WindowHandle,[Parameter(Mandatory=$true)][string]$OutputPath,[int]$Width=0,[int]$Height=0)
$ErrorActionPreference='Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class PW {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint);
}
"@
Add-Type -AssemblyName System.Drawing
$h=[IntPtr]$WindowHandle;[PW]::ShowWindow($h,9)|Out-Null;if($Width -gt 0 -and $Height -gt 0){[PW]::MoveWindow($h,80,80,$Width,$Height,$true)|Out-Null};Start-Sleep -Milliseconds 500;$r=New-Object PW+RECT;[PW]::GetWindowRect($h,[ref]$r)|Out-Null
$w=$r.R-$r.L;$hh=$r.B-$r.T;if($w -le 0 -or $hh -le 0){throw 'Invalid rectangle'}
$bmp=New-Object Drawing.Bitmap $w,$hh;$g=[Drawing.Graphics]::FromImage($bmp);$dc=$g.GetHdc()
try{[PW]::PrintWindow($h,$dc,2)|Out-Null}finally{$g.ReleaseHdc($dc)}
$bmp.Save($OutputPath,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose();Write-Output $OutputPath
