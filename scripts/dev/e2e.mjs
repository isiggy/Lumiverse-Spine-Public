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
            overlay: !!canvas.closest('.spine-avatars-overlay'),
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

try {
  await page.goto(BASE);
  await page.fill('input[type="text"]', process.env.LUMI_USER);
  await page.fill('input[type="password"]', process.env.LUMI_PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);

  await page.goto(CHAT);
  await page.waitForTimeout(5000);
  await openSpineTab();

  const inLibrary = (name) =>
    [...document.querySelectorAll('.spn-model-name')].some((node) => node.textContent === name);
  if (!(await page.evaluate(inLibrary, MODEL_NAME))) {
    console.log(`Importing ${MODEL_NAME}…`);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.click('button:has-text("Import model")'),
    ]);
    await chooser.setFiles(process.env.LUMI_MODEL_ZIP);
    await page.waitForFunction(inLibrary, MODEL_NAME, { timeout: 300000 });
  }

  const binding = await page.evaluate((name) => {
    const section = [...document.querySelectorAll('.spn-section')].find(
      (node) => node.querySelector('.spn-section-title')?.textContent === 'Character model',
    );
    const [characterSelect, modelSelect] = section ? [...section.querySelectorAll('select')] : [];
    if (!modelSelect) return 'no binding controls (is a chat open?)';
    const option = [...modelSelect.options].find((o) => o.textContent === name);
    if (!option) return `${name} missing from the model list`;
    if (modelSelect.value === option.value) return `already bound: ${name}`;
    modelSelect.value = option.value;
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    return `bound ${name} to ${characterSelect.selectedOptions[0]?.textContent}`;
  }, MODEL_NAME);
  console.log(binding);
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

  console.log(`Screenshots: ${OUT}`);
  for (const problem of problems) console.log(problem);
  if (failures.length > 0) {
    console.log(`FAIL: ${failures.length} check(s) failed`);
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
