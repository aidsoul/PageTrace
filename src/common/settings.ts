import type { UserSettings } from '@/types/index';
import { DEFAULT_SETTINGS } from '@/types/index';
import browser from 'webextension-polyfill';

let cachedSettings: UserSettings | null = null;
let listenerRegistered = false;

function ensureStorageListener(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;
  try {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes['settings']) {
        const next = changes['settings'].newValue as Partial<UserSettings> | undefined;
        cachedSettings = { ...DEFAULT_SETTINGS, ...next };
      }
    });
  } catch {
    // Ignore if storage API is unavailable
  }
}

export async function getSettings(): Promise<UserSettings> {
  ensureStorageListener();
  if (cachedSettings) {
    return cachedSettings;
  }
  try {
    const stored = await browser.storage.sync.get('settings');
    cachedSettings = {
      ...DEFAULT_SETTINGS,
      ...(stored.settings as Partial<UserSettings> | undefined),
    };
    return cachedSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Partial<UserSettings>): Promise<void> {
  const current = await getSettings();
  const next = { ...current, ...settings };
  cachedSettings = next;
  await browser.storage.sync.set({ settings: next });
}

const CODE_KEY_MAP: Record<string, string> = {
  Space: 'Space',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph']);

export function formatHotkeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key) || e.key === 'Tab' || e.key === 'Escape') {
    return null;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Command');

  const isFunctionKey = /^F([1-9]|1[0-2])$/i.test(e.code || e.key);
  if (parts.length === 0 && !isFunctionKey) {
    return null;
  }

  const code = e.code || '';
  let keyName: string;
  if (code.startsWith('Key') && code.length === 4) {
    keyName = code.slice(3).toUpperCase();
  } else if (code.startsWith('Digit') && code.length === 6) {
    keyName = code.slice(5);
  } else if (code.startsWith('Numpad') && code.length > 6) {
    keyName = code;
  } else if (CODE_KEY_MAP[code]) {
    keyName = CODE_KEY_MAP[code]!;
  } else if (isFunctionKey) {
    keyName = (code || e.key).toUpperCase();
  } else if (e.key === ' ') {
    keyName = 'Space';
  } else {
    keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }

  parts.push(keyName);
  return parts.join('+');
}

export function matchesHotkey(e: KeyboardEvent, targetHotkey: string): boolean {
  if (!targetHotkey) return false;
  const formatted = formatHotkeyEvent(e);
  if (!formatted) return false;

  const normTarget = targetHotkey.trim().toLowerCase();
  if (formatted.toLowerCase() === normTarget) {
    return true;
  }

  // Fallback for macOS where Command might have been stored as Ctrl
  if (e.metaKey && !e.ctrlKey) {
    const asCtrl = formatted.replace(/\bCommand\b/i, 'Ctrl').toLowerCase();
    if (asCtrl === normTarget) {
      return true;
    }
  }

  // Fallback if a legacy shortcut was saved with a localized e.key character
  if (e.key && e.key.length === 1) {
    const legacyParts: string[] = [];
    if (e.ctrlKey || e.metaKey) legacyParts.push('ctrl');
    if (e.altKey) legacyParts.push('alt');
    if (e.shiftKey) legacyParts.push('shift');
    legacyParts.push(e.key.toLowerCase());
    if (legacyParts.join('+') === normTarget) {
      return true;
    }
  }

  return false;
}

