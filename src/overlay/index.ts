import browser from 'webextension-polyfill';
import type { SearchResult, SearchTypeFilter, SearchSortOption, SearchFilterOptions, TagCatalogItem, UserSettings } from '@/types/index';
import { getSettings, saveSettings } from '@/common/settings';
import { getLocale, DEFAULT_LANGUAGE } from '@/i18n/index';
import { renderTagBadge, formatTimeAgo, normalizeTagName, setSafeHtml, escapeHtml, escapeAttr, matchUrlPattern } from '@/common/tags';
import {
  extractInlineOperators,
  sortSearchResults,
  toggleInlineOperatorToken,
  normalizePageUrl,
  groupResultsByPage,
  formatMarkdownQuote,
  getAutocompleteTokenInfo,
  generateSearchSuggestions,
  applySuggestionToQuery,
  type GroupedSearchResult,
  type SearchSuggestionItem,
  type AutocompleteTokenInfo,
} from '@/common/search-utils';

let currentLang = DEFAULT_LANGUAGE;
let tagCatalog: TagCatalogItem[] = [];
let pinnedDomains: string[] = [];

// In-page search overlay mounted in Shadow DOM

const OVERLAY_CSS = `
  :host {
    all: initial;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  .pt-overlay-backdrop {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 10vh;
    pointer-events: all;
    z-index: 1;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
  }

  .pt-modal {
    background: #181A1F;
    border: 1px solid #2A2D35;
    border-radius: 14px;
    box-shadow: 0 32px 96px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.04);
    width: min(680px, 92vw);
    max-height: 72vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: all;
    position: relative;
  }

  .pt-search-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid #2A2D35;
    background: #181A1F;
    position: relative;
  }

  .pt-search-icon {
    flex-shrink: 0;
    color: #7E838F;
    width: 18px;
    height: 18px;
  }

  .pt-search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #ECEEF2;
    font-size: 16px;
    font-family: inherit;
    caret-color: #F4FF2B;
  }

  .pt-search-input::placeholder {
    color: #7E838F;
  }

  .pt-kbd {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #7E838F;
    font-size: 12px;
  }

  .pt-kbd kbd {
    background: #111215;
    border: 1px solid #2A2D35;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    color: #7E838F;
    font-family: inherit;
  }

  .pt-autocomplete-wrap {
    position: relative;
    width: 100%;
  }

  .pt-autocomplete {
    position: absolute;
    top: 0;
    left: 20px;
    right: 20px;
    background: #181A1F;
    border: 1px solid #2A2D35;
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
    z-index: 100;
    max-height: 220px;
    overflow-y: auto;
    display: none;
    margin-top: 4px;
  }

  .pt-autocomplete.open {
    display: block;
  }

  .pt-autocomplete-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    font-size: 13px;
    color: #ECEEF2;
    cursor: pointer;
    transition: background 0.1s;
    border-bottom: 1px solid #202228;
  }

  .pt-autocomplete-item:last-child {
    border-bottom: none;
  }

  .pt-autocomplete-item:hover,
  .pt-autocomplete-item.active {
    background: #242730;
    color: #F4FF2B;
  }

  .pt-autocomplete-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-weight: 600;
  }

  .pt-autocomplete-desc {
    font-size: 11px;
    color: #7E838F;
  }

  .pt-tabs {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 20px;
    border-bottom: 1px solid #2A2D35;
    background: #181A1F;
  }

  .pt-filter-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .pt-type-wrap,
  .pt-date-wrap,
  .pt-sort-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .pt-type-icon,
  .pt-date-icon,
  .pt-sort-icon {
    position: absolute;
    left: 9px;
    width: 13px;
    height: 13px;
    color: #7E838F;
    pointer-events: none;
    transition: color 0.15s;
  }

  .pt-type-select,
  .pt-date-select,
  .pt-visits-select,
  .pt-sort-select {
    background-color: #111215;
    border: 1px solid #2A2D35;
    color: #7E838F;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    padding: 4px 22px 4px 26px;
    border-radius: 6px;
    cursor: pointer;
    outline: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237E838F' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    background-size: 11px;
    transition: all 0.15s;
  }

  .pt-type-select:hover,
  .pt-date-select:hover,
  .pt-visits-select:hover,
  .pt-sort-select:hover {
    color: #C5C8D1;
    border-color: #3B3F4A;
  }

  .pt-type-wrap:hover .pt-type-icon,
  .pt-date-wrap:hover .pt-date-icon,
  .pt-visits-wrap:hover .pt-visits-icon,
  .pt-sort-wrap:hover .pt-sort-icon {
    color: #C5C8D1;
  }

  .pt-type-select.active,
  .pt-date-select.active,
  .pt-visits-select.active,
  .pt-sort-select.active {
    background-color: rgba(244, 255, 43, 0.12);
    border-color: rgba(244, 255, 43, 0.45);
    color: #F4FF2B;
    font-weight: 600;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23F4FF2B' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  }

  .pt-type-wrap.active .pt-type-icon,
  .pt-date-wrap.active .pt-date-icon,
  .pt-visits-wrap.active .pt-visits-icon,
  .pt-sort-wrap.active .pt-sort-icon {
    color: #F4FF2B;
  }

  .pt-type-select option,
  .pt-date-select option,
  .pt-visits-select option,
  .pt-sort-select option {
    background: #181A1F;
    color: #ECEEF2;
    font-weight: 400;
  }

  .pt-visits {
    display: inline-flex;
    align-items: center;
    gap: 3.5px;
    color: #7E838F;
    font-size: 11px;
    padding: 0 4px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.04);
    cursor: pointer;
    transition: color 0.15s, background-color 0.15s;
  }

  .pt-visits:hover {
    color: #C5C8D1;
    background: rgba(255, 255, 255, 0.08);
  }

  .pt-tag-badge.clickable,
  .pt-domain.clickable {
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .pt-tag-badge.clickable:hover,
  .pt-domain.clickable:hover {
    opacity: 0.85;
    text-decoration: underline;
  }

  .pt-results {
    overflow-y: auto;
    flex: 1;
    padding: 0;
    scrollbar-width: thin;
    scrollbar-color: #2A2D35 transparent;
    background: #181A1F;
    display: flex;
    flex-direction: column;
  }

  .pt-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 24px;
    color: #7E838F;
    font-size: 14px;
    gap: 8px;
  }

  .pt-empty-icon {
    font-size: 32px;
    opacity: 0.5;
  }

  .pt-result {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 12px 20px;
    cursor: pointer;
    transition: background 0.1s;
    border-radius: 0;
    border-left: 3px solid transparent;
    border-bottom: 1px solid #202228;
    background: transparent;
  }

  .pt-result:last-child {
    border-bottom: none;
  }

  .pt-result:hover,
  .pt-result.focused {
    background: #1E2129;
    border-left-color: #F4FF2B;
  }

  .pt-meta-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .pt-meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: #7E838F;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pt-quick-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
  }

  .pt-result:hover .pt-quick-actions,
  .pt-result.focused .pt-quick-actions {
    opacity: 1;
  }

  .pt-act-btn {
    background: #111215;
    border: 1px solid #2A2D35;
    color: #7E838F;
    border-radius: 4px;
    padding: 3px 6px;
    font-size: 11px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: all 0.15s ease;
  }

  .pt-act-btn:hover {
    color: #ECEEF2;
    border-color: #3B3F4A;
    background: #20232A;
  }

  .pt-act-btn.pt-act-delete:hover {
    color: #FF5A5A;
    border-color: rgba(255, 90, 90, 0.4);
  }

  .pt-act-btn.pt-act-blacklist:hover {
    color: #FFA500;
    border-color: rgba(255, 165, 0, 0.4);
  }

  .pt-act-btn.pt-act-pin:hover,
  .pt-act-btn.pt-act-pin.active {
    color: #4DA6FF;
    border-color: rgba(77, 166, 255, 0.4);
  }

  .pt-act-btn.pt-act-pin.active svg {
    fill: currentColor;
  }

  .pt-act-btn.copied {
    color: #55FF88;
    border-color: rgba(85, 255, 136, 0.4);
  }

  .pt-favicon {
    width: 14px;
    height: 14px;
    border-radius: 2px;
    flex-shrink: 0;
    object-fit: contain;
    background: #2A2D35;
  }

  .pt-domain {
    color: #7E838F;
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .pt-meta-dot {
    color: #4A4E58;
    font-size: 9px;
  }

  .pt-tag-badge {
    display: inline-flex;
    align-items: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1.35;
  }

  .pt-time {
    color: #7E838F;
    font-size: 11px;
  }

  .pt-page-title {
    font-size: 13.5px;
    font-weight: 600;
    color: #ECEEF2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pt-snippet {
    font-size: 13px;
    color: #7E838F;
    line-height: 1.5;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .pt-snippet mark {
    background: #F4FF2B;
    color: #111215 !important;
    border-radius: 1px;
    padding: 0 3px;
    font-weight: 600;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .pt-result-note {
    margin-top: 6px;
    padding: 4px 8px;
    background: rgba(244, 255, 43, 0.08);
    border-left: 2px solid #F4FF2B;
    border-radius: 4px;
    font-size: 12px;
    color: #ECEEF2;
    line-height: 1.4;
  }

  .pt-submatches-toggle {
    margin-top: 4px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid #2A2D35;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 11.5px;
    color: #A0A5B2;
    cursor: pointer;
    transition: all 0.15s ease;
    align-self: flex-start;
  }

  .pt-submatches-toggle:hover {
    background: rgba(244, 255, 43, 0.1);
    border-color: rgba(244, 255, 43, 0.3);
    color: #F4FF2B;
  }

  .pt-submatches-list {
    margin-top: 8px;
    padding-left: 12px;
    border-left: 2px solid #2A2D35;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .pt-submatch-item {
    padding: 6px 10px;
    background: #14161A;
    border-radius: 6px;
    border: 1px solid #22252C;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .pt-submatch-item:hover {
    background: #1B1E25;
    border-color: #383D47;
  }

  .pt-submatch-snippet {
    font-size: 12.5px;
    color: #8E93A0;
    line-height: 1.45;
  }

  .pt-submatch-snippet mark {
    background: #F4FF2B;
    color: #111215 !important;
    padding: 0 2px;
    border-radius: 1px;
    font-weight: 600;
  }

  .pt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    border-top: 1px solid #2A2D35;
    font-size: 11.5px;
    color: #7E838F;
    background: #181A1F;
  }

  .pt-footer-count {
    color: #7E838F;
  }

  .pt-footer-hint {
    display: flex;
    gap: 12px;
  }

  .pt-footer-hint span {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .pt-footer-hint kbd {
    background: #111215;
    border: 1px solid #2A2D35;
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 10.5px;
    color: #7E838F;
  }

  .pt-loader {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    color: #7E838F;
    font-size: 13px;
    gap: 10px;
  }

  @keyframes pt-spin {
    to { transform: rotate(360deg); }
  }

  .pt-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid #2A2D35;
    border-top-color: #F4FF2B;
    border-radius: 50%;
    animation: pt-spin 0.7s linear infinite;
  }
`;

