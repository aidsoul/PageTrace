// Shared TypeScript types

/** Depth of DOM indexing chosen by user */
export type IndexDepth = 'headings' | 'semantic' | 'full';

/** Supported media file extensions for whitelist */
export type MediaExtension = 'png' | 'jpg' | 'jpeg' | 'webp' | 'gif' | 'svg' | 'pdf' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'csv';

/** A single indexed web page */
export interface PageRecord {
  id?: number;
  /** Normalized page URL (without fragment/query) */
  url: string;
  title: string;
  favicon: string;
  /** When page was first indexed */
  createdAt: number;
  /** Last time any search result from this page was accessed */
  lastAccessedAt: number;
  /** Estimated storage size in bytes */
  sizeBytes: number;
  /** User or auto-assigned tags for page (e.g. ['WIKI', 'DEV']) */
  tags?: string[];
  /** Total number of visits recorded for this page */
  visitCount?: number;
}

/** A text chunk extracted from a page */
export interface TextChunk {
  id?: number;
  pageId: number;
  /** Raw text content */
  text: string;
  /** 0-based DOM node path / selector hint */
  selector: string;
  /** Heading level: 1–6 for h1–h6, 0 for body text */
  depth: number;
  /** Timestamp of extraction */
  createdAt: number;
}

/** An image or document link found on a page */
export interface MediaItem {
  id?: number;
  pageId: number;
  type: 'image' | 'document';
  /** Absolute URL */
  url: string;
  alt: string;
  title: string;
  /** Filename extracted from URL */
  filename: string;
  /** File extension (lowercase) */
  extension: string;
  createdAt: number;
}

/** Rule for custom indexing tags/selectors per website */
export interface SiteTagRule {
  /** Domain or URL pattern (e.g. "github.com", "*.habr.com") */
  domain: string;
  /** Comma-separated tags / CSS selectors (e.g. "h1, h2, .markdown-body, pre") */
  tags: string;
}

/** Automatic tagging rule: URL mask/domain -> assigned tag */
export interface AutoTagRule {
  id: string;
  /** URL mask or domain (e.g. "wikipedia.org/*", "github.com/*") */
  pattern: string;
  /** Assigned tag name (e.g. "WIKI", "DEV") */
  tag: string;
}

/** Tag in user catalog */
export interface TagCatalogItem {
  /** Tag name (max 12 characters, uppercase) */
  name: string;
  /** Palette color id ('slate' | 'emerald' | 'amber' | 'indigo' | 'lemon') */
  colorId: string;
}

/** Mode for triggering index creation on selected text */
export type IndexCreationTrigger = 'selection' | 'contextmenu' | 'both';

/** User-facing settings stored in browser.storage.sync */
export interface UserSettings {
  /** Interface display language code (e.g. 'en', 'ru') */
  language: string;
  /** Depth of DOM indexing */
  indexDepth: IndexDepth;
  /** How to trigger index creation for selected text */
  indexTrigger: IndexCreationTrigger;
  /** Default tags/selectors for indexing */
  customTags: string;
  /** Per-site custom tag rules */
  siteTagRules: SiteTagRule[];
  /** Automatic tag rules (URL mask -> tag) */
  autoTagRules: AutoTagRule[];
  /** Catalog of defined tags */
  tagCatalog: TagCatalogItem[];
  /** Whether to index media files */
  indexMedia: boolean;
  /** Whitelisted media extensions */
  mediaWhitelist: MediaExtension[];
  /** Mode for URL filtering: 'blacklist' indexes all except blacklisted, 'whitelist' indexes only whitelisted */
  urlFilterMode: 'blacklist' | 'whitelist';
  /** Blacklisted URL patterns (glob / hostname) */
  blacklist: string[];
  /** Whitelisted URL patterns (glob / hostname) when urlFilterMode is 'whitelist' */
  whitelist: string[];
  /** Domains / URL patterns that should never be deleted by TTL or LRU cleanup */
  pinnedDomains: string[];
  /** TTL in days; 0 = unlimited */
  ttlDays: number;
  /** Max DB size in MB */
  maxSizeMb: number;
  /** Custom hotkey override (e.g. "Alt+Shift+F") */
  hotkey: string;
  /** Whether extension is globally enabled */
  enabled: boolean;
  /** Maximum number of results returned by search engine */
  searchMaxResults: number;
  /** Number of results rendered per batch in search UI (infinite scroll) */
  searchPageSize: number;
}

/** Default user settings */
export const DEFAULT_SETTINGS: UserSettings = {
  language: 'en',
  indexDepth: 'semantic',
  indexTrigger: 'selection',
  customTags: 'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, pre, code',
  siteTagRules: [],
  autoTagRules: [
    { id: '1', pattern: 'wikipedia.org/*', tag: 'WIKI' },
    { id: '2', pattern: 'github.com/*', tag: 'DEV' },
  ],
  tagCatalog: [
    { name: 'DOCS', colorId: 'slate' },
    { name: 'DEV', colorId: 'emerald' },
    { name: 'WIKI', colorId: 'amber' },
    { name: 'NOTES', colorId: 'indigo' },
    { name: 'FAV', colorId: 'lemon' },
  ],
  indexMedia: true,
  mediaWhitelist: ['png', 'jpg', 'jpeg', 'webp', 'pdf'],
  urlFilterMode: 'blacklist',
  blacklist: [],
  whitelist: [],
  pinnedDomains: [],
  ttlDays: 30,
  maxSizeMb: 500,
  hotkey: 'Alt+Shift+F',
  enabled: true,
  searchMaxResults: 100,
  searchPageSize: 20,
};

