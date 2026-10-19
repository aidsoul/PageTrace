import browser from 'webextension-polyfill';
import type { Runtime } from 'webextension-polyfill';
import {
  upsertPage,
  cleanupExpired,
  evictLRU,
  addCustomIndex,
  updateCustomIndex,
  deleteCustomIndex,
  deletePageById,
  deletePageByUrl,
  touchPageAccess,
  getIndexSnapshot,
  getLocalDbRevision,
} from '@/db/index';
import {
  rebuildIndex,
  search,
  isIndexInitialized,
  getIndexedRevision,
  serializeSearchIndex,
  hydrateSearchIndex,
  getAvailableTags,
  getAvailableDomains,
} from '@/search/index';
import { getSettings, saveSettings } from '@/common/settings';
import { matchUrlPattern } from '@/common/tags';
import { normalizePageUrl } from '@/common/search-utils';
import type {
  ExtensionMessage,
  IndexPageMessage,
  SaveCustomIndexMessage,
  UpdateCustomIndexMessage,
  DeleteCustomIndexMessage,
  DeletePageMessage,
  GetSearchSuggestionsMessage,
  NavigateToResultMessage,
  TouchPageMessage,
  ExecuteSearchQueryMessage,
  UserSettings,
  IndexCreationTrigger,
  SearchResult,
} from '@/types/index';
import { getLocale, DEFAULT_LANGUAGE } from '@/i18n/index';

// Background service worker

const SEARCH_CACHE_STORAGE_KEY = 'pt_search_cache';
let indexRebuildPromise: Promise<void> | null = null;
let cachePersistTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSearchCachePersist(): void {
  if (cachePersistTimer) clearTimeout(cachePersistTimer);
  cachePersistTimer = setTimeout(() => {
    cachePersistTimer = null;
    const snapshot = serializeSearchIndex(getLocalDbRevision());
    if (!snapshot) {
      browser.storage.local.remove(SEARCH_CACHE_STORAGE_KEY).catch(() => {});
      return;
    }
    try {
      browser.storage.local.set({ [SEARCH_CACHE_STORAGE_KEY]: snapshot }).catch(() => {
        browser.storage.local.remove(SEARCH_CACHE_STORAGE_KEY).catch(() => {});
      });
    } catch {
      browser.storage.local.remove(SEARCH_CACHE_STORAGE_KEY).catch(() => {});
    }
  }, 1200);
}

async function ensureBackgroundSearchIndex(): Promise<void> {
  const currentRev = getLocalDbRevision();
  if (isIndexInitialized() && getIndexedRevision() === currentRev && !indexRebuildPromise) {
    return;
  }
  if (indexRebuildPromise) {
    await indexRebuildPromise;
    return;
  }
  indexRebuildPromise = (async () => {
    try {
      if (!isIndexInitialized()) {
        try {
          const stored = await browser.storage.local.get(['pt_db_rev', SEARCH_CACHE_STORAGE_KEY]);
          const storedRev = Number(stored?.['pt_db_rev']) || currentRev;
          const cached = stored?.[SEARCH_CACHE_STORAGE_KEY] as { revision?: number } | undefined;
          if (cached && cached.revision === storedRev && hydrateSearchIndex(cached)) {
            return;
          }
        } catch {
          // Fall back to full DB snapshot rebuild
        }
      }

      const snap = await getIndexSnapshot();
      const targetRev = getLocalDbRevision();
      await rebuildIndex(snap.pages, snap.chunks, snap.media, snap.customIndexes, targetRev);
      scheduleSearchCachePersist();
    } finally {
      indexRebuildPromise = null;
    }
  })();
  await indexRebuildPromise;
}

async function handleExecuteSearchQuery(msg: ExecuteSearchQueryMessage): Promise<SearchResult[]> {
  await ensureBackgroundSearchIndex();
  return search(msg.query, msg.limit ?? 100, msg.filterOptions);
}

