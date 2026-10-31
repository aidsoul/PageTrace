import browser from 'webextension-polyfill';
import type { SearchResult, SearchTypeFilter, SearchSortOption, SearchFilterOptions, TagCatalogItem, UserSettings, SearchMode } from '@/types/index';
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
let currentSearchMode: SearchMode = 'global';
let liveMatches: LiveDomMatch[] = [];
let currentLiveIndex = -1;
let focusedLiveIndex = 0;
let isPageResultsExpanded = false;
let isFloatingNavOpen = false;


interface LiveDomMatch {
  index: number;
  element: HTMLElement;
  textNode: Text;
  startOffset: number;
  endOffset: number;
  endTextNode?: Text;
  surroundingText: string;
  snippetHtml: string;
  tagName: string;
}

const GLOBAL_ICON_SVG = '<svg class="pt-mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
const PAGE_ICON_SVG = '<svg class="pt-mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

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

  .pt-overlay-backdrop.page-mode {
    background: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    pointer-events: none !important;
    padding-top: 18px !important;
    padding-right: 24px !important;
    justify-content: flex-end !important;
    align-items: flex-start !important;
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
    transition: width 0.15s ease, max-height 0.15s ease, box-shadow 0.15s ease;
  }

  .pt-modal.page-mode {
    width: min(450px, 92vw);
    max-height: 60vh;
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65), 0 0 0 1px #2E3340;
    pointer-events: all !important;
    background: #181A1F;
  }

  .pt-modal.page-mode.collapsed {
    max-height: 48px !important;
  }

  .pt-modal.page-mode.collapsed .pt-results,
  .pt-modal.page-mode.collapsed .pt-footer,
  .pt-modal.page-mode.collapsed .pt-autocomplete-wrap {
    display: none !important;
  }

  .pt-modal.page-mode.collapsed .pt-search-bar {
    border-bottom: none !important;
  }

  .pt-modal.page-mode .pt-search-bar {
    padding: 8px 12px;
    gap: 8px;
  }

  .pt-modal.page-mode .pt-search-input {
    font-size: 14px;
  }

  .pt-modal.page-mode .pt-search-icon {
    display: none;
  }

  .pt-modal.page-mode .pt-kbd {
    display: none;
  }

  .pt-inbar-nav {
    display: none;
    align-items: center;
    gap: 3px;
    flex-shrink: 0;
  }

  .pt-modal.page-mode .pt-inbar-nav.visible {
    display: flex;
  }

  .pt-inbar-counter {
    font-size: 11.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #F4FF2B;
    padding: 2px 6px;
    background: #20232B;
    border-radius: 4px;
    white-space: nowrap;
    min-width: 40px;
    text-align: center;
    line-height: 1.4;
  }

  .pt-inbar-btn {
    background: transparent;
    border: none;
    color: #8E94A2;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.12s ease;
    padding: 0;
    flex-shrink: 0;
  }

  .pt-inbar-btn:hover {
    background: #272B36;
    color: #ECEEF2;
  }

  .pt-inbar-btn svg {
    width: 14px;
    height: 14px;
  }

  .pt-close-btn {
    display: none;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: #8E94A2;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.12s ease;
    padding: 0;
    flex-shrink: 0;
  }

  .pt-modal.page-mode .pt-close-btn {
    display: flex;
  }

  .pt-close-btn:hover {
    background: rgba(239, 68, 68, 0.2);
    color: #F87171;
  }

  .pt-close-btn svg {
    width: 14px;
    height: 14px;
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

  .pt-clear-btn {
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: #7E838F;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    line-height: 1;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .pt-clear-btn:hover {
    background: rgba(255, 255, 255, 0.16);
    color: #ECEEF2;
  }

  .pt-clear-btn.visible {
    display: flex;
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

  .pt-mode-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: #20232B;
    border: 1px solid #2E3340;
    border-radius: 8px;
    color: #9499A6;
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
    flex-shrink: 0;
  }

  .pt-mode-toggle:hover {
    background: #272B36;
    border-color: #3C4252;
    color: #ECEEF2;
  }

  .pt-mode-toggle.is-page {
    background: rgba(244, 255, 43, 0.12);
    border-color: rgba(244, 255, 43, 0.5);
    color: #F4FF2B;
  }

  .pt-mode-icon {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .pt-tabs.page-mode-hidden {
    display: none;
  }

  .pt-live-item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 18px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.12s ease;
    border-left: 2px solid transparent;
  }

  .pt-live-item:hover,
  .pt-live-item.focused {
    background: #1F222A;
    border-left-color: #F4FF2B;
  }

  .pt-live-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: #7E838F;
  }

  .pt-live-tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    background: #252832;
    color: #A0A6B5;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
  }

  .pt-live-pos {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #7E838F;
  }

  .pt-live-snippet {
    font-size: 13px;
    line-height: 1.5;
    color: #C7CBD4;
  }

  .pt-live-snippet mark,
  .pt-highlight {
    background: #F4FF2B;
    color: #111215 !important;
    border-radius: 2px;
    padding: 0 2px;
    font-weight: 600;
  }

  .pt-floating-nav {
    position: fixed;
    top: 20px;
    right: 24px;
    background: #181A1F;
    border: 1px solid #2E3340;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05);
    padding: 6px 10px;
    display: none;
    align-items: center;
    gap: 8px;
    z-index: 2147483647;
    pointer-events: all;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
    color: #ECEEF2;
    animation: pt-dock-in 0.15s ease-out;
  }

  .pt-floating-nav.visible {
    display: flex;
  }

  @keyframes pt-dock-in {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .pt-float-query {
    font-size: 12px;
    font-weight: 500;
    color: #ECEEF2;
    max-width: 140px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: #22252E;
    padding: 3px 8px;
    border-radius: 4px;
  }

  .pt-float-counter {
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #F4FF2B;
    white-space: nowrap;
    min-width: 44px;
    text-align: center;
  }

  .pt-float-divider {
    width: 1px;
    height: 16px;
    background: #2E3340;
  }

  .pt-float-btn {
    background: transparent;
    border: none;
    border-radius: 5px;
    color: #8E94A2;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.12s ease;
  }

  .pt-float-btn:hover {
    background: #272B36;
    color: #ECEEF2;
  }

  .pt-float-close:hover {
    background: rgba(239, 68, 68, 0.2);
    color: #F87171;
  }


  .pt-tabs {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 18px;
    border-bottom: 1px solid #242730;
    background: #14161A;
  }

  .pt-filter-group {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pt-filter-group-left {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .pt-filter-group-left::-webkit-scrollbar {
    display: none;
  }

  .pt-filter-group-right {
    flex-shrink: 0;
  }

  .pt-pill-wrap {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }

  .pt-pill-select {
    background-color: #1A1D24;
    border: 1px solid #2B2F3A;
    color: #8C92A0;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    padding: 5px 24px 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    outline: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%237E838F' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 10px;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .pt-pill-select:hover {
    color: #ECEEF2;
    border-color: #3F4452;
    background-color: #21252E;
  }

  .pt-pill-select:focus-visible {
    border-color: #F4FF2B;
    box-shadow: 0 0 0 1px rgba(244, 255, 43, 0.25);
  }

  .pt-pill-select.active {
    background-color: rgba(244, 255, 43, 0.1);
    border-color: rgba(244, 255, 43, 0.4);
    color: #F4FF2B;
    font-weight: 600;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23F4FF2B' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  }

  .pt-pill-select option {
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

  .pt-result-body {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
  }

  .pt-result-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pt-thumb-box {
    width: 58px;
    height: 58px;
    border-radius: 8px;
    background: #111215;
    border: 1px solid #2A2D35;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pt-thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.15s ease;
  }

  .pt-result:hover .pt-thumb-img,
  .pt-result.focused .pt-thumb-img {
    transform: scale(1.06);
  }

  .pt-submatch-item {
    padding: 6px 10px;
    background: #14161A;
    border-radius: 6px;
    border: 1px solid #22252C;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .pt-submatch-thumb {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    background: #111215;
    border: 1px solid #2A2D35;
    overflow: hidden;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pt-submatch-thumb-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .pt-submatch-content {
    flex: 1;
    min-width: 0;
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


function isElementHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden === true) {
    return true;
  }
  if ('checkVisibility' in el && typeof (el as HTMLElement).checkVisibility === 'function') {
    return !(el as HTMLElement).checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
  }
  const style = window.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'blockquote',
  'article', 'section', 'header', 'footer', 'aside', 'main', 'div', 'td',
  'th', 'tr', 'table', 'dd', 'dt', 'dl', 'pre', 'summary', 'details',
  'figure', 'figcaption', 'form', 'nav'
]);

function getBlockAncestor(node: Node): HTMLElement | null {
  let el = node.parentElement;
  while (el && el !== document.body) {
    if (BLOCK_TAGS.has(el.tagName.toLowerCase())) {
      return el;
    }
    el = el.parentElement;
  }
  return el || document.body;
}

function findLivePageMatches(query: string, maxMatches = 250): LiveDomMatch[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed || !document.body) return [];

  const matches: LiveDomMatch[] = [];
  const overlayHost = document.getElementById('pagetrace-overlay-host');
  const selectionHost = document.getElementById('pagetrace-selection-host');

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (overlayHost && (overlayHost === parent || overlayHost.contains(parent))) {
          return NodeFilter.FILTER_REJECT;
        }
        if (selectionHost && (selectionHost === parent || selectionHost.contains(parent))) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest?.('.pagetrace-toast')) {
          return NodeFilter.FILTER_REJECT;
        }
        const tag = parent.tagName.toLowerCase();
        if (
          tag === 'script' ||
          tag === 'style' ||
          tag === 'noscript' ||
          tag === 'template' ||
          tag === 'textarea' ||
          tag === 'input' ||
          tag === 'select' ||
          tag === 'option' ||
          tag === 'svg' ||
          Boolean(parent.closest('svg'))
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let currentBlock: HTMLElement | null = null;
  let blockEntries: { node: Text; parentEl: HTMLElement; start: number; end: number }[] = [];
  let blockCombinedText = '';

  const processBlockMatches = (): void => {
    if (blockEntries.length === 0 || !blockCombinedText) return;
    const lower = blockCombinedText.toLowerCase();
    if (!lower.includes(trimmed)) return;

    let pos = 0;
    while ((pos = lower.indexOf(trimmed, pos)) !== -1 && matches.length < maxMatches) {
      const matchStart = pos;
      const matchEnd = pos + trimmed.length;

      const startEntry =
        blockEntries.find((e) => matchStart >= e.start && matchStart < e.end) || blockEntries[0]!;
      const endEntry =
        blockEntries.find((e) => matchEnd > e.start && matchEnd <= e.end) ||
        blockEntries[blockEntries.length - 1]!;

      const startOffset = Math.max(0, matchStart - startEntry.start);
      const endOffset = Math.min(endEntry.node.length, matchEnd - endEntry.start);

      const snippetStart = Math.max(0, matchStart - 40);
      const snippetEnd = Math.min(blockCombinedText.length, matchEnd + 60);
      const before = escapeHtml(blockCombinedText.slice(snippetStart, matchStart));
      const matched = escapeHtml(blockCombinedText.slice(matchStart, matchEnd));
      const after = escapeHtml(blockCombinedText.slice(matchEnd, snippetEnd));
      const snippetHtml = `${snippetStart > 0 ? '…' : ''}${before}<mark class="pt-highlight">${matched}</mark>${after}${snippetEnd < blockCombinedText.length ? '…' : ''}`;

      matches.push({
        index: matches.length,
        element: startEntry.parentEl,
        textNode: startEntry.node,
        startOffset,
        endOffset,
        endTextNode: endEntry.node !== startEntry.node ? endEntry.node : undefined,
        surroundingText: blockCombinedText.slice(snippetStart, snippetEnd),
        snippetHtml,
        tagName: startEntry.parentEl.tagName.toLowerCase(),
      });

      pos += Math.max(1, trimmed.length);
    }
  };

  let current: Node | null;
  while ((current = walker.nextNode()) && matches.length < maxMatches) {
    const textNode = current as Text;
    const text = textNode.textContent ?? '';
    if (!text) continue;

    const parentEl = textNode.parentElement as HTMLElement | null;
    if (!parentEl || isElementHidden(parentEl)) continue;

    const blockEl = getBlockAncestor(textNode);
    if (blockEl !== currentBlock) {
      processBlockMatches();
      currentBlock = blockEl;
      blockEntries = [];
      blockCombinedText = '';
    }

    const start = blockCombinedText.length;
    blockCombinedText += text;
    blockEntries.push({
      node: textNode,
      parentEl,
      start,
      end: start + text.length,
    });
  }

  if (matches.length < maxMatches) {
    processBlockMatches();
  }

  return matches;
}

function renderLiveResults(): void {
  if (!shadowRoot) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-results');
  if (!container) return;

  const html = liveMatches
    .map(
      (m, i) => `
      <div class="pt-live-item ${i === focusedLiveIndex ? 'focused' : ''}" data-live-index="${i}">
        <div class="pt-live-item-header">
          <span class="pt-live-tag">&lt;${escapeHtml(m.tagName)}&gt;</span>
          <span class="pt-live-pos">#${i + 1}</span>
        </div>
        <div class="pt-live-snippet">${m.snippetHtml}</div>
      </div>
    `,
    )
    .join('');

  setSafeHtml(container, html);

  container.querySelectorAll<HTMLElement>('.pt-live-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset['liveIndex']);
      if (!Number.isNaN(idx)) {
        activateLiveMatchAndDock(idx);
      }
    });
  });
}

