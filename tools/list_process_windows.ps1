param([Parameter(Mandatory=$true)][int]$ProcessId)
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class WinEnum {
 public delegate bool CB(IntPtr h, IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
}
"@
$script:items=@()
$cb=[WinEnum+CB]{param($h,$x);$proc=0;[WinEnum]::GetWindowThreadProcessId($h,[ref]$proc)|Out-Null;if($proc -eq $ProcessId){$s=New-Object Text.StringBuilder 512;[WinEnum]::GetWindowText($h,$s,512)|Out-Null;$r=New-Object WinEnum+RECT;[WinEnum]::GetWindowRect($h,[ref]$r)|Out-Null;$script:items += [PSCustomObject]@{Handle=$h.ToInt64();Visible=[WinEnum]::IsWindowVisible($h);Title=$s.ToString();Left=$r.L;Top=$r.T;Right=$r.R;Bottom=$r.B}};return $true}
[WinEnum]::EnumWindows($cb,[IntPtr]::Zero)|Out-Null
$script:items
