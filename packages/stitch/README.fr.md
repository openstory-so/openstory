<p align="center">
  <img src="https://assets.openstory.so/brand/openstory-logo-dark.png" alt="OpenStory" width="275" />
</p>

# @openstory/stitch

[English](README.md) · [中文](README.zh-CN.md) · [Español](README.es.md)

Un lecteur conçu pour le cinéma assisté par IA. Le README anglais est le texte source.

Images fixes, dialogues, musique et segments vidéo peuvent être générés dans n'importe quel ordre. Donnez-les à stitch et le navigateur joue cette liste comme une seule séquence. Inutile de monter les plans hors ligne, ou d'installer ffmpeg pour une prévisualisation.

![Temple Street](https://assets.openstory.so/stitch-player/temple-street.gif)

[Démo du lecteur](https://assets.openstory.so/stitch-player/demo)

C'est le lecteur derrière le théâtre d'[OpenStory](https://openstory.so). Un plan est souvent une image de storyboard avec une réplique enregistrée, puis un plan rendu, avec la musique sous toute la coupe. Chaque morceau est décodé quand la tête de lecture l'atteint ([mediabunny](https://mediabunny.dev) et WebCodecs) et dessiné sur un seul canevas. Une vidéo joue le son de son fichier. Une image fixe joue sa propre réplique. Les sous-titres reposent sur l'image. Les commandes sont celles de [Video.js 10](https://videojs.org).

Remplacez une image fixe par un plan quand le plan existe, et le lecteur se met à jour.

Quand la coupe est prête, le même assemblage écrit un MP4 dans le navigateur : H.264 et AAC, via WebCodecs. Pas d'installation de ffmpeg, et pas de processus d'encodage à côté de l'onglet. La lecture ne lit que le plan sous la tête, donc une coupe longue ne place pas le film entier en mémoire.

Donnez-lui des URL `https`, ou des URL `blob:` d'octets que la page détient déjà. La séquence se joue de la même façon en ligne et hors ligne.

## Un animatic en quarante lignes

Trois images fixes, des répliques enregistrées, un lit musical, puis un plan rendu.

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
  durationSeconds: seconds, // la tenue, sauf si le son dure plus longtemps
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
  // Un plan rendu s'insère exactement comme une image fixe, avec son propre son.
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

`musicGainDb` baisse la musique et laisse le dialogue tel quel (`-6` ici). Les sous-titres se coupent avec le bouton ou `c`. **Download** encode la coupe dans le navigateur et écrit un `.vtt` à côté. Le fichier part vers le disque là où `showSaveFilePicker` existe. Le mix reste en mémoire dans les deux cas.

## Ce que contient le paquet

| Import                      | Contenu                                                                                                                            | À installer aussi                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `@openstory/stitch`         | Le moteur : `SequencePlayerEngine`, `ConcatenatedVideoSource`, les types de clips, des aides pures.                                | rien                                                                 |
| `@openstory/stitch/videojs` | `StitchedSequenceMedia`, un média personnalisé [Video.js 10](https://videojs.org), pour que l'habillage Video.js pilote le moteur. | rien à l'exécution (`@videojs/media` est un peer de types seulement) |
| `@openstory/stitch/react`   | `StitchedPlayer` : le canevas sous le `NeutralVideoSkin` de Video.js, avec sous-titres et Download.                                | `react`, `@videojs/react`                                            |
| `@openstory/stitch/export`  | `exportSequence` et `downloadSequence` : le même assemblage, encodé en MP4 dans le navigateur.                                     | rien                                                                 |

`mediabunny` est une dépendance, donc il s'installe avec le paquet. Les peers React sont facultatifs : `react` ^19 et `@videojs/react` ^10. `@videojs/media` est un peer de types de l'entrée Video.js ; `@videojs/react` l'apporte pour la surface React.

```sh
npm install @openstory/stitch
# pour la surface React
npm install react @videojs/react
```

## Commande

`npx @openstory/stitch` joue des images fixes et des vidéos dans le navigateur. Chaque fichier est un chemin ou une URL `http(s)`, relayée par le serveur local. Il écoute sur `127.0.0.1`, affiche l'URL et l'ouvre. La page est ce lecteur : sous-titres, interrupteur de musique, une ligne de chargement, et Download. Le cadre est la boîte du canevas des clips, donc une coupe portrait remplit la fenêtre en portrait. Le processus tourne jusqu'à Ctrl+C. `--no-open` n'ouvre pas le navigateur. `--port` choisit le port.

Les fichiers jouent dans l'ordre où vous les nommez.

```sh
npx @openstory/stitch \
  --music score.mp3 --music-gain -3 \
  --subs lines.srt \
  shot.mp4 --poster board.png --cue 0-1.5 "Love that accent." \
  board.png --audio line.wav --seconds 3 --cue 0-2 "Coming over?"
```

- Un `.mp4`, `.webm` ou `.mov` est une vidéo. Elle joue le son contenu dans le fichier.
- Un `.png`, `.jpg`, `.jpeg` ou `.webp` est une image fixe. La commande lit sa largeur et sa hauteur.
- `--audio` ajoute une réplique à l'image fixe qui précède. Répétez-le pour une autre réplique. L'image reste affichée pendant le plus long de `--seconds` (4 par défaut) et de ce son.
- `--poster` est l'image fixe montrée pendant l'ouverture de la coupe. Il va sur une vidéo d'ouverture.
- `--fallback` est l'image essayée quand l'image fixe qui précède ne se charge pas.
- `--cue START-END TEXT` est un sous-titre sur le clip qui précède. Les temps sont des secondes depuis le début de ce clip. Mettez le texte entre guillemets.
- `--subs lines.srt` (ou `.vtt`) est un seul fichier de sous-titres pour toute la coupe. Un cue qui traverse une coupe est réparti sur les deux clips.
- `--music` est le lit sous toute la coupe. `--music-gain` ne change que ce lit, en dB, et vaut 0 par défaut. La page peut couper ce lit. Le dialogue garde son niveau.

## Skill

Lancez la commande avec npx, comme ci-dessus. `/stitch` fait la même chose et laisse la page ouverte.

Installez les deux skills dans le projet courant :

```sh
npx @openstory/stitch skill
```

Cela copie [`stitch`](skills/stitch/SKILL.md) (`/stitch`) et [`stitch-player`](skills/stitch-player/SKILL.md), le contrat pour intégrer le lecteur React, dans `.agents/skills/` et `.claude/skills/`. Ajoutez `--global` pour les copier plutôt dans votre répertoire personnel. Relancez-le après une mise à jour pour remplacer les deux.

```sh
npx @openstory/stitch skill --global
```

Ou installez le [plugin OpenStory](https://github.com/openstory-so/skills) pour obtenir `create-style`, `create-sequence` et `stitch` ensemble. Le plugin n'inclut pas `stitch-player` :

```sh
npx skills add openstory-so/skills
```

Grok :

```sh
grok plugin marketplace add openstory-so/skills
grok plugin install openstory --trust
```

Claude Code :

```
/plugin marketplace add openstory-so/skills
/plugin install openstory@openstory
```

Codex :

```sh
codex plugin marketplace add openstory-so/skills
codex plugin add openstory@openstory
```

Application ChatGPT pour le bureau : ouvrez Plugins, choisissez Add a marketplace, entrez `openstory-so/skills`, et installez OpenStory. Ces skills tournent dans l'application de bureau.

`@openstory/stitch-player@0.1.0` était la première publication de ce paquet. Installez `@openstory/stitch` à partir de maintenant.

Construit pour [Video.js 10](https://videojs.org) (`^10.0.0`).

## Clips

Un clip est une vidéo rendue ou une image fixe minutée. Les clips jouent dans l'ordre du tableau.

```ts
import type { PlaybackClip } from '@openstory/stitch';

const clips: PlaybackClip[] = [
  // Un clip rendu. Son son intégré joue avec lui.
  // `posterUrl` sert à l'hôte pendant l'attente. Le lecteur ne le peint pas.
  { videoUrl: '/shot-1.mp4', posterUrl: '/shot-1.jpg', cues: [] },
  // Une image fixe, tenue pendant le plus long de `durationSeconds` et de son son.
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

- **Les tailles mélangées conviennent.** Le cadre cible est la boîte englobante des clips vidéo (ou de chaque image fixe, quand il n'y a pas de vidéo). `meta.hasMixedResolutions` est l'avertissement. Des bandes n'apparaissent que lorsque `meta.hasMixedAspectRatios` est vrai ; les clips de même ratio sont mis à l'échelle pour remplir.
- **Les temps des cues sont des secondes depuis le début de leur propre clip.** Le lecteur les place avec les débuts mesurés, donc un clip long décale les cues qui suivent, et ils restent sur leurs clips.
- **Un nouveau tableau des mêmes clips n'est pas une nouvelle séquence.** L'identité est l'ordre plus le média (`playbackClipsKey`) : pour une vidéo, `videoUrl` seulement ; pour une image fixe, les URL d'image, `audioUrls`, `durationSeconds`, `width` et `height`. Le texte des cues n'en fait pas partie, donc un rechargement qui ne change que la formulation ne reconstruit pas le lecteur. Passez quand même la nouvelle liste à `setSource` : la source ouverte copie les cues, et Download écrit ceux-là.

## React

```tsx
import { StitchedPlayer } from '@openstory/stitch/react';

<StitchedPlayer
  clips={clips}
  musicUrl="/score.mp3"
  musicGainDb={-3}
  musicEnabled
  subtitles // affichés par défaut dès qu'un clip a des cues
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

`StitchedPlayer` peut être importé partout, y compris pendant un rendu serveur : il rend `fallback` (rien par défaut) sur le serveur et tant que son code n'est pas chargé côté client, puis le lecteur. Les parties Video.js sont chargées derrière cela, donc votre framework ne les évalue jamais pendant le SSR. Importez la feuille de l'habillage une fois : `import '@videojs/react/video/neutral-skin.css'`.

Les sous-titres sont dessinés par la surface, pas par un élément `<video>` (il n'y en a pas), dans une boîte au-dessus des commandes qui monte avec elles. L'incrustation image dans l'image fonctionne aussi : le canevas est envoyé dans une vidéo cachée, et c'est elle qui flotte. Restylez avec du CSS sur `[data-part="stitch-captions"]` ; le bouton Download est `[data-part="stitch-download"]`.

## Export

```ts
import { exportSequence, downloadSequence } from '@openstory/stitch/export';

// Un fichier en mémoire, plus les sous-titres en WebVTT.
const { blob, vtt, durationSeconds } = await exportSequence({
  clips,
  musicUrl: '/score.mp3',
  musicGainDb: -3,
  musicEnabled: true,
  frameRate: 24, // la valeur par défaut ; les images fixes sont échantillonnées à cette cadence aussi
  subtitles: 'sidecar', // ou 'burn-in' pour les dessiner sur les images, ou 'none'
  onProgress: (fraction) => {},
  signal: controller.signal,
});

// Ou directement vers un fichier choisi par l'utilisateur, depuis un clic.
// En flux là où `showSaveFilePicker` existe ; sinon un Blob. Le mix est en mémoire dans les deux cas.
button.onclick = () =>
  downloadSequence({
    clips,
    musicUrl: null,
    musicGainDb: 0,
    musicEnabled: false,
    filename: 'cut.mp4',
  });
```

L'export exécute le même code d'assemblage, donc le fichier correspond à la prévisualisation : mêmes images, mêmes bandes, même mix. La vidéo est en H.264 et l'audio en AAC, dans un MP4. Un codec que le navigateur ne peut pas encoder est une erreur ; rien n'est remplacé en silence. Un son intégré indécodable et une image fixe sans image chargée lèvent aussi, même si la lecture continue (en silence, ou sur une image noire). Passez `engine.source` d'un lecteur comme `source` pour sauter un second `prepare()` des clips vidéo qu'il a déjà ouverts (le bouton Download le fait), avec le lecteur en pause. La musique est rouverte. Les octets d'un clip peuvent être relus s'ils ont été évincés du cache d'intervalles de 16 Mio.

## Video.js 10 seulement

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
media.attach(canvas); // le moteur dessine dans cet HTMLCanvasElement
await media.play();
media.currentTime = 12; // déplacement
media.textTracks; // une piste `subtitles` quand un clip a des cues ; le bouton sous-titres de l'habillage la coupe
media.activeCueText; // le sous-titre sous la tête, ou null
```

## Le moteur seulement

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
const meta = await engine.prepare(); // lève si une piste vidéo ou le dialogue d'une image fixe ne se décode pas
await engine.play();
engine.pause();
await engine.seek(3.5);
engine.setMusicEnabled(false); // immédiat, sans nouveau prepare
engine.dispose();
```

`cueTextAt(clips, meta.clipOffsetsSeconds, time)` donne le sous-titre d'un instant si vous dessinez le vôtre, et `cuesToWebVTT(clips, meta.clipOffsetsSeconds)` tout le fichier sidecar.

`logger` vaut `console` par défaut. Passez-en un pour entendre un clip dont le son intégré ne se décode pas, ou une musique omise (`meta.musicUndecodable`). Les URL sont demandées telles quelles.

## Comment il reste léger

- **L'ouverture est concurrente.** Chaque clip est ouvert en même temps pour sa durée et sa taille, puis la première image est lue. Une coupe de vingt clips est donc un tour de lectures d'en-têtes plus cette image, pas vingt ouvertures en série. Les images fixes décodent leurs images pendant `prepare()`.
- **Les lectures sont des requêtes Range bornées.** Blocs de 64 Kio. Un en-tête faststart est une requête ; la lecture anticipée double jusqu'à 2 Mio pendant qu'un clip joue. Jusqu'à 16 Mio sont mis en cache par source, donc un clip court peut tenir entièrement en mémoire. `locate()` parcourt la table des décalages, en O(N) sur le nombre de clips.
- **Le son est en flux lui aussi.** L'audio de chaque clip est décodé une seconde avant la tête et abandonné une fois joué ; l'ouverture du clip suivant est demandée trois secondes avant la coupe.
- **Un blocage retient tout ensemble.** L'horloge audio est l'horloge de lecture, donc un blocage réseau la suspend, et l'image, la musique et chaque réplique déjà en file pause et reprennent comme un seul ensemble.

## Prérequis

- **La lecture et l'export ont besoin d'un navigateur :** WebCodecs et Web Audio. Les modules s'importent sous Node, et `@openstory/stitch/react` peut être importé pendant le rendu serveur (il ne charge Video.js que côté client).
- **Les serveurs de clips et d'audio doivent accepter les requêtes Range.** Les URL d'une autre origine ont aussi besoin de CORS, d'un 206, et de `Access-Control-Expose-Headers: Content-Range`. Les URL de même origine n'ont pas besoin de CORS. Une URL `blob:` convient pour la vidéo, la musique et le dialogue quand `fetch` répond `Range` avec 206, ce qui est ainsi qu'une page joue une coupe à partir d'octets qu'elle détient déjà. Une URL `data:` convient pour la réplique d'une image fixe. La lecture charge les images fixes comme des images, ce qui ne demande pas CORS. L'export et l'incrustation lisent le canevas en retour, donc une image fixe d'une autre origine sans CORS tache le canevas et ces deux opérations lèvent `SecurityError`.
- **Encodage (export seulement) :** encodeurs H.264 et AAC, présents dans Chrome, Edge, Safari 17+ et les Firefox récents.

## Licence

MIT