// Overlay state
let shadowRoot: ShadowRoot | null = null;
let activeTab: SearchTypeFilter = 'all';
let activeSort: SearchSortOption = 'relevance';
let activePeriod: 'all' | 'today' | 'week' | 'month' = 'all';
let activeVisits: 'all' | 'multiple' | 'frequent' | 'once' = 'all';
let allResults: SearchResult[] = [];
let filteredResults: SearchResult[] = [];
let groupedResults: GroupedSearchResult[] = [];
let expandedUrls = new Set<string>();
let displayedCount = 0;
let searchMaxResults = 100;
let searchPageSize = 20;
let focusedIndex = 0;
let isListenersMounted = false;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let latestQueryTicket = 0;
let availableTags: string[] = [];
let availableDomains: string[] = [];
let autocompleteItems: SearchSuggestionItem[] = [];
let autocompleteActiveIndex = -1;
let currentTokenInfo: AutocompleteTokenInfo | null = null;

async function refreshSuggestionsData(): Promise<void> {
  try {
    const resp = (await browser.runtime.sendMessage({ type: 'GET_SEARCH_SUGGESTIONS' })) as {
      tags?: string[];
      domains?: string[];
    } | undefined;
    if (resp) {
      if (Array.isArray(resp.tags)) availableTags = resp.tags;
      if (Array.isArray(resp.domains)) availableDomains = resp.domains;
    }
  } catch {}
}

