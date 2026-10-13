import browser from 'webextension-polyfill';
import type { IndexDepth, IndexPageMessage, MediaItem, SiteTagRule, TextChunk, UserSettings, SaveCustomIndexMessage } from '@/types/index';
import { getLocale, DEFAULT_LANGUAGE } from '@/i18n/index';
import { setSafeHtml, matchUrlPattern } from '@/common/tags';
import { getSettings, matchesHotkey } from '@/common/settings';
import { initOverlayInShadow, showOverlayInShadow } from '@/overlay/index';

// Content script: DOM parser, indexer, and in-page UI

declare const __BROWSER__: string;

const DEBOUNCE_MS = 1000;
const THROTTLE_MS = 3000;

let hasIndexed = false;
let observerStarted = false;
let mutationThrottle: ReturnType<typeof setTimeout> | null = null;
let mutationLastRun = 0;
let lastParsedUrl = '';
let lastBodyTextLength = -1;

function isIncognito(): boolean {
  try {
    return Boolean(browser.extension?.inIncognitoContext);
  } catch {
    return false;
  }
}

function normalizeContentUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return rawUrl.split('#')[0]?.replace(/\/$/, '') ?? rawUrl;
  }
}

// Listen for background messages
browser.runtime.onMessage.addListener((rawMsg: unknown) => {
  const msg = rawMsg as { type: string };
  if (msg.type === 'TOGGLE_OVERLAY') {
    toggleOverlay();
  }
  if (msg.type === 'SCROLL_TO') {
    const { text, selector } = rawMsg as { type: string; text: string; selector: string };
    void scrollAndHighlight(text, selector);
  }
  if (msg.type === 'TRIGGER_CREATE_INDEX_FROM_SELECTION') {
    const { text } = rawMsg as { type: string; text?: string };
    window.dispatchEvent(new CustomEvent('pt:trigger-create-index', { detail: { text } }));
  }
  if (msg.type === 'SHOW_TOAST') {
    const { message } = rawMsg as { type: string; message?: string };
    if (message) {
      showToast(message);
    }
  }
});

// Listen for overlay custom events (same-page scroll or cross-tab navigation)
window.addEventListener('pt:scroll', (e: Event) => {
  const detail = (e as CustomEvent<{ text: string; selector: string }>).detail;
  if (detail) {
    void scrollAndHighlight(detail.text, detail.selector);
  }
});

window.addEventListener('pt:navigate', (e: Event) => {
  const detail = (e as CustomEvent<{ url: string; text: string; selector: string }>).detail;
  if (detail?.url) {
    browser.runtime
      .sendMessage({
        type: 'NAVIGATE_TO_RESULT',
        url: detail.url,
        text: detail.text || '',
        selector: detail.selector || '',
      })
      .catch(() => {
        window.open(detail.url, '_blank', 'noopener');
      });
  }
});

// Custom hotkey listener
let cachedHotkey = 'Alt+Shift+F';
let cachedEnabled = true;

async function syncHotkeySetting(): Promise<void> {
  try {
    const s = await getSettings();
    if (s.hotkey) cachedHotkey = s.hotkey;
    if (typeof s.enabled === 'boolean') cachedEnabled = s.enabled;
  } catch {}
}
void syncHotkeySetting();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes['settings']) {
    const s = changes['settings'].newValue as Partial<UserSettings> | undefined;
    if (s?.hotkey) cachedHotkey = s.hotkey;
    if (typeof s?.enabled === 'boolean') cachedEnabled = s.enabled;
  }
});

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

window.addEventListener(
  'keydown',
  (e: KeyboardEvent) => {
    if (!cachedEnabled || !cachedHotkey) return;
    if (!e.altKey && !e.ctrlKey && !e.metaKey && isEditableEventTarget(e.target)) {
      return;
    }
    if (matchesHotkey(e, cachedHotkey)) {
      e.preventDefault();
      e.stopPropagation();
      browser.runtime.sendMessage({ type: 'OPEN_SEARCH_WINDOW' }).catch(() => {});
    }
  },
  true,
);

// MutationObserver for SPA and infinite scroll updates
const observer = new MutationObserver(() => {
  const now = Date.now();
  if (now - mutationLastRun < THROTTLE_MS) {
    if (!mutationThrottle) {
      mutationThrottle = setTimeout(() => {
        mutationThrottle = null;
        mutationLastRun = Date.now();
        scheduleParseIfChanged();
      }, THROTTLE_MS);
    }
    return;
  }
  mutationLastRun = now;
  scheduleParseIfChanged();
});

function scheduleParseIfChanged(): void {
  const currentUrl = normalizeContentUrl(location.href);
  const currentLen = document.body?.textContent?.length ?? 0;
  // Skip DOM traversal if URL is unchanged and text length changed by less than 32 chars
  if (hasIndexed && currentUrl === lastParsedUrl && Math.abs(currentLen - lastBodyTextLength) < 32) {
    return;
  }
  void parsePage();
}

function startMutationObserver(): void {
  if (observerStarted) return;
  const target = document.body ?? document.documentElement;
  if (!target) return;
  observerStarted = true;
  mutationLastRun = Date.now();
  observer.observe(target, {
    childList: true,
    subtree: true,
  });
}

