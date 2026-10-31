// Headless check that the avatar renders in a real Lumiverse instance.
// Run through `scripts/dev/lumiverse.sh e2e`, which supplies the env vars.
//
// Logs in, opens the seeded chat, imports $LUMI_MODEL_ZIP through the Spine
// tab unless a model of that name is already in the library, binds it to the
// chat's character, then reloads the chat and checks the overlay canvas is
// full-size and has the model drawn on it. Each run uses a fresh browser
// profile, so the model's files are always downloaded from the backend again.
// Screenshots go to $LUMI_OUT. Exits non-zero if a check fails.
//
//   lumiverse.sh e2e              # the check above
//   lumiverse.sh e2e --keep-open  # also leave a screenshot with the Spine tab open
//   lumiverse.sh e2e --controls   # also drive every model control, screenshot each and check its effect
//   lumiverse.sh e2e --group      # a three-member group chat: every member's model is drawn in its
//                                 # own column, drags and talking reach the right model, and
//                                 # removing a member re-lays the stage out
//   lumiverse.sh e2e --library    # also test the model library (thumbnails, sorting, filter, tiles
//                                 # and list), dropdown search, and settings file export/import
//   (--model and --slow are handled by lumiverse.sh)

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(process.env.PW_DIR + '/')('playwright');
const BASE = process.env.LUMI_BASE;
const CHAT = `${BASE}/chat/${process.env.LUMI_CHAT_ID}`;
const OUT = process.env.LUMI_OUT;
const keepOpen = process.argv.includes('--keep-open');
const controls = process.argv.includes('--controls');
const group = process.argv.includes('--group');
const testLibrary = process.argv.includes('--library');
const MODEL_ZIPS = (process.env.LUMI_MODEL_ZIPS || process.env.LUMI_MODEL_ZIP).split('\n').filter(Boolean);
const GROUP_CHAT = `${BASE}/chat/${process.env.LUMI_GROUP_CHAT_ID}`;
const GROUP_MEMBERS = (process.env.LUMI_GROUP_MEMBERS || '').split('\n').filter(Boolean);
// The extension names an imported model after its zip file.
const MODEL_NAME = path.basename(process.env.LUMI_MODEL_ZIP).replace(/\.zip$/i, '');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader'], // WebGL without a GPU
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const problems = [];
const failures = [];
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('console', (msg) => {
  if (msg.text().includes('[spine]')) problems.push(`extension: ${msg.text()}`);
});

