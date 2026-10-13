# PageTrace 🔍

> **Full-text indexing and search for visited web pages — 100% local, zero cloud.**

PageTrace is a browser extension that silently indexes every page you visit and lets you search across your entire browsing history in milliseconds. No server, no cloud, no telemetry — all data stays in your browser's IndexedDB.

---

## Features

- 📖 **3-level DOM indexing** — headings only, semantic (articles/paragraphs), or full DOM. Non-blocking execution via `requestIdleCallback` with debounced SPA / `MutationObserver` handling.
- ⚡ **Instant fuzzy search** — in-memory MiniSearch with Latin & Cyrillic tokenization, field boosting (`tagName: 10x`, `title: 2x`, `note: 1.5x`), completing queries in ≤100ms across 50,000+ fragments.
- 🔎 **Rich search operators** — inline query syntax with both English and Russian aliases:
  - Tags: `#tag`, `tag:name`, `тег:name`
  - Domain filters: `site:example.com`, `domain:..`, `сайт:..`, `домен:..`
  - Item type: `type:text|tag|media`, `тип:..`
  - Sorting: `sort:relevance|date_desc|date_asc|visits_desc|visits_asc` (aliases `popular`, `частые`, `редкие`)
  - Date ranges: `after:YYYY-MM-DD`, `before:YYYY-MM-DD`, `date:today|week|month`, `период:сегодня|неделя|месяц`
  - Visit counts: `visits:>N`, `>=N`, `<N`, `<=N`, `N..M`, `multiple`, `once`, `frequent`, `визиты:..`
- 💡 **Live autocompletion & suggestions** — real-time dropdown suggestions for operators, tags, and domains as you type.
- 📚 **Grouped page results** — collapses multiple matching snippets under their parent page into an expandable card.
- 🏷 **Custom tags, notes & selection popover** — select text on any webpage to create custom tagged snippets and annotated notes with auto-generated tags and color-coded badges.
- 📋 **One-click Markdown quotes** — copy snippet citations formatted as `> text — [Title](url)`.
- 🎨 **Shadow DOM overlay & standalone search window** — zero style leakage into host pages, keyboard navigation trapping, plus a dedicated standalone search window.
- 🌐 **Multilingual support** — English and Russian built-in, with a modular file-per-language architecture.
- 🖼 **Media & document tracking** — indexes images, PDFs, DOC/XLS documents found on visited pages.
- 📌 **Pinned domains & smart cleanup** — TTL expiration and LRU size eviction with pinned domain protection to prevent data loss on essential sites.
- 🔒 **Privacy-first & blacklist support** — all data stays local; exclude banking, mail, or private domains via pattern matching.
- ⚙️ **Configurable settings** — adjust indexing depth, debounce times, retention limits, hotkeys, and language via the options page.

---

## Tech Stack

| Layer        | Technology                                              |
| ------------ | ------------------------------------------------------- |
| Manifest     | Manifest V3 (**Firefox** & **Chrome**)                  |
| Language     | TypeScript 5 (strict mode)                              |
| Build        | Rollup + Node.js build runner (`build.mjs`)             |
| Database     | Dexie.js (IndexedDB wrapper, schema v4)                 |
| Search       | MiniSearch 7 (in-memory full-text search with snapshot caching) |
| API          | `webextension-polyfill` (`browser.*` + Promises)        |
| Testing      | Vitest + `fake-indexeddb`                               |
| Localization | Modular TypeScript locale definitions (`src/i18n/`)     |

---

## Project Structure

```
PageTrace/
├── manifests/
│   ├── manifest.firefox.json   # Firefox MV3 + Gecko-specific settings
│   └── manifest.chrome.json    # Chrome MV3
├── src/
│   ├── background/             # Service worker: indexing, cleanup alarms, context menus, snapshot caching
│   ├── content/                # Non-blocking DOM parser, selection popover, overlay injector
│   ├── overlay/                # In-page search overlay UI (Shadow DOM)
│   ├── search-window/          # Standalone search popup window
│   ├── popup/                  # Quick-access toolbar popup
│   ├── options/                # Settings & preferences page
│   ├── db/                     # Dexie schema, migrations, cascade deletes, sync hooks
│   ├── search/                 # MiniSearch engine, field boosting, storage snapshots
│   ├── common/                 # Shared business logic and utilities
│   │   ├── search-utils.ts     # Operator extraction, query parser, grouping, Markdown citations, autocomplete
│   │   ├── settings.ts         # Settings store, change watchers, shortcut matching
│   │   └── tags.ts             # Tag normalization, color hashing, badges, safe HTML sanitization
│   ├── i18n/                   # Internationalization registry & locales
│   │   ├── types.ts            # LocaleTranslations interface
│   │   ├── index.ts            # Locale registry & DOM translation helper
│   │   └── locales/
│   │       ├── en.ts           # English (default)
│   │       └── ru.ts           # Russian
│   └── types/                  # Shared TypeScript data models & message types
├── tests/                      # Automated Vitest test suite
│   ├── setup.ts                # fake-indexeddb environment initialization
│   ├── db.test.ts              # Dexie transactions, cascade deletes, sync hooks
│   ├── search-engine.test.ts   # MiniSearch indexing, note boosting, snippet highlighting
│   └── search-utils-and-tags.test.ts # Operator parsing, date/visit filters, Markdown formatting, tags
├── icons/                      # SVG and PNG icons (16, 32, 48, 128 px)
├── build.mjs                   # Cross-browser build script (IIFE & ESM)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## Search Syntax Guide

PageTrace supports flexible inline search syntax. Operators can be combined with plain text queries:

| Operator | Russian Alias | Example | Description |
| :--- | :--- | :--- | :--- |
| `#tag` / `tag:name` | `тег:name` | `#javascript` or `tag:DOCS` | Matches pages/snippets with the specified tag |
| `site:domain` / `domain:..` | `сайт:..` / `домен:..` | `site:github.com` | Restricts search to a specific domain or host |
| `type:text\|tag\|media` | `тип:..` | `type:tag` | Filters results by item type |
| `sort:criteria` | `сорт:..` | `sort:visits_desc` or `sort:popular` | Sorts by `relevance`, `date_desc`, `date_asc`, `visits_desc`, `visits_asc` |
| `after:YYYY-MM-DD` | `после:..` | `after:2026-01-01` | Matches items indexed after the given date |
| `before:YYYY-MM-DD` | `до:..` | `before:2026-03-01` | Matches items indexed before the given date |
| `date:period` | `период:..` | `date:week` or `период:сегодня` | Filters by dynamic relative period (`today`, `week`, `month`) |
| `visits:condition` | `визиты:..` | `visits:>5` or `visits:frequent` | Filters by visit counts (`>N`, `>=N`, `<N`, `<=N`, `N..M`, `multiple`, `once`, `frequent`) |