// Initial debounced page parse
function scheduleInitialParse(): void {
  setTimeout(async () => {
    if (!hasIndexed) {
      await parsePage();
    }
    startMutationObserver();
  }, DEBOUNCE_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleInitialParse, { once: true });
} else {
  scheduleInitialParse();
}

// Core DOM parser
let lastIndexedSignature = '';
let isParseScheduled = false;

async function parsePage(): Promise<void> {
  if (isIncognito() || isParseScheduled) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  isParseScheduled = true;

  const runExtraction = (): void => {
    isParseScheduled = false;
    const indexDepth: IndexDepth = settings.indexDepth ?? 'semantic';
    const indexMedia: boolean = settings.indexMedia ?? true;
    const mediaWhitelist: string[] = settings.mediaWhitelist ?? ['png', 'jpg', 'jpeg', 'webp', 'pdf'];
    const customTags: string = settings.customTags ?? '';
    const siteTagRules: SiteTagRule[] = settings.siteTagRules ?? [];

    const url = normalizeContentUrl(location.href);
    const title = document.title;
    const favicon = getFavicon();

    lastParsedUrl = url;
    lastBodyTextLength = document.body?.textContent?.length ?? 0;

    const chunks = extractTextChunks(indexDepth, url, customTags, siteTagRules);
    const media = indexMedia ? extractMedia(url, mediaWhitelist) : [];

    if (chunks.length === 0 && media.length === 0) return;

    // Signature check to avoid resending identical page data
    const firstChunkSample = chunks[0]?.text.slice(0, 80) ?? '';
    const lastChunkSample = chunks[chunks.length - 1]?.text.slice(0, 80) ?? '';
    const totalChars = chunks.reduce((acc, c) => acc + c.text.length, 0);
    const signature = `${url}|${indexDepth}|${chunks.length}|${totalChars}|${media.length}|${firstChunkSample}|${lastChunkSample}`;
    if (signature === lastIndexedSignature) return;
    lastIndexedSignature = signature;

    hasIndexed = true;

    const msg: IndexPageMessage = {
      type: 'INDEX_PAGE',
      url,
      title,
      favicon,
      chunks,
      media,
    };
    browser.runtime.sendMessage(msg).catch(() => {
      // Background not ready yet
    });
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(runExtraction, { timeout: 2500 });
  } else {
    setTimeout(runExtraction, 50);
  }
}

// Text extraction
function extractPageMeta(): Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[] {
  const metaChunks: Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[] = [];

  const descEl =
    document.querySelector<HTMLMetaElement>('meta[name="description"]') ||
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]') ||
    document.querySelector<HTMLMetaElement>('meta[name="twitter:description"]');
  const descText = descEl?.content?.trim();
  if (descText && descText.length >= 10) {
    metaChunks.push({ text: descText, selector: 'meta[name="description"]', depth: 1 });
  }

  const keywordsEl = document.querySelector<HTMLMetaElement>('meta[name="keywords"]');
  const keywordsText = keywordsEl?.content?.trim();
  if (keywordsText && keywordsText.length >= 5) {
    metaChunks.push({ text: keywordsText, selector: 'meta[name="keywords"]', depth: 2 });
  }

  return metaChunks;
}

const NOISE_CLASS_ID_REGEX = /cookie|consent|banner-ad|advertisement|sidebar-menu|popup-modal|popup-overlay/i;

function isBoilerplateOrNoise(el: Element): boolean {
  const noiseContainer = el.closest(
    'header, footer, nav, aside, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="dialog"], [aria-modal="true"]',
  );
  if (noiseContainer) return true;

  let current: Element | null = el;
  let depth = 0;
  while (current && current !== document.body && depth < 4) {
    const cls = typeof current.className === 'string' ? current.className : '';
    const id = current.id || '';
    if ((cls || id) && NOISE_CLASS_ID_REGEX.test(`${cls} ${id}`)) {
      return true;
    }
    current = current.parentElement;
    depth++;
  }

  return false;
}

function getMatchingSiteTags(url: string, siteRules: SiteTagRule[] = []): string | null {
  for (const rule of siteRules) {
    const pattern = rule.domain.trim();
    if (!pattern) continue;
    if (matchUrlPattern(pattern, url)) {
      return rule.tags;
    }
  }
  return null;
}