function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`);
  if (!ok) failures.push(message);
}

async function openSpineTab() {
  if (await page.$('.spn-root')) {
    if (await page.evaluate(() => document.querySelector('.spn-root')?.getBoundingClientRect().width > 0)) return;
  }
  // The drawer tab can be scrolled out of the sidebar, so click it from the DOM.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('span,button,div')].find(
      (node) => node.textContent === 'Spine' && node.children.length === 0,
    );
    (label?.closest('button') ?? label)?.click();
  });
  await page.waitForSelector('.spn-root', { timeout: 30000 });
}

/**
 * Snapshot of the stage: canvas size and how many pixels have the model drawn
 * on them, read back by copying the WebGL canvas into a 2D canvas right after
 * the browser presents a frame.
 */
async function stageInfo() {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          const canvas = document.querySelector('.spine-avatars-canvas');
          if (!canvas) return resolve(null);
          const rect = canvas.getBoundingClientRect();
          const probe = document.createElement('canvas');
          const scale = 0.25;
          probe.width = Math.max(1, Math.round(rect.width * scale));
          probe.height = Math.max(1, Math.round(rect.height * scale));
          const context = probe.getContext('2d');
          context.drawImage(canvas, 0, 0, probe.width, probe.height);
          const { data } = context.getImageData(0, 0, probe.width, probe.height);
          let drawn = 0;
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (let y = 0; y < probe.height; y++) {
            for (let x = 0; x < probe.width; x++) {
              if (data[(y * probe.width + x) * 4 + 3] > 16) {
                drawn++;
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
              }
            }
          }
          resolve({
            overlay: !!canvas.closest('[data-lumiverse-avatar-layer]'),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            pixelWidth: canvas.width,
            pixelHeight: canvas.height,
            drawnFraction: drawn / (probe.width * probe.height),
            // Bounding box of the drawn model in CSS pixels
            box: drawn
              ? {
                  x: Math.round(minX / scale),
                  y: Math.round(minY / scale),
                  width: Math.round((maxX - minX + 1) / scale),
                  height: Math.round((maxY - minY + 1) / scale),
                }
              : null,
          });
        });
      }),
  );
}

async function setSlider(label, value) {
  const found = await page.evaluate(
    ({ label, value }) => {
      const input = document.querySelector(`.spn-root input[type=range][aria-label="${label}"]`);
      if (!input) return false;
      // Keep the slider in view so screenshots show its value next to the model.
      input.scrollIntoView({ block: 'center' });
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    { label, value },
  );
  if (!found) throw new Error(`No slider labelled "${label}"`);
  await page.waitForTimeout(400);
}

async function sliderValue(label) {
  return page.evaluate(
    (label) => Number(document.querySelector(`.spn-root input[type=range][aria-label="${label}"]`)?.value),
    label,
  );
}

async function clickButton(text) {
  await page.evaluate((text) => {
    const target = [...document.querySelectorAll('.spn-root button')].find((node) => node.textContent === text);
    if (!target) throw new Error(`No button "${text}"`);
    target.click();
  }, text);
  await page.waitForTimeout(400);
}

async function setCheckbox(text, checked) {
  await page.evaluate(
    ({ text, checked }) => {
      const label = [...document.querySelectorAll('.spn-root label.spn-check')].find(
        (node) => node.textContent === text,
      );
      const input = label?.querySelector('input');
      if (!input) throw new Error(`No checkbox "${text}"`);
      input.scrollIntoView({ block: 'center' });
      if (input.checked !== checked) input.click();
    },
    { text, checked },
  );
  await page.waitForTimeout(400);
}

/** Screenshot of the area the model is drawn in (plus a margin), or the whole page. */
async function shot(name, info, margin = 40) {
  const file = `${OUT}/${name}.png`;
  if (info?.box) {
    const x = Math.max(0, info.box.x - margin);
    const y = Math.max(0, info.box.y - margin);
    await page.screenshot({
      path: file,
      clip: {
        x,
        y,
        width: Math.min(1440 - x, info.box.width + margin * 2),
        height: Math.min(900 - y, info.box.height + margin * 2),
      },
    });
  } else {
    await page.screenshot({ path: file });
  }
  return file;
}

async function waitForModelSettings() {
  await openSpineTab();
  await page.waitForSelector('.spn-root input[aria-label="Render scale"]', { timeout: 180000 });
}

/** Pixels that differ between two screenshots of the same clip. */
async function framesDiffer(clip, gapMs) {
  const first = await page.screenshot({ clip });
  await page.waitForTimeout(gapMs);
  const second = await page.screenshot({ clip });
  return !first.equals(second);
}

async function runControls() {
  console.log('── Controls ──');
  await waitForModelSettings();
  await page.screenshot({ path: `${OUT}/controls-tab.png` });

  // The drawer covers part of the stage, so measure with it open but judge the
  // model by its drawn area on the canvas, which the drawer doesn't affect.
  await clickButton('Fit to canvas');
  let info = await stageInfo();
  const fitted = info;
  check(
    info.box && info.box.height >= info.height * 0.9 && info.box.height <= info.height * 1.01,
    `fit to canvas: model is ${info.box?.height}px tall on a ${info.height}px stage`,
  );
  await page.screenshot({ path: `${OUT}/control-fit.png` });

  // Zoom
  await setSlider('Zoom', 0.5);
  info = await stageInfo();
  check(
    Math.abs(info.box.height / fitted.box.height - 0.5) < 0.06,
    `zoom 0.5: height ${fitted.box.height}px -> ${info.box.height}px`,
  );
  await page.screenshot({ path: `${OUT}/control-zoom-0.5.png` });
  await setSlider('Zoom', 1.4);
  info = await stageInfo();
  // Taller than the stage now, so compare widths.
  check(
    Math.abs(info.box.width / fitted.box.width - 1.4) < 0.08,
    `zoom 1.4: width ${fitted.box.width}px -> ${info.box.width}px`,
  );
  await page.screenshot({ path: `${OUT}/control-zoom-1.4.png` });
  await setSlider('Zoom', 0.6);

  // Rotation
  const upright = await stageInfo();
  await setSlider('Rotation', 90);
  info = await stageInfo();
  check(
    info.box.width > upright.box.width * 1.2 && info.box.height < upright.box.height * 0.8,
    `rotation 90°: box ${upright.box.width}x${upright.box.height} -> ${info.box.width}x${info.box.height}`,
  );
  await page.screenshot({ path: `${OUT}/control-rotation-90.png` });
  await setSlider('Rotation', -30);
  await page.screenshot({ path: `${OUT}/control-rotation-minus30.png` });

  // Fit to canvas keeps the rotation and fits the rotated model
  await setSlider('Rotation', 90);
  await clickButton('Fit to canvas');
  info = await stageInfo();
  const zoomAt90 = await sliderValue('Zoom');
  const fills = Math.max(info.box.width / info.width, info.box.height / info.height);
  check(
    info.box.width <= info.width * 1.01 && info.box.height <= info.height * 1.01 && fills > 0.95,
    `fit at 90°: zoom ${zoomAt90}, model ${info.box.width}x${info.box.height} fills ${info.width}x${info.height}`,
  );
  await page.screenshot({ path: `${OUT}/control-fit-rotated.png` });
  await setSlider('Rotation', 0);
  await clickButton('Fit to canvas');

  // Center model
  await setSlider('X offset', -50);
  await setSlider('Y offset', 30);
  const moved = await stageInfo();
  await page.screenshot({ path: `${OUT}/control-moved.png` });
  await clickButton('Center model');
  info = await stageInfo();
  const centerX = info.box.x + info.box.width / 2;
  check(
    (await sliderValue('X offset')) === 0 &&
      (await sliderValue('Y offset')) === 0 &&
      Math.abs(centerX - info.width / 2) < info.width * 0.05 &&
      moved.box.x + moved.box.width / 2 < info.width * 0.35,
    `center model: center x ${Math.round(moved.box.x + moved.box.width / 2)} -> ${Math.round(centerX)} (stage ${info.width})`,
  );
  await page.screenshot({ path: `${OUT}/control-centered.png` });

  // Render scale: the canvas's backing resolution follows the slider; the model's size doesn't.
  await setSlider('Zoom', 0.9);
  const before = await stageInfo();
  await setSlider('Render scale', 0.25);
  info = await stageInfo();
  check(
    Math.abs(info.pixelWidth - info.width * 0.25) <= 2 && Math.abs(info.box.height - before.box.height) < 8,
    `render scale 0.25: canvas ${before.pixelWidth}x${before.pixelHeight} -> ${info.pixelWidth}x${info.pixelHeight}, model height unchanged (${before.box.height} -> ${info.box.height})`,
  );
  const face = { x: info.box.x + info.box.width * 0.25, y: info.box.y, width: info.box.width * 0.5, height: info.box.width * 0.5 };
  await page.screenshot({ path: `${OUT}/control-render-scale-0.25.png`, clip: face });
  await setSlider('Render scale', 2);
  info = await stageInfo();
  check(Math.abs(info.pixelWidth - info.width * 2) <= 2, `render scale 2: canvas ${info.pixelWidth}x${info.pixelHeight}`);
  await page.screenshot({ path: `${OUT}/control-render-scale-2.png`, clip: face });
  await setSlider('Render scale', 1);
  await page.screenshot({ path: `${OUT}/control-render-scale-1.png`, clip: face });

  // Playback speed: frozen at 0, moving otherwise.
  const clip = { x: info.box.x, y: info.box.y, width: info.box.width, height: info.box.height };
  await setSlider('Playback speed', 0);
  const pausedMoves = await framesDiffer(clip, 800);
  await setSlider('Playback speed', 1);
  const normalMoves = await framesDiffer(clip, 800);
  check(!pausedMoves && normalMoves, `playback speed: frozen at 0 (${!pausedMoves}), animating at 1 (${normalMoves})`);
  await setSlider('Playback speed', 2.5);
  await page.screenshot({ path: `${OUT}/control-speed-2.5.png` });
  await setSlider('Playback speed', 1);

  // Premultiplied alpha: rendering changes when the toggle flips.
  await setSlider('Playback speed', 0);
  const pmaOn = await page.screenshot({ path: `${OUT}/control-pma-on.png`, clip: face });
  await setCheckbox('Premultiplied alpha', false);
  const pmaOff = await page.screenshot({ path: `${OUT}/control-pma-off.png`, clip: face });
  check(!pmaOn.equals(pmaOff), 'premultiplied alpha toggle changes the rendering');
  await setCheckbox('Premultiplied alpha', true);
  await setSlider('Playback speed', 1);

  // Dragging the model moves it and updates the X/Y sliders.
  await clickButton('Center model');
  info = await stageInfo();
  const grabX = info.box.x + info.box.width / 2;
  const grabY = info.box.y + info.box.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - 100, grabY, { steps: 5 });
  await page.mouse.move(grabX - 200, grabY + 50, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const draggedX = await sliderValue('X offset');
  const expectedX = (-200 / (info.width / 2)) * 100;
  check(Math.abs(draggedX - expectedX) < 2, `drag 200px left: X offset ${draggedX}% (expected about ${expectedX.toFixed(1)}%)`);
  await page.screenshot({ path: `${OUT}/control-dragged.png` });
  await clickButton('Center model');

  // Emotions auto-mapped from animation names, and the preview plays one.
  const mapped = await page.evaluate(() =>
    [...document.querySelectorAll('.spn-root select[aria-label^="Animation for "]')]
      .filter((node) => node.value !== 'none')
      .map((node) => `${node.getAttribute('aria-label').replace('Animation for ', '')}→${node.value}`),
  );
  console.log(`Auto-mapped emotions: ${mapped.join(', ') || 'none'}`);
  if (mapped.length > 0) {
    const [emotion] = mapped[0].split('→');
    await page.evaluate((emotion) => {
      const section = [...document.querySelectorAll('.spn-section')].find(
        (node) => node.querySelector('.spn-section-title')?.textContent === 'Emotion mappings',
      );
      section.open = true;
      section.querySelector(`button[aria-label="Play ${emotion} animation"]`).click();
    }, emotion);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/control-emotion-preview.png` });
  }

  // Settings persist across a reload.
  await setSlider('Rotation', 15);
  await setSlider('Zoom', 0.8);
  await page.waitForTimeout(1500);
  await page.goto(CHAT);
  await page.waitForSelector('.spine-avatars-canvas', { timeout: 180000 });
  await waitForModelSettings();
  check(
    (await sliderValue('Rotation')) === 15 && (await sliderValue('Zoom')) === 0.8,
    'rotation and zoom persist across a page reload',
  );
  await page.screenshot({ path: `${OUT}/control-after-reload.png` });
  await setSlider('Rotation', 0);
  await clickButton('Fit to canvas');
  await page.waitForTimeout(1000);
}