function renderLiveEmpty(text: string): void {
  if (!shadowRoot) return;
  const container = shadowRoot.querySelector<HTMLElement>('.pt-results');
  if (!container) return;
  setSafeHtml(
    container,
    `
    <div class="pt-empty">
      <span class="pt-empty-icon">🔍</span>
      <span>${escapeHtml(text)}</span>
    </div>
  `,
  );
}

function activateLiveMatchAndDock(index: number): void {
  if (liveMatches.length === 0) return;
  const backdrop = shadowRoot?.querySelector<HTMLElement>('.pt-overlay-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  unlockPageScroll();

  showFloatingNav();
  activateLiveMatch(index);
}

function showFloatingNav(): void {
  if (!shadowRoot) return;
  let nav = shadowRoot.querySelector<HTMLElement>('.pt-floating-nav');
  const t = getLocale(currentLang);
  const input = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  const query = input?.value || '';

  if (!nav) {
    nav = document.createElement('div');
    nav.className = 'pt-floating-nav visible';
    nav.setAttribute('role', 'toolbar');
    nav.setAttribute('aria-label', 'Page search navigation');
    setSafeHtml(
      nav,
      `
      <span class="pt-float-query" id="pt-float-query" title="${escapeAttr(query)}">${escapeHtml(query)}</span>
      <span class="pt-float-counter"><span id="pt-float-curr">1</span> / <span id="pt-float-total">${liveMatches.length}</span></span>
      <div class="pt-float-divider"></div>
      <button class="pt-float-btn pt-float-prev" type="button" title="${escapeAttr(t.overlay.liveNavPrev)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>
      </button>
      <button class="pt-float-btn pt-float-next" type="button" title="${escapeAttr(t.overlay.liveNavNext)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="pt-float-divider"></div>
      <button class="pt-float-btn pt-float-expand" type="button" title="${escapeAttr(t.overlay.liveNavExpand)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>
      </button>
      <button class="pt-float-btn pt-float-close" type="button" title="${escapeAttr(t.overlay.liveNavClose)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    `,
    );
    shadowRoot.appendChild(nav);

    nav.querySelector('.pt-float-prev')?.addEventListener('click', () => {
      activateLiveMatch(currentLiveIndex - 1);
    });
    nav.querySelector('.pt-float-next')?.addEventListener('click', () => {
      activateLiveMatch(currentLiveIndex + 1);
    });
    nav.querySelector('.pt-float-expand')?.addEventListener('click', () => {
      restoreModalFromFloatingNav();
    });
    nav.querySelector('.pt-float-close')?.addEventListener('click', () => {
      closeOverlay();
    });
  } else {
    nav.classList.add('visible');
    const qEl = nav.querySelector<HTMLElement>('#pt-float-query');
    if (qEl) {
      qEl.textContent = query;
      qEl.title = query;
    }
    const totEl = nav.querySelector<HTMLElement>('#pt-float-total');
    if (totEl) totEl.textContent = String(liveMatches.length);
  }

  if (!isFloatingNavOpen) {
    isFloatingNavOpen = true;
    window.addEventListener('keydown', onFloatingNavGlobalKeydown, true);
  }
}

export function restoreModalFromFloatingNav(): void {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  hideFloatingNav(false);
  const backdrop = shadowRoot?.querySelector<HTMLElement>('.pt-overlay-backdrop');
  if (backdrop) backdrop.style.display = 'flex';
  if (currentSearchMode === 'page') {
    unlockPageScroll();
  } else {
    lockPageScroll();
  }
  const input = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
  input?.focus();
  input?.select();
  if (currentSearchMode === 'page' && liveMatches.length > 0) {
    activateLiveMatch(currentLiveIndex, 'none');
  }
}

export function isFloatingNavVisible(): boolean {
  return isFloatingNavOpen;
}

function hideFloatingNav(clearHighlights = true): void {
  if (isFloatingNavOpen) {
    isFloatingNavOpen = false;
    window.removeEventListener('keydown', onFloatingNavGlobalKeydown, true);
  }
  const nav = shadowRoot?.querySelector<HTMLElement>('.pt-floating-nav');
  if (nav) nav.classList.remove('visible');
  if (clearHighlights) {
    clearLiveHighlights();
  }
}

function onFloatingNavGlobalKeydown(e: KeyboardEvent): void {
  if (!isFloatingNavOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeOverlay();
    return;
  }
  const targetEl = e.target instanceof Element ? e.target : null;
  const tag = targetEl ? targetEl.tagName.toLowerCase() : '';
  const isInteractiveTarget =
    targetEl !== null &&
    (tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      tag === 'button' ||
      tag === 'a' ||
      tag === 'summary' ||
      tag === 'canvas' ||
      (targetEl as HTMLElement).isContentEditable ||
      Boolean(
        targetEl.closest(
          'a, button, summary, select, textarea, input, canvas, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="textbox"], [role="grid"], [role="gridcell"], [contenteditable="true"]'
        )
      ));
  if (isInteractiveTarget && e.key === 'Enter') {
    return;
  }
  if (e.key === 'Enter' || e.key === 'F3') {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      activateLiveMatch(currentLiveIndex - 1);
    } else {
      activateLiveMatch(currentLiveIndex + 1);
    }
    return;
  }
}

