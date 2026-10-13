import browser from 'webextension-polyfill';
import { db, deletePageById } from '@/db/index';
import {
  rebuildIndex,
  search,
  parseSearchQuery,
  sortSearchResults,
  hydrateSearchIndex,
  serializeSearchIndex,
  getAvailableTags,
  getAvailableDomains,
} from '@/search/index';
import type { SearchResult, SearchTypeFilter, SearchSortOption, SearchFilterOptions, TagCatalogItem } from '@/types/index';
import { getSettings, saveSettings } from '@/common/settings';
import { getLocale, applyI18nToDOM, DEFAULT_LANGUAGE } from '@/i18n/index';
import { renderTagBadge, formatTimeAgo, normalizeTagName, escapeHtml, escapeAttr, setSafeHtml, matchUrlPattern } from '@/common/tags';
import {
  toggleInlineOperatorToken,
  groupResultsByPage,
  formatMarkdownQuote,
  getAutocompleteTokenInfo,
  generateSearchSuggestions,
  applySuggestionToQuery,
  normalizePageUrl,
  type GroupedSearchResult,
  type SearchSuggestionItem,
  type AutocompleteTokenInfo,
} from '@/common/search-utils';

let currentLang = DEFAULT_LANGUAGE;
let tagCatalog: TagCatalogItem[] = [];
let pinnedDomains: string[] = [];
let searchMaxResults = 100;
let searchPageSize = 20;
let isIndexReady = false;
let activeTypeFilter: SearchTypeFilter = 'all';
let activeSort: SearchSortOption = 'relevance';
let activePeriod: 'all' | 'today' | 'week' | 'month' = 'all';
let activeVisits: 'all' | 'multiple' | 'frequent' | 'once' = 'all';
let allMatchedResults: SearchResult[] = [];
let filteredResults: SearchResult[] = [];
let groupedResults: GroupedSearchResult[] = [];
let expandedUrls = new Set<string>();
let displayedCount = 0;
let selectedIndex = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let autocompleteItems: SearchSuggestionItem[] = [];
let autocompleteActiveIndex = -1;
let currentTokenInfo: AutocompleteTokenInfo | null = null;

const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const clearBtn = document.getElementById('clearBtn') as HTMLButtonElement;
const autocompleteDropdown = document.getElementById('autocompleteDropdown') as HTMLElement | null;
const typeWrap = document.getElementById('typeWrap') as HTMLElement | null;
const typeSelect = document.getElementById('typeSelect') as HTMLSelectElement | null;
const typeOptAll = document.getElementById('typeOptAll') as HTMLOptionElement | null;
const typeOptText = document.getElementById('typeOptText') as HTMLOptionElement | null;
const typeOptTag = document.getElementById('typeOptTag') as HTMLOptionElement | null;
const typeOptMedia = document.getElementById('typeOptMedia') as HTMLOptionElement | null;
const dateWrap = document.getElementById('dateWrap') as HTMLElement | null;
const dateSelect = document.getElementById('dateSelect') as HTMLSelectElement | null;
const visitsWrap = document.getElementById('visitsWrap') as HTMLElement | null;
const visitsSelect = document.getElementById('visitsSelect') as HTMLSelectElement | null;
const sortWrap = document.getElementById('sortWrap') as HTMLElement;
const sortSelect = document.getElementById('sortSelect') as HTMLSelectElement;
const resultsContainer = document.getElementById('resultsContainer') as HTMLElement;
const footerCount = document.getElementById('footerCount') as HTMLElement;

async function syncSettings(): Promise<void> {
  const settings = await getSettings();
  currentLang = settings.language || DEFAULT_LANGUAGE;
  tagCatalog = settings.tagCatalog || [];
  pinnedDomains = settings.pinnedDomains || [];
  searchMaxResults = settings.searchMaxResults || 100;
  searchPageSize = settings.searchPageSize || 20;
}

