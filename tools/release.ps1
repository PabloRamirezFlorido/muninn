# Publica la versión actual (package.json) como Release de GitHub con el instalador adjunto.
#  1. Exige que no haya cambios sin commit y sube los commits pendientes.
#  2. Compila el instalador (npm run dist), salvo -SkipBuild.
#  3. Crea la release vX.Y.Z con las notas del último commit y adjunta Muninn-Setup-X.Y.Z.exe.
# Uso: npm run release   (o: powershell -ExecutionPolicy Bypass -File tools/release.ps1 [-SkipBuild] [-Installer ruta.exe])
param([switch]$SkipBuild, [string]$Installer)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
# git y gh pueden no estar aún en el PATH de una consola abierta antes de instalarlos.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$tag = "v$version"

if (git status --porcelain) { throw 'Hay cambios sin commit: haz commit antes de publicar.' }
gh release view $tag 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { throw "La release $tag ya existe: sube la versión en package.json antes de publicar." }

Write-Host "Subiendo commits..."
git push --quiet 2>&1 | Out-Null

if (-not $SkipBuild) {
  Write-Host "Compilando el instalador $version..."
  npm run dist | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Falló npm run dist' }
}
if (-not $Installer) { $Installer = Join-Path $root "dist\Muninn-Setup-$version.exe" }
if (-not (Test-Path $Installer)) { throw "No se encuentra el instalador: $Installer" }

# Las notas son el mensaje del último commit (título + lista de cambios).
$notes = Join-Path ([IO.Path]::GetTempPath()) "muninn-notes-$version.md"
$msg = git log -1 --format=%B
[IO.File]::WriteAllText($notes, (($msg | Select-Object -Skip 1) -join "`n").Trim() + "`n`nDescarga **Muninn-Setup-$version.exe**, ejecútalo y listo. Si ya tenías Muninn, se actualiza conservando tu configuración y tus vídeos.`n", (New-Object Text.UTF8Encoding $false))

Write-Host "Publicando $tag..."
gh release create $tag "$Installer#Muninn-Setup-$version.exe" --title "Muninn $version" --notes-file $notes --target main
if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear la release' }
Remove-Item $notes -ErrorAction SilentlyContinue
Write-Host "Publicada: $(gh release view $tag --json url --jq .url)"