// ── Group chat ──────────────────────────────────────────────────────────────

const modelName = (zip) => path.basename(zip).replace(/\.zip$/i, '');

async function importModel(zip) {
  const name = modelName(zip);
  const inLibrary = (name) =>
    [...document.querySelectorAll('.spn-model-name, .spn-tile-name')].some((node) => node.textContent === name);
  if (await page.evaluate(inLibrary, name)) return;
  console.log(`Importing ${name}…`);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.click('button:has-text("Import model")'),
  ]);
  await chooser.setFiles(zip);
  await page.waitForFunction(inLibrary, name, { timeout: 300000 });
}

/** The Character model section's dropdowns (Lumiverse's own): [character, model]. */
function bindingPickers() {
  return page.locator('.spn-section:has(> .spn-section-title:text-is("Character model")) .spn-picker');
}

/** An option's label: its first line that isn't a one-letter initial. */
function optionLabel(text) {
  return text.split('\n').map((line) => line.trim()).find((line) => line.length > 1) ?? '';
}

/** Open a dropdown and list its options' labels. */
async function pickerOptions(picker) {
  await picker.locator('button').first().click();
  await page.waitForSelector('[role="listbox"]');
  const labels = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts()).map(optionLabel);
  await page.keyboard.press('Escape');
  return labels;
}