export async function initOverlayInShadow(shadow: ShadowRoot): Promise<void> {
  shadowRoot = shadow;
  try {
    const s = await getSettings();
    currentLang = s.language || DEFAULT_LANGUAGE;
    tagCatalog = s.tagCatalog || [];
    pinnedDomains = s.pinnedDomains || [];
    searchMaxResults = s.searchMaxResults || 100;
    searchPageSize = s.searchPageSize || 20;
  } catch {
    currentLang = DEFAULT_LANGUAGE;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes['settings']) {
      const s = changes['settings'].newValue as Partial<UserSettings> | undefined;
      if (s?.pinnedDomains) pinnedDomains = s.pinnedDomains;
      if (s?.tagCatalog) tagCatalog = s.tagCatalog;
    }
  });

  if (!shadow.querySelector('#pt-overlay-style')) {
    const style = document.createElement('style');
    style.id = 'pt-overlay-style';
    style.textContent = OVERLAY_CSS;
    shadow.appendChild(style);
  }

  renderOverlay();
  mountEventListeners();
  void refreshSuggestionsData();
}

export async function showOverlayInShadow(): Promise<void> {
  try {
    const s = await getSettings();
    tagCatalog = s.tagCatalog || [];
    searchMaxResults = s.searchMaxResults || 100;
    searchPageSize = s.searchPageSize || 20;
    if (s.language && s.language !== currentLang) {
      currentLang = s.language;
      renderOverlay();
      mountEventListeners();
    }
  } catch {}
  void refreshSuggestionsData();
  const input = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
  if (input) {
    void performSearch(input.value);
    input.focus();
    input.select();
  }
}

function renderOverlay(): void {
  if (!shadowRoot) return;

  const existing = shadowRoot.querySelector('.pt-overlay-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'pt-overlay-backdrop';
  setSafeHtml(backdrop, buildModalHTML());
  shadowRoot.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeOverlay();
  });

  bindModalInteractiveListeners();

  const input = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  input?.focus();
}

