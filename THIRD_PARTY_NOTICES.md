# Componentes de terceros

El instalador de Muninn incluye estos componentes de terceros, cada uno bajo su propia licencia.

## FFmpeg

- **Uso:** captura, codificación y edición de vídeo. Muninn lo ejecuta como un programa aparte (`resources/ffmpeg/ffmpeg.exe`), sin enlazarlo.
- **Versión:** `n8.1.3-32-g760d10603e-20261102`, compilación estática `win64-gpl` de [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- **Licencia:** GNU General Public License v3 (compilación con `--enable-gpl --enable-version3`). El texto completo se instala junto al ejecutable, en `resources/ffmpeg/LICENSE.txt`.
- **Código fuente:**
  - FFmpeg: https://github.com/FFmpeg/FFmpeg (commit `760d10603e`, rama de la versión 8.1).
  - Scripts con los que se compiló y bibliotecas incluidas: https://github.com/BtbN/FFmpeg-Builds.
- FFmpeg es una marca de Fabrice Bellard, creador del proyecto FFmpeg.

## Electron

- **Uso:** interfaz y aplicación de escritorio. Versión 45.1.0.
- **Licencia:** MIT. Incluye Chromium y Node.js, cada uno con sus licencias, que se instalan en `LICENSES.chromium.html` y `LICENSE.electron.txt`.
- **Código fuente:** https://github.com/electron/electron

## Iconos

Los iconos de la interfaz están dibujados siguiendo el estilo de [Lucide](https://lucide.dev) (licencia ISC).

## Riot Games

Muninn no está respaldado ni patrocinado por Riot Games. League of Legends y VALORANT son marcas de Riot Games, Inc. Para detectar las partidas, la app usa las interfaces locales que ofrecen sus clientes.
