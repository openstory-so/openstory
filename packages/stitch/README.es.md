<p align="center">
  <img src="https://assets.openstory.so/brand/openstory-logo-dark.png" alt="OpenStory" width="275" />
</p>

# @openstory/stitch

[English](README.md) · [中文](README.zh-CN.md) · [Français](README.fr.md)

Un reproductor pensado para el cine con IA. El README en inglés es el texto de origen.

Las imágenes fijas, el diálogo, la música y los segmentos de vídeo se pueden generar en cualquier orden. Déselos a stitch y el navegador reproduce esa lista como una sola secuencia. No hace falta montar los clips fuera de línea, ni usar ffmpeg para una vista previa.

![Temple Street](https://assets.openstory.so/stitch-player/temple-street.gif)

[Demo del reproductor](https://assets.openstory.so/stitch-player/demo)

Es el reproductor del teatro de [OpenStory](https://openstory.so). Un plano suele ser una imagen de storyboard con una línea grabada, y después un clip renderizado, con la música bajo todo el corte. Cada pieza se decodifica cuando el cabezal la alcanza ([mediabunny](https://mediabunny.dev) y WebCodecs) y se dibuja en un solo lienzo. Un vídeo reproduce el sonido de su archivo. Una imagen fija reproduce su propia línea. Los subtítulos quedan sobre la imagen. Los controles son [Video.js 10](https://videojs.org).

Cuando el clip existe, sustituye la imagen fija y el reproductor se actualiza.

Cuando el corte está listo, la misma unión escribe un MP4 en el navegador: H.264 y AAC, mediante WebCodecs. No hay que instalar ffmpeg y no hay un proceso de codificación al lado de la pestaña. La reproducción solo lee el clip bajo el cabezal, así que un corte largo no deja la película entera en memoria.

Dele URL `https`, o URL `blob:` de bytes que la página ya tiene. La secuencia se reproduce igual en línea y sin conexión.

## Un animatic en cuarenta líneas

Tres imágenes fijas, líneas grabadas, una cama de música y luego un clip renderizado.

```tsx
import { StitchedPlayer } from '@openstory/stitch/react';
import '@videojs/react/video/neutral-skin.css';

const still = (
  n: number,
  seconds: number,
  cues: { at: number; text: string }[]
) => ({
  imageUrl: `https://cdn.example/board/${n}.png`,
  fallbackImageUrl: null,
  durationSeconds: seconds, // la permanencia, salvo que el sonido dure más
  audioUrls: [`https://cdn.example/board/${n}.wav`],
  width: 1920,
  height: 1080,
  cues: cues.map(({ at, text }, i, all) => ({
    startSeconds: at,
    endSeconds: all[i + 1]?.at ?? seconds,
    text,
  })),
});

const clips = [
  still(0, 4, [{ at: 0.2, text: 'Ann: Where were you?' }]),
  still(1, 3, [
    { at: 0.1, text: 'Bob: Out.' },
    { at: 1.4, text: 'Bob: Walking.' },
  ]),
  // Un plano renderizado entra igual que una imagen fija, con su propio sonido.
  {
    videoUrl: 'https://cdn.example/shots/3.mp4',
    posterUrl: 'https://cdn.example/board/3.png',
    cues: [],
  },
];

export const Animatic = () => (
  <div style={{ aspectRatio: '16 / 9', background: 'black' }}>
    <StitchedPlayer
      clips={clips}
      musicUrl="https://cdn.example/score.mp3"
      musicGainDb={-6}
      musicEnabled
      download={{ filename: 'animatic.mp4' }}
    />
  </div>
);
```

`musicGainDb` baja la música y deja el diálogo como está (`-6` aquí). Los subtítulos se activan con el botón o con `c`. **Download** codifica el corte en el navegador y escribe un `.vtt` al lado. El archivo va al disco donde existe `showSaveFilePicker`. La mezcla queda en memoria en ambos casos.

## Qué incluye el paquete

| Importación                 | Qué                                                                                                                           | Instalar también                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `@openstory/stitch`         | El motor: `SequencePlayerEngine`, `ConcatenatedVideoSource`, los tipos de clip y ayudas puras.                                | nada                                                          |
| `@openstory/stitch/videojs` | `StitchedSequenceMedia`, un medio propio de [Video.js 10](https://videojs.org), para que la piel de Video.js dirija el motor. | nada en ejecución (`@videojs/media` es un peer solo de tipos) |
| `@openstory/stitch/react`   | `StitchedPlayer`: el lienzo bajo el `NeutralVideoSkin` de Video.js, con subtítulos y Download.                                | `react`, `@videojs/react`                                     |
| `@openstory/stitch/export`  | `exportSequence` y `downloadSequence`: la misma unión, codificada a MP4 en el navegador.                                      | nada                                                          |

`mediabunny` es una dependencia, así que se instala con el paquete. Los peers de React son opcionales: `react` ^19 y `@videojs/react` ^10. `@videojs/media` es un peer de tipos de la entrada de Video.js; `@videojs/react` lo trae para la superficie de React.

```sh
npm install @openstory/stitch
# para la superficie de React
npm install react @videojs/react
```

## Comando

`npx @openstory/stitch` reproduce imágenes fijas y vídeos en el navegador. Cada archivo es una ruta o una URL `http(s)`, servida a través del servidor local. Escucha en `127.0.0.1`, imprime la URL y la abre. La página es este reproductor: subtítulos, un interruptor de música, una línea de carga y Download. El marco es la caja del lienzo de los clips, así que un corte vertical llena la ventana en vertical. El proceso sigue hasta Ctrl+C. `--no-open` no abre el navegador. `--port` elige el puerto.

Los archivos se reproducen en el orden en que los nombra.

```sh
npx @openstory/stitch \
  --music score.mp3 --music-gain -3 \
  --subs lines.srt \
  shot.mp4 --poster board.png --cue 0-1.5 "Love that accent." \
  board.png --audio line.wav --seconds 3 --cue 0-2 "Coming over?"
```

- Un `.mp4`, `.webm` o `.mov` es un vídeo. Reproduce el sonido de dentro del archivo.
- Un `.png`, `.jpg`, `.jpeg` o `.webp` es una imagen fija. El comando lee su ancho y su alto.
- `--audio` añade una línea a la imagen fija anterior. Repítalo para otra línea. La imagen permanece el mayor entre `--seconds` (4 por defecto) y ese sonido.
- `--poster` es la imagen fija que se muestra mientras se abre el corte. Va en un vídeo de apertura.
- `--fallback` es la imagen que se prueba cuando la imagen fija anterior no carga.
- `--cue START-END TEXT` es un subtítulo del clip anterior. Los tiempos son segundos desde el inicio de ese clip. Ponga el texto entre comillas.
- `--subs lines.srt` (o `.vtt`) es un solo archivo de subtítulos para todo el corte. Un cue que cruza un corte se parte en los dos clips.
- `--music` es la cama bajo todo el corte. `--music-gain` cambia solo esa cama, en dB, y vale 0 por defecto. La página puede apagar esa cama. El diálogo se queda en su nivel.

## Compartir un corte

`npx @openstory/stitch bundle <dir> …` escribe la página del reproductor, `cut.json` y cada archivo (una URL se descarga) en una carpeta que se reproduce desde cualquier alojamiento estático. `npx @openstory/stitch share …` sube esa misma carpeta a OpenStory e imprime un enlace que cualquiera puede abrir; el primer uso inicia sesión con un código de dispositivo y guarda la clave en `~/.openstory/stitch.json`. `--origin` apunta a otro servidor de OpenStory. Cada imagen fija se revisa por si muestra a una persona real; si la muestra, hace falta `--portrait-rights <base>`, la base para usar su imagen. Ambos aceptan todas las opciones de corte del comando de reproducción y ninguno abre el navegador sobre el corte. Un agente sin shell puede compartir el mismo corte con la herramienta `create_stitch` del servidor MCP de OpenStory: cada medio es una URL que el servidor descarga o un archivo pequeño en base64.

## Skill

Ejecute el comando con npx, como arriba. `/stitch` hace lo mismo y deja la página en marcha.

Instale ambas skills en el proyecto actual:

```sh
npx @openstory/stitch skill
```

Eso copia [`stitch`](skills/stitch/SKILL.md) (`/stitch`) y [`stitch-player`](skills/stitch-player/SKILL.md), el contrato para incrustar el reproductor de React, en `.agents/skills/` y `.claude/skills/`. Añada `--global` para copiarlas en su directorio de inicio. Ejecútelo de nuevo después de actualizar para reemplazar ambas.

```sh
npx @openstory/stitch skill --global
```

O instale el [plugin de OpenStory](https://github.com/openstory-so/skills) para obtener `create-style`, `create-sequence` y `stitch` juntos. El plugin no incluye `stitch-player`:

```sh
npx skills add openstory-so/skills
```

Grok:

```sh
grok plugin marketplace add openstory-so/skills
grok plugin install openstory --trust
```

Claude Code:

```
/plugin marketplace add openstory-so/skills
/plugin install openstory@openstory
```

Codex:

```sh
codex plugin marketplace add openstory-so/skills
codex plugin add openstory@openstory
```

Aplicación de escritorio de ChatGPT: abra Plugins, elija Add a marketplace, escriba `openstory-so/skills` e instale OpenStory. Esas skills se ejecutan en la aplicación de escritorio.

`@openstory/stitch-player@0.1.0` fue la primera publicación de este paquete. A partir de ahora instale `@openstory/stitch`.

Construido para [Video.js 10](https://videojs.org) (`^10.0.0`).

## Clips

Un clip es un vídeo renderizado o una imagen fija con duración. Los clips se reproducen en el orden del array.

```ts
import type { PlaybackClip } from '@openstory/stitch';

const clips: PlaybackClip[] = [
  // Un clip renderizado. Su sonido incrustado suena con él.
  // `posterUrl` es para que el anfitrión lo muestre mientras espera. El reproductor no lo pinta.
  { videoUrl: '/shot-1.mp4', posterUrl: '/shot-1.jpg', cues: [] },
  // Una imagen fija, sostenida el mayor entre `durationSeconds` y su sonido.
  {
    imageUrl: '/shot-2.png',
    fallbackImageUrl: null,
    durationSeconds: 4,
    audioUrls: ['/shot-2-dialogue.wav'],
    width: 1920,
    height: 1080,
    cues: [
      { startSeconds: 0.2, endSeconds: 1.6, text: 'Ann: Where were you?' },
    ],
  },
];
```

- **Los tamaños mezclados valen.** El marco de destino es la caja que envuelve los clips de vídeo (o cada imagen fija, cuando no hay vídeo). `meta.hasMixedResolutions` es el aviso. Las bandas solo aparecen cuando `meta.hasMixedAspectRatios` está activo; los clips de la misma relación se escalan para llenar.
- **Los tiempos de los cues son segundos desde el inicio de su propio clip.** El reproductor los coloca con los inicios medidos, así que un clip largo mueve los cues que van después y estos se quedan en sus clips.
- **Un array nuevo de los mismos clips no es una secuencia nueva.** La identidad es el orden más el medio (`playbackClipsKey`): en un vídeo, solo `videoUrl`; en una imagen fija, las URL de imagen, `audioUrls`, `durationSeconds`, `width` y `height`. El texto del cue no forma parte, así que una recarga que solo cambia la redacción no reconstruye el reproductor. Pase igual la lista nueva a `setSource`: la fuente abierta copia los cues, y Download escribe esos.

## React

```tsx
import { StitchedPlayer } from '@openstory/stitch/react';

<StitchedPlayer
  clips={clips}
  musicUrl="/score.mp3"
  musicGainDb={-3}
  musicEnabled
  subtitles // visibles por defecto cuando algún clip tiene cues
  autoPlay={false}
  download={{ filename: 'cut.mp4', subtitles: 'sidecar' }}
  onMeta={(meta) => console.log(meta.durationSeconds, meta.clipOffsetsSeconds)}
  onTimeUpdate={(t) => {}}
  onPlay={() => {}}
  onPause={() => {}}
  onEnded={() => {}}
  onError={(reason) => console.error(reason)}
/>;
```

`StitchedPlayer` se puede importar en cualquier sitio, incluido un render de servidor: renderiza `fallback` (nada por defecto) en el servidor y hasta que su código ha cargado en el cliente, y después el reproductor. Las partes de Video.js se cargan detrás de eso, así que el framework no las evalúa durante el SSR. Importe la hoja de la piel una vez: `import '@videojs/react/video/neutral-skin.css'`.

Los subtítulos los dibuja la superficie, no un elemento `<video>` (no hay ninguno), en una caja sobre los controles que sube con ellos. Picture-in-Picture también funciona: el lienzo se envía a un vídeo oculto y eso es lo que flota. Cambie el estilo con CSS en `[data-part="stitch-captions"]`; el botón Download es `[data-part="stitch-download"]`.

## Exportación

```ts
import { exportSequence, downloadSequence } from '@openstory/stitch/export';

// Un archivo en memoria, más los subtítulos en WebVTT.
const { blob, vtt, durationSeconds } = await exportSequence({
  clips,
  musicUrl: '/score.mp3',
  musicGainDb: -3,
  musicEnabled: true,
  frameRate: 24, // el valor por defecto; las imágenes fijas también se muestrean a esta tasa
  subtitles: 'sidecar', // o 'burn-in' para dibujarlos en los fotogramas, o 'none'
  onProgress: (fraction) => {},
  signal: controller.signal,
});

// O directo a un archivo que elige la persona, desde un clic. En flujo donde
// existe `showSaveFilePicker`; si no, un Blob. La mezcla está en memoria en ambos casos.
button.onclick = () =>
  downloadSequence({
    clips,
    musicUrl: null,
    musicGainDb: 0,
    musicEnabled: false,
    filename: 'cut.mp4',
  });
```

La exportación ejecuta el mismo código de unión, así que el archivo coincide con la vista previa: los mismos fotogramas, las mismas bandas, la misma mezcla. El vídeo es H.264 y el audio es AAC, en un MP4. Un códec que el navegador no puede codificar es un error; no se sustituye en silencio. El audio incrustado que no se puede decodificar y una imagen fija sin imagen cargada también lanzan, aunque la reproducción continúe (en silencio, o sobre un fotograma negro). Pase `engine.source` de un reproductor como `source` para saltarse un segundo `prepare()` de los clips de vídeo que ya abrió (el botón Download hace esto), con el reproductor en pausa. La música se vuelve a abrir. Los bytes de un clip se pueden volver a leer si salieron de la caché de rangos de 16 MiB.

## Solo Video.js 10

```ts
import { StitchedSequenceMedia } from '@openstory/stitch/videojs';

const media = new StitchedSequenceMedia();
media.setListeners({ onError: console.error });
media.setSource({
  clips,
  musicUrl: null,
  musicGainDb: 0,
  musicEnabled: false,
  subtitles: true,
});
media.attach(canvas); // el motor dibuja en este HTMLCanvasElement
await media.play();
media.currentTime = 12; // salto
media.textTracks; // una pista `subtitles` cuando algún clip tiene cues; el botón de subtítulos de la piel la conmuta
media.activeCueText; // el subtítulo en el cabezal, o null
```

## Solo el motor

```ts
import { SequencePlayerEngine } from '@openstory/stitch';

const engine = new SequencePlayerEngine({
  canvas,
  clips,
  musicUrl: null,
  musicGainDb: 0,
  musicEnabled: false,
  onTimeUpdate: (t) => {},
  onBuffering: (stalled) => {},
  onEnded: () => {},
  onError: console.error,
});
const meta = await engine.prepare(); // lanza si una pista de vídeo o el diálogo de una imagen fija no se puede decodificar
await engine.play();
engine.pause();
await engine.seek(3.5);
engine.setMusicEnabled(false); // al instante, sin otro prepare
engine.dispose();
```

`cueTextAt(clips, meta.clipOffsetsSeconds, time)` da el subtítulo de un instante si usted dibuja el suyo, y `cuesToWebVTT(clips, meta.clipOffsetsSeconds)` el sidecar completo.

`logger` es `console` por defecto. Pase uno para oír un clip cuyo sonido incrustado no se decodifica, o una música omitida (`meta.musicUndecodable`). Las URL se piden tal como se dan.

## Cómo se mantiene ligero

- **La apertura es concurrente.** Cada clip se abre a la vez por su duración y su tamaño, y después se lee el primer fotograma. Un corte de veinte clips es una ronda de lecturas de cabecera más ese fotograma, no veinte aperturas en serie. Las imágenes fijas decodifican sus imágenes durante `prepare()`.
- **Las lecturas son peticiones Range acotadas.** Bloques de 64 KiB. Una cabecera faststart es una petición; la lectura anticipada se duplica hasta 2 MiB mientras suena un clip. Se cachean hasta 16 MiB por fuente, así que un clip corto puede quedarse entero en memoria. `locate()` recorre la tabla de desplazamientos, O(N) en el número de clips.
- **El sonido también va en flujo.** El audio de cada clip se decodifica un segundo por delante del cabezal y se suelta al reproducirse; la apertura del clip siguiente se pide tres segundos antes del corte.
- **Una pausa de red retiene todo junto.** El reloj de audio es el reloj de reproducción, así que un atasco de red lo suspende, y la imagen, la música y cada línea de diálogo ya en cola pausan y siguen como una sola cosa.

## Requisitos

- **La reproducción y la exportación necesitan un navegador:** WebCodecs y Web Audio. Los módulos se importan bajo Node, y `@openstory/stitch/react` se puede importar durante el render de servidor (carga Video.js solo en el cliente).
- **Los servidores de clips y de audio deben aceptar peticiones Range.** Las URL de otro origen también necesitan CORS, un 206 y `Access-Control-Expose-Headers: Content-Range`. Las URL del mismo origen no necesitan CORS. Una URL `blob:` sirve para vídeo, música y diálogo cuando `fetch` responde a `Range` con 206, que es como una página reproduce un corte a partir de bytes que ya tiene. Una URL `data:` sirve para la línea de una imagen fija. La reproducción carga las imágenes fijas como imágenes, y eso no necesita CORS. La exportación y Picture-in-Picture leen el lienzo de vuelta, así que una imagen fija de otro origen sin CORS mancha el lienzo y esas dos operaciones lanzan `SecurityError`.
- **Codificación (solo exportación):** codificadores H.264 y AAC, que tienen Chrome, Edge, Safari 17+ y Firefox reciente.

## Licencia

MIT
