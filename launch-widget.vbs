Dim fso, shell, dir, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = dir & "\widget.ps1"
Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
shell.Run cmd, 0, False
