---
name: shadow-dom-ui
description: >-
  Guidelines for building isolated Shadow DOM interfaces (overlay, selection popover, toasts)
  and non-blocking DOM indexing in PageTrace (src/overlay/, src/content/, src/search-window/, src/options/).
  Use this skill when working on UI components, CSS styling, themes, keyboard navigation, or DOM parsing.
---

# Shadow DOM UI & Content Script Guide

PageTrace injects interactive UI directly into arbitrary third-party web pages via [src/content/index.ts](file:///d:/Projects/PageTrace/src/content/index.ts) and [src/overlay/index.ts](file:///d:/Projects/PageTrace/src/overlay/index.ts), alongside standalone extension pages (`popup`, `options`, `search-window`).

## Shadow DOM Isolation Rules

1. **Zero Style Leakage**:
   - The search overlay (`#pagetrace-overlay-host`) and content-script popovers/widgets (`#pagetrace-selection-host`) must render inside a `ShadowRoot` (`attachShadow({ mode: 'open' })`).
   - All CSS inside the Shadow DOM must be self-contained (`:host { all: initial; ... }`) with explicit `font-family`, `box-sizing: border-box`, and CSS custom properties so host-page styles (`div`, `input`, `button`, `mark`) never bleed into PageTrace UI.
2. **Keyboard & Focus Trapping**:
   - When the overlay or selection popover is open and focused, call `e.stopPropagation()` on `keydown`, `keyup`, and `keypress` events inside the Shadow DOM so host-page single-key shortcuts (e.g., GitHub `s` or `/`, YouTube `k` or `f`) are not accidentally triggered while typing.
   - Maintain full keyboard navigation: `Alt+Shift+F` (or custom hotkey configured via [src/common/settings.ts](file:///d:/Projects/PageTrace/src/common/settings.ts)) to toggle, `↑`/`↓` to navigate results or autocomplete suggestions, `Enter` to open/scroll, `Esc` to close.
3. **Safe HTML Rendering**:
   - Never assign untrusted or dynamic strings to `.innerHTML`. Always escape dynamic values with `escapeHtml()` / `escapeAttr()` and mount fragments using `setSafeHtml(container, html)` from [src/common/tags.ts](file:///d:/Projects/PageTrace/src/common/tags.ts).

## Non-Blocking Content Script Indexing

To avoid causing layout thrashing or main-thread jank on visited pages:
- **Initial Indexing**: Wait `DEBOUNCE_MS` (`1000ms`) after DOM ready, then schedule DOM traversal inside `requestIdleCallback` (with a `setTimeout` fallback).
- **SPA & Infinite Scroll**: `MutationObserver` must remain throttled (`THROTTLE_MS = 3000ms`) and skip re-parsing if the normalized URL and body text length have not meaningfully changed.
- **Self-Ignore**: Never index nodes belonging to PageTrace's own host elements (`#pagetrace-overlay-host`, `#pagetrace-selection-host`, `.pagetrace-highlight`) or non-content tags (`script`, `style`, `noscript`, `svg`, `nav`, `footer`).

## UI Parity Between Overlay & Standalone Search Window

When adding or modifying search UI features:
- **Feature Parity**: Keep behavior, filtering, quick action buttons (Markdown quote copying via `formatMarkdownQuote`, page deletion, domain blacklist), and keyboard shortcuts synchronized between the in-page Shadow DOM overlay ([src/overlay/index.ts](file:///d:/Projects/PageTrace/src/overlay/index.ts)) and the standalone search window ([src/search-window/index.ts](file:///d:/Projects/PageTrace/src/search-window/index.ts)).
- **Result Grouping & Autocomplete**: Reuse `groupResultsByPage()` to collapse multiple matches under the same URL, and `getAutocompleteTokenInfo()` / `generateSearchSuggestions()` to power live operator and tag autocompletion.
- **Shared Helpers**:
  - [src/common/tags.ts](file:///d:/Projects/PageTrace/src/common/tags.ts) for tag badges, colors, and DOM sanitization.
  - [src/common/search-utils.ts](file:///d:/Projects/PageTrace/src/common/search-utils.ts) for query parsing, date filters, operator extraction, grouping, and markdown formatting.
  - [src/common/settings.ts](file:///d:/Projects/PageTrace/src/common/settings.ts) for reading and watching extension settings and matching keyboard shortcuts.