function buildModalHTML(): string {
  const t = getLocale(currentLang);
  const isCustomSort = activeSort !== 'relevance';
  return `
    <div class="pt-modal" role="dialog" aria-modal="true" aria-label="PageTrace Search">
      <div class="pt-search-bar">
        <svg class="pt-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          class="pt-search-input"
          type="text"
          placeholder="${escapeAttr(t.overlay.placeholder)}"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search query"
        />
        <div class="pt-kbd">
          <kbd>Esc</kbd>
        </div>
      </div>
      <div class="pt-autocomplete-wrap">
        <div class="pt-autocomplete" role="listbox" aria-label="${escapeAttr(t.overlay.autocompleteHint)}"></div>
      </div>
      <div class="pt-tabs">
        <div class="pt-type-wrap ${activeTab !== 'all' ? 'active' : ''}">
          <svg class="pt-type-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
            <polyline points="2 17 12 22 22 17"></polyline>
            <polyline points="2 12 12 17 22 12"></polyline>
          </svg>
          <select
            class="pt-type-select ${activeTab !== 'all' ? 'active' : ''}"
            title="${escapeAttr(t.overlay.typeLabel)}"
            aria-label="${escapeAttr(t.overlay.typeLabel)}"
          >
            <option value="all" id="pt-type-opt-all" ${activeTab === 'all' ? 'selected' : ''}>${escapeHtml(t.overlay.tabAll)}</option>
            <option value="text" id="pt-type-opt-text" ${activeTab === 'text' ? 'selected' : ''}>${escapeHtml(t.overlay.tabText)}</option>
            <option value="tag" id="pt-type-opt-tag" ${activeTab === 'tag' ? 'selected' : ''}>${escapeHtml(t.overlay.tabTag)}</option>
            <option value="media" id="pt-type-opt-media" ${activeTab === 'media' ? 'selected' : ''}>${escapeHtml(t.overlay.tabMedia)}</option>
          </select>
        </div>
        <div class="pt-filter-controls">
          <div class="pt-date-wrap ${activePeriod !== 'all' ? 'active' : ''}">
            <svg class="pt-date-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            <select
              class="pt-date-select ${activePeriod !== 'all' ? 'active' : ''}"
              title="${escapeAttr(t.overlay.dateLabel)}"
              aria-label="${escapeAttr(t.overlay.dateLabel)}"
            >
              <option value="all" ${activePeriod === 'all' ? 'selected' : ''}>${escapeHtml(t.overlay.dateAll)}</option>
              <option value="today" ${activePeriod === 'today' ? 'selected' : ''}>${escapeHtml(t.overlay.dateToday)}</option>
              <option value="week" ${activePeriod === 'week' ? 'selected' : ''}>${escapeHtml(t.overlay.dateWeek)}</option>
              <option value="month" ${activePeriod === 'month' ? 'selected' : ''}>${escapeHtml(t.overlay.dateMonth)}</option>
            </select>
          </div>
          <div class="pt-visits-wrap ${activeVisits !== 'all' ? 'active' : ''}">
            <svg class="pt-visits-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            <select
              class="pt-visits-select ${activeVisits !== 'all' ? 'active' : ''}"
              title="${escapeAttr(t.overlay.visitsLabel)}"
              aria-label="${escapeAttr(t.overlay.visitsLabel)}"
            >
              <option value="all" ${activeVisits === 'all' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsAll)}</option>
              <option value="multiple" ${activeVisits === 'multiple' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsMultiple)}</option>
              <option value="frequent" ${activeVisits === 'frequent' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsFrequent)}</option>
              <option value="once" ${activeVisits === 'once' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsOnce)}</option>
            </select>
          </div>
          <div class="pt-sort-wrap ${isCustomSort ? 'active' : ''}">
            <svg class="pt-sort-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/>
            </svg>
            <select
              class="pt-sort-select ${isCustomSort ? 'active' : ''}"
              title="${escapeAttr(t.overlay.sortLabel)}"
              aria-label="${escapeAttr(t.overlay.sortLabel)}"
            >
              <option value="relevance" ${activeSort === 'relevance' ? 'selected' : ''}>${escapeHtml(t.overlay.sortRelevance)}</option>
              <option value="newest" ${activeSort === 'newest' ? 'selected' : ''}>${escapeHtml(t.overlay.sortNewest)}</option>
              <option value="oldest" ${activeSort === 'oldest' ? 'selected' : ''}>${escapeHtml(t.overlay.sortOldest)}</option>
              <option value="title_asc" ${activeSort === 'title_asc' ? 'selected' : ''}>${escapeHtml(t.overlay.sortTitleAsc)}</option>
              <option value="title_desc" ${activeSort === 'title_desc' ? 'selected' : ''}>${escapeHtml(t.overlay.sortTitleDesc)}</option>
              <option value="visits_desc" ${activeSort === 'visits_desc' ? 'selected' : ''}>${escapeHtml(t.overlay.sortVisitsDesc)}</option>
              <option value="visits_asc" ${activeSort === 'visits_asc' ? 'selected' : ''}>${escapeHtml(t.overlay.sortVisitsAsc)}</option>
            </select>
          </div>
        </div>
      </div>
      <div class="pt-results" role="listbox">
        <div class="pt-empty">
          <span class="pt-empty-icon">🔍</span>
          <span>${escapeHtml(t.overlay.emptyInitial)}</span>
        </div>
      </div>
      <div class="pt-footer">
        <span class="pt-footer-count" id="pt-count"></span>
        <div class="pt-footer-hint">
          <span><kbd>↑↓</kbd> ${escapeHtml(t.overlay.hintNavigate)}</span>
          <span><kbd>↵</kbd> ${escapeHtml(t.overlay.hintOpen)}</span>
          <span><kbd>Esc</kbd> ${escapeHtml(t.overlay.hintClose)}</span>
        </div>
      </div>
    </div>
  `;
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

function renderAutocompleteDropdown(items: SearchSuggestionItem[]): void {
  if (!shadowRoot) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-autocomplete');
  if (!container) return;

  autocompleteActiveIndex = 0;
  const html = items
    .map(
      (item, idx) => `
      <div class="pt-autocomplete-item ${idx === 0 ? 'active' : ''}" data-idx="${idx}">
        <span class="pt-autocomplete-label">${escapeHtml(item.label)}</span>
        <span class="pt-autocomplete-desc">${escapeHtml(item.description || item.category)}</span>
      </div>
    `,
    )
    .join('');

  setSafeHtml(container, html);
  container.classList.add('open');

  container.querySelectorAll<HTMLElement>('.pt-autocomplete-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset['idx']);
      selectAutocompleteSuggestion(idx);
    });
  });
}

function hideAutocompleteDropdown(): void {
  if (!shadowRoot) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-autocomplete');
  if (container) {
    container.classList.remove('open');
    container.replaceChildren();
  }
  autocompleteItems = [];
  autocompleteActiveIndex = -1;
  currentTokenInfo = null;
}

function selectAutocompleteSuggestion(idx: number): void {
  if (!shadowRoot) return;
  const input = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  if (!input || !currentTokenInfo || !autocompleteItems[idx]) return;

  const item = autocompleteItems[idx]!;
  const res = applySuggestionToQuery(input.value, currentTokenInfo, item);
  input.value = res.newQuery;
  input.focus();
  input.setSelectionRange(res.newCursorPos, res.newCursorPos);
  hideAutocompleteDropdown();
  void performSearch(input.value);
}