function extractTextChunks(
  depth: IndexDepth,
  url: string,
  customTags?: string,
  siteTagRules?: SiteTagRule[],
): Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[] {
  const chunks: Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[] = [];
  const seenTexts = new Set<string>();

  const pushUniqueChunk = (el: Element, rawText: string, level: number): void => {
    const norm = normalizeSearchText(rawText);
    if (!norm || seenTexts.has(norm)) return;
    seenTexts.add(norm);
    chunks.push({ text: rawText, selector: getCSSSelector(el), depth: level });
  };

  // Check if this site has custom selector rules
  const matchedSiteRuleTags = getMatchingSiteTags(url, siteTagRules);
  if (matchedSiteRuleTags) {
    const selectors = matchedSiteRuleTags
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (selectors.length > 0) {
      for (const m of extractPageMeta()) {
        seenTexts.add(normalizeSearchText(m.text));
        chunks.push(m);
      }

      const querySelectorStr = selectors.join(', ');
      try {
        document.querySelectorAll<HTMLElement>(querySelectorStr).forEach((el) => {
          const text = el.textContent?.trim();
          if (!text || text.length < 5) return;
          if (isScriptLike(el) || isInteractive(el) || isHidden(el) || isBoilerplateOrNoise(el)) return;
          const isHeading = /^H[1-6]$/i.test(el.tagName);
          const level = isHeading ? parseInt(el.tagName[1]!, 10) : 0;
          pushUniqueChunk(el, text, level);
        });

        if (chunks.length > 0) {
          return chunks;
        }
      } catch (err) {
        console.warn('[PageTrace] Error querying custom site selectors:', querySelectorStr, err);
      }
    }
  }

  // Include page meta descriptions for semantic and full modes
  if (depth !== 'headings') {
    for (const m of extractPageMeta()) {
      seenTexts.add(normalizeSearchText(m.text));
      chunks.push(m);
    }
  }

  // Headings only mode (h1-h6)
  if (depth === 'headings') {
    document.querySelectorAll<HTMLHeadingElement>('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const text = el.textContent?.trim();
      if (!text || isInteractive(el) || isHidden(el) || isBoilerplateOrNoise(el)) return;
      const level = parseInt(el.tagName[1]!, 10);
      pushUniqueChunk(el, text, level);
    });
    return chunks;
  }

  // Semantic mode
  if (depth === 'semantic') {
    document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const text = el.textContent?.trim();
      if (!text || isInteractive(el) || isHidden(el) || isBoilerplateOrNoise(el)) return;
      const level = parseInt(el.tagName[1]!, 10);
      pushUniqueChunk(el, text, level);
    });

    const primaryContainers = Array.from(
      document.querySelectorAll<HTMLElement>(
        'article, main, [role="main"], [role="article"], .content, .post-content, .article-content, .entry-content, .markdown-body, #content, #main',
      ),
    ).filter((c) => !isHidden(c) && !isBoilerplateOrNoise(c));

    const contentTargets = primaryContainers.length > 0 ? primaryContainers : [document.body];

    const defaultSemanticSelectors = 'p, li, blockquote, figcaption, td, th, pre, code, dd, dt, details summary';
    const customSelectorList = (customTags || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const targetSelectors = customSelectorList.length > 0 ? customSelectorList.join(', ') : defaultSemanticSelectors;

    contentTargets.forEach((container) => {
      if (!container) return;
      try {
        container.querySelectorAll<HTMLElement>(targetSelectors).forEach((el) => {
          const text = el.textContent?.trim();
          const isHeading = /^H[1-6]$/i.test(el.tagName);
          const isCodeOrTable = el.tagName === 'PRE' || el.tagName === 'CODE' || el.tagName === 'TD' || el.tagName === 'TH';
          const minLen = isHeading ? 3 : isCodeOrTable ? 10 : 18;
          if (!text || text.length < minLen) return;
          if (isScriptLike(el) || isInteractive(el) || isHidden(el) || isBoilerplateOrNoise(el)) return;

          const level = isHeading ? parseInt(el.tagName[1]!, 10) : 0;
          pushUniqueChunk(el, text, level);
        });
      } catch (err) {
        console.warn('[PageTrace] Invalid custom selector in semantic mode:', targetSelectors, err);
      }
    });

    return chunks;
  }

  // Full DOM mode: use TreeWalker to skip hidden and boilerplate subtrees
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        const el = node as HTMLElement;
        if (
          isScriptLike(el) ||
          isInteractive(el) ||
          el.id === 'pagetrace-overlay-host' ||
          el.id === 'pagetrace-selection-host' ||
          /^(HEADER|FOOTER|NAV|ASIDE|DIALOG)$/i.test(el.tagName) ||
          isHidden(el)
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let currentEl: HTMLElement | null;
    while ((currentEl = walker.nextNode() as HTMLElement | null)) {
      let direct = '';
      for (let i = 0; i < currentEl.childNodes.length; i++) {
        const child = currentEl.childNodes[i]!;
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent?.trim();
          if (t) direct += (direct ? ' ' : '') + t;
        }
      }
      if (direct.length < 15) continue;
      if (isBoilerplateOrNoise(currentEl)) continue;
      const isHeading = /^H[1-6]$/i.test(currentEl.tagName);
      const level = isHeading ? parseInt(currentEl.tagName[1]!, 10) : 0;
      pushUniqueChunk(currentEl, direct, level);
    }
  }

  return chunks;
}