---

## Keyboard Shortcuts

| Action | Shortcut | Description |
| :--- | :--- | :--- |
| Toggle search overlay | `Alt + Shift + F` | Opens or closes the in-page search overlay (configurable in options) |
| Close overlay / window | `Esc` | Dismisses the overlay, autocomplete suggestions, or selection widget |
| Navigate results / suggestions | `↑` / `↓` | Moves active selection up or down |
| Open selected result | `Enter` | Opens the selected URL in a new or current tab |
| Accept autocomplete suggestion | `Tab` / `Enter` | Fills the suggested tag, domain, or operator into the search bar |

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Installation

```bash
npm install
```

### Build Commands

```bash
# Build both Firefox and Chrome extensions
npm run build

# Build specifically for Firefox (output: dist/firefox/)
npm run build:firefox

# Build specifically for Chrome (output: dist/chrome/)
npm run build:chrome

# Development watch mode
npm run dev:firefox
npm run dev:chrome
```

### Verification & Testing

```bash
# Run the automated Vitest test suite
npm test

# Run tests in watch mode
npm run test:watch

# Strict TypeScript type check
npm run type-check

# Lint Firefox extension bundle using web-ext
npm run lint
```

---

## Loading the Extension

### Firefox

1. Open `about:debugging` in Firefox.
2. Click **This Firefox** on the left menu.
3. Click **Load Temporary Add-on…**.
4. Select `dist/firefox/manifest.json`.

### Chrome

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** toggle in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `dist/chrome` directory.

---

## Internationalization (i18n)

Languages are isolated in individual TypeScript files in `src/i18n/locales/`.

### Adding a New Language

To add a new language (e.g., German `de`):

1. Create `src/i18n/locales/de.ts` implementing `LocaleTranslations` (TypeScript enforces complete key coverage).
2. Register the locale in `src/i18n/index.ts`:
   ```ts
   import { de } from './locales/de';

   export const LOCALES = { en, ru, de };
   export const AVAILABLE_LANGUAGES = [
     { code: 'en', name: 'English' },
     { code: 'ru', name: 'Русский' },
     { code: 'de', name: 'Deutsch' },
   ];
   ```
3. The options page dropdown and all UI components will immediately make the new language selectable.

---

## Architecture Highlights

- **Shadow DOM Isolation**: The search overlay and selection widgets render inside open `ShadowRoot` boundaries with complete CSS isolation (`:host { all: initial; }`), preventing host-page style collisions and stopping host single-key shortcut events from firing during input.
- **Non-blocking Content Script Indexing**: Traversal schedules inside `requestIdleCallback` after DOM debouncing (`1000ms`). SPA dynamic navigation and infinite scrolling are monitored by throttled `MutationObserver` (`3000ms`), ignoring PageTrace's own UI elements and non-content tags.
- **Incremental Search Engine Synchronization**: Background processes register `DbSearchSyncHooks` with Dexie so additions, updates, and cascade deletions update the in-memory MiniSearch index incrementally, avoiding full index reconstructions.
- **Snapshot Caching**: Search index states are serialized and cached in browser storage, allowing near-instant search readiness upon service worker wake-up.

---

## Roadmap

- [x] Manifest V3 support for Firefox and Chrome
- [x] Advanced inline search operators (tags, domains, dates, visits, sorting)
- [x] Live autocomplete suggestions and page result grouping
- [x] Automated test suite (Vitest + `fake-indexeddb`)
- [ ] Full index export / import (JSON / archive)
- [ ] Thumbnail previews for cached media
- [ ] Dark / Light theme toggle in overlay

---

## Author

**AidSoul** — [work-aidsoul@outlook.com](mailto:work-aidsoul@outlook.com)

---

## License

MIT
