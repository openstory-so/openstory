<p align="center">
  <img src="https://assets.openstory.so/brand/openstory-logo-dark.png" alt="OpenStory" width="275" />
</p>

# @openstory/stitch

[English](README.md) · [Français](README.fr.md) · [Español](README.es.md)

为 AI 影视制作设计的播放器。英文 README 是这份文档的原文。

静帧、对白、音乐和视频可以按任意顺序生成。把它们交给 stitch，浏览器就把这份列表当成一条序列来播。预览不必先在剪辑软件里接好，也不必为了看一眼去装 ffmpeg。

![Temple Street](https://assets.openstory.so/stitch-player/temple-street.gif)

[播放器演示](https://assets.openstory.so/stitch-player/demo)

这是 [OpenStory](https://openstory.so) 剧场背后的播放器。一个镜头常常是一张分镜静帧加一句录好的台词，然后才是渲染出的视频，音乐铺在整条成片下面。播放头走到哪一段，就解码哪一段（[mediabunny](https://mediabunny.dev) 和 WebCodecs），画在同一块画布上。视频播放文件里的声音。静帧播放它自己的台词。字幕叠在画面上。控件是 [Video.js 10](https://videojs.org)。

视频就绪后，用它换掉静帧，播放器会跟着更新。

成片确定之后，同一次拼接在浏览器里写出 MP4：H.264 和 AAC，走 WebCodecs。不用安装 ffmpeg，标签页旁边也没有编码进程。播放只读取播放头下面的那一段，所以一条长片不会把整部片子放进内存。

给它 `https` URL，或者页面已经持有的字节的 `blob:` URL。同一条序列在线和离线都这样播。

## 四十行里的动态分镜

三张静帧、录好的台词、一条音乐床，然后一个渲染好的镜头。

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
  durationSeconds: seconds, // 停留时长；声音更长时以声音为准
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
  // 渲染好的镜头和静帧一样放进列表，自带声音。
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

`musicGainDb` 只压低音乐，对白保持原样（这里是 `-6`）。字幕用按钮或 `c` 切换。**Download** 在浏览器里编码这条成片，并在旁边写一个 `.vtt`。支持 `showSaveFilePicker` 时，文件直接写到磁盘。混音无论哪种情况都留在内存里。

## 包里有什么

| 导入路径                    | 内容                                                                                                    | 还要安装                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@openstory/stitch`         | 引擎：`SequencePlayerEngine`、`ConcatenatedVideoSource`、clip 类型，以及纯函数。                        | 不用                                         |
| `@openstory/stitch/videojs` | `StitchedSequenceMedia`，一种 [Video.js 10](https://videojs.org) 自定义媒体，让 Video.js 皮肤驱动引擎。 | 运行时不用（`@videojs/media` 只是类型 peer） |
| `@openstory/stitch/react`   | `StitchedPlayer`：Video.js `NeutralVideoSkin` 下面的画布，带字幕和 Download。                           | `react`、`@videojs/react`                    |
| `@openstory/stitch/export`  | `exportSequence` 和 `downloadSequence`：同一次拼接，在浏览器里编码成 MP4。                              | 不用                                         |

`mediabunny` 是依赖，会随包安装。React 的 peer 是可选的：`react` ^19 和 `@videojs/react` ^10。`@videojs/media` 是 Video.js 入口的类型 peer；React 表面由 `@videojs/react` 带进来。

```sh
npm install @openstory/stitch
# React 表面再装这两个
npm install react @videojs/react
```

## 命令

`npx @openstory/stitch` 在浏览器里播放本地静帧和视频。它监听 `127.0.0.1`，打印 URL，并打开页面。页面就是这个播放器：字幕、音乐开关、一行加载提示，以及 Download。画面是这些 clip 的画布包围盒，所以竖屏成片会以竖屏铺满窗口。进程一直运行到 Ctrl+C。`--no-open` 不打开浏览器。`--port` 指定端口。

文件按你写出的顺序播放。

```sh
npx @openstory/stitch \
  --music score.mp3 --music-gain -3 \
  --subs lines.srt \
  shot.mp4 --poster board.png --cue 0-1.5 "Love that accent." \
  board.png --audio line.wav --seconds 3 --cue 0-2 "Coming over?"
```

- `.mp4`、`.webm`、`.mov` 是视频。它播放文件里的声音。
- `.png`、`.jpg`、`.jpeg`、`.webp` 是静帧。命令会读取它的宽和高。
- `--audio` 给它前面那张静帧加一句台词。再写一次就再加一句。静帧停留时间取 `--seconds`（默认 4）和这段声音中较长的一个。
- `--poster` 是成片打开时显示的静帧，只能放在开头的视频上。
- `--fallback` 是它前面那张静帧加载失败时改用的图。
- `--cue START-END TEXT` 是它前面那个 clip 上的一条字幕。时间是从该 clip 起点算起的秒数。文字请加引号。
- `--subs lines.srt`（或 `.vtt`）是整条成片的一个字幕文件。跨过切点的一条字幕会拆到两边的 clip 上。
- `--music` 是铺在整条成片下的音乐床。`--music-gain` 只改变这条床，单位是 dB，默认 0。页面可以关掉音乐床。对白保持自己的音量。

## Skill

用 npx 运行上面的命令。`/stitch` 做同一件事，并让页面保持运行。

把两个 skill 安装到当前项目：

```sh
npx @openstory/stitch skill
```

这会把 [`stitch`](skills/stitch/SKILL.md)（`/stitch`）和 [`stitch-player`](skills/stitch-player/SKILL.md)（嵌入 React 播放器的约定）复制到 `.agents/skills/` 和 `.claude/skills/`。加上 `--global` 则复制到用户主目录。升级后再运行一次，即可替换这两个 skill。

```sh
npx @openstory/stitch skill --global
```

也可以安装 [OpenStory 插件](https://github.com/openstory-so/skills)，一次得到 `create-style`、`create-sequence` 和 `stitch`。插件不包含 `stitch-player`：

```sh
npx skills add openstory-so/skills
```

Grok：

```sh
grok plugin marketplace add openstory-so/skills
grok plugin install openstory --trust
```

Claude Code：

```
/plugin marketplace add openstory-so/skills
/plugin install openstory@openstory
```

Codex：

```sh
codex plugin marketplace add openstory-so/skills
codex plugin add openstory@openstory
```

ChatGPT 桌面应用：打开 Plugins，选择 Add a marketplace，输入 `openstory-so/skills`，安装 OpenStory。这些 skill 在桌面应用里运行。

`@openstory/stitch-player@0.1.0` 是这个包的第一次发布。之后请安装 `@openstory/stitch`。

针对 [Video.js 10](https://videojs.org)（`^10.0.0`）构建。

## Clip

一个 clip 是一段渲染好的视频，或一张计时的静帧。Clip 按数组顺序播放。

```ts
import type { PlaybackClip } from '@openstory/stitch';

const clips: PlaybackClip[] = [
  // 渲染好的 clip。文件里的声音一起播放。
  // `posterUrl` 给宿主在等待时显示。播放器不绘制它。
  { videoUrl: '/shot-1.mp4', posterUrl: '/shot-1.jpg', cues: [] },
  // 静帧。停留时间取 `durationSeconds` 和它的声音中较长的一个。
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

- **尺寸可以混用。** 目标画面是视频 clip 的包围盒（没有视频时，是每张静帧的包围盒）。`meta.hasMixedResolutions` 是对此的警告。只有 `meta.hasMixedAspectRatios` 为真时才出现黑边；比例相同的 clip 会被放大到铺满。
- **字幕时间从它自己的 clip 起点算起，单位是秒。** 播放器用测得的 clip 起点来放置字幕，所以前面的长 clip 会把后面的字幕往后推，字幕仍留在自己的 clip 上。
- **同一批 clip 的新数组不是一条新序列。** 身份是顺序加上媒体（`playbackClipsKey`）：视频只看 `videoUrl`；静帧看图片 URL、`audioUrls`、`durationSeconds`、`width` 和 `height`。字幕文字不在身份里，所以一次只改措辞的重新获取不会重建播放器。仍然要把新列表传给 `setSource`：打开中的源会复制这些字幕，Download 写出的是它们。

## React

```tsx
import { StitchedPlayer } from '@openstory/stitch/react';

<StitchedPlayer
  clips={clips}
  musicUrl="/score.mp3"
  musicGainDb={-3}
  musicEnabled
  subtitles // 任一 clip 有字幕时默认显示
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

`StitchedPlayer` 在任何地方导入都安全，包括服务端渲染：服务端以及客户端代码尚未加载时，它渲染 `fallback`（默认什么都不渲染），然后才是播放器。Video.js 的部分在这之后才加载，所以框架在 SSR 期间不会执行它们。皮肤样式表导入一次：`import '@videojs/react/video/neutral-skin.css'`。

字幕由这个表面绘制，不由 `<video>` 元素绘制（这里没有 `<video>`），画在控件上方的盒子里，并随控件抬起。画中画也可以用：画布被送进一个隐藏的 video，浮起来的是那个 video。用 `[data-part="stitch-captions"]` 上的 CSS 改字幕样式；Download 按钮是 `[data-part="stitch-download"]`。

## 导出

```ts
import { exportSequence, downloadSequence } from '@openstory/stitch/export';

// 内存中的文件，加上 WebVTT 字幕。
const { blob, vtt, durationSeconds } = await exportSequence({
  clips,
  musicUrl: '/score.mp3',
  musicGainDb: -3,
  musicEnabled: true,
  frameRate: 24, // 默认值；静帧也按这个帧率采样
  subtitles: 'sidecar', // 或 'burn-in' 把字幕画进画面，或 'none'
  onProgress: (fraction) => {},
  signal: controller.signal,
});

// 或者从一次点击直接写到用户选择的文件。有 `showSaveFilePicker`
// 时按流写出；否则是一个 Blob。混音无论哪种情况都在内存里。
button.onclick = () =>
  downloadSequence({
    clips,
    musicUrl: null,
    musicGainDb: 0,
    musicEnabled: false,
    filename: 'cut.mp4',
  });
```

导出跑的是同一套拼接代码，所以文件和预览一致：同样的帧、同样的黑边、同样的混音。视频是 H.264，音频是 AAC，装在 MP4 里。浏览器编不了的编解码器是错误，不会悄悄换成别的。嵌在文件里但解不了的声音，以及没有载入画面的静帧，也会抛出错误，尽管播放会继续（静音，或停在黑帧上）。把播放器的 `engine.source` 作为 `source` 传进去，可以跳过对它已经打开的视频 clip 的第二次 `prepare()`（Download 按钮就是这样做的），播放器要处于暂停。音乐会重新打开。如果 clip 字节已从 16 MiB 的区间缓存里被换出，可能会再读一次。

## 仅 Video.js 10

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
media.attach(canvas); // 引擎画进这个 HTMLCanvasElement
await media.play();
media.currentTime = 12; // 跳转
media.textTracks; // 任一 clip 有字幕时有一条 `subtitles` 轨道；皮肤的字幕按钮切换它
media.activeCueText; // 播放头处的字幕，没有则为 null
```

## 仅引擎

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
const meta = await engine.prepare(); // 视频轨或静帧对白无法解码时抛出
await engine.play();
engine.pause();
await engine.seek(3.5);
engine.setMusicEnabled(false); // 立即生效，不必重新 prepare
engine.dispose();
```

自己绘制字幕时，`cueTextAt(clips, meta.clipOffsetsSeconds, time)` 给出某个时间的字幕，`cuesToWebVTT(clips, meta.clipOffsetsSeconds)` 给出整份 sidecar。

`logger` 默认是 `console`。传一个进去，才能听到某段嵌入声音解不了，或音乐被略过（`meta.musicUndecodable`）。URL 按给定的地址去取。

## 它如何保持轻量

- **打开是并发的。** 每个 clip 同时打开，只为了读时长和尺寸，然后读取第一帧。所以二十个 clip 是一轮头信息读取加上那一帧，而不是二十次串行打开。静帧在 `prepare()` 期间解码图片。
- **读取是有界的 Range 请求。** 每块 64 KiB。faststart 头是一次请求；播放某个 clip 时，预读按倍增到最多 2 MiB。每个源最多缓存 16 MiB，短 clip 可以整段留在内存里。`locate()` 走偏移表，复杂度是 clip 数量的 O(N)。
- **声音也是流式的。** 每个 clip 的音频在播放头前一秒解码，播完就丢弃；下一段的开头在切点前三秒开始取。
- **一次停顿把所有东西停在一起。** 音频时钟就是播放时钟，所以网络停顿会挂起它，画面、音乐和每一句已排队的对白一起暂停、一起继续。

## 要求

- **播放和导出需要浏览器：** WebCodecs 和 Web Audio。这些模块可以在 Node 里导入，`@openstory/stitch/react` 在服务端渲染期间导入也是安全的（它只在客户端加载 Video.js）。
- **Clip 和音频服务器必须接受 Range 请求。** 跨源 URL 还需要 CORS、206，以及 `Access-Control-Expose-Headers: Content-Range`。同源 URL 不需要 CORS。当 `fetch` 用 206 回答 `Range` 时，`blob:` URL 可用于视频、音乐和对白，页面就是这样播放它已经持有的字节。静帧的台词可以用 `data:` URL。播放把静帧当作图片加载，不需要 CORS。导出和画中画会读回画布，所以一张没有 CORS 的跨源静帧会污染画布，这两项会抛出 `SecurityError`。
- **编码（仅导出）：** H.264 和 AAC 编码器。Chrome、Edge、Safari 17+ 和较新的 Firefox 都有。

## 许可证

MIT
