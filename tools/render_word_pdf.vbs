Option Explicit

Dim args, inputPath, outputPath, word, doc
Set args = WScript.Arguments
If args.Count < 2 Then
  WScript.Echo "Usage: cscript render_word_pdf.vbs input.docx output.pdf"
  WScript.Quit 2
End If

inputPath = args(0)
outputPath = args(1)
Set word = CreateObject("Word.Application")
word.Visible = False
word.DisplayAlerts = 0
word.AutomationSecurity = 3
On Error Resume Next
Set doc = word.Documents.Open(inputPath, False, True, False, "", "", True, "", "", 0, 0, False, False, False, True, False)
If Err.Number <> 0 Then
  WScript.Echo "OPEN_ERROR " & Err.Number & " " & Err.Description
  word.Quit
  WScript.Quit 3
End If
Err.Clear
doc.ExportAsFixedFormat outputPath, 17, False, 0, 0, 1, 9999, 0, True, True, 0, True, True, False
If Err.Number <> 0 Then
  WScript.Echo "EXPORT_ERROR " & Err.Number & " " & Err.Description
  doc.Close False
  word.Quit
  WScript.Quit 4
End If
WScript.Echo "PAGES " & doc.ComputeStatistics(2)
doc.Close False
word.Quit
Set doc = Nothing
Set word = Nothing
