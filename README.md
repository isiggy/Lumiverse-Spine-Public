# Spine Avatars for Lumiverse

A [Spindle](https://docs.lumiverse.chat/) extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that shows **Spine animated models** as character avatars. It's the Spine counterpart of [Live2D Avatars for Lumiverse](https://github.com/isiggy/Lumiverse-Live2d-Public) and works the same way: import a model, bind it to a character, and it appears when you open that character's chat.

Plays skeletons exported from **Spine 4.1** (binary `.skel` or `.json`), with their `.atlas` and page images.

## Features

- **Model library**: import Spine model folders as `.zip` archives straight from the browser. Files are stored in the extension's private storage and cached in the browser (Cache Storage) for instant reloads.
- **Per-character bindings**: assign a model to each character; it loads when you open that character's chat.
- **View controls** (per character and model):
  - **Render scale**: the resolution the model is drawn at, relative to the screen. Lower is faster and softer, higher is sharper. It doesn't change the model's size.
  - **Zoom**: the model's size. At 1 the model fits the stage upright.
  - **Rotation**: −180° to 180°, about the model's center.
  - **Playback speed**: 0 (paused) to 3×.
  - **Premultiplied alpha**: how texture colors are blended. Defaults to the atlas's `pma` flag; flip it if edges look dark or haloed.
  - **Fit to canvas**: zooms so the whole model fits the stage at its current rotation, and centers it.
  - **Center model**: moves the model back to the center, keeping its zoom.
  - X / Y offset sliders, or drag the model to move it.
- **Animations**: pick the skin, the looping idle animation, an animation for when the chat opens (with delay), one for clicks (optionally sending a message into the chat, with *Auto-send interaction* to get a reply), and a talking animation layered on top while the character's message is "spoken" (duration scales with message length).
- **Emotion-driven animation**: new character messages are classified into one of the 28 classic emotions (`joy`, `anger`, `surprise`, …) with a quiet LLM generation, and each emotion can be mapped to an animation, which plays once before the idle loop resumes. Emotions are mapped automatically on first load when the model has animations with matching names (`angry`, `sad`, `shy`, `surprise`, …). You can also reuse Lumiverse's own expression detection (`EXPRESSION_CHANGED`) or turn it off.
- **Background mode**: a global toggle that draws the model behind the chat instead of over it. Needs `app_manipulation`. While it's on the chat takes the clicks, so dragging and clicking the model don't work.
- **Debug**: draw bones and the model's reference bounds, and a reload button.
- **Command palette**: `Spine: Open Settings`, `Spine: Reload Models`, `Spine: Toggle Enabled` (Ctrl/Cmd+K).

## Installation

Install from the Lumiverse **Extensions** panel with this repository's GitHub URL, or via the REST API:

```
POST /api/v1/spindle/install  { "url": "https://github.com/isiggy/Lumiverse-Spine-Public" }
```

The repository ships prebuilt bundles in `dist/`, so no build step is needed at install time.

## Permissions

The extension works with whatever you grant and degrades gracefully:

| Permission | Used for | Without it |
|---|---|---|
| `app_manipulation` | rendering the avatar as a full-app overlay | the avatar renders inside the Spine drawer tab preview |
| `generation` | LLM emotion classification | no automatic emotion detection (native/off modes still work) |
| `chat_mutation` | reading messages (emotion + talking) and sending click messages | no talking animation, no click messages |
| `chats` | resolving which character the active chat belongs to | falls back to the frontend's active-chat context |
| `characters` | listing characters by name in the binding UI | bind models to the current chat's character only |

## Usage

1. Open the **Spine** tab in the sidebar drawer (or press Ctrl/Cmd+K and search "Spine").
2. Grant the requested permissions from the banner (or from the Extensions panel).
3. **Import a model**: zip the exported folder (the `.skel` or `.json` skeleton, its `.atlas`, and the atlas page images) and use *Import model (.zip)*. A single top-level folder inside the zip is fine. The model is named after the zip file.
4. **Bind it to a character** under *Character model*.
5. Open that character's chat and the avatar appears. Adjust it under *Model settings*.

## How it works

- **Backend** (`dist/backend.js`, Bun worker): stores settings and model files in extension user storage, unpacks ZIPs with [fflate](https://github.com/101arrowz/fflate), checks the skeleton's Spine version, sends model files to the browser in 1 MB chunks the browser asks for a few at a time, classifies emotions with `spindle.generate.quiet`, and relays chat events.
- **Frontend** (`dist/frontend.js`): draws the skeleton with the official [spine-webgl](https://github.com/EsotericSoftware/spine-runtimes/tree/4.1/spine-ts) 4.1 runtime on a WebGL canvas in an app overlay (`ctx.ui.mountApp`) or the drawer tab. The overlay is a `position: fixed`, `pointer-events: none` canvas, so it never blocks the app; clicks and drags are picked up at the document level and go to the model only when they land on one of its visible parts with nothing drawn above it.

## Development

```bash
bun install
bun run typecheck
bun run build     # writes dist/backend.js + dist/frontend.js
```

To try the extension in a real local Lumiverse instance (Linux), use `scripts/dev/lumiverse.sh`: `setup`, `start`, `deploy`, then `e2e` for a headless check that the avatar renders (`e2e --controls` also drives every model control). `CLAUDE.md` explains each step.

## Third-party runtime

`dist/frontend.js` bundles `@esotericsoftware/spine-webgl` and `@esotericsoftware/spine-core` 4.1, © Esoteric Software, under the [Spine Runtimes License](https://esotericsoftware.com/spine-runtimes-license), whose full text is in `LICENSE-spine-runtimes`. Under that license, integrating the runtimes into software is permitted for holders of a Spine Editor license; read the license for the exact terms before distributing this extension. Spine is a trademark of Esoteric Software. This project is not affiliated with Esoteric Software.

## Known limitations

- Spine 4.1 skeletons only. Other versions are rejected at import with a message naming the version; the binary formats differ between Spine versions.
- One model on stage at a time (the active chat's character).
- Clicks hit-test the model's region and mesh shapes, so fully transparent areas inside a part still count as the model.

## License

MIT (see `LICENSE`). The bundled Spine runtime keeps its own license, as above.