function updateAllLiveHighlights(): void {
  if (!('Highlight' in window) || !('highlights' in CSS)) {
    document.querySelectorAll('.pt-fallback-match').forEach((el) => {
      el.classList.remove('pt-fallback-match', 'pt-fallback-match-active');
    });
    liveMatches.forEach((m, idx) => {
      if (m.element && m.element.isConnected) {
        m.element.classList.add('pt-fallback-match');
        if (idx === currentLiveIndex) {
          m.element.classList.add('pt-fallback-match-active');
        }
      }
    });
    return;
  }

  const highlightsMap = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
  try {
    const allRanges: Range[] = [];
    let activeRange: Range | null = null;

    liveMatches.forEach((m, idx) => {
      if (m.textNode && m.textNode.isConnected) {
        try {
          const range = document.createRange();
          range.setStart(m.textNode, m.startOffset);
          const endNode = m.endTextNode && m.endTextNode.isConnected ? m.endTextNode : m.textNode;
          range.setEnd(endNode, m.endOffset);
          allRanges.push(range);
          if (idx === currentLiveIndex) {
            activeRange = range;
          }
        } catch {}
      }
    });

    const HighlightConstructor = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
    if (allRanges.length > 0) {
      highlightsMap.set('pagetrace-match', new HighlightConstructor(...allRanges));
    } else {
      highlightsMap.delete('pagetrace-match');
    }

    if (activeRange) {
      highlightsMap.set('pagetrace-match-active', new HighlightConstructor(activeRange));
    } else {
      highlightsMap.delete('pagetrace-match-active');
    }
  } catch {}
}