/** Choose the option whose label is one of `labels`, searching first when the dropdown has a search field. */
async function pick(picker, labels, searchLabel) {
  await picker.locator('button').first().click();
  await page.waitForSelector('[role="listbox"]');
  const search = page.locator(`input[aria-label="${searchLabel}"]`);
  if (await search.isVisible().catch(() => false)) await search.fill(labels[0]);
  const options = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts()).map(optionLabel);
  const index = options.findIndex((option) => labels.includes(option));
  if (index === -1) {
    await page.keyboard.press('Escape');
    throw new Error(`${labels[0]} missing from the dropdown (${options.join(', ')})`);
  }
  await page.locator('[role="listbox"] [role="option"]').nth(index).click();
}

/** Pick a character in the Character model section; returns its option label. */
async function selectCharacter(characterId) {
  const name = await page.evaluate(
    (id) => fetch(`/api/v1/characters/${id}`).then((response) => response.json()).then((c) => c.name),
    characterId,
  );
  const labels = [name, `${name} (in this chat)`];
  const picker = bindingPickers().nth(0);
  const current = optionLabel(await picker.innerText());
  if (!labels.includes(current)) await pick(picker, labels, 'Search characters…');
  await page.waitForTimeout(300);
  return optionLabel(await bindingPickers().nth(0).innerText());
}

async function bindModel(name) {
  const picker = bindingPickers().nth(1);
  if (optionLabel(await picker.innerText()) !== name) await pick(picker, [name], 'Search models…');
  await page.waitForTimeout(500);
}

/** Names of the models in the library, in the order shown (tiles or list). */
function libraryNames() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.spn-tile-name, .spn-model-name')].map((node) => node.textContent),
  );
}

async function setLibrarySort(label) {
  await page.locator('.spn-root select[aria-label="Sort models"]').selectOption({ label });
}

/** Import a settings file through the Character model section; returns the confirm dialog's text, if one opened. */
async function importSettingsFile(filePath) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.click('button:has-text("Import settings")'),
  ]);
  await chooser.setFiles(filePath);
  // Lumiverse's confirm modal: the title, then the message, then the buttons.
  const title = page.locator('h3:has-text("Import model settings")');
  const opened = await title.waitFor({ timeout: 5000 }).then(() => true, () => false);
  if (!opened) return null;
  const text = await title.locator('xpath=..').innerText();
  await page.locator('button:text-is("Import")').click();
  await page.waitForTimeout(1500);
  return text;
}

function fileStatus() {
  return page.evaluate(() => {
    const exportButton = [...document.querySelectorAll('.spn-root button')].find((b) => b.textContent === 'Export settings');
    return exportButton?.parentElement?.querySelector('[role="status"]')?.textContent ?? '';
  });
}

