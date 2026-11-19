# Muninn

Grabación en segundo plano para juegos al estilo Medal: buffer circular, clips automáticos de los mejores momentos, partidas completas y un límite de espacio. Se llama así por Muninn, el cuervo "memoria" de Odín, que sobrevolaba el mundo y volvía contando lo que había visto.

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
- `npm run dist`: genera el instalador en `dist/Muninn Setup x.y.z.exe`.

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
- **Barra de momentos** ([src/renderer/app.js](src/renderer/app.js)): cada momento (kill, objetivo, clip manual…) guarda su hora real (`at`). El reproductor lo marca en la barra; al pulsar un marcador se selecciona el tramo de 10 s antes a 4 s después, y ese tramo se puede ajustar arrastrando sus extremos o con las teclas I/O.
- **Audio** ([src/renderer/audio.js](src/renderer/audio.js)): una ventana oculta captura el audio del sistema (loopback) y el micrófono con WebAudio, y los envía en PCM al stdin de FFmpeg.
- **Juegos** ([src/games.js](src/games.js)):
  - **League of Legends:** Live Client Data API (`127.0.0.1:2999`). Detecta kills, multikills, ace, primera sangre, robos y objetivos, y victoria.
  - **Valorant:** presencia del cliente local de Riot (lockfile). Detecta inicio y fin de partida y rondas ganadas o perdidas; no hay API de kills.
  - **Otros juegos:** basta con añadir su `.exe` en Ajustes; activa la grabación y la tecla rápida.
- **Clips** ([src/director.js](src/director.js)): los eventos que caen a menos de 3 s entre sí se unen en un solo clip, hasta la duración máxima configurada.
- **Espacio** ([src/library.js](src/library.js)): al superar la cuota se borran primero las partidas completas más antiguas y después los clips más antiguos. Los favoritos no se borran nunca.

Log de diagnóstico: `%APPDATA%\Muninn\muninn.log`.