function clearLiveHighlights(): void {
  if ('highlights' in CSS && CSS.highlights) {
    const h = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
    h.delete('pagetrace-match');
    h.delete('pagetrace-match-active');
  }
  document.querySelectorAll('.pt-scroll-target-flash').forEach((el) => {
    el.classList.remove('pt-scroll-target-flash');
  });
  document.querySelectorAll('.pt-fallback-match').forEach((el) => {
    el.classList.remove('pt-fallback-match', 'pt-fallback-match-active');
  });
}

function activateLiveMatch(index: number, scrollBehavior: ScrollBehavior | 'none' = 'smooth'): void {
  if (liveMatches.length === 0) return;
  currentLiveIndex = (index + liveMatches.length) % liveMatches.length;
  focusedLiveIndex = currentLiveIndex;
  updateFocus();

  const inbarCurr = shadowRoot?.querySelector<HTMLElement>('#pt-inbar-curr');
  if (inbarCurr) inbarCurr.textContent = String(currentLiveIndex + 1);

  const currEl = shadowRoot?.querySelector<HTMLElement>('#pt-float-curr');
  if (currEl) currEl.textContent = String(currentLiveIndex + 1);

  const m = liveMatches[currentLiveIndex];
  if (!m || !m.element) return;

  if (m.element.isConnected && scrollBehavior !== 'none') {
    m.element.scrollIntoView({ behavior: scrollBehavior, block: 'center' });
  }

  document.querySelectorAll('.pt-scroll-target-flash').forEach((el) => {
    el.classList.remove('pt-scroll-target-flash');
  });
  if (m.element.isConnected) {
    void m.element.offsetWidth;
    m.element.classList.add('pt-scroll-target-flash');
  }

  updateAllLiveHighlights();
}

function setSearchMode(mode: SearchMode): void {
  if (currentSearchMode === 'page' && mode !== 'page') {
    clearLiveHighlights();
  }
  currentSearchMode = mode;
  syncModeUI();
  const input = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
  if (input) {
    void performSearch(input.value);
    input.focus();
  }
}