// Media extraction
function extractMedia(
  pageUrl: string,
  whitelist: string[],
): Omit<MediaItem, 'id' | 'pageId' | 'createdAt'>[] {
  const items: Omit<MediaItem, 'id' | 'pageId' | 'createdAt'>[] = [];
  const seen = new Set<string>();
  const allowedExts = new Set(whitelist.map((w) => w.toLowerCase()));

  // Images
  document.querySelectorAll<HTMLImageElement>('img').forEach((el) => {
    let url = el.currentSrc || el.src;
    if (!url && el.parentElement?.tagName === 'PICTURE') {
      const source = el.parentElement.querySelector<HTMLSourceElement>('source[srcset]');
      const firstSrc = source?.srcset?.split(',')[0]?.trim().split(/\s+/)[0];
      if (firstSrc) url = firstSrc;
    }
    if (!url) return;
    const absUrl = absoluteUrl(url, pageUrl);
    if (seen.has(absUrl)) return;
    const ext = getExt(absUrl);
    if (!allowedExts.has(ext)) return;
    seen.add(absUrl);
    items.push({
      type: 'image',
      url: absUrl,
      alt: el.alt ?? '',
      title: el.title ?? '',
      filename: getFilename(absUrl),
      extension: ext,
    });
  });

  // Inline SVGs
  if (allowedExts.has('svg')) {
    document.querySelectorAll<SVGElement>('svg').forEach((el) => {
      if (isHidden(el)) return;
      const title = el.querySelector('title')?.textContent?.trim() ?? '';
      if (!title) return;
      const id = `svg:${title}`;
      if (seen.has(id)) return;
      seen.add(id);
      items.push({
        type: 'image',
        url: '',
        alt: title,
        title,
        filename: '',
        extension: 'svg',
      });
    });
  }

  // Document links
  const DOC_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv']);
  document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((el) => {
    const href = el.href;
    if (!href) return;
    const absUrl = absoluteUrl(href, pageUrl);
    if (seen.has(absUrl)) return;
    const ext = getExt(absUrl);
    if (!DOC_EXTS.has(ext) || !allowedExts.has(ext)) return;
    seen.add(absUrl);
    items.push({
      type: 'document',
      url: absUrl,
      alt: '',
      title: el.textContent?.trim() ?? '',
      filename: getFilename(absUrl),
      extension: ext,
    });
  });

  return items;
}

