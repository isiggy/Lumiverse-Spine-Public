# Lumiverse Spine extension

A Spindle extension for Lumiverse that shows Spine models as character avatars. It's the Spine counterpart of [Lumiverse-Live2d](https://github.com/isiggy/Lumiverse-Live2d-Public) and shares its structure, settings layout and model transfer code; when fixing something here, check whether the Live2D repo needs the same fix. See README.md for features.

## Layout

- `spindle.json`: extension manifest.
- `src/backend.ts`: runs in a Lumiverse-managed Bun process. Settings and model storage, ZIP import (finds the skeleton and atlas, checks the Spine version), streaming model files to the browser, LLM emotion classification.
- `src/frontend.ts`: browser entry. Wires the stage, settings tab and backend messages together.
- `src/frontend/stage.ts`: spine-webgl rendering, layout and model interaction. `ui.ts` is the settings tab, `assets.ts` the model file cache, `tus.ts` the upload client, `thumbnail.ts` turns a stage capture into a library thumbnail.
- `src/shared/`: the settings schema, the frontend/backend message types, and `settings-file.ts`, the export/import file format (shared with the Live2D extension; keep the two copies in step).
- The Character model dropdowns are Lumiverse's own searchable select (`ctx.components.mountSelect`), mounted after each render into placeholders and destroyed on the next; e2e drives them by clicking the trigger and the `[role="option"]` rows.
- `dist/` is committed, because Lumiverse installs straight from the repo. Rebuild before committing source changes.

Each Spine editor version has its own skeleton format, so there's a runtime per supported version, both bundled into `dist/frontend.js`: the npm package `@esotericsoftware/spine-webgl` pinned to 4.1.x, and spine-ts 3.8 vendored as `vendor/spine-webgl-3.8.js` (it isn't on npm). `SUPPORTED_SPINE_VERSIONS` in `src/shared/settings.ts` lists them; the import check uses it, and the stage picks a model's runtime from its `spineVersion`.

`src/frontend/runtimes.ts` types the 3.8 namespace as 4.1's and patches 3.8 where it differs, so the stage's code works with either: atlases are always parsed by 4.1's parser (3.8's can't read a 4.x-style atlas, which 3.8 models often come with) and copied into 3.8's classes, 3.8 pages get `setTexture()`, `RegionAttachment.computeWorldVertices` takes the slot, and 3.8's batcher blends alpha like 4.1's. Each runtime gets its own renderer on the canvas's one WebGL context. When the stage starts using a runtime feature it didn't use before, check that 3.8 has it with the same signature.

## How the stage lays out a model

`Stage.transform()` maps skeleton coordinates (y-up) to host CSS pixels; the render loop folds that into the MVP matrix each frame, and pointer hit-testing uses its inverse. Settings are read every frame, so the UI only has to mutate the settings object.

- Group chats: every chat member with a bound model is drawn on one shared canvas. The stage is split into equal columns, one per member with a model, in member order, and everything below is relative to the model's column instead of the whole stage (a solo chat has one column). The backend reads the members from `chat.metadata.character_ids` (`metadata.group === true`) and sends them as `chat_context` / `chat_members`. Members with a Live2D model get columns too: `src/frontend/columns.ts` shares the columns with the Live2D extension through a registry on `window` (it's the same file in both repos, keep them in step). The Live2D repo's `e2e --group --spine-model …` tests a mixed group chat.
- Reference bounds: the visible parts at frame 0 of the idle animation, measured once per load. Zoom 1 fits these bounds to the column, upright.
- Rotation is about the center of those bounds. X/Y move that center by a percent of half the column's size.
- Render scale only sets the canvas's backing size (`devicePixelRatio × renderScale`, clamped to the GPU's limits); with several models the highest render scale wins.
- Premultiplied alpha: atlas pages are decoded with `premultiplyAlpha: 'none'` so the stored bytes reach the GPU untouched, and the toggle sets `SkeletonRenderer.premultipliedAlpha`. The default comes from the atlas's `pma:` line.

## Build

`node_modules` doesn't survive between cloud sessions, so run `bun install` first.

```bash
bun install && bun run typecheck && bun run build
```

## Testing in a real Lumiverse instance

Use `scripts/dev/lumiverse.sh`; don't set Lumiverse up by hand. In a Claude Code session, put its work directory in the session scratchpad:

```bash
export LUMI_WORK=<scratchpad>/lumi
scripts/dev/lumiverse.sh setup    # ~20s: Bun 1.4, clone Lumiverse, install deps
scripts/dev/lumiverse.sh start    # background server on http://127.0.0.1:7860 (owner / spinetest123)
scripts/dev/lumiverse.sh deploy   # build this repo, install or update the extension, grant permissions, enable
scripts/dev/lumiverse.sh e2e      # headless: create a chat, import and bind spineboy, check it renders
```

