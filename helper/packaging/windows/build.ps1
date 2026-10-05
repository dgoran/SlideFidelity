<#
Builds the Windows installer for SlideFidelity Helper (per-machine, x64, WiX v5).

  packaging\windows\build.ps1         release MSI: signed when Azure Artifact Signing is configured
  packaging\windows\build.ps1 -Dev    local test MSI: accepts the dev add-in origin, never signed

Needs: Rust (MSVC), WiX v5 (`dotnet tool install --global wix --version 5.0.2`) and its Util
extension (`wix extension add -g WixToolset.Util.wixext/5.0.2`).

Signing (Azure Artifact Signing through signtool): set SLIDEFIDELITY_SIGN_DLIB to the path of
Azure.CodeSigning.Dlib.dll and SLIDEFIDELITY_SIGN_METADATA to its metadata.json (endpoint, account,
certificate profile). signtool comes from the Windows SDK; set SIGNTOOL if it is not on PATH.
Without both variables the MSI is built unsigned with a warning (local testing only).

The signing identity needs the "Artifact Signing Certificate Profile Signer" role on the signing account
(Owner alone is refused with 403). Sign in first with `az login`; the dlib uses that session.
#>
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$version = (Select-String -Path Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$out = 'target\package\windows'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out | Out-Null

$cargo = @('build', '--release', '--locked')
if ($Dev) { $cargo += @('--features', 'dev-origin') }
& cargo @cargo
if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
$exe = Join-Path $out 'slidefidelity-helper.exe'
Copy-Item 'target\release\slidefidelity-helper.exe' $exe

$dlib = $env:SLIDEFIDELITY_SIGN_DLIB
$metadata = $env:SLIDEFIDELITY_SIGN_METADATA
$sign = (-not $Dev) -and $dlib -and $metadata
$signtool = if ($env:SIGNTOOL) { $env:SIGNTOOL } else { 'signtool.exe' }
function Sign-File([string]$path) {
    & $signtool sign /v /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $dlib /dmdf $metadata $path
    if ($LASTEXITCODE -ne 0) { throw "signing $path failed ($LASTEXITCODE)" }
}
if ($sign) {
    Sign-File $exe
} elseif (-not $Dev) {
    Write-Warning 'SLIDEFIDELITY_SIGN_DLIB / SLIDEFIDELITY_SIGN_METADATA not set; building an unsigned MSI (local testing only)'
}

$suffix = if ($Dev) { '-dev' } else { '' }
$msi = Join-Path $out "SlideFidelityHelper-$version$suffix.msi"
& wix build -arch x64 -ext WixToolset.Util.wixext -d "Version=$version" -d "HelperExe=$exe" `
    -o $msi 'packaging\windows\helper.wxs'
if ($LASTEXITCODE -ne 0) { throw "wix build failed ($LASTEXITCODE)" }
if ($sign) {
    Sign-File $msi
    & $signtool verify /pa /v $msi
    if ($LASTEXITCODE -ne 0) { throw "signature verification failed ($LASTEXITCODE)" }
}

(Get-FileHash $msi -Algorithm SHA256).Hash
"built $msi"
