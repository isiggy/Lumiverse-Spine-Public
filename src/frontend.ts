/**
 * Spine Avatars — frontend module.
 *
 * Wires the stage (overlay or in-tab preview), the settings drawer tab, the
 * backend message channel, and chat lifecycle events together.
 */

import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { ModelAssets } from './frontend/assets';
import { Stage } from './frontend/stage';
import { SettingsUI, UI_CSS, type UIController } from './frontend/ui';
import { tusUpload } from './frontend/tus';
import type { BackendToFrontend, ExpressionMsg } from './shared/protocol';
import {
  defaultModelSettings,
  defaultSettings,
  ensureModelSettingsShape,
  normalizeSettings,
  type ModelDescription,
  type ModelRecord,
  type ModelSettings,
  type SpineSettings,
} from './shared/settings';

const EXTENSION_ID = 'spine_avatars';

const STAGE_CSS = `
.spine-avatars-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 4; }
.spine-avatars-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; background: transparent; }
html.spine-avatars-hover, html.spine-avatars-hover * { cursor: grab !important; }
/* Background mode: the host mounts the overlay at z-index 9990 above the whole
   app. Drop it to 0 so it sits above the app's backdrop and global wallpaper
   but under <main> (z-index 1), which holds the chat. While a chat is open the
   overlay moves into the chat view instead (see placeOverlay). */
html.spine-avatars-bg .spine-avatars-mount { z-index: 0 !important; }
html.spine-avatars-bg .spine-avatars-overlay { z-index: 0; }
`;

// A jointed figure: bones and joints, the way a Spine rig is built.
const TAB_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><path d="M12 6.5v6.5"/><path d="M12 8.5l-4 2.5-1.5 3.5M12 8.5l4 2.5 1.5 3.5"/><path d="M12 13l-3 3.5L8 21M12 13l3 3.5 1 4.5"/><circle cx="12" cy="13" r=".8"/><circle cx="8" cy="11" r=".8"/><circle cx="16" cy="11" r=".8"/><circle cx="9" cy="16.5" r=".8"/><circle cx="15" cy="16.5" r=".8"/></svg>';