function updateAutocompleteVisuals(): void {
  if (!shadowRoot) return;
  shadowRoot.querySelectorAll<HTMLElement>('.pt-autocomplete-item').forEach((el, i) => {
    el.classList.toggle('active', i === autocompleteActiveIndex);
  });
}

function bindModalInteractiveListeners(): void {
  if (!shadowRoot) return;

  const input = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  input?.addEventListener('input', (e) => {
    const q = (e.target as HTMLInputElement).value;
    const cursorPos = input.selectionStart ?? q.length;

    currentTokenInfo = getAutocompleteTokenInfo(q, cursorPos);
    if (currentTokenInfo && (currentTokenInfo.prefix || currentTokenInfo.filter.length >= 1)) {
      autocompleteItems = generateSearchSuggestions(currentTokenInfo, availableTags, availableDomains);
      if (autocompleteItems.length > 0) {
        renderAutocompleteDropdown(autocompleteItems);
      } else {
        hideAutocompleteDropdown();
      }
    } else {
      hideAutocompleteDropdown();
    }

    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      void performSearch(q);
    }, 80);
  });

  const resultsEl = shadowRoot.querySelector<HTMLElement>('.pt-results');
  resultsEl?.addEventListener('scroll', () => {
    if (
      displayedCount < groupedResults.length &&
      resultsEl.scrollTop + resultsEl.clientHeight >= resultsEl.scrollHeight - 100
    ) {
      loadMoreOverlayResults();
    }
  });

  const typeSelect = shadowRoot.querySelector<HTMLSelectElement>('.pt-type-select');
  const typeWrap = shadowRoot.querySelector<HTMLElement>('.pt-type-wrap');
  typeSelect?.addEventListener('change', () => {
    activeTab = (typeSelect.value as SearchTypeFilter) || 'all';
    const isCustomType = activeTab !== 'all';
    typeSelect.classList.toggle('active', isCustomType);
    typeWrap?.classList.toggle('active', isCustomType);
    const inputEl = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
    void performSearch(inputEl?.value ?? '');
    inputEl?.focus();
  });

  const dateSelect = shadowRoot.querySelector<HTMLSelectElement>('.pt-date-select');
  const dateWrap = shadowRoot.querySelector<HTMLElement>('.pt-date-wrap');
  dateSelect?.addEventListener('change', () => {
    activePeriod = (dateSelect.value as 'all' | 'today' | 'week' | 'month') || 'all';
    const isCustomDate = activePeriod !== 'all';
    dateSelect.classList.toggle('active', isCustomDate);
    dateWrap?.classList.toggle('active', isCustomDate);
    const inputEl = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
    void performSearch(inputEl?.value ?? '');
    inputEl?.focus();
  });

  const visitsSelect = shadowRoot.querySelector<HTMLSelectElement>('.pt-visits-select');
  const visitsWrap = shadowRoot.querySelector<HTMLElement>('.pt-visits-wrap');
  visitsSelect?.addEventListener('change', () => {
    activeVisits = (visitsSelect.value as 'all' | 'multiple' | 'frequent' | 'once') || 'all';
    const isCustomVisits = activeVisits !== 'all';
    visitsSelect.classList.toggle('active', isCustomVisits);
    visitsWrap?.classList.toggle('active', isCustomVisits);
    const inputEl = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
    void performSearch(inputEl?.value ?? '');
    inputEl?.focus();
  });

  const sortSelect = shadowRoot.querySelector<HTMLSelectElement>('.pt-sort-select');
  const sortWrap = shadowRoot.querySelector<HTMLElement>('.pt-sort-wrap');
  sortSelect?.addEventListener('change', () => {
    activeSort = (sortSelect.value as SearchSortOption) || 'relevance';
    const isCustomSort = activeSort !== 'relevance';
    sortSelect.classList.toggle('active', isCustomSort);
    sortWrap?.classList.toggle('active', isCustomSort);
    const inputEl = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
    void performSearch(inputEl?.value ?? '');
    inputEl?.focus();
  });
}

function mountEventListeners(): void {
  if (!shadowRoot || isListenersMounted) return;
  isListenersMounted = true;

  shadowRoot.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== 'Escape' && ke.target instanceof HTMLSelectElement) {
      return;
    }

    if (autocompleteItems.length > 0) {
      if (ke.key === 'ArrowDown') {
        ke.preventDefault();
        autocompleteActiveIndex = (autocompleteActiveIndex + 1) % autocompleteItems.length;
        updateAutocompleteVisuals();
        return;
      }
      if (ke.key === 'ArrowUp') {
        ke.preventDefault();
        autocompleteActiveIndex = (autocompleteActiveIndex - 1 + autocompleteItems.length) % autocompleteItems.length;
        updateAutocompleteVisuals();
        return;
      }
      if (ke.key === 'Enter' || ke.key === 'Tab') {
        ke.preventDefault();
        if (autocompleteActiveIndex >= 0) {
          selectAutocompleteSuggestion(autocompleteActiveIndex);
        }
        return;
      }
      if (ke.key === 'Escape') {
        ke.preventDefault();
        hideAutocompleteDropdown();
        return;
      }
    }

    switch (ke.key) {
      case 'Escape':
        closeOverlay();
        break;
      case 'ArrowDown':
        ke.preventDefault();
        navigate(1);
        break;
      case 'ArrowUp':
        ke.preventDefault();
        navigate(-1);
        break;
      case 'Enter':
        openFocused();
        break;
    }
  });
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
  return extractInlineOperators(query).sort || 'relevance';
}

