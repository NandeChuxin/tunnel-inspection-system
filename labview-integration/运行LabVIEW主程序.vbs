Option Explicit
Dim fso, here, viPath, app, vi
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
viPath = fso.BuildPath(here, "Main.vi")

Set app = CreateObject("LabVIEW.Application")
Set vi = app.GetVIReference(viPath)
vi.SetControlValue "URL", "http://127.0.0.1:8899/prototype-holo-core.html"
vi.OpenFrontPanel
vi.Run True

