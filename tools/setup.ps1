# Prepara los binarios que no están en el repositorio:
#  - vendor/ffmpeg/ffmpeg.exe: FFmpeg 8.1 (BtbN win64-gpl), con la suma SHA-256 verificada.
#    Hace falta FFmpeg 8 o superior por el filtro gfxcapture.
#  - vendor/procwatch/procwatch.exe: compilado de native/procwatch.cs con el csc de .NET Framework
#    que trae Windows.
# Uso: npm run setup   (o: powershell -ExecutionPolicy Bypass -File tools/setup.ps1)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path $PSScriptRoot -Parent

# ---- FFmpeg ----
$ffDir = Join-Path $root 'vendor\ffmpeg'
if (Test-Path (Join-Path $ffDir 'ffmpeg.exe')) {
  Write-Host 'FFmpeg ya está en vendor/ffmpeg'
} else {
  $asset = 'ffmpeg-n8.1-latest-win64-gpl-8.1.zip'
  $base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) "muninn-ffmpeg-$([guid]::NewGuid())"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    Write-Host "Descargando $asset..."
    Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset)
    Invoke-WebRequest "$base/checksums.sha256" -OutFile (Join-Path $tmp 'checksums.sha256')
    $expected = ((Select-String -Path (Join-Path $tmp 'checksums.sha256') -Pattern ([regex]::Escape($asset))).Line -split '\s+')[0]
    $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { throw "La suma SHA-256 de FFmpeg no coincide (esperada $expected, obtenida $actual)" }
    Write-Host 'Suma SHA-256 verificada'
    Expand-Archive (Join-Path $tmp $asset) -DestinationPath $tmp
    $bin = Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    New-Item -ItemType Directory -Force $ffDir | Out-Null
    Copy-Item $bin.FullName $ffDir
    Copy-Item (Join-Path $bin.Directory.Parent.FullName 'LICENSE.txt') $ffDir
    Write-Host 'FFmpeg listo en vendor/ffmpeg'
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

# ---- procwatch ----
$pwDir = Join-Path $root 'vendor\procwatch'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
New-Item -ItemType Directory -Force $pwDir | Out-Null
& $csc /nologo /optimize /target:exe "/out:$(Join-Path $pwDir 'procwatch.exe')" (Join-Path $root 'native\procwatch.cs')
if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar procwatch' }
Write-Host 'procwatch listo en vendor/procwatch'