async function runLibrary() {
  console.log('── Library, dropdown search and settings files ──');
  await openSpineTab();
  const hasThumbnail = await page
    .waitForFunction(
      (name) =>
        [...document.querySelectorAll('.spn-tile')].some(
          (tile) =>
            tile.querySelector('.spn-tile-name')?.textContent === name &&
            tile.querySelector('img')?.src.startsWith('data:image/'),
        ),
      MODEL_NAME,
      { timeout: 15000 },
    )
    .then(() => true, () => false);
  check(hasThumbnail, `${MODEL_NAME} has a thumbnail in the tile view`);

  // Enough models for the dropdown to offer a search field.
  const extra = ['Aurora', 'Beryl', 'Cobalt', 'Dahlia', 'Ember', 'Fern'];
  const copies = path.join(OUT, 'library-copies');
  fs.mkdirSync(copies, { recursive: true });
  for (const name of extra) {
    const zip = path.join(copies, `${name}.zip`);
    fs.copyFileSync(process.env.LUMI_MODEL_ZIP, zip);
    await importModel(zip);
  }
  const librarySection = page.locator('.spn-section:has(> .spn-section-title:text-is("Model library"))');
  await librarySection.screenshot({ path: `${OUT}/library-tiles.png` });

  await setLibrarySort('Name (Z–A)');
  let names = await libraryNames();
  check(names[0] === [...names].sort((a, b) => b.localeCompare(a))[0], `Name (Z–A) puts ${names[0]} first`);
  await setLibrarySort('Oldest first');
  const oldest = await libraryNames();
  await setLibrarySort('Newest first');
  names = await libraryNames();
  check(
    names.join() === [...oldest].reverse().join() && names.indexOf('Fern') < names.indexOf('Aurora'),
    `Newest first is Oldest first reversed, Fern before Aurora (${names.join(', ')})`,
  );
  await setLibrarySort('Name (A–Z)');
  names = await libraryNames();
  check(names[0] === 'Aurora', `Name (A–Z) puts ${names[0]} first`);

  await page.fill('.spn-library-filter', 'er');
  names = await libraryNames();
  check(names.join() === 'Beryl,Ember,Fern', `filter "er" shows ${names.join(', ')}`);
  await librarySection.screenshot({ path: `${OUT}/library-filter.png` });
  await page.fill('.spn-library-filter', '');

  const tileCount = await page.locator('.spn-tile').count();
  await page.click('.spn-segmented button:text-is("List")');
  const listRows = await page.locator('.spn-list-thumb').count();
  check(
    listRows === tileCount && (await page.locator('.spn-tile').count()) === 0,
    `list view shows ${listRows} rows for ${tileCount} tiles`,
  );
  await librarySection.screenshot({ path: `${OUT}/library-list.png` });
  await page.click('.spn-segmented button:text-is("Tiles")');

  // Search in the model dropdown.
  const modelPicker = bindingPickers().nth(1);
  await modelPicker.scrollIntoViewIfNeeded();
  await modelPicker.locator('button').first().click();
  const search = page.locator('input[aria-label="Search models…"]');
  check(await search.isVisible().catch(() => false), 'model dropdown has a search field');
  await search.fill('cob');
  const options = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts())
    .map(optionLabel)
    .filter((label) => label !== 'No model');
  check(options.join() === 'Cobalt', `searching "cob" leaves ${options.join(', ')}`);
  await page.screenshot({ path: `${OUT}/model-search.png` });
  await page.keyboard.press('Escape');

  // Export this character's settings, change them, and import the file back.
  await waitForModelSettings();
  await setSlider('Zoom', 0.8);
  await setSlider('Rotation', 15);
  await page.waitForTimeout(800);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('button:has-text("Export settings")'),
  ]);
  const exported = path.join(OUT, download.suggestedFilename());
  await download.saveAs(exported);
  const file = JSON.parse(fs.readFileSync(exported, 'utf8'));
  check(
    file.format === 'lumiverse-avatar-model-settings' &&
      file.extension === 'spine' &&
      file.model.name === MODEL_NAME &&
      file.settings.zoom === 0.8 &&
      file.settings.rotation === 15,
    `exported ${download.suggestedFilename()} (zoom ${file.settings?.zoom}, rotation ${file.settings?.rotation})`,
  );

  await setSlider('Zoom', 1.3);
  await setSlider('Rotation', 0);
  const dialog = await importSettingsFile(exported);
  check(dialog?.includes(MODEL_NAME), 'import asks before replacing the settings');
  await waitForModelSettings();
  check((await sliderValue('Zoom')) === 0.8 && (await sliderValue('Rotation')) === 15, 'import restored zoom 0.8 and rotation 15');
  check((await fileStatus()).startsWith('Imported'), `status: ${await fileStatus()}`);

  // A file for a model that isn't in the library applies to the bound model after a warning.
  const missing = path.join(OUT, 'missing-model.spine-settings.json');
  fs.writeFileSync(
    missing,
    JSON.stringify({ ...file, model: { id: 'not_here', name: 'Not Here' }, settings: { ...file.settings, zoom: 0.5, speed: 'fast' } }),
  );
  const warning = await importSettingsFile(missing);
  check(warning?.includes("isn't in your library"), 'a file for a missing model warns before applying');
  await waitForModelSettings();
  check((await sliderValue('Zoom')) === 0.5 && (await sliderValue('Playback speed')) === 1, 'it applied zoom 0.5 and ignored the bad speed value');
  await page.screenshot({ path: `${OUT}/import-applied.png` });

  // A Live2D settings file is refused with a message.
  const live2d = path.join(OUT, 'live2d.json');
  fs.writeFileSync(live2d, JSON.stringify({ ...file, extension: 'live2d' }));
  check((await importSettingsFile(live2d)) === null, 'a Live2D file opens no dialog');
  await page.waitForTimeout(500);
  check((await fileStatus()).includes('Live2D Avatars extension'), `status: ${await fileStatus()}`);

  // Sort and view persist.
  await setLibrarySort('Largest first');
  await page.click('.spn-segmented button:text-is("List")');
  await page.waitForTimeout(1000);
  await page.goto(CHAT);
  await page.waitForTimeout(5000);
  await openSpineTab();
  const kept = await page.evaluate(() => ({
    sort: document.querySelector('.spn-root select[aria-label="Sort models"]')?.value,
    list: document.querySelectorAll('.spn-list-thumb').length,
  }));
  check(kept.sort === 'largest' && kept.list > 0, `sort and view kept after a reload (${JSON.stringify(kept)})`);
  await page.click('.spn-segmented button:text-is("Tiles")');
  await setLibrarySort('Name (A–Z)');
  await waitForModelSettings();
  await clickButton('Fit to canvas');
  await setSlider('Rotation', 0);
  await clickButton('Fit to canvas');
  await page.waitForTimeout(1000);
}

