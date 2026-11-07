# The Canvas player

One page, built by `yarn build:player` into `out/player/` (part of `yarn build:engine`). The engine serves it at `/preview/`; the series
files come from `/files/<series>/...`. The same bundle is embedded in the studio and loaded by the renderer in headless Chromium.

## Page API for code (renderer, tests)

```js
await page.goto('http://127.0.0.1:7465/preview/')          // no query: the page idles, nothing is loaded
await page.waitForFunction(() => window.cts)                 // defined as soon as the module has run
await page.evaluate(async ([tl, base]) => {
  await window.cts.load(tl, base, { width: 1920, height: 1080 })   // all assets decoded when it resolves
}, [timelineJson, 'http://127.0.0.1:7465/files/<series>/'])
const n = await page.evaluate(() => window.cts.frameCount())       // ceil(duration * fps.out)
await page.evaluate((i) => window.cts.renderFrame(i), i)           // draws frame i on window.cts.canvas
const dataUrl = await page.evaluate(() => window.cts.canvas.toDataURL('image/jpeg', 0.95))   // or 'image/png'
```

- `load(timeline, baseUrl, { width, height, clipStills?, variant? })`: `timeline` is the parsed `timeline.<lang>.json` object (validated
  with `timelineSchema`); `baseUrl` is the series folder url and must end with `/` (it is added when missing). It loads
  `sets/<set>/set.json` for each scene and `cast/<id>/rig.json` for each actor under it. It sizes the canvas to `width` x `height`.
  `clipStills` maps a clip id to the url of its first-frame image (relative to `baseUrl` or absolute); it is drawn on the placeholder card.
  `variant` takes `cast/<id>/variants/<variant>/rig.json` instead.
- `renderFrame(i)` draws frame `i` (time `i / fps.out`) and depends only on `(timeline, i)`: no clock, no randomness, no I/O. Inside a
  `clips` range it draws a placeholder card (clip id and length, plus the still): the final render must not use those frames.
- Inside a `titles` range (`[t0, t1)`) it draws a static title card: fixed palette (navy card, yellow rules, cream text), the already translated text centred, wrapped and shrunk to fit, in the system `sans-serif` (no web font, so nothing loads late). Clips win over titles.
- Helpers: `cts.frameCount()`, `cts.frameTime(i)` (seconds), `cts.frameAt(t)` (frame shown at `t`). The pure versions `frameCountFor`,
  `frameTime`, `frameAt` are exported by `src/player/stage.ts`.
- `cts.ready` is a promise that resolves when the url-driven start (preview or sheet mode) has loaded (it is already resolved with no
  query); `cts.error` holds the message when it rejected; `document.body.dataset.ready` is `preview`, `sheet` or `error`.

## Sampling and drawing rules

- Actor poses (x, y, facing, emotion, eyes, mouth, rot, bob) are sampled on the 12 fps grid (`snapToGrid`); the camera at 24 fps.
- x/y are the actor's feet point in set pixels. The camera `center` is in set pixels; camera scale = (frame height / set height) * `zoom`.
- Parts are drawn in global `z` order; a child's pivot sits at its `at` in the parent's pixel coordinates and rotates by the sampled
  `rot[part]` degrees. The face plate (eyes, brows, mouth, each centred on the plate's `at`) is attached to the rig's `face.parent`.
- The drawn facing differs from the sampled facing: the whole actor is mirrored about its root pivot.
- Eyes: a `closed` or `half` key in the eyes track wins; `open` shows the emotion's eye state. An emotion the rig lacks is `neutral`.
- `bob` is an amplitude (0..1) of the rig's `move.bobPx`; the bounce is `|sin(pi * t / move.stepSeconds)|`.
- Set layers are drawn by `z`; actors are at z 50 (behind a layer with z >= 50). A layer without `at` is stretched over the set size. Parallax `k`
  shifts a layer by `(set centre - camera centre) * (k - 1)`.
- SVG parts are rasterised once per needed scale (the biggest camera zoom of the timeline) into `ImageBitmap`s; PNGs are used as they are.

## Preview mode

`/preview/?preview=1&series=<slug>&episode=<id>[&lang=hr|en][&t=<seconds>][&w=960&h=540][&files=<url>]`

Loads `/files/<series>/episodes/<id>/timeline.<lang>.json` (`lang` defaults to `hr`), shows play/pause, a scrub bar, a language switch and the
time, and plays one `<audio>` per timeline audio entry (best effort sync; the MP4 is the reference). Test ids: `cts-canvas`, `cts-controls`,
`cts-play`, `cts-scrub` (range, value = frame), `cts-time`, `cts-lang` (select), `cts-status`, `cts-audio`, `cts-audio-<n>`, `cts-message`.
`files` overrides the files root (default `../files/` relative to the page, i.e. `/files/`), for a page served from elsewhere.

## Pose sheet mode

`/preview/?series=<slug>&sheet=<castId>[&variant=a|c][&files=<url>]`

Draws `cast/<castId>/rig.json` (or `cast/<castId>/variants/<variant>/rig.json`) in a labelled grid, 6 columns of 260 x 340 px: neutral,
every emotion, every gesture at its peak, all 8 mouths and the 3 eye states (the face cells are head close-ups). The canvas is resized to the
sheet (1560 x 1416 for 19 cells). Wait with `await window.cts.ready`, then read `window.cts.canvas`. The same sheet can be drawn from a page that is
already open with `await window.cts.loadSheet(baseUrl, castId, variant?)`.
