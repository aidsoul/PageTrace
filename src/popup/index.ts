import browser from 'webextension-polyfill';
import { getSettings, matchesHotkey } from '@/common/settings';
import { applyI18nToDOM, getLocale } from '@/i18n/index';
import type { UserSettings } from '@/types/index';

// Extension popup script

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function renderShortcutKeys(hotkey: string): void {
  const container = $('shortcutKeys');
  if (!container) return;

  const keys = (hotkey || 'Alt+Shift+F')
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean);

  container.replaceChildren();
  keys.forEach((key, idx) => {
    if (idx > 0) {
      container.appendChild(document.createTextNode(' + '));
    }
    const kbd = document.createElement('kbd');
    kbd.textContent = key;
    container.appendChild(kbd);
  });
}

function renderStatusBadge(enabled: boolean, paused: boolean): void {
  const badge = $('statusBadge');
  if (!badge) return;
  if (!enabled) {
    badge.textContent = 'OFF';
    badge.style.background = 'rgba(126, 131, 143, 0.15)';
    badge.style.color = '#7E838F';
    badge.style.borderColor = 'rgba(126, 131, 143, 0.25)';
    return;
  }
  if (paused) {
    badge.textContent = 'PAUSED';
    badge.style.background = 'rgba(245, 158, 11, 0.15)';
    badge.style.color = '#F59E0B';
    badge.style.borderColor = 'rgba(245, 158, 11, 0.35)';
    return;
  }
  badge.textContent = 'ON';
  badge.style.background = 'rgba(244, 255, 43, 0.12)';
  badge.style.color = '#F4FF2B';
  badge.style.borderColor = 'rgba(244, 255, 43, 0.25)';
}

function renderSnoozeState(pausedUntil: number, lang: string): void {
  const statusEl = $('indexingStatusText');
  const snoozeActions = $('snoozeActions');
  const resumeBtn = $<HTMLButtonElement>('resumeBtn');
  const snooze15Btn = $<HTMLButtonElement>('snooze15Btn');
  const snooze60Btn = $<HTMLButtonElement>('snooze60Btn');
  const snoozeRestartBtn = $<HTMLButtonElement>('snoozeRestartBtn');

  const t = getLocale(lang);
  const now = Date.now();
  const isPaused = pausedUntil === -1 || pausedUntil > now;

  [snooze15Btn, snooze60Btn, snoozeRestartBtn].forEach((btn) => btn?.classList.remove('active'));

  if (isPaused) {
    statusEl?.classList.add('paused');
    if (pausedUntil === -1) {
      if (statusEl) statusEl.textContent = t.popup.indexingStatusPausedRestart;
      snoozeRestartBtn?.classList.add('active');
    } else {
      const minsLeft = Math.max(1, Math.ceil((pausedUntil - now) / 60000));
      if (statusEl) statusEl.textContent = t.popup.indexingStatusPaused(minsLeft);
      if (minsLeft <= 16) {
        snooze15Btn?.classList.add('active');
      } else {
        snooze60Btn?.classList.add('active');
      }
    }
    if (resumeBtn) resumeBtn.style.display = 'block';
    snoozeActions?.classList.add('has-resume');
  } else {
    statusEl?.classList.remove('paused');
    if (statusEl) statusEl.textContent = t.popup.indexingStatusActive;
    if (resumeBtn) resumeBtn.style.display = 'none';
    snoozeActions?.classList.remove('has-resume');
  }
}

async function init(): Promise<void> {
  const settings = await getSettings();
  let currentHotkey = settings.hotkey || 'Alt+Shift+F';
  let currentEnabled = settings.enabled;
  let currentLanguage = settings.language;

  let localData = await browser.storage.local.get('pt_paused_until').catch(() => ({ pt_paused_until: 0 }));
  let currentPausedUntil = Number(localData?.pt_paused_until || 0);

  const isPaused = currentPausedUntil === -1 || currentPausedUntil > Date.now();
  applyI18nToDOM(document, currentLanguage);
  renderStatusBadge(currentEnabled, isPaused);
  renderShortcutKeys(currentHotkey);
  renderSnoozeState(currentPausedUntil, currentLanguage);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes['settings']) {
      const next = changes['settings'].newValue as Partial<UserSettings> | undefined;
      if (!next) return;
      if (next.language) {
        currentLanguage = next.language;
        applyI18nToDOM(document, next.language);
        renderSnoozeState(currentPausedUntil, currentLanguage);
      }
      if (typeof next.enabled === 'boolean') {
        currentEnabled = next.enabled;
        const paused = currentPausedUntil === -1 || currentPausedUntil > Date.now();
        renderStatusBadge(currentEnabled, paused);
      }
      if (next.hotkey) {
        currentHotkey = next.hotkey;
        renderShortcutKeys(currentHotkey);
      }
    }

    if (area === 'local' && changes['pt_paused_until']) {
      currentPausedUntil = Number(changes['pt_paused_until'].newValue || 0);
      const paused = currentPausedUntil === -1 || currentPausedUntil > Date.now();
      renderStatusBadge(currentEnabled, paused);
      renderSnoozeState(currentPausedUntil, currentLanguage);
    }
  });

  async function setSnooze(minutes: number): Promise<void> {
    const target = Date.now() + minutes * 60 * 1000;
    currentPausedUntil = target;
    await browser.alarms.create('pt_snooze_alarm', { delayInMinutes: minutes }).catch(() => {});
    await browser.storage.local.set({ pt_paused_until: target }).catch(() => {});
    renderStatusBadge(currentEnabled, true);
    renderSnoozeState(target, currentLanguage);
  }

  async function setSnoozeUntilRestart(): Promise<void> {
    currentPausedUntil = -1;
    await browser.alarms.clear('pt_snooze_alarm').catch(() => {});
    await browser.storage.local.set({ pt_paused_until: -1 }).catch(() => {});
    renderStatusBadge(currentEnabled, true);
    renderSnoozeState(-1, currentLanguage);
  }

  async function resumeIndexing(): Promise<void> {
    currentPausedUntil = 0;
    await browser.alarms.clear('pt_snooze_alarm').catch(() => {});
    await browser.storage.local.set({ pt_paused_until: 0 }).catch(() => {});
    renderStatusBadge(currentEnabled, false);
    renderSnoozeState(0, currentLanguage);
  }

  $('snooze15Btn')?.addEventListener('click', () => {
    void setSnooze(15);
  });

  $('snooze60Btn')?.addEventListener('click', () => {
    void setSnooze(60);
  });

  $('snoozeRestartBtn')?.addEventListener('click', () => {
    void setSnoozeUntilRestart();
  });

  $('resumeBtn')?.addEventListener('click', () => {
    void resumeIndexing();
  });

  const searchBtn = $('openSearchBtn');
  if (searchBtn) {
    searchBtn.addEventListener('click', async () => {
      try {
        await browser.runtime.sendMessage({ type: 'OPEN_SEARCH_WINDOW' });
      } catch (err) {
        console.error('[PageTrace] Could not send OPEN_SEARCH_WINDOW message:', err);
      }
      window.close();
    });
  }

  const optionsBtn = $('openOptions');
  if (optionsBtn) {
    optionsBtn.addEventListener('click', () => {
      browser.runtime.openOptionsPage();
    });
  }

  window.addEventListener(
    'keydown',
    async (e: KeyboardEvent) => {
      if (!currentEnabled || !currentHotkey) return;
      if (matchesHotkey(e, currentHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        try {
          await browser.runtime.sendMessage({ type: 'OPEN_SEARCH_WINDOW' });
        } catch {}
        window.close();
      }
    },
    true,
  );
}

init();
