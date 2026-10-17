---
name: dexie-minisearch-index
description: >-
  Database schema, IndexedDB operations (Dexie.js), and full-text search engine (MiniSearch)
  guidelines for PageTrace. Use this skill when modifying database tables, queries,
  TTL/LRU cleanup, tag filtering, inline search operators, or index export/import.
---

# Dexie.js & MiniSearch Architecture Guide

PageTrace stores all indexed browsing data locally in IndexedDB via Dexie.js ([src/db/index.ts](file:///d:/Projects/PageTrace/src/db/index.ts)) and performs instant fuzzy full-text search in memory via MiniSearch ([src/search/index.ts](file:///d:/Projects/PageTrace/src/search/index.ts)). Query parsing, inline operators, and grouping utilities are centralized in [src/common/search-utils.ts](file:///d:/Projects/PageTrace/src/common/search-utils.ts).

## Database Schema (`PageTraceDB`)

Defined in [src/db/index.ts](file:///d:/Projects/PageTrace/src/db/index.ts):
- `pages`: `'++id, url, lastAccessedAt, createdAt, sizeBytes, *tags, visitCount'` (`PageRecord`, schema version 4)
- `text_chunks`: `'++id, pageId, depth, createdAt'` (`TextChunk`)
- `media_items`: `'++id, pageId, type, extension, createdAt'` (`MediaItem`)
- `custom_indexes`: `'++id, pageId, name, url, createdAt'` (`CustomTagIndex`, includes optional `note?: string`)

### Rules for Database Modifications

1. **Schema Migrations**:
   - Never modify existing `this.version(N)` blocks in `PageTraceDB` if users already have data at that version. Increment the version (`this.version(N + 1).stores(...)`) and provide an `.upgrade()` callback if existing records require transformation (e.g. version 4 adds `visitCount` with default `1`).
2. **Cascade Deletions & Transactions**:
   - Deleting pages must always cascade to `text_chunks`, `media_items`, and `custom_indexes` inside a single `'rw'` transaction (use `deletePagesCascade(pageIds)`).
   - Automatic cleanup operations (`cleanupExpired(ttlDays, pinnedDomains?)` and `evictLRU(maxSizeMb, pinnedDomains?)`) must exclude pages whose URL matches patterns in `pinnedDomains` using `matchUrlPattern()`.
3. **Database Revision Tracking & Incremental Sync**:
   - Every write operation (`upsertPage`, `addCustomIndex`, `updateCustomIndex`, `deleteCustomIndex`, `cleanupExpired`, `evictLRU`, `clearDatabase`, `clearPagesByTag`) must call `bumpDbRevision()`, writing `pt_db_rev` to `browser.storage.local`.
   - Dexie notifies search indexes incrementally via `DbSearchSyncHooks` (`setSearchSyncHooks` in [src/db/index.ts](file:///d:/Projects/PageTrace/src/db/index.ts)), calling `onPageUpserted`, `onCustomIndexUpserted`, `onCustomIndexesDeleted`, `onPagesDeleted`, and `onDatabaseCleared` to update `MiniSearch` without triggering expensive full rebuilds.
   - `upsertPage` automatically initializes `visitCount` to 1 on creation and increments `(existing.visitCount ?? 1) + 1` on repeated visits.
4. **URL & Tag Normalization**:
   - Always normalize page URLs with `normalizePageUrl(url)` (strips hash and trailing slash) and text with `normalizeIndexedText(s)` from [src/common/search-utils.ts](file:///d:/Projects/PageTrace/src/common/search-utils.ts).
   - Always normalize tags with `normalizeTagName(raw)` from [src/common/tags.ts](file:///d:/Projects/PageTrace/src/common/tags.ts) (uppercase, max 12 chars, spaces to `_`).

## Search Engine (`MiniSearch`)

Defined in [src/search/index.ts](file:///d:/Projects/PageTrace/src/search/index.ts):
- **Performance Target**: Search execution must complete in `≤ 100ms` on 50,000 text fragments.
- **Document Types & Fields**: Unified `SearchDoc` with `id` prefixed as `tag:<id>`, `text:<id>`, or `media:<id>`. Indexed fields: `['tagName', 'text', 'title', 'note']`. Stored fields include `visitCount`.
- **Field Boosting**: `tagName: 10.0`, `title: 2.0`, `note: 1.5`, body text: `1.0`. User-created `tag` results and annotated notes surface above standard text fragments in relevance scoring.
- **Index Snapshot Caching**: Serialized search snapshots (`SerializedSearchIndexSnapshot`) are persisted and rehydrated via `saveIndexSnapshotToStorage()` / `loadIndexSnapshotFromStorage()` to avoid rebuilding the entire index on extension startup or service worker wake-up.
- **Tokenization**: Splits words across both Latin and Cyrillic characters (`/[\s\-_.,;:!?()[\]{}'"«»]+/u`).
- **Inline Query Operators & Utilities**:
  - Centralized in [src/common/search-utils.ts](file:///d:/Projects/PageTrace/src/common/search-utils.ts).
  - Supported operators: `#tag`, `tag:..`/`тег:..`, `site:..`/`domain:..`/`сайт:..`/`домен:..`, `type:..`/`тип:..`, `sort:..`/`сорт:..` (including `visits_desc`/`visits_asc`, aliases `popular`/`частые`/`редкие`), date operators `after:..`/`после:..`, `before:..`/`до:..`, `date:today|week|month`/`период:сегодня|неделя|месяц`, and visit operators `visits:..`/`визиты:..` (`>N`, `>=N`, `<N`, `<=N`, `N..M`, `multiple`, `once`, `frequent`).
  - When adding new query operators, update `SearchFilterOptions` in [src/types/index.ts](file:///d:/Projects/PageTrace/src/types/index.ts), `parseSearchQuery()`, `extractInlineOperators()`, and alias dictionaries in [src/common/search-utils.ts](file:///d:/Projects/PageTrace/src/common/search-utils.ts).
- **Result Grouping & Suggestions**:
  - `groupResultsByPage()` groups multiple matches from the same page into an expandable card.
  - `generateSearchSuggestions()` and `getAutocompleteTokenInfo()` provide live autocompletion for tags, domains, and operators in the search input.
  - `formatMarkdownQuote()` formats quotes as `> text — [Title](url)`.
- **Safe Highlighting**: `highlightSnippet()` escapes all HTML characters before wrapping matched terms in `<mark>` tags so snippets can be safely rendered via `setSafeHtml()`.