async function updateContextMenu(trigger?: IndexCreationTrigger, lang?: string): Promise<void> {
  try {
    const s = await getSettings();
    if (!trigger) {
      trigger = s.indexTrigger;
    }
    const currentLang = lang || s.language;
    const t = getLocale(currentLang);

    await browser.contextMenus.removeAll();
    if (trigger === 'contextmenu' || trigger === 'both') {
      browser.contextMenus.create({
        id: 'create-index-selection',
        title: t.background.contextMenuTitle,
        contexts: ['selection'],
      });
    }
    browser.contextMenus.create({
      id: 'toggle-pin-domain',
      title: t.background.contextMenuPinDomain,
      contexts: ['page', 'frame'],
    });
  } catch (err) {
    console.warn('[PageTrace] Context menu update error:', err);
  }
}

async function syncBrowserCommandShortcut(hotkey?: string): Promise<void> {
  try {
    const commandsApi = browser.commands as typeof browser.commands & {
      update?: (detail: { name: string; shortcut: string }) => Promise<void>;
    };
    if (typeof commandsApi?.update !== 'function') return;
    const targetHotkey = hotkey || (await getSettings()).hotkey;
    if (targetHotkey) {
      await commandsApi.update({ name: 'toggle-overlay', shortcut: targetHotkey });
    }
  } catch {
    // Ignore if shortcut format is unsupported by browser.commands.update
  }
}

// Register daily cleanup alarm and context menu on install
browser.runtime.onInstalled.addListener(async () => {
  await browser.alarms.create('daily-cleanup', {
    periodInMinutes: 24 * 60,
    delayInMinutes: 1,
  });
  console.log('[PageTrace] Extension installed. Daily cleanup alarm set.');
  await updateContextMenu();
  await syncBrowserCommandShortcut();
});

updateContextMenu().catch((e) => console.warn(e));
void syncBrowserCommandShortcut();

// Update context menu and shortcut when settings change
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['settings']) {
    const newSettings = changes['settings'].newValue as Partial<UserSettings> | undefined;
    if (newSettings?.indexTrigger || newSettings?.language) {
      updateContextMenu(newSettings.indexTrigger, newSettings.language).catch(console.warn);
    }
    if (newSettings?.hotkey) {
      void syncBrowserCommandShortcut(newSettings.hotkey);
    }
  }
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'create-index-selection' && tab?.id) {
    try {
      await browser.tabs.sendMessage(tab.id, {
        type: 'TRIGGER_CREATE_INDEX_FROM_SELECTION',
        text: info.selectionText || '',
      });
    } catch (err) {
      console.warn('[PageTrace] Failed to send TRIGGER_CREATE_INDEX_FROM_SELECTION:', err);
    }
    return;
  }

  if (info.menuItemId === 'toggle-pin-domain' && tab?.id) {
    const pageUrl = info.pageUrl || tab.url;
    if (!pageUrl) return;

    try {
      const parsedUrl = new URL(pageUrl);
      const hostname = parsedUrl.hostname;
      if (
        !hostname ||
        parsedUrl.protocol.startsWith('chrome') ||
        parsedUrl.protocol.startsWith('moz-extension') ||
        parsedUrl.protocol === 'about:'
      ) {
        return;
      }

      const s = await getSettings();
      const pinned = Array.isArray(s.pinnedDomains) ? [...s.pinnedDomains] : [];
      const lowerHost = hostname.toLowerCase();
      const isPinned = pinned.some((p) => p.toLowerCase() === lowerHost);

      const lang = s.language || DEFAULT_LANGUAGE;
      const t = getLocale(lang);
      let toastMsg = '';

      if (isPinned) {
        const nextPinned = pinned.filter((p) => p.toLowerCase() !== lowerHost);
        await saveSettings({ pinnedDomains: nextPinned });
        toastMsg = t.content.toastDomainUnpinned(hostname);
      } else {
        pinned.push(hostname);
        await saveSettings({ pinnedDomains: pinned });
        toastMsg = t.content.toastDomainPinned(hostname);
      }

      try {
        await browser.tabs.sendMessage(tab.id, {
          type: 'SHOW_TOAST',
          message: toastMsg,
        });
      } catch {}
    } catch (err) {
      console.warn('[PageTrace] Failed to toggle pinned domain:', err);
    }
  }
});