`e2e` prints `OK: avatar overlay is on screen` and writes screenshots to `$LUMI_WORK/shots/`. It reads the canvas back, so an overlay that's present but empty fails. After changing code, run `deploy` then `e2e` again.

- `e2e --model path/to/model.zip` tests a specific model instead of spineboy. The extension names an imported model after its zip file, so `e2e` finds it by that name and imports it only if it isn't in the library yet.
- `e2e --group` tests a three-member group chat (`seed-group` creates it): each member's model in its own column, a drag and a talking message reaching only the right model, and the stage re-laying out when a member leaves and comes back. Repeat `--model` to give members different models in turn.
- `e2e --controls` then drives every control in the Model settings tab (fit, zoom, rotation, fit while rotated, center, render scale, playback speed, premultiplied alpha, persistence across a reload), checks each one's effect on the drawn model, and saves a `control-*.png` screenshot for each.
- `e2e --library` then tests the model library (thumbnail, sorting, filter, tiles and list, persistence), search in the model dropdown, and settings file export and import. It imports six copies of the model zip under other names, so the dropdown has enough options to show its search field.
- `e2e --slow` sends the browser's traffic through a 3 MB/s proxy (`scripts/dev/throttle-proxy.mjs`), like a remote user. Use it for anything that touches model downloads.

Other commands: `stop`, `restart`, `status`, `logs [n]`, `seed` (character and chat only), `models` (downloads spineboy, a Spine 4.1 example, to `$LUMI_WORK/models/`; there's no 3.8 test model to download, ask for one). `export` the variable rather than prefixing one command, since every command reads it.

### Pitfalls the script handles (don't rediscover them)

- **Old Bun.** The preinstalled Bun may be older than the 1.4 Lumiverse needs, and `bun.sh` is blocked by the network proxy, so the script downloads Bun from GitHub releases.
- **Extension backend crashes with `TypeError: Unable to deserialize data`.** Lumiverse runs extension backends with `bun` from PATH, and the IPC handshake between Bun versions fails. The script sets `LUMIVERSE_BUN_METHOD=direct` and `LUMIVERSE_BUN_PATH` so they use the same Bun as the server.
- **`EAFNOSUPPORT` on listen.** Lumiverse binds `::` and the container has no IPv6. The script sets `LUMIVERSE_HOST=0.0.0.0`, which newer Lumiverse reads, and patches `src/main.ts` to bind `0.0.0.0` on versions that hard-code `::`.
- **Server exits asking for the setup wizard.** It needs `OWNER_PASSWORD` (and `OWNER_USERNAME`) on first boot to create the owner account.
- **Stopping the server.** Use `lumiverse.sh stop`, which kills the saved PID. `pkill -f "src/index.ts"` also matches the Bash tool's own shell command and kills it.
- **REST quirks.** Log in with `POST /api/auth/sign-in/username` and keep the cookie. `GET /api/v1/spindle/` with a trailing slash returns the web app's HTML.
- **Locally installed extensions** go in `$DATA_DIR/extensions/<identifier>/repo/` and are registered with `POST /api/v1/spindle/import-local`.

### Browser testing notes

- Playwright uses the preinstalled Chromium at `/opt/pw-browsers/chromium`. Pass `--enable-unsafe-swiftshader` or WebGL (and the model) won't render.
- The Spine drawer tab can be scrolled out of the sidebar, so click it from the DOM (see `scripts/dev/e2e.mjs`).
- The drawer tab's root isn't attached to the page until the tab is opened, so don't skip rendering into nodes that aren't connected yet.

## Sending data to the browser

`spindle.sendToFrontend` messages reach the browser through Bun's WebSocket pub/sub, which **silently drops** messages once about 16 MB is queued for a connection. That's why the browser pulls model files a few 1 MB chunks at a time (`src/frontend/assets.ts`, `get_model_manifest` / `get_model_chunk` in `src/backend.ts`) and re-requests chunks that don't arrive. Keep anything large on that pattern rather than pushing it.

## Reference

docs.lumiverse.chat is blocked by the network proxy. The same docs are in the Lumiverse repo under `developer-docs/docs/`, at `$LUMI_WORK/Lumiverse` after `setup`. The Spine 4.1 runtime source is in `node_modules/@esotericsoftware/spine-core` and `spine-webgl` (`dist/*.js` are readable ES modules); the 3.8 one is `vendor/spine-webgl-3.8.js`.

- Messages: Lumiverse documents a `CHARACTER_MESSAGE_RENDERED` event but never emits it. A reply's message is created once it has finished streaming (`MESSAGE_SENT`) and a regenerated reply arrives as `MESSAGE_SWIPED` with `action: 'added'`. In a group chat the message's `extra.character_id` names the member who wrote it (`extra.greeting_character_id` for greetings).