let loadedDbRevision = -1;

async function init(): Promise<void> {
  await syncSettings();
  applyI18nToDOM(document, currentLang);

  searchInput?.focus();
  void loadIndex(true);

  window.addEventListener('focus', async () => {
    const prevLang = currentLang;
    await syncSettings();
    if (currentLang !== prevLang) {
      applyI18nToDOM(document, currentLang);
    }
    void loadIndex(false);
  });

  resultsContainer?.addEventListener('scroll', () => {
    if (
      displayedCount < groupedResults.length &&
      resultsContainer.scrollTop + resultsContainer.clientHeight >= resultsContainer.scrollHeight - 120
    ) {
      loadMoreResults();
    }
  });

  searchInput?.addEventListener('input', () => {
    const query = searchInput.value;
    clearBtn.classList.toggle('visible', query.length > 0);

    const cursorPos = searchInput.selectionStart ?? query.length;
    currentTokenInfo = getAutocompleteTokenInfo(query, cursorPos);
    if (currentTokenInfo && (currentTokenInfo.prefix || currentTokenInfo.filter.length >= 1)) {
      autocompleteItems = generateSearchSuggestions(currentTokenInfo, getAvailableTags(), getAvailableDomains());
      if (autocompleteItems.length > 0) {
        renderAutocomplete(autocompleteItems);
      } else {
        hideAutocomplete();
      }
    } else {
      hideAutocomplete();
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      performSearch(query);
    }, 80);
  });

  clearBtn?.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.classList.remove('visible');
    hideAutocomplete();
    searchInput.focus();
    performSearch('');
  });

  typeSelect?.addEventListener('change', () => {
    const type = (typeSelect.value as SearchTypeFilter) || 'all';
    setActiveTypeFilter(type);
    searchInput?.focus();
  });

  dateSelect?.addEventListener('change', () => {
    activePeriod = (dateSelect.value as 'all' | 'today' | 'week' | 'month') || 'all';
    const isCustomDate = activePeriod !== 'all';
    dateSelect.classList.toggle('active', isCustomDate);
    dateWrap?.classList.toggle('active', isCustomDate);
    performSearch(searchInput.value);
    searchInput?.focus();
  });

  visitsSelect?.addEventListener('change', () => {
    activeVisits = (visitsSelect.value as 'all' | 'multiple' | 'frequent' | 'once') || 'all';
    const isCustomVisits = activeVisits !== 'all';
    visitsSelect.classList.toggle('active', isCustomVisits);
    visitsWrap?.classList.toggle('active', isCustomVisits);
    performSearch(searchInput.value);
    searchInput?.focus();
  });

  sortSelect?.addEventListener('change', () => {
    activeSort = (sortSelect.value as SearchSortOption) || 'relevance';
    const isCustomSort = activeSort !== 'relevance';
    sortSelect.classList.toggle('active', isCustomSort);
    sortWrap?.classList.toggle('active', isCustomSort);
    performSearch(searchInput.value);
    searchInput?.focus();
  });

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocompleteActiveIndex = (autocompleteActiveIndex + 1) % autocompleteItems.length;
        updateAutocompleteVisuals();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocompleteActiveIndex = (autocompleteActiveIndex - 1 + autocompleteItems.length) % autocompleteItems.length;
        updateAutocompleteVisuals();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (autocompleteActiveIndex >= 0) {
          selectAutocomplete(autocompleteActiveIndex);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideAutocomplete();
        return;
      }
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      window.close();
      return;
    }

    if (e.target instanceof HTMLSelectElement) {
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      changeSelection(1);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      changeSelection(-1);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      openSelected();
      return;
    }
  });
}