export function setup(ctx: SpindleFrontendContext) {
  ctx.deferReady();

  // ── State store ───────────────────────────────────────────────────────────
  let settings: SpineSettings = defaultSettings();
  let models: ModelRecord[] = [];
  let characters: Array<{ id: string; name: string }> = [];
  let permissions: string[] = [];
  let stateReceived = false;

  const cleanups: Array<() => void> = [];
  const removeStyle = ctx.dom.addStyle(STAGE_CSS + UI_CSS);
  cleanups.push(removeStyle);

  const assets = new ModelAssets((payload) => ctx.sendToBackend(payload));

  // ── Persistence ───────────────────────────────────────────────────────────
  let saveTimer: number | null = null;
  const saveNow = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    ctx.sendToBackend({ type: 'save_settings', settings });
  };
  const saveDebounced = () => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 500);
  };

  const getOrCreateModelSettings = (
    characterId: string,
    modelId: string,
    description: ModelDescription | null,
  ): ModelSettings => {
    const byCharacter = (settings.characterModelsSettings[characterId] ??= {});
    let modelSettings = byCharacter[modelId];
    if (!modelSettings) {
      modelSettings = defaultModelSettings(description);
      byCharacter[modelId] = modelSettings;
      saveDebounced();
    } else {
      ensureModelSettingsShape(modelSettings, description);
    }
    return modelSettings;
  };

  // ── Stage ─────────────────────────────────────────────────────────────────
  const stage = new Stage({
    getSettings: () => settings,
    getModelRecord: (modelId) => models.find((model) => model.id === modelId),
    getModelSettings: getOrCreateModelSettings,
    saveSettingsDebounced: saveDebounced,
    layoutChanged: () => ui.layoutChanged(),
    assets,
    sendInteraction: (message, characterId) => {
      const { chatId } = stage.getChatContext();
      if (!chatId) return;
      ctx.sendToBackend({
        type: 'interaction',
        chatId,
        message,
        generate: settings.global.autoSendInteraction,
        characterId,
      });
    },
    log: (message) => console.debug('[spine]', message),
  });
  cleanups.push(() => stage.destroy());

  // ── Stage host: app overlay when permitted, tab preview otherwise ─────────
  const embeddedHost = document.createElement('div');
  let overlayMount: { root: HTMLElement; mountRoot: HTMLElement; destroy(): void } | null = null;
  let overlayActive = false;

  const ensureStageHost = () => {
    if (permissions.includes('app_manipulation')) {
      if (!overlayMount) {
        try {
          const mount = ctx.ui.mountApp({ className: 'spine-avatars-mount', position: 'app-overlay' });
          const host = document.createElement('div');
          host.className = 'spine-avatars-overlay';
          mount.root.appendChild(host);
          overlayMount = {
            root: host,
            mountRoot: mount.root,
            destroy: () => {
              host.remove();
              mount.destroy();
            },
          };
          cleanups.push(() => overlayMount?.destroy());
        } catch (error) {
          console.debug('[spine] overlay mount unavailable:', error);
        }
      }
      if (overlayMount) {
        overlayActive = true;
        stage.setHost(overlayMount.root);
        applyBackgroundMode();
        return;
      }
    }
    overlayActive = false;
    stage.setHost(embeddedHost);
    applyBackgroundMode();
  };

  const applyBackgroundMode = () => {
    const on = settings.global.enabled && settings.global.backgroundMode && overlayActive;
    document.documentElement.classList.toggle('spine-avatars-bg', on);
    setOverlayTracking(on);
    placeOverlay();
  };
  cleanups.push(() => document.documentElement.classList.remove('spine-avatars-bg'));

  // In background mode the chat view draws its own wallpaper and scene image
  // inside <main>, faded by the user's wallpaper opacity. Under <main> the model
  // would show through that fade, so a fully opaque wallpaper hid it. Instead the
  // overlay goes inside the chat view, just before the chat body: positioned at
  // z-index 0 after the wallpaper and scene layers (also z-index 0), it paints
  // above them and below the text scrim (1) and the chat itself (3).
  const placeOverlay = () => {
    if (!overlayMount) return;
    const host = overlayMount.root;
    const bgOn = document.documentElement.classList.contains('spine-avatars-bg');
    // Fast path for the observer, which fires on every chat update: still in place.
    const next = host.nextElementSibling;
    if (bgOn && host.isConnected && next?.getAttribute('data-lumiverse-surface') === 'chat-body') return;
    const chatBody = bgOn
      ? document.querySelector('[data-component="ChatView"] > [data-lumiverse-surface="chat-body"]')
      : null;
    const target = chatBody?.parentElement ?? overlayMount.mountRoot;
    if (host.parentElement === target && (!chatBody || host.nextElementSibling === chatBody)) return;
    target.insertBefore(host, chatBody ?? null);
  };

  // Opening another chat or page replaces the chat view, so follow it.
  let overlayObserver: MutationObserver | null = null;
  let placeFrame: number | null = null;
  const setOverlayTracking = (on: boolean) => {
    if (on && !overlayObserver) {
      overlayObserver = new MutationObserver(() => {
        if (placeFrame !== null) return;
        placeFrame = window.requestAnimationFrame(() => {
          placeFrame = null;
          placeOverlay();
        });
      });
      overlayObserver.observe(document.querySelector('[data-app-root]') ?? document.body, {
        childList: true,
        subtree: true,
      });
    } else if (!on && overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
      if (placeFrame !== null) window.cancelAnimationFrame(placeFrame);
      placeFrame = null;
    }
  };
  cleanups.push(() => setOverlayTracking(false));

  // ── Settings tab ──────────────────────────────────────────────────────────
  let classifyPending: { resolve: (label: string) => void; reject: (error: Error) => void } | null = null;

  const controller: UIController = {
    getSettings: () => settings,
    getModels: () => models,
    getCharacters: () => characters,
    getPermissions: () => permissions,
    getActiveCharacterId: () => ctx.getActiveChat().characterId,
    stage,
    saveDebounced,
    saveNow,
    reloadStage: () => {
      applyBackgroundMode();
      void stage.reload();
    },
    importZip: async (status) => {
      const files = await ctx.uploads.pickFile({
        accept: ['.zip', 'application/zip'],
        maxSizeBytes: 512 * 1024 * 1024,
      });
      const file = files[0];
      if (!file) return;
      status('Uploading…');
      try {
        const uploadId = await tusUpload(file.bytes, file.name, EXTENSION_ID, (sent, total) => {
          status(`Uploading… ${Math.round((sent / total) * 100)}%`);
        });
        status('Importing…');
        ctx.sendToBackend({ type: 'import_model_zip', uploadId, name: file.name.replace(/\.zip$/i, '') });
      } catch (error) {
        status(`Upload failed: ${String(error)}`);
      }
    },
    deleteModel: async (modelId) => {
      const record = models.find((model) => model.id === modelId);
      const { confirmed } = await ctx.ui.showConfirm({
        title: 'Delete Spine model',
        message: `Delete "${record?.name ?? modelId}" and its files? Character bindings to it are removed.`,
        variant: 'danger',
        confirmLabel: 'Delete',
      });
      if (confirmed) ctx.sendToBackend({ type: 'delete_model', modelId });
    },
    classifyTest: (text) =>
      new Promise<string>((resolve, reject) => {
        // Results carry no request id, so only one test runs at a time.
        classifyPending?.reject(new Error('Replaced by a newer test.'));
        const pending = { resolve, reject };
        classifyPending = pending;
        ctx.sendToBackend({ type: 'classify_test', text });
        setTimeout(() => {
          if (classifyPending === pending) {
            classifyPending = null;
            reject(new Error('Timed out.'));
          }
        }, 60_000);
      }),
    describeModel: async (modelId) => {
      const record = models.find((model) => model.id === modelId);
      if (!record) throw new Error(`Unknown model: ${modelId}`);
      return stage.describeModel(record);
    },
    getDownloadProgress: (modelId) => assets.progress(modelId),
    getOrCreateModelSettings,
    requestPermissions: async (perms) => {
      try {
        permissions = await ctx.permissions.request(perms);
      } catch {
        /* user declined */
      }
      ensureStageHost();
      ui.render();
    },
    embeddedHost,
    usingOverlay: () => overlayActive,
    applyBackgroundMode,
  };

  const ui = new SettingsUI(controller);

  const tab = ctx.ui.registerDrawerTab({
    id: 'spine',
    title: 'Spine Avatars',
    shortName: 'Spine',
    description: 'Animated Spine character avatars',
    keywords: ['spine', 'avatar', 'model', 'skeleton', 'animation'],
    headerTitle: 'Spine',
    iconSvg: TAB_ICON,
  });
  ui.mount(tab.root);
  cleanups.push(() => tab.destroy());

  const inputAction = ctx.ui.registerInputBarAction({
    id: 'spine-settings',
    label: 'Spine Settings',
    iconSvg: TAB_ICON,
  });
  const unsubAction = inputAction.onClick(() => tab.activate());
  cleanups.push(() => {
    unsubAction();
    inputAction.destroy();
  });

  // ── Chat context ──────────────────────────────────────────────────────────
  // The backend knows a chat's members (it reads the chat); the frontend only
  // knows the active chat's own character, which is all there is to go on
  // when the backend can't read chats. Otherwise clear the stage and wait for
  // the members, so a group chat doesn't first load one model on its own.
  const followActiveChat = () => {
    const active = ctx.getActiveChat();
    if (stage.getChatContext().chatId !== active.chatId) {
      const own = active.characterId && !permissions.includes('chats') ? [active.characterId] : [];
      stage.setChatContext(active.chatId, own);
    }
    if (active.chatId) ctx.sendToBackend({ type: 'get_chat_context', chatId: active.chatId });
  };

  /**
   * The character a message or expression is about, if its model is on stage.
   * Without a character (the backend couldn't tell who wrote it) it can only
   * mean the one model on stage.
   */
  const stageCharacterFor = (chatId: string, characterId: string | null): string | null => {
    const context = stage.getChatContext();
    if (!context.chatId || chatId !== context.chatId) return null;
    const onStage = stage.charactersOnStage();
    if (characterId) return onStage.includes(characterId) ? characterId : null;
    return onStage.length === 1 ? onStage[0]! : null;
  };

  // ── Backend message handling ──────────────────────────────────────────────
  const playMappedExpression = (msg: ExpressionMsg) => {
    const characterId = stageCharacterFor(msg.chatId, msg.characterId);
    if (!characterId) return;
    const modelId = settings.characterModelMapping[characterId];
    if (!modelId) return;
    const modelSettings = getOrCreateModelSettings(characterId, modelId, stage.getDescription(characterId));
    const animation = modelSettings.classify_mapping[msg.label] ?? 'none';
    if (animation !== 'none') stage.playAnimation(characterId, animation);
  };

  const unsubBackend = ctx.onBackendMessage((payload) => {
    const msg = payload as BackendToFrontend;
    if (assets.handleMessage(msg)) return;
    switch (msg.type) {
      case 'state': {
        // Only take settings from the first snapshot: a second one (from the
        // boot retry) would replace objects the stage and tab are editing and
        // drop an edit still waiting to be saved.
        if (!stateReceived) settings = normalizeSettings(msg.settings);
        models = msg.models;
        characters = msg.characters;
        permissions = msg.permissions;
        stateReceived = true;
        ensureStageHost();
        followActiveChat();
        ui.render();
        break;
      }
      case 'settings_saved':
        break;
      case 'model_imported':
        models = [...models.filter((model) => model.id !== msg.model.id), msg.model];
        ui.render();
        void stage.reload();
        break;
      case 'model_deleted':
        models = models.filter((model) => model.id !== msg.modelId);
        assets.invalidate(msg.modelId);
        for (const characterId of Object.keys(settings.characterModelMapping)) {
          if (settings.characterModelMapping[characterId] === msg.modelId) {
            delete settings.characterModelMapping[characterId];
          }
        }
        for (const byModel of Object.values(settings.characterModelsSettings)) {
          if (byModel) delete byModel[msg.modelId];
        }
        ui.render();
        void stage.reload();
        break;
      case 'import_error':
        ui.render();
        void ctx.ui.showConfirm({
          title: 'Spine import failed',
          message: msg.error,
          variant: 'warning',
          confirmLabel: 'OK',
        });
        break;
      case 'expression':
        playMappedExpression(msg);
        break;
      case 'character_message': {
        const characterId = stageCharacterFor(msg.chatId, msg.characterId);
        if (characterId && msg.textLength > 0) stage.playTalk(characterId, msg.textLength);
        break;
      }
      case 'chat_context': {
        // Answers can arrive out of order across chat switches; only take the active chat's.
        const active = ctx.getActiveChat();
        if (msg.chatId !== active.chatId) break;
        const fallback = active.characterId ? [active.characterId] : [];
        stage.setChatContext(msg.chatId, msg.characterIds?.length ? msg.characterIds : fallback);
        ui.render();
        break;
      }
      case 'chat_members':
        if (msg.chatId !== stage.getChatContext().chatId) break;
        stage.setChatContext(msg.chatId, msg.characterIds);
        ui.render();
        break;
      case 'classify_test_result':
        if (classifyPending) {
          const pending = classifyPending;
          classifyPending = null;
          if (msg.error) pending.reject(new Error(msg.error));
          else pending.resolve(msg.label);
        }
        break;
      case 'permissions_changed':
        permissions = msg.permissions;
        ensureStageHost();
        followActiveChat(); // with `chats` granted, group members can now be read
        ui.render();
        break;
      case 'focus_tab':
        tab.activate();
        break;
      case 'reload_models':
        void stage.reload();
        break;
      case 'toggle_enabled':
        settings.global.enabled = msg.enabled;
        applyBackgroundMode();
        ui.render();
        void stage.reload();
        break;
    }
  });
  cleanups.push(unsubBackend);

  // Chat switches reach us via the backend relay; this direct subscription is
  // the fallback when the backend lacks the `chats` permission.
  const unsubChat = ctx.events.on('CHAT_SWITCHED', () => {
    window.setTimeout(() => {
      followActiveChat();
      ui.render();
    }, 50);
  });
  cleanups.push(unsubChat);

  // ── Boot ──────────────────────────────────────────────────────────────────
  ctx.sendToBackend({ type: 'get_state' });
  ctx.ready();

  // If the backend was still starting, retry the state request once.
  window.setTimeout(() => {
    if (!stateReceived) ctx.sendToBackend({ type: 'get_state' });
  }, 3000);

  return () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        /* best-effort teardown */
      }
    }
    ctx.dom.cleanup();
  };
}