async function selectByLabel(label, value) {
  await page.evaluate(
    ({ label, value }) => {
      const select = document.querySelector(`.spn-root select[aria-label="${label}"]`);
      if (!select) throw new Error(`No select labelled "${label}"`);
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { label, value },
  );
  await page.waitForTimeout(300);
}

/**
 * Per column of the stage: the share of its pixels drawn, the drawn box, and
 * how much of it changes between frames (motion), sampled a few times.
 */
async function columnInfo(columns, samples = 4) {
  return page.evaluate(
    ({ columns, samples }) =>
      new Promise((resolve) => {
        const canvas = document.querySelector('.spine-avatars-canvas');
        if (!canvas) return resolve(null);
        const rect = canvas.getBoundingClientRect();
        const scale = 0.25;
        const probe = document.createElement('canvas');
        probe.width = Math.max(1, Math.round(rect.width * scale));
        probe.height = Math.max(1, Math.round(rect.height * scale));
        const context = probe.getContext('2d', { willReadFrequently: true });
        const grab = () => {
          context.clearRect(0, 0, probe.width, probe.height);
          context.drawImage(canvas, 0, 0, probe.width, probe.height);
          return context.getImageData(0, 0, probe.width, probe.height).data;
        };
        const frames = [];
        const next = () =>
          requestAnimationFrame(() => {
            frames.push(grab());
            if (frames.length <= samples) setTimeout(next, 150);
            else finish();
          });
        const finish = () => {
          const columnWidth = probe.width / columns;
          const result = [];
          for (let column = 0; column < columns; column++) {
            const x0 = Math.round(column * columnWidth);
            const x1 = Math.round((column + 1) * columnWidth);
            let drawn = 0;
            let changed = 0;
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let y = 0; y < probe.height; y++) {
              for (let x = x0; x < x1; x++) {
                const i = (y * probe.width + x) * 4;
                if (frames[0][i + 3] > 16) {
                  drawn++;
                  minX = Math.min(minX, x);
                  maxX = Math.max(maxX, x);
                  minY = Math.min(minY, y);
                  maxY = Math.max(maxY, y);
                }
                for (let f = 1; f < frames.length; f++) {
                  const a = frames[f - 1];
                  const b = frames[f];
                  if (Math.abs(a[i + 3] - b[i + 3]) > 24 || Math.abs(a[i] - b[i]) > 24) changed++;
                }
              }
            }
            const area = (x1 - x0) * probe.height;
            result.push({
              drawnFraction: drawn / area,
              motion: changed / area / (frames.length - 1),
              box: drawn
                ? {
                    x: Math.round(minX / scale),
                    y: Math.round(minY / scale),
                    width: Math.round((maxX - minX + 1) / scale),
                    height: Math.round((maxY - minY + 1) / scale),
                  }
                : null,
            });
          }
          resolve({ width: Math.round(rect.width), height: Math.round(rect.height), columns: result });
        };
        next();
      }),
    { columns, samples },
  );
}