async function performSearch(query: string): Promise<void> {
  const t = getLocale(currentLang);
  const trimmed = query.trim();

  const isDefaultBrowse =
    !trimmed &&
    activeTab === 'all' &&
    activeSort === 'relevance' &&
    activePeriod === 'all' &&
    activeVisits === 'all';
  if (isDefaultBrowse) {
    allResults = [];
    filteredResults = [];
    groupedResults = [];
    displayedCount = 0;
    updateTabCounts(false);
    renderEmpty(t.overlay.emptyInitial);
    return;
  }

  const ticket = ++latestQueryTicket;

  try {
    const dateRange = getDateRangeFromPeriod(activePeriod);
    const visitsRange = getVisitsRangeFromFilter(activeVisits);
    const filterOptions: SearchFilterOptions = {
      sort: activeSort,
      ...(activeTab !== 'all' ? { type: activeTab } : {}),
      ...(dateRange.dateFrom !== undefined ? { dateFrom: dateRange.dateFrom } : {}),
      ...(dateRange.dateTo !== undefined ? { dateTo: dateRange.dateTo } : {}),
      ...(visitsRange.minVisits !== undefined ? { minVisits: visitsRange.minVisits } : {}),
      ...(visitsRange.maxVisits !== undefined ? { maxVisits: visitsRange.maxVisits } : {}),
    };

    const results = (await browser.runtime.sendMessage({
      type: 'EXECUTE_SEARCH_QUERY',
      query: trimmed,
      limit: searchMaxResults,
      filterOptions,
    })) as SearchResult[] | undefined;

    if (ticket !== latestQueryTicket) return;
    allResults = Array.isArray(results) ? results : [];
  } catch (err) {
    console.warn('[PageTrace Overlay] Search query error:', err);
    if (ticket !== latestQueryTicket) return;
    allResults = [];
  }

  const parsed = extractInlineOperators(trimmed);
  updateTabCounts(
    Boolean(trimmed) ||
      activeTab !== 'all' ||
      activeSort !== 'relevance' ||
      activePeriod !== 'all' ||
      activeVisits !== 'all',
    parsed.type,
  );
  focusedIndex = 0;
  renderResults();
}

function updateTabCounts(visible: boolean, inlineTypeOverride?: SearchTypeFilter): void {
  if (!shadowRoot) return;
  const t = getLocale(currentLang);
  const counts: Record<SearchTypeFilter, number> = {
    all: allResults.length,
    text: allResults.filter((r) => r.type === 'text').length,
    tag: allResults.filter((r) => r.type === 'tag').length,
    media: allResults.filter((r) => r.type === 'media').length,
  };

  const getOptLabel = (label: string, count: number): string => {
    return visible ? `${label} (${count})` : label;
  };

  const optAll = shadowRoot.getElementById('pt-type-opt-all');
  const optText = shadowRoot.getElementById('pt-type-opt-text');
  const optTag = shadowRoot.getElementById('pt-type-opt-tag');
  const optMedia = shadowRoot.getElementById('pt-type-opt-media');

  if (optAll) optAll.textContent = getOptLabel(t.overlay.tabAll, counts.all);
  if (optText) optText.textContent = getOptLabel(t.overlay.tabText, counts.text);
  if (optTag) optTag.textContent = getOptLabel(t.overlay.tabTag, counts.tag);
  if (optMedia) optMedia.textContent = getOptLabel(t.overlay.tabMedia, counts.media);
}

function getFilteredResults(): SearchResult[] {
  const input = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
  const effectiveSort = getEffectiveSort(input?.value ?? '');
  const base = activeTab === 'all' ? allResults : allResults.filter((r) => r.type === activeTab);
  return sortSearchResults(base, effectiveSort);
}

function applyInlineOperator(operatorToken: string): void {
  if (!shadowRoot) return;
  const input = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  if (!input) return;

  input.value = toggleInlineOperatorToken(input.value, operatorToken);
  input.focus();
  void performSearch(input.value);
}

