import { config } from "../package.json";
import {
  registerOAuthCallback, unregisterOAuthCallback,
  startOpenAIOAuth, signOutOpenAI, isOpenAIOAuthActive,
  startAnthropicOAuth, signOutAnthropic, isAnthropicOAuthActive,
  cancelOAuthFlow,
} from "./modules/auth/oauth";

let openaiOAuthInFlight = false;
import { setCredential, getCredential, removeCredential, migrateFromPrefs } from "./modules/auth/storage";
import { registerChatPanelSection, unregisterChatPanelSection } from "./modules/panel/chatPanel";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { registerSmartActions, registerSmartActionsShortcut } from "./modules/reader/smartActions";
import { getString, initLocale } from "./utils/locale";

function registerPreferencePane() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: `${rootURI}content/preferences.xhtml`,
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}

function registerStylesheet(win: _ZoteroTypes.MainWindow) {
  if (addon.data.styleWindows.has(win)) return;
  const link = win.document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = `chrome://${config.addonRef}/content/zoteroPane.css`;
  win.document.documentElement?.appendChild(link);
  addon.data.styleWindows.add(win);
}

function abortAllRequests() {
  for (const controller of addon.data.activeAbortControllers) {
    controller.abort();
  }
  addon.data.activeAbortControllers.clear();
}

function updateOAuthStatuses(win: Window) {
  updateOpenAIOAuthStatus(win);
  updateAnthropicOAuthStatus(win);
}

function updateAnthropicOAuthStatus(win: Window) {
  const doc = win.document;
  const statusEl = doc.getElementById(`zotero-prefpane-${config.addonRef}-anthropic-oauth-status`);
  const btnEl = doc.getElementById(`zotero-prefpane-${config.addonRef}-anthropic-oauth-btn`) as HTMLButtonElement | null;

  if (isAnthropicOAuthActive()) {
    if (statusEl) statusEl.textContent = "✓ Signed in with Claude";
    if (btnEl) {
      btnEl.textContent = "Sign Out";
      btnEl.style.background = "#dc2626";
    }
  } else {
    if (statusEl) statusEl.textContent = "";
    if (btnEl) {
      btnEl.textContent = "Sign in with Claude";
      btnEl.style.background = "#d97706";
    }
  }
}

function updateOpenAIOAuthStatus(win: Window) {
  const doc = win.document;
  const statusEl = doc.getElementById(`zotero-prefpane-${config.addonRef}-openai-oauth-status`);
  const btnEl = doc.getElementById(`zotero-prefpane-${config.addonRef}-openai-oauth-btn`) as HTMLButtonElement | null;

  if (isOpenAIOAuthActive()) {
    if (statusEl) statusEl.textContent = "✓ Signed in with ChatGPT";
    if (btnEl) {
      btnEl.textContent = "Sign Out";
      btnEl.style.background = "#dc2626";
    }
  } else {
    if (statusEl) statusEl.textContent = "";
    if (btnEl) {
      btnEl.textContent = "Sign in with ChatGPT";
      btnEl.style.background = "#4f46e5";
    }
  }
}

function loadApiKeyIntoField(win: Window, providerId: string) {
  const doc = win.document;
  const field = doc.getElementById(`zotero-prefpane-${config.addonRef}-${providerId}-key`) as HTMLInputElement | null;
  if (!field) return;
  const cred = getCredential(providerId);
  if (cred?.type === "api") {
    field.value = cred.key;
  }
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  migrateFromPrefs();
  registerOAuthCallback();
  registerPreferencePane();
  registerSmartActions();
  registerChatPanelSection();

  for (const win of Zotero.getMainWindows()) {
    await onMainWindowLoad(win);
  }

  new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({ text: getString("startup-finish"), progress: 100 })
    .show();

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
  registerStylesheet(win);
  registerSmartActionsShortcut();
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  abortAllRequests();
  unregisterOAuthCallback();
  unregisterChatPanelSection();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  delete Zotero[config.addonInstance as keyof typeof Zotero];
}

async function onNotify(
  _event: string,
  _type: string,
  _ids: Array<string | number>,
  _extraData: { [key: string]: any },
) {}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  const win = data.window as Window;

  switch (type) {
    case "load": {
      registerPrefsScripts(win);
      updateOAuthStatuses(win);
      for (const pid of ["openai", "anthropic", "gemini", "custom"]) {
        loadApiKeyIntoField(win, pid);
      }
      break;
    }

    case "openaiOAuth": {
      if (isOpenAIOAuthActive()) {
        signOutOpenAI();
        updateOpenAIOAuthStatus(win);
      } else if (openaiOAuthInFlight) {
        cancelOAuthFlow();
        openaiOAuthInFlight = false;
        updateOpenAIOAuthStatus(win);
      } else {
        openaiOAuthInFlight = true;
        const btnEl = win.document.getElementById(
          `zotero-prefpane-${config.addonRef}-openai-oauth-btn`,
        ) as HTMLButtonElement | null;
        if (btnEl) btnEl.textContent = "Cancel";
        try {
          await startOpenAIOAuth();
          updateOpenAIOAuthStatus(win);
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (msg !== "OAuth flow cancelled") {
            const statusEl = win.document.getElementById(
              `zotero-prefpane-${config.addonRef}-openai-oauth-status`,
            );
            if (statusEl) statusEl.textContent = `Error: ${msg}`;
          }
        } finally {
          openaiOAuthInFlight = false;
          updateOpenAIOAuthStatus(win);
        }
      }
      break;
    }

    case "anthropicOAuth": {
      if (isAnthropicOAuthActive()) {
        signOutAnthropic();
        updateAnthropicOAuthStatus(win);
      } else {
        try {
          const btnEl = win.document.getElementById(
            `zotero-prefpane-${config.addonRef}-anthropic-oauth-btn`,
          ) as HTMLButtonElement | null;
          if (btnEl) {
            btnEl.textContent = "Authorizing...";
            btnEl.disabled = true;
          }
          await startAnthropicOAuth(win);
          updateAnthropicOAuthStatus(win);
        } catch (err: any) {
          const statusEl = win.document.getElementById(
            `zotero-prefpane-${config.addonRef}-anthropic-oauth-status`,
          );
          if (statusEl) statusEl.textContent = `Error: ${err?.message || err}`;
        } finally {
          const btnEl = win.document.getElementById(
            `zotero-prefpane-${config.addonRef}-anthropic-oauth-btn`,
          ) as HTMLButtonElement | null;
          if (btnEl) btnEl.disabled = false;
          updateAnthropicOAuthStatus(win);
        }
      }
      break;
    }

    case "saveApiKey": {
      const providerId = data.provider as string;
      const field = win.document.getElementById(
        `zotero-prefpane-${config.addonRef}-${providerId}-key`,
      ) as HTMLInputElement | null;
      const key = field?.value?.trim();

      if (key) {
        await setCredential(providerId, { type: "api", key });
      } else {
        removeCredential(providerId);
      }
      break;
    }

    default:
      break;
  }
}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