// Scroll and highlight matched text on page
function normalizeSearchText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function ensureHighlightStyles(): void {
  if (document.getElementById('pagetrace-highlight-styles')) return;
  const style = document.createElement('style');
  style.id = 'pagetrace-highlight-styles';
  style.textContent = `
    ::highlight(pagetrace-match) {
      background-color: #FDE047;
      color: #0F172A;
    }
    @keyframes pt-target-pulse {
      0% {
        box-shadow: 0 0 0 0 rgba(253, 224, 71, 0.85), 0 0 0 4px rgba(253, 224, 71, 0.35);
        background-color: rgba(253, 224, 71, 0.28);
      }
      70% {
        box-shadow: 0 0 0 6px rgba(253, 224, 71, 0), 0 0 0 2px rgba(253, 224, 71, 0.45);
        background-color: rgba(253, 224, 71, 0.14);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(253, 224, 71, 0);
        background-color: transparent;
      }
    }
    .pt-scroll-target-flash {
      border-radius: 4px;
      animation: pt-target-pulse 3.2s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function findTargetElement(text: string, selector: string): HTMLElement | null {
  if (!document.body) return null;

  const normFull = normalizeSearchText(text);
  const needles = [
    normFull.slice(0, 100),
    normFull.slice(0, 60),
    normFull.slice(0, 30),
  ].filter((n) => n.length > 0);

  // Try exact CSS selector first, but verify it matches text to avoid outdated selectors
  if (selector && !selector.startsWith('meta[') && !selector.startsWith('http')) {
    try {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => !isHidden(el),
      );
      if (candidates.length > 0) {
        if (needles.length === 0) return candidates[0]!;
        for (const needle of needles) {
          const matched = candidates.find((el) =>
            normalizeSearchText(el.textContent ?? '').includes(needle),
          );
          if (matched) return matched;
        }
      }
    } catch {
      // Ignore invalid selector syntax
    }
  }

  if (needles.length === 0) return null;

  // Search text nodes with TreeWalker with whitespace normalization
  for (const needle of needles) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const parent = node.parentElement;
      if (!parent || isScriptLike(parent) || isHidden(parent)) continue;
      if (normalizeSearchText(node.textContent ?? '').includes(needle)) {
        return parent;
      }
    }
  }

  // Fallback: search block and inline elements whose normalized textContent matches
  for (const needle of needles) {
    let bestMatch: HTMLElement | null = null;
    let bestLen = Infinity;

    const elements = document.body.querySelectorAll<HTMLElement>(
      'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, pre, code, dd, dt, summary, article, section, div, span, a',
    );
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]!;
      if (isScriptLike(el) || isHidden(el)) continue;
      const elNorm = normalizeSearchText(el.textContent ?? '');
      if (elNorm.includes(needle) && elNorm.length < bestLen) {
        bestMatch = el;
        bestLen = elNorm.length;
      }
    }

    if (bestMatch) return bestMatch;
  }

  // For meta description matches, scroll to top h1 or body
  if (selector && selector.startsWith('meta[')) {
    return document.querySelector<HTMLElement>('h1') || document.body;
  }

  return null;
}

export async function scrollAndHighlight(text: string, selector: string, attempt = 0): Promise<void> {
  const target = findTargetElement(text, selector);

  if (!target) {
    // Retry for dynamically rendered SPA content
    if (attempt < 10) {
      setTimeout(() => {
        void scrollAndHighlight(text, selector, attempt + 1);
      }, 300);
      return;
    }

    // Fallback: use native Scroll-to-Text Fragment (#:~:text=...) if selector is outdated or element is dynamic
    if (text && text.trim().length > 0) {
      const cleanSnippet = encodeURIComponent(text.trim().slice(0, 80).replace(/\s+/g, ' '));
      try {
        const textDirective = `:~:text=${cleanSnippet}`;
        if (!window.location.hash.includes(':~:text=')) {
          window.location.hash = textDirective;
        }
      } catch {}
    }

    let lang = DEFAULT_LANGUAGE;
    try {
      const s = await getSettings();
      if (s.language) lang = s.language;
    } catch {}
    showToast(getLocale(lang).content.toastTextNotFound);
    return;
  }

  ensureHighlightStyles();

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  highlightElement(target, text);
}

function highlightElement(el: HTMLElement, matchText: string): void {
  el.classList.remove('pt-scroll-target-flash');
  void el.offsetWidth; // trigger reflow to restart animation
  el.classList.add('pt-scroll-target-flash');
  setTimeout(() => {
    el.classList.remove('pt-scroll-target-flash');
  }, 3300);

  // Highlight exact text range via CSS Custom Highlight API when supported
  if (!matchText || !('Highlight' in window) || !('highlights' in CSS)) return;

  try {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNodes: { node: Text; start: number; end: number }[] = [];
    let fullText = '';
    let current: Text | null;

    while ((current = walker.nextNode() as Text | null)) {
      const val = current.textContent ?? '';
      if (!val) continue;
      const start = fullText.length;
      fullText += val;
      textNodes.push({ node: current, start, end: fullText.length });
    }

    if (!fullText || textNodes.length === 0) return;

    const fullLower = fullText.toLowerCase();
    const rawSnippet = matchText.trim().slice(0, 80).toLowerCase();
    let matchStart = fullLower.indexOf(rawSnippet);
    let matchEnd = matchStart !== -1 ? matchStart + rawSnippet.length : -1;

    if (matchStart === -1) {
      const escapedWords = matchText
        .trim()
        .slice(0, 80)
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (escapedWords.length > 0) {
        const rx = new RegExp(escapedWords.join('\\s+'), 'i');
        const m = rx.exec(fullText);
        if (m && m.index !== undefined) {
          matchStart = m.index;
          matchEnd = m.index + m[0].length;
        }
      }
    }

    if (matchStart !== -1 && matchEnd > matchStart) {
      const startEntry = textNodes.find((t) => matchStart >= t.start && matchStart < t.end);
      const endEntry = textNodes.find((t) => matchEnd > t.start && matchEnd <= t.end);

      if (startEntry && endEntry) {
        const range = document.createRange();
        range.setStart(startEntry.node, matchStart - startEntry.start);
        range.setEnd(endEntry.node, matchEnd - endEntry.start);

        const highlight = new (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight(range);
        (CSS as unknown as { highlights: Map<string, unknown> }).highlights.set('pagetrace-match', highlight);
        setTimeout(() => {
          (CSS as unknown as { highlights: Map<string, unknown> }).highlights.delete('pagetrace-match');
        }, 3500);
      }
    }
  } catch {
    // Ignore Range errors if DOM mutates mid-highlight
  }
}

function showToast(message: string): void {
  const toast = document.createElement('div');
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    zIndex: '2147483647',
    background: '#1E293B',
    color: '#FDE047',
    padding: '12px 20px',
    borderRadius: '10px',
    fontSize: '14px',
    fontFamily: 'system-ui, sans-serif',
    boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
    transition: 'opacity 0.5s',
    opacity: '1',
  });
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  setTimeout(() => { toast.remove(); }, 3100);
}

// Overlay toggle in Shadow DOM
let overlayLoaded = false;

function toggleOverlay(): void {
  if (!overlayLoaded) {
    injectOverlay();
    return;
  }
  const host = document.getElementById('pagetrace-overlay-host');
  if (host) {
    const isHiddenNow = host.style.display === 'none';
    host.style.display = isHiddenNow ? 'block' : 'none';
    if (isHiddenNow) {
      void showOverlayInShadow();
    }
  }
}

function injectOverlay(): void {
  overlayLoaded = true;

  const host = document.createElement('div');
  host.id = 'pagetrace-overlay-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647; pointer-events: none;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  ensureHighlightStyles();
  void initOverlayInShadow(shadow);
}

// DOM utility helpers
function isHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden === true || el.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  // Fast native C++ visibility check supported in modern Chrome & Firefox
  if ('checkVisibility' in el && typeof (el as HTMLElement).checkVisibility === 'function') {
    return !(el as HTMLElement).checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
  }
  const style = getComputedStyle(el);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  );
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    tag === 'button' ||
    (el as HTMLElement).isContentEditable
  );
}

function isScriptLike(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'script' || tag === 'style' || tag === 'noscript';
}

function getFavicon(): string {
  const link =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ||
    document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]');
  if (link?.href) return link.href;
  return `${location.origin}/favicon.ico`;
}

function getExt(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    return dot !== -1 ? path.slice(dot + 1).toLowerCase().split('?')[0]! : '';
  } catch {
    return '';
  }
}

function getFilename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

function absoluteUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function getCSSSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector += `#${CSS.escape(current.id)}`;
      parts.unshift(selector);
      break;
    }
    const parentEl: Element | null = current.parentElement;
    if (parentEl) {
      const children = parentEl.children;
      const targetTag = current.tagName;
      let sameTagCount = 0;
      let selfIndex = 0;
      for (let i = 0; i < children.length; i++) {
        const sibling = children[i]!;
        if (sibling.tagName === targetTag) {
          sameTagCount++;
          if (sibling === current) {
            selfIndex = sameTagCount;
          }
        }
      }
      if (sameTagCount > 1 && selfIndex > 0) {
        selector += `:nth-of-type(${selfIndex})`;
      }
    }
    parts.unshift(selector);
    current = parentEl;
  }
  return parts.join(' > ');
}