function createOverlayResultElement(group: GroupedSearchResult, idx: number): HTMLElement {
  const wrapper = document.createElement('div');
  setSafeHtml(wrapper, buildResultHTML(group, idx));
  const el = wrapper.firstElementChild as HTMLElement;
  const r = group.primary;
  const t = getLocale(currentLang);
  const domain = (() => { try { return new URL(r.url).hostname; } catch { return r.url; } })();

  const faviconImg = el.querySelector<HTMLImageElement>('img.pt-favicon');
  faviconImg?.addEventListener('error', () => {
    faviconImg.style.display = 'none';
  });

  const tagTrigger = el.querySelector<HTMLElement>('.pt-tag-trigger');
  tagTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const tag = tagTrigger.dataset['tag'];
    if (tag) applyInlineOperator(`#${tag}`);
  });

  const domainTrigger = el.querySelector<HTMLElement>('.pt-domain.clickable');
  domainTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dom = domainTrigger.dataset['domain'];
    if (dom) applyInlineOperator(`site:${dom}`);
  });

  const visitsTrigger = el.querySelector<HTMLElement>('.pt-visits');
  visitsTrigger?.addEventListener('click', (e) => {
    e.stopPropagation();
    const count = visitsTrigger.dataset['visits'];
    if (count) applyInlineOperator(`visits:>=${count}`);
  });

  const copyBtn = el.querySelector<HTMLButtonElement>('.pt-act-copy');
  copyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatMarkdownQuote(r.text, r.title, r.url));
      copyBtn.classList.add('copied');
      const orig = copyBtn.title;
      copyBtn.title = t.overlay.actionCopyQuoteSuccess;
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.title = orig;
      }, 1500);
    } catch {}
  });

  const delBtn = el.querySelector<HTMLButtonElement>('.pt-act-delete');
  delBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.confirm(t.overlay.actionDeleteConfirm)) {
      await browser.runtime.sendMessage({ type: 'DELETE_PAGE', pageId: r.pageId, url: r.url });
      allResults = allResults.filter((item) => item.pageId !== r.pageId && item.url !== r.url);
      renderResults();
    }
  });

  const blBtn = el.querySelector<HTMLButtonElement>('.pt-act-blacklist');
  blBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (window.confirm(t.overlay.actionBlacklistConfirm(domain))) {
      const s = await getSettings();
      if (!s.blacklist.includes(domain)) {
        s.blacklist.push(domain);
        await saveSettings(s);
      }
      allResults = allResults.filter((item) => {
        try { return new URL(item.url).hostname !== domain; } catch { return !item.url.includes(domain); }
      });
      renderResults();
    }
  });

  const pinBtn = el.querySelector<HTMLButtonElement>('.pt-act-pin');
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
      pinBtn.title = t.overlay.actionPinDomain;
    } else {
      currentPinned.push(domain);
      await saveSettings({ pinnedDomains: currentPinned });
      pinnedDomains = currentPinned;
      pinBtn.classList.add('active');
      pinBtn.title = t.overlay.actionUnpinDomain;
    }
  });

  const toggleBtn = el.querySelector<HTMLButtonElement>('.pt-submatches-toggle');
  toggleBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const norm = normalizePageUrl(r.url);
    if (expandedUrls.has(norm)) {
      expandedUrls.delete(norm);
    } else {
      expandedUrls.add(norm);
    }
    renderResults();
  });

  el.querySelectorAll<HTMLElement>('.pt-submatch-item').forEach((subEl) => {
    subEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const subIdx = Number(subEl.dataset['subIdx']);
      const subItem = group.subMatches[subIdx];
      if (subItem) openResult(subItem);
    });
  });

  el.addEventListener('click', () => openResult(r));
  el.addEventListener('mouseenter', () => {
    focusedIndex = idx;
    updateFocus();
  });

  return el;
}

function appendOverlayResultBatch(container: HTMLElement, startIdx: number, endIdx: number): void {
  const fragment = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) {
    const group = groupedResults[i];
    if (group) {
      fragment.appendChild(createOverlayResultElement(group, i));
    }
  }
  container.appendChild(fragment);
}

function loadMoreOverlayResults(): void {
  if (!shadowRoot || displayedCount >= groupedResults.length) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-results');
  if (!container) return;

  const prevCount = displayedCount;
  displayedCount = Math.min(groupedResults.length, displayedCount + searchPageSize);
  appendOverlayResultBatch(container, prevCount, displayedCount);
  updateFocus();
}

function renderResults(): void {
  if (!shadowRoot) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-results');
  if (!container) return;

  const t = getLocale(currentLang);
  filteredResults = getFilteredResults();
  groupedResults = groupResultsByPage(filteredResults);
  displayedCount = Math.min(groupedResults.length, searchPageSize);

  const countEl = shadowRoot.querySelector('#pt-count');
  if (countEl) {
    countEl.textContent = filteredResults.length > 0 ? t.overlay.resultsCount(filteredResults.length) : '';
  }

  if (groupedResults.length === 0) {
    setSafeHtml(
      container,
      `<div class="pt-empty">
        <span class="pt-empty-icon">😶‍🌫️</span>
        <span>${escapeHtml(t.overlay.noResults)}</span>
      </div>`,
    );
    return;
  }

  container.replaceChildren();
  container.scrollTop = 0;
  appendOverlayResultBatch(container, 0, displayedCount);
  updateFocus();
}