async function checkStartupSnoozeReset(): Promise<void> {
  try {
    const data = await browser.storage.local.get('pt_paused_until');
    if (data?.pt_paused_until === -1) {
      await browser.storage.local.set({ pt_paused_until: 0 });
    }
  } catch {}
}
void checkStartupSnoozeReset();
if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    void checkStartupSnoozeReset();
  });
}

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'pt_snooze_alarm') {
    await browser.storage.local.set({ pt_paused_until: 0 }).catch(() => {});
    return;
  }
  if (alarm.name === 'daily-cleanup') {
    console.log('[PageTrace] Running daily cleanup...');
    const settings = await getSettings();
    await cleanupExpired(settings.ttlDays, settings.pinnedDomains);
    await evictLRU(settings.maxSizeMb, settings.pinnedDomains);
    scheduleSearchCachePersist();
    console.log('[PageTrace] Daily cleanup done.');
  }
});

// Open search window on keyboard shortcut
browser.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-overlay') {
    const settings = await getSettings();
    if (!settings.enabled) return;
    await openSearchWindow();
  }
});

let openSearchPromise: Promise<void> | null = null;
let lastOpenSearchTime = 0;

async function openSearchWindow(): Promise<void> {
  const now = Date.now();
  if (now - lastOpenSearchTime < 250) {
    return;
  }
  if (openSearchPromise) {
    return openSearchPromise;
  }
  lastOpenSearchTime = now;

  openSearchPromise = (async () => {
    const width = 680;
    const height = 580;

    try {
      // Focus existing search window if already open
      const allWindows = await browser.windows.getAll({ populate: true });
      for (const win of allWindows) {
        if (win.tabs?.some((t) => t.url && t.url.includes('search.html'))) {
          await browser.windows.update(win.id!, { focused: true });
          return;
        }
      }
    } catch (err) {
      console.warn('[PageTrace] Could not check existing windows:', err);
    }

    // Center popup relative to the last focused browser window
    let left: number | undefined;
    let top: number | undefined;

    try {
      const lastFocused = await browser.windows.getLastFocused();
      if (lastFocused && lastFocused.width && lastFocused.height) {
        const winLeft = lastFocused.left ?? 0;
        const winTop = lastFocused.top ?? 0;
        left = Math.max(0, Math.round(winLeft + (lastFocused.width - width) / 2));
        top = Math.max(0, Math.round(winTop + (lastFocused.height - height) / 2));
      }
    } catch (err) {
      console.warn('[PageTrace] Could not determine last focused window coordinates:', err);
    }

    const searchUrl = browser.runtime.getURL('search.html');

    try {
      await browser.windows.create({
        url: searchUrl,
        type: 'popup',
        width,
        height,
        left,
        top,
        focused: true,
      });
    } catch (err) {
      console.error('[PageTrace] Failed to create popup window, opening in tab:', err);
      try {
        await browser.tabs.create({ url: searchUrl, active: true });
      } catch {
        // ignore
      }
    }
  })().finally(() => {
    openSearchPromise = null;
  });

  return openSearchPromise;
}