function renderAutocomplete(items: SearchSuggestionItem[]): void {
  if (!autocompleteDropdown) return;
  autocompleteActiveIndex = 0;
  const html = items
    .map(
      (item, idx) => `
      <div class="autocomplete-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}">
        <span class="autocomplete-label">${escapeHtml(item.label)}</span>
        <span class="autocomplete-desc">${escapeHtml(item.description || item.category)}</span>
      </div>
    `,
    )
    .join('');
  setSafeHtml(autocompleteDropdown, html);
  autocompleteDropdown.classList.add('open');

  autocompleteDropdown.querySelectorAll<HTMLElement>('.autocomplete-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset['idx']);
      selectAutocomplete(idx);
    });
  });
}

function hideAutocomplete(): void {
  if (autocompleteDropdown) {
    autocompleteDropdown.classList.remove('open');
    autocompleteDropdown.replaceChildren();
  }
  autocompleteItems = [];
  autocompleteActiveIndex = -1;
  currentTokenInfo = null;
}

function selectAutocomplete(idx: number): void {
  if (!currentTokenInfo || !autocompleteItems[idx]) return;
  const item = autocompleteItems[idx]!;
  const res = applySuggestionToQuery(searchInput.value, currentTokenInfo, item);
  searchInput.value = res.newQuery;
  clearBtn.classList.toggle('visible', searchInput.value.length > 0);
  searchInput.focus();
  searchInput.setSelectionRange(res.newCursorPos, res.newCursorPos);
  hideAutocomplete();
  performSearch(searchInput.value);
}

function updateAutocompleteVisuals(): void {
  if (!autocompleteDropdown) return;
  autocompleteDropdown.querySelectorAll<HTMLElement>('.autocomplete-item').forEach((el, i) => {
    el.classList.toggle('active', i === autocompleteActiveIndex);
  });
}

function getDateRangeFromPeriod(period: 'all' | 'today' | 'week' | 'month'): { dateFrom?: number; dateTo?: number } {
  const now = new Date();
  if (period === 'today') {
    return {
      dateFrom: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime(),
      dateTo: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime(),
    };
  }
  if (period === 'week') {
    return {
      dateFrom: Date.now() - 7 * 24 * 60 * 60 * 1000,
      dateTo: Date.now(),
    };
  }
  if (period === 'month') {
    return {
      dateFrom: Date.now() - 30 * 24 * 60 * 60 * 1000,
      dateTo: Date.now(),
    };
  }
  return {};
}

function setActiveTypeFilter(type: SearchTypeFilter): void {
  activeTypeFilter = type;
  if (typeSelect) {
    typeSelect.value = type;
    const isCustomType = type !== 'all';
    typeSelect.classList.toggle('active', isCustomType);
    typeWrap?.classList.toggle('active', isCustomType);
  }

  applyTypeFilterAndRender();
}

async function loadIndex(force = false): Promise<void> {
  try {
    let currentRev = 0;
    let cachedSnapshot: { revision?: number } | undefined;
    try {
      const stored = await browser.storage.local.get(['pt_db_rev', 'pt_search_cache']);
      currentRev = Number(stored?.['pt_db_rev']) || 0;
      cachedSnapshot = stored?.['pt_search_cache'] as { revision?: number } | undefined;
    } catch {}

    if (!force && isIndexReady && currentRev > 0 && currentRev === loadedDbRevision) {
      return;
    }

    if (
      !force &&
      currentRev > 0 &&
      cachedSnapshot &&
      cachedSnapshot.revision === currentRev &&
      hydrateSearchIndex(cachedSnapshot)
    ) {
      loadedDbRevision = currentRev;
      isIndexReady = true;
    } else {
      const [pages, chunks, media, customIndexes] = await Promise.all([
        db.pages.toArray(),
        db.text_chunks.toArray(),
        db.media_items.toArray(),
        db.custom_indexes.toArray(),
      ]);
      const rev = currentRev || Date.now();
      await rebuildIndex(pages, chunks, media, customIndexes, rev);
      loadedDbRevision = rev;
      isIndexReady = true;

      const serialized = serializeSearchIndex(rev);
      if (serialized) {
        try {
          browser.storage.local.set({ pt_search_cache: serialized }).catch(() => {});
        } catch {}
      }
    }

    if (searchInput.value.trim() || activeTypeFilter !== 'all' || activeSort !== 'relevance' || activePeriod !== 'all') {
      performSearch(searchInput.value);
    }
  } catch (err) {
    console.error('[PageTrace Search] Error loading index:', err);
  }
}