function buildResultHTML(group: GroupedSearchResult, _i: number): string {
  const r = group.primary;
  const t = getLocale(currentLang);
  const domain = (() => { try { return new URL(r.url).hostname; } catch { return r.url; } })();
  const favicon = r.favicon
    ? `<img class="pt-favicon" src="${escapeAttr(r.favicon)}" alt="">`
    : `<span class="pt-favicon"></span>`;

  const customShortTag =
    r.tagName && (r.tagName !== r.text || r.tagName.length <= 15) ? r.tagName : '';
  const activeTag = customShortTag || (r.tags && r.tags.length > 0 ? r.tags[0]! : '');
  const normTag = activeTag ? normalizeTagName(activeTag) : '';
  const tagHtml = normTag
    ? `<span class="pt-tag-trigger" data-tag="${escapeAttr(normTag)}" title="Filter by #${escapeAttr(normTag)}">${renderTagBadge(normTag, tagCatalog, 'clickable')}</span>`
    : '';

  const timeAgo = formatTimeAgo(r.createdAt, currentLang);
  const normUrl = normalizePageUrl(r.url);
  const isExpanded = expandedUrls.has(normUrl);
  const subCount = group.subMatches.length;

  let subMatchesHtml = '';
  if (subCount > 0) {
    const toggleLabel = isExpanded ? t.overlay.collapseMatches : t.overlay.expandMatches(subCount);
    const subListHtml = isExpanded
      ? `
      <div class="pt-submatches-list">
        ${group.subMatches
          .map(
            (sub, subIdx) => `
          <div class="pt-submatch-item" data-sub-idx="${subIdx}" title="${escapeAttr(t.overlay.hintOpen)}">
            <div class="pt-submatch-snippet">${sub.snippet}</div>
            ${sub.note ? `<div class="pt-result-note"><span class="pt-note-icon">📝</span> ${escapeHtml(sub.note)}</div>` : ''}
          </div>
        `,
          )
          .join('')}
      </div>
    `
      : '';

    subMatchesHtml = `
      <button class="pt-submatches-toggle" type="button">${escapeHtml(toggleLabel)}</button>
      ${subListHtml}
    `;
  }

  const isPinned = pinnedDomains.some(
    (p) => p.toLowerCase() === domain.toLowerCase() || matchUrlPattern(p, r.url),
  );
  const pinTitle = isPinned ? t.overlay.actionUnpinDomain : t.overlay.actionPinDomain;
  const pinClass = isPinned ? 'pt-act-btn pt-act-pin active' : 'pt-act-btn pt-act-pin';

  const visitCount = r.visitCount ?? 1;
  const visitsTooltip = t.overlay.visitsTooltip(visitCount);
  const visitsHtml = `
    <span class="pt-visits" title="${escapeAttr(visitsTooltip)}" data-visits="${visitCount}">
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
      </svg>
      <span>${visitCount}</span>
    </span>
  `;

  return `
    <div class="pt-result" role="option" tabindex="-1">
      <div class="pt-meta-header">
        <div class="pt-meta-row">
          ${favicon}
          <span class="pt-domain clickable" data-domain="${escapeAttr(domain)}" title="Filter by site:${escapeAttr(domain)}">${escapeHtml(domain)}</span>
          ${tagHtml ? `<span class="pt-meta-dot">•</span>${tagHtml}` : ''}
          <span class="pt-meta-dot">•</span>${visitsHtml}
          ${timeAgo ? `<span class="pt-meta-dot">•</span><span class="pt-time">${escapeHtml(timeAgo)}</span>` : ''}
        </div>
        <div class="pt-quick-actions">
          <button class="${pinClass}" type="button" title="${escapeAttr(pinTitle)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="17" x2="12" y2="22"/>
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>
            </svg>
          </button>
          <button class="pt-act-btn pt-act-copy" type="button" title="${escapeAttr(t.overlay.actionCopyQuote)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
            </svg>
          </button>
          <button class="pt-act-btn pt-act-delete" type="button" title="${escapeAttr(t.overlay.actionDeletePage)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
            </svg>
          </button>
          <button class="pt-act-btn pt-act-blacklist" type="button" title="${escapeAttr(t.overlay.actionBlacklistDomain)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="pt-page-title">${escapeHtml(r.title || domain)}</div>
      <div class="pt-snippet">${r.snippet}</div>
      ${r.note ? `<div class="pt-result-note"><span class="pt-note-icon">📝</span> ${escapeHtml(r.note)}</div>` : ''}
      ${subMatchesHtml}
    </div>
  `;
}

function renderEmpty(msg: string): void {
  if (!shadowRoot) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-results');
  if (!container) return;
  setSafeHtml(
    container,
    `<div class="pt-empty">
      <span class="pt-empty-icon">🔍</span>
      <span>${escapeHtml(msg)}</span>
    </div>`,
  );
  const countEl = shadowRoot.querySelector('#pt-count');
  if (countEl) countEl.textContent = '';
}

function navigate(delta: number): void {
  if (!shadowRoot || groupedResults.length === 0) return;
  focusedIndex = Math.max(0, Math.min(groupedResults.length - 1, focusedIndex + delta));
  if (focusedIndex >= displayedCount) {
    loadMoreOverlayResults();
  }
  updateFocus();
  const items = shadowRoot.querySelectorAll<HTMLElement>('.pt-result');
  items[focusedIndex]?.scrollIntoView({ block: 'nearest' });
}

function updateFocus(): void {
  if (!shadowRoot) return;
  shadowRoot.querySelectorAll<HTMLElement>('.pt-result').forEach((el, i) => {
    el.classList.toggle('focused', i === focusedIndex);
  });
}

function openFocused(): void {
  if (groupedResults[focusedIndex]) openResult(groupedResults[focusedIndex]!.primary);
}

function openResult(r: SearchResult): void {
  if (r.type === 'media' && r.selector.startsWith('http')) {
    browser.runtime.sendMessage({ type: 'TOUCH_PAGE', pageId: r.pageId, url: r.url }).catch(() => {});
    window.open(r.selector, '_blank', 'noopener');
    closeOverlay();
    return;
  }

  if (normalizePageUrl(location.href) === normalizePageUrl(r.url)) {
    browser.runtime.sendMessage({ type: 'TOUCH_PAGE', pageId: r.pageId, url: r.url }).catch(() => {});
    closeOverlay();
    window.dispatchEvent(new CustomEvent('pt:scroll', { detail: { text: r.text, selector: r.selector } }));
  } else {
    closeOverlay();
    window.dispatchEvent(
      new CustomEvent('pt:navigate', {
        detail: { url: r.url, text: r.text, selector: r.selector },
      }),
    );
  }
}

function closeOverlay(): void {
  hideAutocompleteDropdown();
  const host = document.getElementById('pagetrace-overlay-host');
  if (host) host.style.display = 'none';
  if (location.pathname.endsWith('search.html')) {
    window.close();
  }
}

const host = document.getElementById('pagetrace-overlay-host');
if (host) {
  host.addEventListener('pt:init', (e) => {
    const detail = (e as CustomEvent).detail as { shadow?: ShadowRoot } | undefined;
    const shadow = detail?.shadow || host.shadowRoot;
    if (shadow) {
      void initOverlayInShadow(shadow);
    }
  });

  host.addEventListener('pt:show', () => {
    void showOverlayInShadow();
  });
}