// Handle messages from content scripts and UI views
browser.runtime.onMessage.addListener(
  (rawMessage: unknown, sender: Runtime.MessageSender): Promise<unknown> | true | undefined => {
    const message = rawMessage as ExtensionMessage | { type: string };

    if (message.type === 'OPEN_SEARCH_WINDOW') {
      openSearchWindow().catch((e) => console.error(e));
      return undefined;
    }

    if (message.type === 'EXECUTE_SEARCH_QUERY') {
      return handleExecuteSearchQuery(message as ExecuteSearchQueryMessage).catch((e) => {
        console.error('[PageTrace] Execute search query error:', e);
        return [];
      });
    }

    if (message.type === 'GET_INDEX_SNAPSHOT') {
      return getIndexSnapshot().catch((e) => {
        console.error('[PageTrace] Get index snapshot error:', e);
        return { pages: [], chunks: [], media: [], customIndexes: [] };
      });
    }

    if (message.type === 'TOUCH_PAGE') {
      const msg = message as TouchPageMessage;
      touchPageAccess({ pageId: msg.pageId, url: msg.url }).catch((e) => {
        console.error('[PageTrace] Touch page error:', e);
      });
      return undefined;
    }

    if (message.type === 'NAVIGATE_TO_RESULT') {
      handleNavigateToResult(message as NavigateToResultMessage).catch((e) => {
        console.error('[PageTrace] Navigate to result error:', e);
      });
      return true;
    }

    if (message.type === 'INDEX_PAGE') {
      if (sender.tab?.incognito) {
        return undefined;
      }
      handleIndexPage(message as IndexPageMessage).catch((e) => {
        console.error('[PageTrace] Index error:', e);
      });
      return true;
    }

    if (message.type === 'SAVE_CUSTOM_INDEX') {
      if (sender.tab?.incognito) {
        return Promise.resolve({ id: -1, duplicate: false });
      }
      const msg = message as SaveCustomIndexMessage;
      return addCustomIndex({
        url: msg.url,
        pageTitle: msg.pageTitle,
        favicon: msg.favicon,
        name: msg.name,
        text: msg.text,
        selector: msg.selector,
      })
        .then((res) => {
          if (!res.duplicate) scheduleSearchCachePersist();
          return res;
        })
        .catch((e) => {
          console.error('[PageTrace] Save custom index error:', e);
          return { id: -1, duplicate: false };
        });
    }

    if (message.type === 'UPDATE_CUSTOM_INDEX') {
      const msg = message as UpdateCustomIndexMessage;
      return updateCustomIndex(msg.id, msg.changes)
        .then((res) => {
          if (res.updated) scheduleSearchCachePersist();
          return res;
        })
        .catch((e) => {
          console.error('[PageTrace] Update custom index error:', e);
          return { updated: false, duplicate: false };
        });
    }

    if (message.type === 'DELETE_CUSTOM_INDEX') {
      const msg = message as DeleteCustomIndexMessage;
      deleteCustomIndex(msg.id)
        .then(() => {
          scheduleSearchCachePersist();
        })
        .catch((e) => {
          console.error('[PageTrace] Delete custom index error:', e);
        });
      return true;
    }

    if (message.type === 'DELETE_PAGE') {
      const msg = message as DeletePageMessage;
      (async () => {
        if (msg.pageId !== undefined) {
          await deletePageById(msg.pageId);
        } else if (msg.url) {
          await deletePageByUrl(msg.url);
        }
        scheduleSearchCachePersist();
      })().catch((e) => {
        console.error('[PageTrace] Delete page error:', e);
      });
      return true;
    }

    if (message.type === 'GET_SEARCH_SUGGESTIONS') {
      return (async () => {
        await ensureBackgroundSearchIndex();
        return {
          tags: getAvailableTags(),
          domains: getAvailableDomains(),
        };
      })().catch((e) => {
        console.error('[PageTrace] Get search suggestions error:', e);
        return { tags: [], domains: [] };
      });
    }

    return undefined;
  },
);