function updateInbarNavVisuals(): void {
  if (!shadowRoot) return;
  const t = getLocale(currentLang);
  const inbarNav = shadowRoot.querySelector<HTMLElement>('.pt-inbar-nav');
  const hasMatches = currentSearchMode === 'page' && liveMatches.length > 0;
  if (inbarNav) {
    inbarNav.classList.toggle('visible', hasMatches);
  }

  const currEl = shadowRoot.querySelector<HTMLElement>('#pt-inbar-curr');
  if (currEl) {
    currEl.textContent = hasMatches ? String(currentLiveIndex + 1) : '0';
  }

  const totalEl = shadowRoot.querySelector<HTMLElement>('#pt-inbar-total');
  if (totalEl) {
    totalEl.textContent = String(liveMatches.length);
  }

  const expandBtn = shadowRoot.querySelector<HTMLButtonElement>('.pt-inbar-toggle-expand');
  if (expandBtn) {
    expandBtn.title = isPageResultsExpanded ? t.overlay.liveCollapseList : t.overlay.liveExpandList;
    setSafeHtml(
      expandBtn,
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${isPageResultsExpanded ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'}"/></svg>`
    );
  }

  const modal = shadowRoot.querySelector<HTMLElement>('.pt-modal');
  if (modal && currentSearchMode === 'page') {
    modal.classList.toggle('collapsed', !isPageResultsExpanded);
  }
}

function syncModeUI(): void {
  if (!shadowRoot) return;
  const t = getLocale(currentLang);
  const isPage = currentSearchMode === 'page';

  const backdrop = shadowRoot.querySelector<HTMLElement>('.pt-overlay-backdrop');
  if (backdrop) {
    backdrop.classList.toggle('page-mode', isPage);
  }

  const modal = shadowRoot.querySelector<HTMLElement>('.pt-modal');
  if (modal) {
    modal.classList.toggle('page-mode', isPage);
    modal.classList.toggle('collapsed', isPage && !isPageResultsExpanded);
  }

  if (isPage) {
    unlockPageScroll();
  } else {
    lockPageScroll();
  }

  const modeBtn = shadowRoot.querySelector<HTMLButtonElement>('.pt-mode-toggle');
  if (modeBtn) {
    modeBtn.classList.toggle('is-page', isPage);
    modeBtn.title = isPage
      ? `${t.overlay.modePageLabel}. ${t.overlay.modeTogglePage}`
      : `${t.overlay.modeGlobalLabel}. ${t.overlay.modeToggleGlobal}`;
    modeBtn.setAttribute('aria-label', modeBtn.title);
    setSafeHtml(modeBtn, isPage ? PAGE_ICON_SVG : GLOBAL_ICON_SVG);
  }

  const input = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  if (input) {
    input.placeholder = isPage ? t.overlay.placeholderPage : t.overlay.placeholder;
  }

  const tabs = shadowRoot.querySelector<HTMLElement>('.pt-tabs');
  if (tabs) {
    tabs.classList.toggle('page-mode-hidden', isPage);
  }

  const footerHint = shadowRoot.querySelector<HTMLElement>('.pt-footer-hint');
  if (footerHint) {
    if (isPage) {
      setSafeHtml(
        footerHint,
        `<span><kbd>↵</kbd> ${escapeHtml(t.overlay.liveNavNext)}</span><span><kbd>Shift+↵</kbd> ${escapeHtml(t.overlay.liveNavPrev)}</span><span><kbd>Esc</kbd> ${escapeHtml(t.overlay.hintClose)}</span>`
      );
    } else {
      setSafeHtml(
        footerHint,
        `<span><kbd>↑↓</kbd> ${escapeHtml(t.overlay.hintNavigate)}</span><span><kbd>↵</kbd> ${escapeHtml(t.overlay.hintOpen)}</span><span><kbd>Esc</kbd> ${escapeHtml(t.overlay.hintClose)}</span>`
      );
    }
  }

  updateInbarNavVisuals();
}

export async function initOverlayInShadow(shadow: ShadowRoot, initialMode: SearchMode = 'global'): Promise<void> {
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

  currentSearchMode = initialMode;
  renderOverlay();
  mountEventListeners();
  syncModeUI();
  void refreshSuggestionsData();
  const initialInput = shadowRoot.querySelector<HTMLInputElement>('.pt-search-input');
  if (initialInput) {
    void performSearch(initialInput.value);
    initialInput.focus();
    if (initialInput.value) {
      initialInput.select();
    }
  }
}

export async function showOverlayInShadow(targetMode?: SearchMode): Promise<void> {
  if (targetMode) {
    currentSearchMode = targetMode;
  }
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  hideFloatingNav();
  const backdrop = shadowRoot?.querySelector<HTMLElement>('.pt-overlay-backdrop');
  if (backdrop) backdrop.style.display = 'flex';
  if (currentSearchMode === 'page') {
    unlockPageScroll();
  } else {
    lockPageScroll();
  }
  try {
    const s = await getSettings();
    tagCatalog = s.tagCatalog || [];
    searchMaxResults = s.searchMaxResults || 100;
    searchPageSize = s.searchPageSize || 20;
    if (s.language && s.language !== currentLang) {
      currentLang = s.language;
      renderOverlay();
    }
  } catch {}
  void refreshSuggestionsData();
  syncModeUI();
  const input = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
  const clearBtn = shadowRoot?.querySelector<HTMLButtonElement>('.pt-clear-btn');
  if (input) {
    clearBtn?.classList.toggle('visible', input.value.length > 0);
    void performSearch(input.value);
    input.focus();
    input.select();
  }
}

let originalHtmlOverflow: string | null = null;
let originalBodyOverflow: string | null = null;
let isScrollLocked = false;

function lockPageScroll(): void {
  if (isScrollLocked) return;
  isScrollLocked = true;
  originalHtmlOverflow = document.documentElement.style.overflow;
  originalBodyOverflow = document.body ? document.body.style.overflow : '';
  document.documentElement.style.overflow = 'hidden';
  if (document.body) {
    document.body.style.overflow = 'hidden';
  }
}

function unlockPageScroll(): void {
  if (!isScrollLocked) return;
  isScrollLocked = false;
  if (originalHtmlOverflow !== null) {
    document.documentElement.style.overflow = originalHtmlOverflow;
    originalHtmlOverflow = null;
  }
  if (document.body && originalBodyOverflow !== null) {
    document.body.style.overflow = originalBodyOverflow;
    originalBodyOverflow = null;
  }
}

function renderOverlay(): void {
  if (!shadowRoot) return;
  if (currentSearchMode === 'page') {
    unlockPageScroll();
  } else {
    lockPageScroll();
  }

  const existing = shadowRoot.querySelector('.pt-overlay-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'pt-overlay-backdrop';
  setSafeHtml(backdrop, buildModalHTML());
  shadowRoot.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeOverlay();
  });

  backdrop.addEventListener('wheel', (e) => {
    if (currentSearchMode === 'page') return;
    const modal = shadowRoot?.querySelector('.pt-modal');
    if (!modal?.contains(e.target as Node)) {
      e.preventDefault();
    }
  }, { passive: false });

  backdrop.addEventListener('touchmove', (e) => {
    if (currentSearchMode === 'page') return;
    const results = shadowRoot?.querySelector('.pt-results');
    if (!results?.contains(e.target as Node)) {
      e.preventDefault();
    }
  }, { passive: false });

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
        <button
          class="pt-mode-toggle ${currentSearchMode === 'page' ? 'is-page' : ''}"
          type="button"
          title="${currentSearchMode === 'page' ? escapeAttr(t.overlay.modePageLabel + '. ' + t.overlay.modeTogglePage) : escapeAttr(t.overlay.modeGlobalLabel + '. ' + t.overlay.modeToggleGlobal)}"
          aria-label="${currentSearchMode === 'page' ? escapeAttr(t.overlay.modePageLabel + '. ' + t.overlay.modeTogglePage) : escapeAttr(t.overlay.modeGlobalLabel + '. ' + t.overlay.modeToggleGlobal)}"
        >
          ${currentSearchMode === 'page' ? PAGE_ICON_SVG : GLOBAL_ICON_SVG}
        </button>
        <svg class="pt-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input
          class="pt-search-input"
          type="text"
          placeholder="${currentSearchMode === 'page' ? escapeAttr(t.overlay.placeholderPage) : escapeAttr(t.overlay.placeholder)}"
          autocomplete="off"
          spellcheck="false"
          aria-label="Search query"
        />
        <div class="pt-inbar-nav ${currentSearchMode === 'page' && liveMatches.length > 0 ? 'visible' : ''}">
          <span class="pt-inbar-counter"><span id="pt-inbar-curr">${liveMatches.length > 0 ? currentLiveIndex + 1 : 0}</span>/<span id="pt-inbar-total">${liveMatches.length}</span></span>
          <button class="pt-inbar-btn pt-inbar-prev" type="button" title="${escapeAttr(t.overlay.liveNavPrev)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>
          </button>
          <button class="pt-inbar-btn pt-inbar-next" type="button" title="${escapeAttr(t.overlay.liveNavNext)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <button class="pt-inbar-btn pt-inbar-toggle-expand" type="button" title="${isPageResultsExpanded ? escapeAttr(t.overlay.liveCollapseList) : escapeAttr(t.overlay.liveExpandList)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${isPageResultsExpanded ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'}"/></svg>
          </button>
        </div>
        <button class="pt-clear-btn" type="button" aria-label="Clear">✕</button>
        <button class="pt-close-btn" type="button" title="${escapeAttr(t.overlay.hintClose)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="pt-kbd">
          <kbd>Esc</kbd>
        </div>
      </div>
      <div class="pt-autocomplete-wrap">
        <div class="pt-autocomplete" role="listbox" aria-label="${escapeAttr(t.overlay.autocompleteHint)}"></div>
      </div>
      <div class="pt-tabs ${currentSearchMode === 'page' ? 'page-mode-hidden' : ''}">
        <div class="pt-filter-group pt-filter-group-left">
          <div class="pt-pill-wrap ${activeTab !== 'all' ? 'active' : ''}">
            <select
              class="pt-type-select pt-pill-select ${activeTab !== 'all' ? 'active' : ''}"
              title="${escapeAttr(t.overlay.typeLabel)}"
              aria-label="${escapeAttr(t.overlay.typeLabel)}"
            >
              <option value="all" id="pt-type-opt-all" ${activeTab === 'all' ? 'selected' : ''}>${escapeHtml(t.overlay.tabAll)}</option>
              <option value="text" id="pt-type-opt-text" ${activeTab === 'text' ? 'selected' : ''}>${escapeHtml(t.overlay.tabText)}</option>
              <option value="tag" id="pt-type-opt-tag" ${activeTab === 'tag' ? 'selected' : ''}>${escapeHtml(t.overlay.tabTag)}</option>
              <option value="media" id="pt-type-opt-media" ${activeTab === 'media' ? 'selected' : ''}>${escapeHtml(t.overlay.tabMedia)}</option>
            </select>
          </div>
          <div class="pt-pill-wrap ${activePeriod !== 'all' ? 'active' : ''}">
            <select
              class="pt-date-select pt-pill-select ${activePeriod !== 'all' ? 'active' : ''}"
              title="${escapeAttr(t.overlay.dateLabel)}"
              aria-label="${escapeAttr(t.overlay.dateLabel)}"
            >
              <option value="all" ${activePeriod === 'all' ? 'selected' : ''}>${escapeHtml(t.overlay.dateAll)}</option>
              <option value="today" ${activePeriod === 'today' ? 'selected' : ''}>${escapeHtml(t.overlay.dateToday)}</option>
              <option value="week" ${activePeriod === 'week' ? 'selected' : ''}>${escapeHtml(t.overlay.dateWeek)}</option>
              <option value="month" ${activePeriod === 'month' ? 'selected' : ''}>${escapeHtml(t.overlay.dateMonth)}</option>
            </select>
          </div>
          <div class="pt-pill-wrap ${activeVisits !== 'all' ? 'active' : ''}">
            <select
              class="pt-visits-select pt-pill-select ${activeVisits !== 'all' ? 'active' : ''}"
              title="${escapeAttr(t.overlay.visitsLabel)}"
              aria-label="${escapeAttr(t.overlay.visitsLabel)}"
            >
              <option value="all" ${activeVisits === 'all' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsAll)}</option>
              <option value="multiple" ${activeVisits === 'multiple' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsMultiple)}</option>
              <option value="frequent" ${activeVisits === 'frequent' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsFrequent)}</option>
              <option value="once" ${activeVisits === 'once' ? 'selected' : ''}>${escapeHtml(t.overlay.visitsOnce)}</option>
            </select>
          </div>
        </div>
        <div class="pt-filter-group pt-filter-group-right">
          <div class="pt-pill-wrap ${isCustomSort ? 'active' : ''}">
            <select
              class="pt-sort-select pt-pill-select ${isCustomSort ? 'active' : ''}"
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
          ${currentSearchMode === 'page'
            ? `<span><kbd>↵</kbd> ${escapeHtml(t.overlay.liveNavNext)}</span><span><kbd>Shift+↵</kbd> ${escapeHtml(t.overlay.liveNavPrev)}</span><span><kbd>Esc</kbd> ${escapeHtml(t.overlay.hintClose)}</span>`
            : `<span><kbd>↑↓</kbd> ${escapeHtml(t.overlay.hintNavigate)}</span><span><kbd>↵</kbd> ${escapeHtml(t.overlay.hintOpen)}</span><span><kbd>Esc</kbd> ${escapeHtml(t.overlay.hintClose)}</span>`}
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
  const modeBtn = shadowRoot.querySelector<HTMLButtonElement>('.pt-mode-toggle');
  modeBtn?.addEventListener('click', () => {
    setSearchMode(currentSearchMode === 'global' ? 'page' : 'global');
  });

  const clearBtn = shadowRoot.querySelector<HTMLButtonElement>('.pt-clear-btn');
  clearBtn?.addEventListener('click', () => {
    if (input) {
      input.value = '';
      clearBtn.classList.remove('visible');
      void performSearch('');
      input.focus();
    }
  });

  shadowRoot.querySelector('.pt-inbar-prev')?.addEventListener('click', () => {
    activateLiveMatch(currentLiveIndex - 1);
  });

  shadowRoot.querySelector('.pt-inbar-next')?.addEventListener('click', () => {
    activateLiveMatch(currentLiveIndex + 1);
  });

  shadowRoot.querySelector('.pt-inbar-toggle-expand')?.addEventListener('click', () => {
    isPageResultsExpanded = !isPageResultsExpanded;
    updateInbarNavVisuals();
  });

  shadowRoot.querySelector('.pt-close-btn')?.addEventListener('click', () => {
    closeOverlay();
  });
  input?.addEventListener('input', (e) => {
    const q = (e.target as HTMLInputElement).value;
    clearBtn?.classList.toggle('visible', q.length > 0);
    if (currentSearchMode === 'global') {
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
    typeSelect.closest('.pt-pill-wrap')?.classList.toggle('active', isCustomType);
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
    dateSelect.closest('.pt-pill-wrap')?.classList.toggle('active', isCustomDate);
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
    visitsSelect.closest('.pt-pill-wrap')?.classList.toggle('active', isCustomVisits);
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
    sortSelect.closest('.pt-pill-wrap')?.classList.toggle('active', isCustomSort);
    const inputEl = shadowRoot?.querySelector<HTMLInputElement>('.pt-search-input');
    void performSearch(inputEl?.value ?? '');
    inputEl?.focus();
  });
}