function getVisitsRangeFromFilter(filter: 'all' | 'multiple' | 'frequent' | 'once'): {
  minVisits?: number;
  maxVisits?: number;
} {
  switch (filter) {
    case 'multiple':
      return { minVisits: 2 };
    case 'frequent':
      return { minVisits: 3 };
    case 'once':
      return { minVisits: 1, maxVisits: 1 };
    case 'all':
    default:
      return {};
  }
}

function getEffectiveSort(query: string): SearchSortOption {
  if (activeSort !== 'relevance') return activeSort;
  return parseSearchQuery(query).sort || 'relevance';
}

function performSearch(query: string): void {
  const trimmed = query.trim();
  const t = getLocale(currentLang);

  if (
    !trimmed &&
    activeTypeFilter === 'all' &&
    activeSort === 'relevance' &&
    activePeriod === 'all' &&
    activeVisits === 'all'
  ) {
    allMatchedResults = [];
    filteredResults = [];
    groupedResults = [];
    displayedCount = 0;
    selectedIndex = 0;
    updateTabCounts(false);
    renderEmpty(t.search.emptyInitial);
    updateFooter(0);
    return;
  }

  if (!isIndexReady) {
    renderEmpty(t.search.loading);
    updateFooter(0);
    return;
  }

  const dateRange = getDateRangeFromPeriod(activePeriod);
  const visitsRange = getVisitsRangeFromFilter(activeVisits);
  const filterOptions: SearchFilterOptions = {
    sort: activeSort,
    ...(activeTypeFilter !== 'all' ? { type: activeTypeFilter } : {}),
    ...(dateRange.dateFrom !== undefined ? { dateFrom: dateRange.dateFrom } : {}),
    ...(dateRange.dateTo !== undefined ? { dateTo: dateRange.dateTo } : {}),
    ...(visitsRange.minVisits !== undefined ? { minVisits: visitsRange.minVisits } : {}),
    ...(visitsRange.maxVisits !== undefined ? { maxVisits: visitsRange.maxVisits } : {}),
  };

  allMatchedResults = search(trimmed, searchMaxResults, filterOptions);

  const parsed = parseSearchQuery(trimmed);
  const hasQueryOrFilter =
    Boolean(trimmed) ||
    activeTypeFilter !== 'all' ||
    activeSort !== 'relevance' ||
    activePeriod !== 'all' ||
    activeVisits !== 'all';
  updateTabCounts(hasQueryOrFilter, parsed.type);
  applyTypeFilterAndRender();
}

function updateTabCounts(visible: boolean, inlineTypeOverride?: SearchTypeFilter): void {
  const t = getLocale(currentLang);
  const counts: Record<SearchTypeFilter, number> = {
    all: allMatchedResults.length,
    text: allMatchedResults.filter((r) => r.type === 'text').length,
    tag: allMatchedResults.filter((r) => r.type === 'tag').length,
    media: allMatchedResults.filter((r) => r.type === 'media').length,
  };

  const getOptLabel = (label: string, count: number): string => {
    return visible ? `${label} (${count})` : label;
  };

  if (typeOptAll) typeOptAll.textContent = getOptLabel(t.search.tabAll, counts.all);
  if (typeOptText) typeOptText.textContent = getOptLabel(t.search.tabText, counts.text);
  if (typeOptTag) typeOptTag.textContent = getOptLabel(t.search.tabTag, counts.tag);
  if (typeOptMedia) typeOptMedia.textContent = getOptLabel(t.search.tabMedia, counts.media);
}

