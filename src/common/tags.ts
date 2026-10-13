// Tag color palette, badge helpers, and URL pattern matching

export interface TagColorDef {
  id: string;
  nameRu: string;
  nameEn: string;
  color: string;      // Hex text color
  bg: string;         // rgba with 12% opacity
  border: string;     // subtle border
}

export const TAG_COLORS: TagColorDef[] = [
  {
    id: 'slate',
    nameRu: 'Архив / Документы',
    nameEn: 'Archive / Docs',
    color: '#94A3B8',
    bg: 'rgba(148, 163, 184, 0.12)',
    border: 'rgba(148, 163, 184, 0.25)',
  },
  {
    id: 'emerald',
    nameRu: 'Разработка / Код',
    nameEn: 'Dev / Code',
    color: '#34D399',
    bg: 'rgba(52, 211, 153, 0.12)',
    border: 'rgba(52, 211, 153, 0.25)',
  },
  {
    id: 'amber',
    nameRu: 'Статьи / Чтение',
    nameEn: 'Articles / Reading',
    color: '#FBBF24',
    bg: 'rgba(251, 191, 36, 0.12)',
    border: 'rgba(251, 191, 36, 0.25)',
  },
  {
    id: 'indigo',
    nameRu: 'Исследования / Заметки',
    nameEn: 'Research / Notes',
    color: '#818CF8',
    bg: 'rgba(129, 140, 248, 0.12)',
    border: 'rgba(129, 140, 248, 0.25)',
  },
  {
    id: 'lemon',
    nameRu: 'Важное / Избранное',
    nameEn: 'Important / Favorite',
    color: '#F4FF2B',
    bg: 'rgba(244, 255, 43, 0.12)',
    border: 'rgba(244, 255, 43, 0.25)',
  },
];

export function getTagColorById(colorId?: string): TagColorDef {
  const found = TAG_COLORS.find((c) => c.id === colorId);
  return found || TAG_COLORS[0]!;
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) => HTML_ESCAPE_MAP[c] ?? c);
}

export function escapeAttr(s: string): string {
  return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Reuse a single DOMParser instance across the entire context to avoid allocating
// a new parser on every result card or UI update.
let sharedParser: DOMParser | null = null;

/**
 * Safely parses an HTML fragment via a shared DOMParser and replaces element children
 * without using direct innerHTML assignment (prevents XSS and satisfies web-ext lint).
 */
export function setSafeHtml(el: Element | ShadowRoot, html: string): void {
  if (!html) {
    el.replaceChildren();
    return;
  }
  if (!sharedParser) {
    sharedParser = new DOMParser();
  }
  const doc = sharedParser.parseFromString(html, 'text/html');
  el.replaceChildren(...Array.from(doc.body.childNodes));
}

export function normalizeTagName(raw: string): string {
  let cleaned = (raw || '')
    .trim()
    .replace(/^#+/, '')
    .replace(/[<>"'`&]/g, '')
    .replace(/\s+/g, '_')
    .toUpperCase();
  if (cleaned.length > 12) {
    cleaned = cleaned.slice(0, 12).replace(/_+$/, '');
  }
  return cleaned;
}

export function getTagColorForName(tagName: string, catalog?: Array<{ name: string; colorId: string }>): TagColorDef {
  const norm = normalizeTagName(tagName);
  if (catalog) {
    const item = catalog.find((c) => normalizeTagName(c.name) === norm);
    if (item) {
      return getTagColorById(item.colorId);
    }
  }

  // Deterministic fallback based on string hash to pick one of 5 colors
  let hash = 0;
  for (let i = 0; i < norm.length; i++) {
    hash = (hash * 31 + norm.charCodeAt(i)) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length]!;
}

export function renderTagBadge(
  tagName: string,
  catalog?: Array<{ name: string; colorId: string }>,
  extraClass = '',
): string {
  const norm = normalizeTagName(tagName);
  if (!norm) return '';
  const c = getTagColorForName(norm, catalog);
  const safeClass = escapeAttr(extraClass);
  const safeNorm = escapeHtml(norm);

  return `<span class="pt-tag-badge ${safeClass}" style="color:${c.color};background:${c.bg};border:1px solid ${c.border};">#${safeNorm}</span>`;
}

// Cache compiled pattern matchers to avoid repeated RegExp allocations in loops
interface CompiledPattern {
  cleanPattern: string;
  bareDomain: string;
  isWildcardPathOrBare: boolean;
  regex: RegExp;
}

const patternCache = new Map<string, CompiledPattern>();

function getCompiledPattern(rawPattern: string): CompiledPattern {
  const p = rawPattern.trim().toLowerCase();
  let cached = patternCache.get(p);
  if (cached) return cached;

  const cleanPattern = p.replace(/^https?:\/\//, '');
  const regexStr =
    '^' +
    cleanPattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*') +
    '$';
  const regex = new RegExp(regexStr, 'i');
  const bareDomain = cleanPattern.split('/')[0]!.replace(/^\*\./, '');
  const slashIdx = cleanPattern.indexOf('/');
  const pathPart = slashIdx >= 0 ? cleanPattern.slice(slashIdx) : '';
  const isWildcardPathOrBare = !cleanPattern.startsWith('*.') && (pathPart === '' || pathPart === '/' || pathPart === '/*');

  cached = { cleanPattern, bareDomain, isWildcardPathOrBare, regex };
  if (patternCache.size > 500) {
    patternCache.clear();
  }
  patternCache.set(p, cached);
  return cached;
}

/**
 * Matches URL against wildcards or domain patterns.
 * Supports:
 * - wikipedia.org/*
 * - *.habr.com/*
 * - github.com
 * - https://github.com/org/*
 */
export function matchUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || !url) return false;
  const u = url.trim().toLowerCase();

  try {
    const { bareDomain, isWildcardPathOrBare, regex } = getCompiledPattern(pattern);
    const urlObj = new URL(u);
    const hostname = urlObj.hostname;
    const domainAndPath = hostname + urlObj.pathname + urlObj.search;

    if (regex.test(domainAndPath) || regex.test(hostname) || regex.test(u)) {
      return true;
    }

    // Also match subdomain if pattern is just domain e.g. "wikipedia.org" or "wikipedia.org/*"
    if (isWildcardPathOrBare && (hostname === bareDomain || hostname.endsWith('.' + bareDomain))) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

export function formatTimeAgo(timestamp?: number, lang = 'ru'): string {
  if (!timestamp) return '';
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  const isRu = lang === 'ru';

  if (diffSec < 60) {
    return isRu ? 'только что' : 'just now';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return isRu ? `${diffMin} мин назад` : `${diffMin} min ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return isRu ? `${diffHours} ч назад` : `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return isRu ? `${diffDays} дн назад` : `${diffDays}d ago`;
  }
  return new Date(timestamp).toLocaleDateString(isRu ? 'ru-RU' : 'en-US', {
    day: 'numeric',
    month: 'short',
  });
}