/** A user-created index / tag for a selected text fragment */
export interface CustomTagIndex {
  id?: number;
  pageId: number;
  url: string;
  pageTitle: string;
  favicon: string;
  /** Tag or index name (default: text itself) */
  name: string;
  /** The selected text content */
  text: string;
  /** Optional user note or comment */
  note?: string;
  /** Selector hint */
  selector: string;
  /** Timestamp */
  createdAt: number;
}

/** Message from content script to background */
export interface IndexPageMessage {
  type: 'INDEX_PAGE';
  url: string;
  title: string;
  favicon: string;
  chunks: Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[];
  media: Omit<MediaItem, 'id' | 'pageId' | 'createdAt'>[];
}

/** Message from background/popup to content script to trigger overlay */
export interface ToggleOverlayMessage {
  type: 'TOGGLE_OVERLAY';
}

/** Message from content script asking background to scroll to text */
export interface ScrollToMessage {
  type: 'SCROLL_TO';
  text: string;
  selector: string;
}

/** Message from search UI / options / content script to open a page and smoothly scroll to text */
export interface NavigateToResultMessage {
  type: 'NAVIGATE_TO_RESULT';
  url: string;
  text: string;
  selector: string;
}

/** Message to save a custom user-created index for selected text */
export interface SaveCustomIndexMessage {
  type: 'SAVE_CUSTOM_INDEX';
  url: string;
  pageTitle: string;
  favicon: string;
  name: string;
  text: string;
  note?: string;
  selector: string;
}

/** Message to update a custom user-created index */
export interface UpdateCustomIndexMessage {
  type: 'UPDATE_CUSTOM_INDEX';
  id: number;
  changes: Partial<Pick<CustomTagIndex, 'name' | 'text' | 'note' | 'selector' | 'pageTitle' | 'url'>>;
}

/** Message to delete a custom user-created index */
export interface DeleteCustomIndexMessage {
  type: 'DELETE_CUSTOM_INDEX';
  id: number;
}

/** Message from background to content script to open create index popup for selected text */
export interface TriggerCreateIndexMessage {
  type: 'TRIGGER_CREATE_INDEX_FROM_SELECTION';
  text?: string;
}

/** Message from content script / overlay to fetch index snapshot from background IndexedDB */
export interface GetIndexSnapshotMessage {
  type: 'GET_INDEX_SNAPSHOT';
}

/** Message to update page lastAccessedAt timestamp when result is opened */
export interface TouchPageMessage {
  type: 'TOUCH_PAGE';
  pageId?: number;
  url?: string;
}

/** Message to execute a search query in background without transferring entire DB snapshot */
export interface ExecuteSearchQueryMessage {
  type: 'EXECUTE_SEARCH_QUERY';
  query: string;
  limit?: number;
  filterOptions?: SearchFilterOptions;
}

/** Message to delete a page from index */
export interface DeletePageMessage {
  type: 'DELETE_PAGE';
  pageId?: number;
  url?: string;
}

/** Message to get autocomplete tags and domains */
export interface GetSearchSuggestionsMessage {
  type: 'GET_SEARCH_SUGGESTIONS';
}

export type ExtensionMessage =
  | IndexPageMessage
  | ToggleOverlayMessage
  | ScrollToMessage
  | NavigateToResultMessage
  | SaveCustomIndexMessage
  | UpdateCustomIndexMessage
  | DeleteCustomIndexMessage
  | TriggerCreateIndexMessage
  | GetIndexSnapshotMessage
  | TouchPageMessage
  | ExecuteSearchQueryMessage
  | DeletePageMessage
  | GetSearchSuggestionsMessage;

/** Content type filter for search results */
export type SearchTypeFilter = 'all' | 'text' | 'tag' | 'media';

/** Sort order for search results */
export type SearchSortOption =
  | 'relevance'
  | 'newest'
  | 'oldest'
  | 'title_asc'
  | 'title_desc'
  | 'visits_desc'
  | 'visits_asc';

/** Filter options for search query execution */
export interface SearchFilterOptions {
  /** Filter by content type (default: 'all') */
  type?: SearchTypeFilter;
  /** Filter by specific tags (e.g. ['WIKI', 'DEV']) */
  tags?: string[];
  /** Filter by domain/site substring or glob (e.g. 'github.com') */
  domain?: string;
  /** Sort order for results (default: 'relevance') */
  sort?: SearchSortOption;
  /** Filter results created/accessed after this timestamp (ms) */
  dateFrom?: number;
  /** Filter results created/accessed before this timestamp (ms) */
  dateTo?: number;
  /** Minimum page visit count */
  minVisits?: number;
  /** Maximum page visit count */
  maxVisits?: number;
}

/** Search result returned by the search engine */
export interface SearchResult {
  id: number;
  pageId: number;
  url: string;
  title: string;
  favicon: string;
  text: string;
  /** Optional user note or comment for tag bookmarks */
  note?: string;
  selector: string;
  type: 'text' | 'media' | 'tag';
  /** Custom tag name if type === 'tag' */
  tagName?: string;
  /** Attached tags for this page */
  tags?: string[];
  /** Timestamp of page/index for relative time display */
  createdAt?: number;
  /** Page visit count */
  visitCount?: number;
  /** Snippet with HTML <mark> tags around matches */
  snippet: string;
  score: number;
}