// Navigate to target page and scroll to matched text
async function handleNavigateToResult(msg: NavigateToResultMessage): Promise<void> {
  const { url, text, selector } = msg;
  const targetNormalized = normalizePageUrl(url);

  await touchPageAccess({ url }).catch(() => {});

  // Check if a tab with this URL is already open
  try {
    const tabs = await browser.tabs.query({});
    const existingTab = tabs.find(
      (t) => t.id && t.url && normalizePageUrl(t.url) === targetNormalized,
    );

    if (existingTab?.id) {
      if (existingTab.windowId !== undefined) {
        await browser.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
      }
      await browser.tabs.update(existingTab.id, { active: true });

      if (text || selector) {
        try {
          await browser.tabs.sendMessage(existingTab.id, {
            type: 'SCROLL_TO',
            text,
            selector,
          });
          return;
        } catch {
          // Content script not active in existing tab; reload and scroll after load
          await browser.tabs.reload(existingTab.id);
          waitForTabAndScroll(existingTab.id, text, selector);
          return;
        }
      }
      return;
    }
  } catch (err) {
    console.warn('[PageTrace] Error checking existing tabs:', err);
  }

  // Find a normal browser window to open the tab in
  let targetWindowId: number | undefined;
  try {
    const normalWindows = await browser.windows.getAll({ windowTypes: ['normal'] });
    const focusedNormal = normalWindows.find((w) => w.focused) ?? normalWindows[0];
    if (focusedNormal?.id !== undefined) {
      targetWindowId = focusedNormal.id;
      await browser.windows.update(targetWindowId, { focused: true }).catch(() => {});
    }
  } catch {
    // Fallback to default window
  }

  // Create new tab and scroll once loaded
  const newTab = await browser.tabs.create({
    url,
    active: true,
    ...(targetWindowId !== undefined ? { windowId: targetWindowId } : {}),
  });

  if (newTab.id && (text || selector)) {
    waitForTabAndScroll(newTab.id, text, selector);
  }
}

function waitForTabAndScroll(tabId: number, text: string, selector: string): void {
  let done = false;

  const cleanup = (): void => {
    if (done) return;
    done = true;
    browser.tabs.onUpdated.removeListener(listener);
    clearTimeout(timeoutId);
  };

  const listener = (updatedTabId: number, changeInfo: { status?: string }): void => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') {
      cleanup();
      setTimeout(() => {
        browser.tabs
          .sendMessage(tabId, {
            type: 'SCROLL_TO',
            text,
            selector,
          })
          .catch((err) => {
            console.warn('[PageTrace] Could not send SCROLL_TO after load:', err);
          });
      }, 300);
    }
  };

  const timeoutId = setTimeout(cleanup, 20000);
  browser.tabs.onUpdated.addListener(listener);
}

async function isIndexingPaused(): Promise<boolean> {
  try {
    const data = await browser.storage.local.get('pt_paused_until');
    const pausedUntil = Number(data?.pt_paused_until || 0);
    if (pausedUntil === -1) return true;
    if (pausedUntil > Date.now()) return true;
    if (pausedUntil > 0 && pausedUntil <= Date.now()) {
      await browser.storage.local.set({ pt_paused_until: 0 }).catch(() => {});
      return false;
    }
  } catch {}
  return false;
}

function isUrlAllowedForIndexing(url: string, settings: UserSettings): boolean {
  if (settings.urlFilterMode === 'whitelist') {
    if (!settings.whitelist || settings.whitelist.length === 0) return false;
    return settings.whitelist.some((pattern) => matchUrlPattern(pattern, url));
  }
  return !isBlacklisted(url, settings.blacklist);
}

// Save indexed page data
async function handleIndexPage(msg: IndexPageMessage): Promise<void> {
  if (isSystemPage(msg.url)) return;

  const settings = await getSettings();

  if (!settings.enabled) return;
  if (await isIndexingPaused()) return;
  if (!isUrlAllowedForIndexing(msg.url, settings)) return;

  await upsertPage(
    msg.url,
    msg.title,
    msg.favicon,
    msg.chunks,
    settings.indexMedia ? msg.media : [],
  );
  scheduleSearchCachePersist();
}

function isSystemPage(url: string): boolean {
  return (
    url.startsWith('about:') ||
    url.startsWith('chrome://') ||
    url.startsWith('moz-extension://') ||
    url.startsWith('chrome-extension://') ||
    url.includes('addons.mozilla.org') ||
    url.includes('chrome.google.com/webstore')
  );
}

function isBlacklisted(url: string, blacklist: string[]): boolean {
  if (!blacklist.length) return false;
  return blacklist.some((pattern) => matchUrlPattern(pattern, url));
}
