# Muninn

Grabación en segundo plano para juegos al estilo Medal: buffer circular, clips automáticos de los mejores momentos, partidas completas y un límite de espacio. Se llama así por Muninn, el cuervo "memoria" de Odín, que sobrevolaba el mundo y volvía contando lo que había visto.

## Descargar

**[Descargar la última versión](../../releases/latest)**

En esa página, descarga `Muninn-Setup-x.y.z.exe` y ejecútalo. Si ya tenías Muninn instalado, se actualiza conservando tu configuración y tus vídeos.

Requisitos: Windows 10 u 11. Recomendable una GPU NVIDIA, AMD o Intel con codificador por hardware.

> El instalador no está firmado digitalmente, así que la primera vez Windows puede mostrar "Windows protegió su PC". Pulsa **Más información → Ejecutar de todas formas**.

Muninn incluye FFmpeg (licencia GPL v3) y Electron. Sus licencias y dónde encontrar su código fuente están en [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Muninn no está respaldado por Riot Games.

Hasta la versión 1.2 se llamaba **Jugadas**:
- El `appId` (`com.pablo.jugadas`) se mantiene a propósito, para que el instalador de Muninn actualice la instalación anterior en vez de crear otra aparte.
- La primera vez que arranca, Muninn copia `settings.json` y `encoders.json` de `%APPDATA%\Jugadas` a `%APPDATA%\Muninn`.

**Icono:** los originales son `assets/icon.svg` y `assets/tray.svg` (versión simplificada para la bandeja). Los PNG se generan con `npx electron tools/render-icons.js`.

## Puesta en marcha

Requisitos: Windows 10/11 y Node.js 20 o superior.

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Descarga FFmpeg y compila `procwatch` (no están en el repositorio):
   ```bash
   npm run setup
   ```

## Uso

- `npm start`: abre la app en modo desarrollo.
- `npm start -- --demo`: simula una partida de LoL (kills, doble kill, robo de Barón y victoria) para probar todo el flujo sin abrir el juego.
- `npm run dist`: genera el instalador en `dist/Muninn-Setup-x.y.z.exe`.
- `npm run release`: publica la versión de `package.json` como Release de GitHub con el instalador adjunto ([tools/release.ps1](tools/release.ps1)).
  - Exige que no haya cambios sin commit, sube los commits, compila y usa como notas el mensaje del último commit.
  - Si la versión ya está publicada, no hace nada: sube antes el número de versión.

Al instalar, si `npm install` bloquea los scripts de instalación, ejecuta `node node_modules/electron/install.js`.

**FFmpeg:** la app usa FFmpeg 8 o superior desde `vendor/ffmpeg/ffmpeg.exe`; hace falta por el filtro `gfxcapture`. Es la compilación `win64-gpl` estática de [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases), versión n8.1, con su `LICENSE.txt` al lado. `npm run setup` la descarga y verifica su suma SHA-256. No está en el repositorio porque pesa ~160 MB, más que el límite de GitHub. Al empaquetar se copia a `resources/ffmpeg`.

**procwatch:** el detector de juegos usa `vendor/procwatch/procwatch.exe` (código en [native/procwatch.cs](native/procwatch.cs)). `npm run setup` lo compila con el `csc` de .NET Framework que trae Windows. Gasta unos 2 ms de CPU por comprobación, frente a los ~270 ms de `tasklist`, que queda como respaldo.

**Inicio con Windows:** el acceso se registra con `--hidden`. En ese modo solo se crean la bandeja y la tecla rápida, con prioridad baja. La detección de encoders (en caché en `encoders.json`), el vigilante de juegos y la grabación esperan 30 s, salvo que abras la app o pulses la tecla. La ventana principal y la de notificaciones se crean al usarse y se destruyen al cerrarse. La captura de audio solo existe mientras se graba.

Variables de depuración:
- `MUNINN_DATA=<carpeta>`: usa una configuración aislada. Con `MUNINN_OLD_DATA=<carpeta>` se prueba además la migración desde Jugadas.
- `MUNINN_FFDEBUG=1`: guarda la salida completa de FFmpeg en `_buffer/<sesión>.ffmpeg.log`.

Los nombres antiguos `JUGADAS_*` siguen funcionando.

## Cómo funciona

- **Captura** ([src/recorder.js](src/recorder.js)): con un juego abierto se graba solo su ventana, con `gfxcapture` (Windows Graphics Capture), aunque haya otras ventanas encima. Sin juego, o si su ventana aún no existe, se graba el monitor con `ddagrab`. El vídeo se codifica con NVENC, AMF o QSV, o con x264 si no hay GPU compatible, y se graba en segmentos `.ts` de 2 s dentro de `<biblioteca>/_buffer`. Fuera de partida solo se conservan los últimos N segundos; durante una partida se conservan todos, para poder guardarla entera.
- **Sincronía** ([src/recorder.js](src/recorder.js)): audio y vídeo usan la hora del sistema en segundos desde que arranca FFmpeg (t0). El vídeo la recibe con `setpts=RTCTIME`. El audio la recibe en `writeAudio`, que lo coloca según su hora de captura y corrige la deriva del reloj de la tarjeta de sonido. Con FFmpeg 7 o superior no se usan `-copyts`/`-itsoffset`: con marcas de tiempo en hora epoch, el planificador detiene el vídeo.
- **Barra de momentos** ([src/renderer/app.js](src/renderer/app.js)): cada momento guarda su hora real (`at`) y el reproductor lo marca en la barra.
  - Momentos que se marcan: kill, muerte, asistencia, objetivo, ronda, clip manual o nota propia.
  - Los juegos emiten un `event` por cada momento tuyo; solo los activados en Ajustes generan clip (`clip: true`), el resto se marca en la barra de la partida completa ([src/director.js](src/director.js) `mark`).
  - Al pulsar un marcador se selecciona el tramo de 10 s antes a 4 s después; se ajusta arrastrando sus extremos o con las teclas I/O.
  - La tecla N añade una nota en el instante actual, guardada como evento `note`.
- **Estadísticas** ([src/games.js](src/games.js)): durante la partida de LoL se guarda cada 5 s una instantánea de `allgamedata`: KDA, CS, visión, nivel y duración. En Valorant, el marcador.
- **Partida ↔ clips:** se relacionan por tiempo (clip del mismo juego dentro de la duración de la partida), así que funciona también con vídeos antiguos.
- **Discord** ([src/library.js](src/library.js) `exportForDiscord`): recodifica a un bitrate calculado para el límite configurado (10 MB por defecto) y repite si se pasa. Lo deja en `<biblioteca>/discord` y en el portapapeles (`Set-Clipboard -LiteralPath`).
- **Editor** ([src/library.js](src/library.js)):
  - `montage`: une vídeos con `concat`, o con `xfade` + `acrossfade` si hay fundido. Escala y rellena a 16:9 a la mayor altura (máx. 1440p) y a 60 fps, y usa `anullsrc` para los clips sin audio. Los momentos de cada clip se trasladan a la línea de tiempo del montaje, y el montaje lleva `montage: true` para no enlazarse con ninguna partida.
  - `slowMotion`: divide el vídeo en hasta tres tramos con `trim`, ralentiza el central con `setpts` y `atempo` y los vuelve a unir.
  - `exportGif`: genera un GIF con `palettegen`/`paletteuse` a 15 fps y 480 px de ancho, de 15 s como mucho, en `<biblioteca>/gifs`.
- **Audio** ([src/renderer/audio.js](src/renderer/audio.js)): una ventana oculta captura el audio del sistema (loopback) y el micrófono con WebAudio, y los envía en PCM al stdin de FFmpeg.
- **Juegos** ([src/games.js](src/games.js)):
  - **League of Legends:** Live Client Data API (`127.0.0.1:2999`). Detecta kills, multikills, ace, primera sangre, robos y objetivos, y victoria.
  - **Valorant:** presencia del cliente local de Riot (lockfile). Detecta inicio y fin de partida y rondas ganadas o perdidas; no hay API de kills.
  - **Otros juegos:** basta con añadir su `.exe` en Ajustes; activa la grabación y la tecla rápida.
- **Clips** ([src/director.js](src/director.js)): los eventos que caen a menos de 3 s entre sí se unen en un solo clip, hasta la duración máxima configurada.
- **Espacio** ([src/library.js](src/library.js)): al superar la cuota se borran primero las partidas completas más antiguas y después los clips más antiguos. Los favoritos no se borran nunca.

Log de diagnóstico: `%APPDATA%\Muninn\muninn.log`.