// Selection tooltip for creating custom indexes
function initSelectionIndexingWatcher(): void {
  if (isIncognito()) return;

  const host = document.createElement('div');
  host.id = 'pagetrace-selection-host';
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif;
    }

    .pt-selection-wrapper {
      position: fixed;
      display: none;
      z-index: 2147483646;
      pointer-events: auto;
      user-select: none;
    }

    .pt-pill-btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: #1E293B;
      color: #F8FAFC;
      border: 1px solid rgba(253, 224, 71, 0.4);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08);
      border-radius: 9999px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: pt-pop 0.18s cubic-bezier(0.16, 1, 0.3, 1);
      white-space: nowrap;
    }

    .pt-pill-btn:hover {
      background: #273549;
      border-color: #FDE047;
      color: #FDE047;
      transform: translateY(-1px) scale(1.02);
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55), 0 0 12px rgba(253, 224, 71, 0.25);
    }

    .pt-pill-icon {
      font-size: 14px;
      line-height: 1;
    }

    .pt-popover-card {
      display: none;
      width: 320px;
      background: #1E293B;
      border: 1px solid rgba(253, 224, 71, 0.35);
      border-radius: 12px;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.08);
      padding: 16px;
      animation: pt-pop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: auto;
    }

    .pt-popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }

    .pt-popover-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12.5px;
      font-weight: 600;
      color: #FDE047;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .pt-close-btn {
      background: transparent;
      border: none;
      color: #64748B;
      cursor: pointer;
      font-size: 14px;
      padding: 4px;
      line-height: 1;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }

    .pt-close-btn:hover {
      color: #F8FAFC;
      background: rgba(255, 255, 255, 0.08);
    }

    .pt-snippet-quote {
      background: rgba(15, 23, 42, 0.65);
      border-left: 3px solid #FDE047;
      border-radius: 4px;
      padding: 8px 10px;
      font-size: 12px;
      line-height: 1.45;
      color: #CBD5E1;
      max-height: 64px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      margin-bottom: 12px;
      word-break: break-word;
    }

    .pt-form-group {
      margin-bottom: 12px;
    }

    .pt-label {
      display: block;
      font-size: 11px;
      font-weight: 500;
      color: #94A3B8;
      margin-bottom: 5px;
    }

    .pt-input {
      width: 100%;
      background: #0F172A;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: 13px;
      color: #F8FAFC;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .pt-textarea {
      min-height: 48px;
      resize: vertical;
      font-family: inherit;
    }

    .pt-input:focus {
      border-color: #FDE047;
      box-shadow: 0 0 0 2px rgba(253, 224, 71, 0.2);
    }

    .pt-input::placeholder {
      color: #475569;
      font-size: 12px;
    }

    .pt-hint {
      font-size: 10.5px;
      color: #64748B;
      margin-top: 5px;
      line-height: 1.3;
    }

    .pt-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .pt-btn {
      border: none;
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }

    .pt-btn:active {
      transform: scale(0.97);
    }

    .pt-btn-cancel {
      background: rgba(255, 255, 255, 0.06);
      color: #94A3B8;
    }

    .pt-btn-cancel:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #F8FAFC;
    }

    .pt-btn-save {
      background: #FDE047;
      color: #1E293B;
    }

    .pt-btn-save:hover {
      opacity: 0.9;
    }

    @keyframes pt-pop {
      0% {
        opacity: 0;
        transform: scale(0.92) translateY(4px);
      }
      100% {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }
  `;
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'pt-selection-wrapper';

  setSafeHtml(
    wrapper,
    `
    <button type="button" class="pt-pill-btn" id="ptPillBtn">
      <span>Создать индекс</span>
    </button>
    <div class="pt-popover-card" id="ptPopoverCard">
      <div class="pt-popover-header">
        <div class="pt-popover-title">
          <span>Создать индекс</span>
        </div>
        <button type="button" class="pt-close-btn" id="ptCloseBtn" title="Закрыть">✕</button>
      </div>
      <div class="pt-snippet-quote" id="ptSnippetQuote"></div>
      <div class="pt-form-group">
        <label class="pt-label" for="ptIndexName" id="ptIndexNameLabel">Имя индекса (тег):</label>
        <input type="text" id="ptIndexName" class="pt-input" placeholder="По умолчанию: выбранный текст" autocomplete="off" />
        <div class="pt-hint">Оставьте пустым, чтобы индекс был создан с именем выбранного текста</div>
      </div>
      <div class="pt-form-group">
        <label class="pt-label" for="ptIndexNote" id="ptIndexNoteLabel">Заметка:</label>
        <textarea id="ptIndexNote" class="pt-input pt-textarea" rows="2" placeholder="Личная заметка или комментарий..." autocomplete="off"></textarea>
      </div>
      <div class="pt-actions">
        <button type="button" class="pt-btn pt-btn-cancel" id="ptCancelBtn">Отмена</button>
        <button type="button" class="pt-btn pt-btn-save" id="ptSaveBtn">Сохранить</button>
      </div>
    </div>
  `,
  );
  shadow.appendChild(wrapper);

  const pillBtn = shadow.getElementById('ptPillBtn') as HTMLButtonElement;
  const popoverCard = shadow.getElementById('ptPopoverCard') as HTMLElement;
  const closeBtn = shadow.getElementById('ptCloseBtn') as HTMLButtonElement;
  const cancelBtn = shadow.getElementById('ptCancelBtn') as HTMLButtonElement;
  const saveBtn = shadow.getElementById('ptSaveBtn') as HTMLButtonElement;
  const snippetQuote = shadow.getElementById('ptSnippetQuote') as HTMLElement;
  const indexNameInput = shadow.getElementById('ptIndexName') as HTMLInputElement;
  const indexNoteInput = shadow.getElementById('ptIndexNote') as HTMLTextAreaElement;

  let currentSelectedText = '';
  let currentTargetElement: HTMLElement | null = null;
  let currentRange: Range | null = null;
  let isPopoverOpen = false;
  let currentLang = DEFAULT_LANGUAGE;

  function updateWidgetText(): void {
    const t = getLocale(currentLang);
    const pillSpan = pillBtn?.querySelector('span');
    if (pillSpan) pillSpan.textContent = t.content.createIndexBtn;
    const titleSpan = popoverCard?.querySelector('.pt-popover-title span');
    if (titleSpan) titleSpan.textContent = t.content.popoverTitle;
    if (closeBtn) closeBtn.title = t.content.closeBtnTitle;
    const label = popoverCard?.querySelector('#ptIndexNameLabel');
    if (label) label.textContent = t.content.indexNameLabel;
    const noteLabel = popoverCard?.querySelector('#ptIndexNoteLabel');
    if (noteLabel) noteLabel.textContent = t.content.indexNoteLabel;
    if (indexNoteInput) indexNoteInput.placeholder = t.content.indexNotePlaceholder;
    const hint = popoverCard?.querySelector('.pt-hint');
    if (hint) hint.textContent = t.content.hint;
    if (cancelBtn) cancelBtn.textContent = t.content.cancelBtn;
    if (saveBtn) saveBtn.textContent = t.content.saveBtn;
  }

  function hideWidget(): void {
    wrapper.style.display = 'none';
    pillBtn.style.display = 'none';
    popoverCard.style.display = 'none';
    isPopoverOpen = false;
    currentSelectedText = '';
    currentTargetElement = null;
    currentRange = null;
  }

  function showPopoverCard(text: string, element: HTMLElement | null, range: Range | null): void {
    if (!text) return;

    currentSelectedText = text;
    currentTargetElement = element;
    if (range) {
      currentRange = range.cloneRange();
    }
    isPopoverOpen = true;

    updateWidgetText();
    const t = getLocale(currentLang);

    wrapper.style.display = 'block';
    pillBtn.style.display = 'none';
    popoverCard.style.display = 'block';

    snippetQuote.textContent = currentSelectedText;
    indexNameInput.value = '';
    if (indexNoteInput) indexNoteInput.value = '';

    const preview = currentSelectedText.length > 35
      ? currentSelectedText.slice(0, 35) + '…'
      : currentSelectedText;
    indexNameInput.placeholder = t.content.indexNamePlaceholderPreview(preview);

    const popWidth = 320;
    const popHeight = 280;

    let popTop = Math.max(20, window.innerHeight / 3);
    let popLeft = Math.max(12, (window.innerWidth - popWidth) / 2);

    if (range) {
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        popTop = rect.top - popHeight - 8;
        if (popTop < 10) {
          popTop = rect.bottom + 8;
        }
        popLeft = rect.left + rect.width / 2 - popWidth / 2;
      }
    }

    popLeft = Math.max(12, Math.min(window.innerWidth - popWidth - 12, popLeft));
    if (popTop + popHeight > window.innerHeight - 12) {
      popTop = Math.max(12, window.innerHeight - popHeight - 12);
    }
    wrapper.style.top = `${popTop}px`;
    wrapper.style.left = `${popLeft}px`;

    setTimeout(() => {
      indexNameInput.focus();
    }, 50);
  }

  async function saveCurrentIndex(): Promise<void> {
    if (!currentSelectedText) return;

    const selectedText = currentSelectedText;
    const targetElement = currentTargetElement;
    const rawName = indexNameInput.value.trim();
    const finalName = rawName || selectedText;
    const note = indexNoteInput?.value.trim() || undefined;
    const selector = targetElement ? getCSSSelector(targetElement) : '';

    hideWidget();

    const msg: SaveCustomIndexMessage = {
      type: 'SAVE_CUSTOM_INDEX',
      url: normalizeContentUrl(location.href),
      pageTitle: document.title || location.href,
      favicon: getFavicon(),
      name: finalName,
      text: selectedText,
      note,
      selector,
    };

    const t = getLocale(currentLang);
    const displayName = finalName.length > 30 ? finalName.slice(0, 30) + '…' : finalName;

    try {
      const res = (await browser.runtime.sendMessage(msg)) as { id?: number; duplicate?: boolean } | undefined;
      if (res?.duplicate) {
        showToast(t.content.toastDuplicate(displayName));
        return;
      }
    } catch (err) {
      console.error('[PageTrace] Failed to send SAVE_CUSTOM_INDEX:', err);
    }

    showToast(t.content.toastSaved(displayName));

    if (targetElement) {
      ensureHighlightStyles();
      highlightElement(targetElement, selectedText);
    }
  }

  pillBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    showPopoverCard(currentSelectedText, currentTargetElement, currentRange);
  });

  // Triggered from the right-click context menu
  window.addEventListener('pt:trigger-create-index', async (e) => {
    try {
      const settings = await getSettings();
      if (settings.language) {
        currentLang = settings.language;
      }
    } catch {}
    updateWidgetText();

    const detail = (e as CustomEvent).detail as { text?: string };
    const sel = window.getSelection();
    let text = detail?.text?.trim() || '';
    let range: Range | null = null;
    let parentEl: HTMLElement | null = null;

    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      const selText = sel.toString().trim();
      if (selText) text = selText;
      range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      parentEl = (container.nodeType === Node.ELEMENT_NODE
        ? (container as Element)
        : container.parentElement) as HTMLElement | null;
    }

    if (!text && currentSelectedText) {
      text = currentSelectedText;
      range = currentRange;
      parentEl = currentTargetElement;
    }

    if (text) {
      showPopoverCard(text, parentEl, range);
    }
  });

  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void saveCurrentIndex();
  });

  indexNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveCurrentIndex();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideWidget();
    }
  });

  indexNoteInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void saveCurrentIndex();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideWidget();
    }
  });

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideWidget();
  });

  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideWidget();
  });

  document.addEventListener('mousedown', (e) => {
    const path = e.composedPath();
    if (path.includes(host)) return;
    if (isPopoverOpen || wrapper.style.display === 'block') {
      hideWidget();
    }
  });

  window.addEventListener('scroll', () => {
    if (!isPopoverOpen && wrapper.style.display === 'block') {
      hideWidget();
    }
  }, { passive: true });

  document.addEventListener('mouseup', () => {
    setTimeout(async () => {
      if (isPopoverOpen) return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        hideWidget();
        return;
      }

      const text = sel.toString().trim();
      if (text.length < 2) {
        hideWidget();
        return;
      }

      try {
        const settings = await getSettings();
        if (settings.language) {
          currentLang = settings.language;
        }
        if (settings.enabled === false) return;

        const trigger = settings.indexTrigger ?? 'selection';
        if (trigger === 'contextmenu') {
          return;
        }
      } catch {
        // Continue if storage query fails
      }
      updateWidgetText();

      // Ignore selections inside inputs or extension overlays
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const parentEl = (container.nodeType === Node.ELEMENT_NODE
        ? (container as Element)
        : container.parentElement) as HTMLElement | null;

      if (!parentEl) return;
      if (
        parentEl.closest('#pagetrace-overlay-host') ||
        parentEl.closest('#pagetrace-selection-host') ||
        parentEl.closest('input, textarea, select, button, [contenteditable="true"]')
      ) {
        return;
      }

      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;

      currentSelectedText = text;
      currentTargetElement = parentEl;
      currentRange = range.cloneRange();

      const pillWidth = 145;
      const pillHeight = 32;

      let top = rect.top - pillHeight - 8;
      if (top < 10) {
        top = rect.bottom + 8;
      }

      let left = rect.left + rect.width / 2 - pillWidth / 2;
      left = Math.max(10, Math.min(window.innerWidth - pillWidth - 10, left));

      wrapper.style.top = `${top}px`;
      wrapper.style.left = `${left}px`;
      wrapper.style.display = 'block';
      pillBtn.style.display = 'inline-flex';
      popoverCard.style.display = 'none';
    }, 20);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSelectionIndexingWatcher, { once: true });
} else {
  initSelectionIndexingWatcher();
}