async function postCharacterMessage(chatId, characterId, content) {
  return page.evaluate(
    async ({ chatId, characterId, content }) => {
      const response = await fetch(`/api/v1/chats/${chatId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Spine Test', content, is_user: false, extra: { character_id: characterId } }),
      });
      return response.status;
    },
    { chatId, characterId, content },
  );
}

async function runGroup() {
  console.log('── Group chat ──');
  const members = GROUP_MEMBERS;
  if (members.length < 2) throw new Error('No group chat members; run lumiverse.sh seed-group');
  await page.goto(GROUP_CHAT);
  await page.waitForTimeout(5000);
  await openSpineTab();
  for (const zip of MODEL_ZIPS) await importModel(zip);

  // Member i gets model i (wrapping around), so with one zip every member shares it.
  const names = MODEL_ZIPS.map(modelName);
  for (const [index, characterId] of members.entries()) {
    const label = await selectCharacter(characterId);
    await bindModel(names[index % names.length]);
    console.log(`bound ${names[index % names.length]} to ${label}`);
  }
  const labels = await pickerOptions(bindingPickers().nth(0));
  check(
    labels.slice(0, members.length).every((label) => label.endsWith('(in this chat)')),
    `group members listed first in the character picker: ${labels.slice(0, members.length).join(', ')}`,
  );
  // Fit every model to its column, upright and centered.
  for (const characterId of members) {
    await selectCharacter(characterId);
    await waitForModelSettings();
    await setSlider('Rotation', 0);
    await clickButton('Fit to canvas');
  }
  await page.waitForTimeout(1500);

  await page.goto(GROUP_CHAT);
  const appeared = await page
    .waitForSelector('.spine-avatars-canvas', { timeout: 180000 })
    .then(() => true, () => false);
  check(appeared, 'group chat shows the stage');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/group-chat.png` });

  let info = await columnInfo(members.length);
  console.log('Columns:', JSON.stringify(info.columns.map((c) => ({ drawn: +c.drawnFraction.toFixed(3), box: c.box }))));
  const columnWidth = info.width / members.length;
  info.columns.forEach((column, index) => {
    const centerX = column.box ? column.box.x + column.box.width / 2 : NaN;
    const inColumn = centerX > index * columnWidth && centerX < (index + 1) * columnWidth;
    check(
      column.drawnFraction > 0.01 && inColumn,
      `member ${index + 1}'s model is drawn in column ${index + 1} (${(column.drawnFraction * 100).toFixed(1)}% drawn, center x ${Math.round(centerX)})`,
    );
  });

  // Dragging the first member's model moves only it, by a share of its column.
  await openSpineTab();
  await selectCharacter(members[0]);
  await waitForModelSettings();
  // Shrink it so it stays inside its column (which is all columnInfo measures) after the drag.
  await setSlider('Zoom', 0.6);
  info = await columnInfo(members.length);
  const first = info.columns[0].box;
  const second = info.columns[1].box;
  // The middle of the box can fall between limbs; a third of the way down is the head.
  const grabX = first.x + first.width / 2;
  const grabY = first.y + first.height * 0.3;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 40, grabY, { steps: 5 });
  await page.mouse.move(grabX + 80, grabY + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const afterDrag = await columnInfo(members.length);
  const moved = afterDrag.columns[0].box;
  const others = afterDrag.columns[1].box;
  const shift = moved.x + moved.width / 2 - (first.x + first.width / 2);
  const otherShift = Math.max(Math.abs(others.x - second.x), Math.abs(others.y - second.y));
  check(
    Math.abs(shift - 80) < 12 && otherShift < 16,
    `drag moves member 1's model 80px (${shift}px) and leaves member 2's (${otherShift}px, idle sway)`,
  );
  await page.screenshot({ path: `${OUT}/group-dragged.png` });
  await openSpineTab();
  await selectCharacter(members[0]);
  await waitForModelSettings();
  const draggedX = await sliderValue('X offset');
  const expectedX = (80 / (columnWidth / 2)) * 100;
  check(
    Math.abs(draggedX - expectedX) < 2,
    `member 1's X offset is relative to its column: ${draggedX}% (expected about ${expectedX.toFixed(1)}%)`,
  );
  await clickButton('Fit to canvas');

  // A message from the last member makes only that member's model talk. Give it
  // a talk animation that moves a lot, and the other members none.
  const talker = members.length - 1;
  let talkAnimation = null;
  for (const [index, characterId] of members.entries()) {
    await selectCharacter(characterId);
    await waitForModelSettings();
    if (index !== talker) {
      await selectByLabel('While talking', 'none');
      continue;
    }
    talkAnimation = await page.evaluate(() => {
      const select = document.querySelector('.spn-root select[aria-label="While talking"]');
      const idle = document.querySelector('.spn-root select[aria-label="Idle (loops)"]')?.value;
      const values = [...select.options].map((o) => o.value).filter((v) => v !== 'none' && v !== idle);
      return values.find((v) => /run|walk|jump|talk/i.test(v)) ?? values[0] ?? null;
    });
    await selectByLabel('While talking', talkAnimation);
    await setSlider('Talk time per character (ms)', 100);
  }
  await page.waitForTimeout(1500);
  const quiet = await columnInfo(members.length, 6);
  const status = await postCharacterMessage(
    process.env.LUMI_GROUP_CHAT_ID,
    members[talker],
    'This is a fairly long line of dialogue so that the talking animation keeps playing for a few seconds.',
  );
  await page.waitForTimeout(1200);
  const talking = await columnInfo(members.length, 6);
  await page.screenshot({ path: `${OUT}/group-talking.png` });
  const motion = (info) => info.columns.map((c) => +c.motion.toFixed(4));
  console.log(`Motion before ${JSON.stringify(motion(quiet))}, while member ${talker + 1} talks ${JSON.stringify(motion(talking))} (talk animation: ${talkAnimation})`);
  check(status === 201, `posted a message from member ${talker + 1} (HTTP ${status})`);
  check(
    talking.columns[talker].motion > quiet.columns[talker].motion * 1.5 + 0.002,
    `member ${talker + 1}'s model talks after its message`,
  );
  check(
    talking.columns.every((c, i) => i === talker || c.motion < quiet.columns[i].motion * 1.5 + 0.002),
    'the other members keep idling',
  );

  // Removing a member re-lays out the stage without a reload.
  const removed = members[members.length - 1];
  const removeStatus = await page.evaluate(
    async ({ chatId, characterId }) =>
      (await fetch(`/api/v1/chats/${chatId}/members/${characterId}`, { method: 'DELETE' })).status,
    { chatId: process.env.LUMI_GROUP_CHAT_ID, characterId: removed },
  );
  await page.waitForTimeout(4000);
  const two = await columnInfo(members.length - 1);
  await page.screenshot({ path: `${OUT}/group-member-removed.png` });
  console.log('After removal:', JSON.stringify(two.columns.map((c) => ({ drawn: +c.drawnFraction.toFixed(3), box: c.box }))));
  const twoWidth = two.width / (members.length - 1);
  check(
    removeStatus < 300 &&
      two.columns.every((c, i) => c.box && c.box.x + c.box.width / 2 > i * twoWidth && c.box.x + c.box.width / 2 < (i + 1) * twoWidth),
    `after removing member ${members.length} (HTTP ${removeStatus}), the rest share the stage in ${members.length - 1} columns`,
  );
  // Put the member back for the next run.
  await page.evaluate(
    async ({ chatId, characterId }) =>
      fetch(`/api/v1/chats/${chatId}/members/${characterId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_greeting: true }),
      }),
    { chatId: process.env.LUMI_GROUP_CHAT_ID, characterId: removed },
  );
  await page.waitForTimeout(3000);
  const three = await columnInfo(members.length);
  check(
    three.columns.every((c) => c.drawnFraction > 0.01),
    `after adding member ${members.length} back, all ${members.length} models are drawn`,
  );
  await page.screenshot({ path: `${OUT}/group-member-added.png` });
}

try {
  await page.goto(BASE);
  await page.fill('input[type="text"]', process.env.LUMI_USER);
  await page.fill('input[type="password"]', process.env.LUMI_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  if (group) {
    await runGroup();
    console.log(`Screenshots: ${OUT}`);
    for (const problem of problems) console.log(problem);
    if (failures.length > 0) {
      console.log(`FAIL: ${failures.length} check(s) failed`);
      process.exitCode = 1;
    } else {
      console.log('OK: group chat checks passed');
    }
    process.exit();
  }

  await page.goto(CHAT);
  await page.waitForTimeout(5000);
  await openSpineTab();

  const inLibrary = (name) =>
    [...document.querySelectorAll('.spn-model-name, .spn-tile-name')].some((node) => node.textContent === name);
  if (!(await page.evaluate(inLibrary, MODEL_NAME))) {
    console.log(`Importing ${MODEL_NAME}…`);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.click('button:has-text("Import model")'),
    ]);
    await chooser.setFiles(process.env.LUMI_MODEL_ZIP);
    await page.waitForFunction(inLibrary, MODEL_NAME, { timeout: 300000 });
  }

  if ((await bindingPickers().count()) < 2) {
    console.log('no binding controls (is a chat open?)');
  } else if (optionLabel(await bindingPickers().nth(1).innerText()) === MODEL_NAME) {
    console.log(`already bound: ${MODEL_NAME}`);
  } else {
    await bindModel(MODEL_NAME);
    console.log(`bound ${MODEL_NAME} to ${optionLabel(await bindingPickers().nth(0).innerText())}`);
  }
  await page.waitForTimeout(3000);
  if (keepOpen) await page.screenshot({ path: `${OUT}/spine-tab.png` });

  await page.goto(CHAT);
  const loadStart = Date.now();
  // Large models take a while to download, especially with --slow.
  const appeared = await page
    .waitForSelector('.spine-avatars-canvas', { timeout: 180000 })
    .then(() => true, () => false);
  if (appeared) console.log(`Model loaded ${((Date.now() - loadStart) / 1000).toFixed(1)}s after opening the chat`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/chat.png` });

  const stage = await stageInfo();
  console.log('Stage:', JSON.stringify(stage));
  if (!stage || stage.width === 0 || stage.height === 0) {
    check(false, 'no visible avatar canvas');
  } else if (stage.drawnFraction < 0.005) {
    check(false, `the canvas is empty (${(stage.drawnFraction * 100).toFixed(2)}% drawn)`);
  } else if (!stage.overlay) {
    console.log('NOTE: rendering in the Spine tab preview (app_manipulation not granted)');
  } else {
    console.log(`OK: avatar overlay is on screen (${(stage.drawnFraction * 100).toFixed(1)}% of the stage drawn)`);
  }

  if (controls && failures.length === 0) await runControls();
  if (testLibrary && stage?.drawnFraction > 0) await runLibrary();

  console.log(`Screenshots: ${OUT}`);
  for (const problem of problems) console.log(problem);
  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} check(s) failed`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