function applyTypeFilterAndRender(): void {
  const trimmed = searchInput?.value.trim() ?? '';
  const t = getLocale(currentLang);

  if (
    !trimmed &&
    activeTypeFilter === 'all' &&
    activeSort === 'relevance' &&
    activePeriod === 'all' &&
    activeVisits === 'all'
  ) {
    filteredResults = [];
    groupedResults = [];
    displayedCount = 0;
    selectedIndex = 0;
    updateTabCounts(false);
    renderEmpty(t.search.emptyInitial);
    updateFooter(0);
    return;
  }

  const effectiveSort = getEffectiveSort(trimmed);
  const base =
    activeTypeFilter === 'all'
      ? allMatchedResults
      : allMatchedResults.filter((r) => r.type === activeTypeFilter);
  filteredResults = sortSearchResults(base, effectiveSort);
  groupedResults = groupResultsByPage(filteredResults);

  selectedIndex = 0;
  displayedCount = Math.min(groupedResults.length, searchPageSize);
  renderResults();
  updateFooter(filteredResults.length);
}

function applyInlineOperator(operatorToken: string): void {
  searchInput.value = toggleInlineOperatorToken(searchInput.value, operatorToken);
  clearBtn.classList.toggle('visible', searchInput.value.length > 0);
  searchInput.focus();
  performSearch(searchInput.value);
}

