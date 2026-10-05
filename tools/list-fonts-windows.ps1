<#
List every font family PowerPoint for Windows can use on this computer, one per line.

Covers fonts installed for all users and for the current user, plus the fonts Microsoft 365
ships privately and its downloaded cloud fonts. Import the output into SlideFidelity:
Settings > Show-machine fonts > Import.

Usage: powershell -ExecutionPolicy Bypass -File tools\list-fonts-windows.ps1 > show-machine-fonts.txt
Not yet verified on a Windows machine.
#>
Add-Type -AssemblyName System.Drawing

$names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)

# Fonts installed for all users and the current user.
(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { [void]$names.Add($_.Name) }

# Office private fonts and cloud fonts (not registered with Windows).
$officeDirs = @(
  "$env:ProgramFiles\Microsoft Office\root\vfs\Fonts\private",
  "${env:ProgramFiles(x86)}\Microsoft Office\root\vfs\Fonts\private",
  "$env:LOCALAPPDATA\Microsoft\FontCache\4\CloudFonts"
)
foreach ($dir in $officeDirs) {
  if (-not (Test-Path $dir)) { continue }
  Get-ChildItem -Path $dir -Recurse -File -Include *.ttf, *.otf, *.ttc | ForEach-Object {
    try {
      $collection = New-Object System.Drawing.Text.PrivateFontCollection
      $collection.AddFontFile($_.FullName)
      $collection.Families | ForEach-Object { [void]$names.Add($_.Name) }
    } catch { }
  }
}

$names | Sort-Object