function mountEventListeners(): void {
  if (!shadowRoot || isListenersMounted) return;
  isListenersMounted = true;

  shadowRoot.addEventListener('keyup', (e: Event) => {
    e.stopPropagation();
  });
  shadowRoot.addEventListener('keypress', (e: Event) => {
    e.stopPropagation();
  });

  shadowRoot.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    ke.stopPropagation();
    if (ke.key !== 'Escape' && ke.target instanceof HTMLSelectElement) {
      return;
    }

    if (currentSearchMode === 'global' && autocompleteItems.length > 0) {
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
        ke.preventDefault();
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
        if (currentSearchMode === 'page') {
          ke.preventDefault();
          if (liveMatches.length === 0) break;
          if (isPageResultsExpanded) {
            activateLiveMatchAndDock(focusedLiveIndex);
            break;
          }
          if (ke.shiftKey) {
            activateLiveMatch(currentLiveIndex - 1, 'smooth');
          } else {
            activateLiveMatch(currentLiveIndex + 1, 'smooth');
          }
          break;
        }
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

  if (currentSearchMode === 'page') {
    hideAutocompleteDropdown();
    const countEl = shadowRoot?.querySelector<HTMLElement>('#pt-count');
    if (!trimmed) {
      liveMatches = [];
      currentLiveIndex = -1;
      focusedLiveIndex = 0;
      clearLiveHighlights();
      updateInbarNavVisuals();
      if (countEl) countEl.textContent = '';
      renderLiveEmpty(t.overlay.emptyInitial);
      return;
    }

    liveMatches = findLivePageMatches(trimmed);
    currentLiveIndex = liveMatches.length > 0 ? 0 : -1;
    focusedLiveIndex = 0;
    updateInbarNavVisuals();

    if (countEl) {
      countEl.textContent = t.overlay.liveMatchesCount(liveMatches.length);
    }

    if (liveMatches.length === 0) {
      clearLiveHighlights();
      renderLiveEmpty(t.overlay.liveNoResults);
      return;
    }

    activateLiveMatch(0, 'none');
    renderLiveResults();
    return;
  }


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
  const getUniquePagesCount = (results: SearchResult[]): number => {
    const urls = new Set<string>();
    for (const r of results) {
      urls.add(normalizePageUrl(r.url));
    }
    return urls.size;
  };

  const counts: Record<SearchTypeFilter, number> = {
    all: getUniquePagesCount(allResults),
    text: getUniquePagesCount(allResults.filter((r) => r.type === 'text')),
    tag: getUniquePagesCount(allResults.filter((r) => r.type === 'tag')),
    media: getUniquePagesCount(allResults.filter((r) => r.type === 'media')),
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

  el.querySelectorAll<HTMLImageElement>('.pt-thumb-img, .pt-submatch-thumb-img').forEach((img) => {
    img.addEventListener('error', () => {
      img.parentElement?.remove();
    });
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
    const newEl = createOverlayResultElement(group, idx);
    el.replaceWith(newEl);
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
    countEl.textContent =
      filteredResults.length > 0
        ? t.overlay.resultsCount(filteredResults.length, groupedResults.length)
        : '';
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

function getImagePreviewUrl(result: SearchResult): string | null {
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'bmp', 'avif']);

  const getExt = (urlStr: string): string => {
    try {
      const pathname = new URL(urlStr).pathname;
      const match = pathname.match(/\.([a-z0-9]+)$/i);
      return match ? match[1]!.toLowerCase() : '';
    } catch {
      const match = urlStr.split('?')[0]?.split('#')[0]?.match(/\.([a-z0-9]+)$/i);
      return match ? match[1]!.toLowerCase() : '';
    }
  };

  const isHttpOrData = (s?: string): boolean =>
    Boolean(s && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:image/')));

  if (isHttpOrData(result.selector)) {
    const ext = getExt(result.selector);
    if (imageExts.has(ext) || result.selector.startsWith('data:image/') || result.type === 'media') {
      return result.selector;
    }
  }

  if (isHttpOrData(result.url)) {
    const ext = getExt(result.url);
    if (imageExts.has(ext) || result.url.startsWith('data:image/')) {
      return result.url;
    }
  }

  if (result.type === 'media') {
    const cand = result.selector || result.url;
    if (isHttpOrData(cand)) return cand;
  }

  const trimmed = result.text.trim();
  if (isHttpOrData(trimmed) && imageExts.has(getExt(trimmed))) {
    return trimmed;
  }

  return null;
}

function buildResultHTML(group: GroupedSearchResult, _i: number): string {
  const r = group.primary;
  const t = getLocale(currentLang);
  const primaryImgUrl = getImagePreviewUrl(r);
  const primaryThumbHtml = primaryImgUrl
    ? `
      <div class="pt-thumb-box">
        <img
          class="pt-thumb-img"
          src="${escapeAttr(primaryImgUrl)}"
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
        />
      </div>
    `
    : '';
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
          .map((sub, subIdx) => {
            const subImgUrl = getImagePreviewUrl(sub);
            const subThumbHtml = subImgUrl
              ? `
                <div class="pt-submatch-thumb">
                  <img
                    class="pt-submatch-thumb-img"
                    src="${escapeAttr(subImgUrl)}"
                    alt=""
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  />
                </div>
              `
              : '';
            return `
              <div class="pt-submatch-item" data-sub-idx="${subIdx}" title="${escapeAttr(t.overlay.hintOpen)}">
                ${subThumbHtml}
                <div class="pt-submatch-content">
                  <div class="pt-submatch-snippet">${sub.snippet}</div>
                  ${sub.note ? `<div class="pt-result-note"><span class="pt-note-icon">📝</span> ${escapeHtml(sub.note)}</div>` : ''}
                </div>
              </div>
            `;
          })
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
      <div class="pt-result-body">
        <div class="pt-result-content">
          <div class="pt-page-title">${escapeHtml(r.title || domain)}</div>
          <div class="pt-snippet">${r.snippet}</div>
          ${r.note ? `<div class="pt-result-note"><span class="pt-note-icon">📝</span> ${escapeHtml(r.note)}</div>` : ''}
        </div>
        ${primaryThumbHtml}
      </div>
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
  if (!shadowRoot) return;
  if (currentSearchMode === 'page') {
    if (liveMatches.length === 0) return;
    focusedLiveIndex = (focusedLiveIndex + delta + liveMatches.length) % liveMatches.length;
    updateFocus();
    const liveItems = shadowRoot.querySelectorAll<HTMLElement>('.pt-live-item');
    liveItems[focusedLiveIndex]?.scrollIntoView({ block: 'nearest' });
    activateLiveMatch(focusedLiveIndex, 'smooth');
    return;
  }

  if (groupedResults.length === 0) return;
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
  if (currentSearchMode === 'page') {
    shadowRoot.querySelectorAll<HTMLElement>('.pt-live-item').forEach((el, i) => {
      el.classList.toggle('focused', i === focusedLiveIndex);
    });
    return;
  }
  shadowRoot.querySelectorAll<HTMLElement>('.pt-result').forEach((el, i) => {
    el.classList.toggle('focused', i === focusedIndex);
  });
}

function openFocused(): void {
  if (currentSearchMode === 'page') {
    if (liveMatches[focusedLiveIndex]) {
      activateLiveMatchAndDock(focusedLiveIndex);
    }
    return;
  }
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

export function getCurrentSearchMode(): SearchMode {
  return currentSearchMode;
}

export function isOverlayOpen(): boolean {
  const host = document.getElementById('pagetrace-overlay-host');
  return Boolean(host && host.style.display !== 'none');
}

export function closeOverlay(): void {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  hideFloatingNav();
  clearLiveHighlights();
  unlockPageScroll();
  hideAutocompleteDropdown();
  const host = document.getElementById('pagetrace-overlay-host');
  if (host) host.style.display = 'none';
  if (location.pathname.endsWith('search.html')) {
    window.close();
  }
}

function ensureOverlayHost(): ShadowRoot {
  let host = document.getElementById('pagetrace-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'pagetrace-overlay-host';
    host.style.cssText =
      'all: initial; display: block; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647; pointer-events: none;';
    document.documentElement.appendChild(host);
  }
  return host.shadowRoot || host.attachShadow({ mode: 'open' });
}

let overlayInitPromise: Promise<void> | null = null;

async function handleOverlayToggle(targetMode?: SearchMode): Promise<void> {
  const host = document.getElementById('pagetrace-overlay-host');
  if (!host || !overlayInitPromise) {
    const shadow = ensureOverlayHost();
    overlayInitPromise = initOverlayInShadow(shadow, targetMode);
    await overlayInitPromise;
    const mountedHost = document.getElementById('pagetrace-overlay-host');
    if (mountedHost) mountedHost.style.display = 'block';
    return;
  }

  const isHiddenNow = host.style.display === 'none';
  if (isHiddenNow) {
    host.style.display = 'block';
    await showOverlayInShadow(targetMode);
  } else if (isFloatingNavVisible() && (!targetMode || targetMode === 'page')) {
    restoreModalFromFloatingNav();
  } else {
    const currentMode = getCurrentSearchMode();
    if (targetMode && targetMode !== currentMode) {
      await showOverlayInShadow(targetMode);
    } else {
      closeOverlay();
    }
  }
}

const globalScope = window as unknown as Record<string, unknown>;
globalScope.__pt_toggle_overlay = (mode?: SearchMode) => {
  void handleOverlayToggle(mode);
};
globalScope.__pt_close_overlay = () => {
  closeOverlay();
};
globalScope.__pt_is_overlay_open = () => {
  return isOverlayOpen();
};

window.addEventListener('pt:toggle-overlay-event', ((e: CustomEvent<{ mode?: SearchMode }>) => {
  void handleOverlayToggle(e.detail?.mode);
}) as EventListener);