function createResultCard(group: GroupedSearchResult, idx: number): HTMLElement {
  const card = document.createElement('div');
  card.className = `result-card${idx === selectedIndex ? ' selected' : ''}`;
  card.setAttribute('role', 'option');
  card.setAttribute('data-index', String(idx));

  const result = group.primary;
  const t = getLocale(currentLang);
  const domain = getDomain(result.url);
  const faviconHtml = result.favicon
    ? `<img class="result-favicon" src="${escapeAttr(result.favicon)}" alt="" />`
    : '';

  const filePreview = getFilePreview(result);
  let previewHtml = '';

  if (filePreview) {
    if (filePreview.isImage) {
      previewHtml = `
        <div class="result-thumb-box">
          <img
            class="result-thumb-img"
            src="${escapeAttr(filePreview.url)}"
            alt="${escapeAttr(result.title)}"
            referrerpolicy="no-referrer"
            loading="lazy"
          />
        </div>
      `;
    } else {
      previewHtml = `
        <div class="result-file-badge">
          <span class="result-file-badge-icon">${getFileIcon(filePreview.ext)}</span>
          <span class="result-file-badge-ext">${escapeHtml(filePreview.ext)}</span>
        </div>
      `;
    }
  }

  const customShortTag =
    result.tagName && result.tagName.length <= 16 && !/\s/.test(result.tagName)
      ? result.tagName
      : '';
  const activeTag = customShortTag || (result.tags && result.tags.length > 0 ? result.tags[0]! : '');
  const normTag = activeTag ? normalizeTagName(activeTag) : '';
  const tagHtml = normTag
    ? `<span class="tag-filter-trigger" data-tag="${escapeAttr(normTag)}" title="Filter by #${escapeAttr(normTag)}">${renderTagBadge(normTag, tagCatalog, 'clickable')}</span>`
    : '';

  const timeAgo = formatTimeAgo(result.createdAt, currentLang);
  const normUrl = normalizePageUrl(result.url);
  const isExpanded = expandedUrls.has(normUrl);
  const subCount = group.subMatches.length;

  let subMatchesHtml = '';
  if (subCount > 0) {
    const toggleLabel = isExpanded ? t.search.collapseMatches : t.search.expandMatches(subCount);
    const subListHtml = isExpanded
      ? `
      <div class="result-submatches-list">
        ${group.subMatches
          .map(
            (sub, subIdx) => `
          <div class="result-submatch-item" data-sub-idx="${subIdx}" title="${escapeAttr(t.search.hintOpen)}">
            <div class="result-submatch-snippet">${sub.snippet}</div>
            ${sub.note ? `<div class="result-note"><span class="note-icon">📝</span> ${escapeHtml(sub.note)}</div>` : ''}
          </div>
        `,
          )
          .join('')}
      </div>
    `
      : '';

    subMatchesHtml = `
      <button class="result-submatches-toggle" type="button">${escapeHtml(toggleLabel)}</button>
      ${subListHtml}
    `;
  }

  const visitCount = result.visitCount ?? 1;
  const visitsTooltip = t.search.visitsTooltip(visitCount);
  const visitsHtml = `
    <span class="result-visits" title="${escapeAttr(visitsTooltip)}" data-visits="${visitCount}">
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
      </svg>
      <span>${visitCount}</span>
    </span>
  `;

  const isPinned = pinnedDomains.some(
    (p) => p.toLowerCase() === domain.toLowerCase() || matchUrlPattern(p, result.url),
  );
  const pinTitle = isPinned ? t.search.actionUnpinDomain : t.search.actionPinDomain;
  const pinClass = isPinned ? 'result-act-btn act-pin active' : 'result-act-btn act-pin';

  setSafeHtml(
    card,
    `
    <div class="result-card-inner">
      <div class="result-info">
        <div class="result-meta-header">
          <div class="result-meta-row">
            ${faviconHtml}
            <span class="result-domain clickable" data-domain="${escapeAttr(domain)}" title="Filter by site:${escapeAttr(domain)}">${escapeHtml(domain)}</span>
            ${tagHtml ? `<span class="result-meta-dot">•</span>${tagHtml}` : ''}
            <span class="result-meta-dot">•</span>${visitsHtml}
            ${timeAgo ? `<span class="result-meta-dot">•</span><span class="result-time">${escapeHtml(timeAgo)}</span>` : ''}
          </div>
          <div class="result-quick-actions">
            <button class="${pinClass}" type="button" title="${escapeAttr(pinTitle)}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="17" x2="12" y2="22"/>
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>
              </svg>
            </button>
            <button class="result-act-btn act-copy" type="button" title="${escapeAttr(t.search.actionCopyQuote)}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
              </svg>
            </button>
            <button class="result-act-btn act-delete" type="button" title="${escapeAttr(t.search.actionDeletePage)}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
              </svg>
            </button>
            <button class="result-act-btn act-blacklist" type="button" title="${escapeAttr(t.search.actionBlacklistDomain)}">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="result-title" title="${escapeAttr(result.title || domain)}">${escapeHtml(result.title || domain)}</div>
        <div class="result-snippet">${result.snippet}</div>
        ${result.note ? `<div class="result-note"><span class="note-icon">📝</span> ${escapeHtml(result.note)}</div>` : ''}
        ${subMatchesHtml}
      </div>
      ${previewHtml}
    </div>
  `,
  );

  const faviconImg = card.querySelector<HTMLImageElement>('.result-favicon');
  faviconImg?.addEventListener('error', () => {
    faviconImg.style.display = 'none';
  });

  const thumbImg = card.querySelector<HTMLImageElement>('.result-thumb-img');
  thumbImg?.addEventListener('error', () => {
    if (thumbImg.parentElement) thumbImg.parentElement.style.display = 'none';
  });

  const tagTrigger = card.querySelector<HTMLElement>('.tag-filter-trigger');
  tagTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const tag = tagTrigger.dataset['tag'];
    if (tag) applyInlineOperator(`#${tag}`);
  });

  const domainTrigger = card.querySelector<HTMLElement>('.result-domain.clickable');
  domainTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dom = domainTrigger.dataset['domain'];
    if (dom) applyInlineOperator(`site:${dom}`);
  });

  const visitsTrigger = card.querySelector<HTMLElement>('.result-visits');
  visitsTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const count = visitsTrigger.dataset['visits'];
    if (count) applyInlineOperator(`visits:>=${count}`);
  });

  const copyBtn = card.querySelector<HTMLButtonElement>('.act-copy');
  copyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatMarkdownQuote(result.text, result.title, result.url));
      copyBtn.classList.add('copied');
      const orig = copyBtn.title;
      copyBtn.title = t.search.actionCopyQuoteSuccess;
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.title = orig;
      }, 1500);
    } catch {}
  });

  const delBtn = card.querySelector<HTMLButtonElement>('.act-delete');
  delBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.confirm(t.search.actionDeleteConfirm)) {
      await deletePageById(result.pageId);
      allMatchedResults = allMatchedResults.filter((item) => item.pageId !== result.pageId && item.url !== result.url);
      applyTypeFilterAndRender();
    }
  });

  const blBtn = card.querySelector<HTMLButtonElement>('.act-blacklist');
  blBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.confirm(t.search.actionBlacklistConfirm(domain))) {
      const s = await getSettings();
      if (!s.blacklist.includes(domain)) {
        s.blacklist.push(domain);
        await saveSettings(s);
      }
      allMatchedResults = allMatchedResults.filter((item) => {
        try { return new URL(item.url).hostname !== domain; } catch { return !item.url.includes(domain); }
      });
      applyTypeFilterAndRender();
    }
  });

  const pinBtn = card.querySelector<HTMLButtonElement>('.act-pin');
  pinBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const s = await getSettings();
    const currentPinned = Array.isArray(s.pinnedDomains) ? [...s.pinnedDomains] : [];
    const lowerDomain = domain.toLowerCase();
    const wasPinned = currentPinned.some((p) => p.toLowerCase() === lowerDomain);

    if (wasPinned) {
      const nextPinned = currentPinned.filter((p) => p.toLowerCase() !== lowerDomain);
      await saveSettings({ pinnedDomains: nextPinned });
      pinnedDomains = nextPinned;
      pinBtn.classList.remove('active');
      pinBtn.title = t.search.actionPinDomain;
    } else {
      currentPinned.push(domain);
      await saveSettings({ pinnedDomains: currentPinned });
      pinnedDomains = currentPinned;
      pinBtn.classList.add('active');
      pinBtn.title = t.search.actionUnpinDomain;
    }
  });

  const toggleBtn = card.querySelector<HTMLButtonElement>('.result-submatches-toggle');
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const norm = normalizePageUrl(result.url);
    if (expandedUrls.has(norm)) {
      expandedUrls.delete(norm);
    } else {
      expandedUrls.add(norm);
    }
    renderResults();
  });

  card.querySelectorAll<HTMLElement>('.result-submatch-item').forEach((subEl) => {
    subEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const subIdx = Number(subEl.dataset['subIdx']);
      const subItem = group.subMatches[subIdx];
      if (subItem) openResult(subItem);
    });
  });

  card.addEventListener('click', () => {
    openResult(result);
  });

  card.addEventListener('mouseenter', () => {
    selectedIndex = idx;
    updateSelectionVisuals();
    updateFooter(filteredResults.length);
  });

  return card;
}

function appendResultBatch(startIdx: number, endIdx: number): void {
  const fragment = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) {
    const group = groupedResults[i];
    if (group) {
      fragment.appendChild(createResultCard(group, i));
    }
  }
  resultsContainer.appendChild(fragment);
}

function loadMoreResults(): void {
  if (displayedCount >= groupedResults.length) return;
  const prevCount = displayedCount;
  displayedCount = Math.min(groupedResults.length, displayedCount + searchPageSize);
  appendResultBatch(prevCount, displayedCount);
}

function renderResults(): void {
  const t = getLocale(currentLang);
  if (groupedResults.length === 0) {
    renderEmpty(t.search.noResults);
    return;
  }

  resultsContainer.replaceChildren();
  resultsContainer.scrollTop = 0;
  appendResultBatch(0, displayedCount);
  scrollSelectedIntoView();
}

function getFilePreview(result: SearchResult): { isImage: boolean; isDoc: boolean; url: string; ext: string } | null {
  const candidateUrl = result.type === 'media' && result.selector ? result.selector : result.url;
  if (!candidateUrl) return null;

  const clean = candidateUrl.split('?')[0].split('#')[0].toLowerCase();
  const extMatch = clean.match(/\.([a-z0-9]+)$/i);
  const ext = extMatch ? extMatch[1] : '';

  const imageExts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'bmp', 'avif'];
  const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'zip', 'rar', 'txt', 'mp4', 'mp3', 'json'];

  const isImage = imageExts.includes(ext) || candidateUrl.startsWith('data:image/');
  const isDoc = docExts.includes(ext);

  if (isImage) {
    return { isImage: true, isDoc: false, url: candidateUrl, ext: ext || 'img' };
  }

  if (isDoc || result.type === 'media') {
    if (result.type === 'media' && candidateUrl.startsWith('http')) {
      return { isImage: true, isDoc: false, url: candidateUrl, ext: ext || 'img' };
    }
    return { isImage: false, isDoc: true, url: candidateUrl, ext: ext || 'file' };
  }

  return null;
}

function getFileIcon(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'pdf': return '📄';
    case 'doc':
    case 'docx':
    case 'txt': return '📝';
    case 'xls':
    case 'xlsx':
    case 'csv': return '📊';
    case 'zip':
    case 'rar': return '📦';
    case 'mp4': return '🎬';
    case 'mp3': return '🎵';
    default: return '📁';
  }
}

function renderEmpty(text: string): void {
  setSafeHtml(
    resultsContainer,
    `
    <div class="empty-state">
      <span class="empty-icon">🔍</span>
      <span>${escapeHtml(text)}</span>
    </div>
  `,
  );
}

function updateFooter(count: number): void {
  const t = getLocale(currentLang);
  if (count === 0) {
    footerCount.textContent = t.search.footerCountZero;
  } else {
    footerCount.textContent = t.search.footerCount(selectedIndex + 1, count);
  }
}

function changeSelection(delta: number): void {
  if (groupedResults.length === 0) return;

  selectedIndex = Math.max(0, Math.min(groupedResults.length - 1, selectedIndex + delta));
  if (selectedIndex >= displayedCount) {
    loadMoreResults();
  }
  updateSelectionVisuals();
  scrollSelectedIntoView();
  updateFooter(filteredResults.length);
}

function updateSelectionVisuals(): void {
  const cards = resultsContainer.querySelectorAll('.result-card');
  cards.forEach((card, idx) => {
    card.classList.toggle('selected', idx === selectedIndex);
  });
}

function scrollSelectedIntoView(): void {
  const selectedCard = resultsContainer.querySelector('.result-card.selected') as HTMLElement | null;
  if (selectedCard) {
    selectedCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function openSelected(): void {
  const group = groupedResults[selectedIndex];
  if (group) {
    openResult(group.primary);
  }
}

async function openResult(result: SearchResult): Promise<void> {
  if (result.type === 'media' && result.selector.startsWith('http')) {
    browser.runtime
      .sendMessage({
        type: 'TOUCH_PAGE',
        url: result.url,
      })
      .catch(() => {});
    try {
      await browser.tabs.create({ url: result.selector, active: true });
    } catch {
      window.open(result.selector, '_blank');
    }
    window.close();
    return;
  }

  try {
    await browser.runtime.sendMessage({
      type: 'NAVIGATE_TO_RESULT',
      url: result.url,
      text: result.text || '',
      selector: result.selector || '',
    });
  } catch {
    window.open(result.url, '_blank');
  }

  window.close();
}

function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

init();
