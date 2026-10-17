---
name: webext-mv3-workflow
description: >-
  Build, lint, test, and cross-browser Manifest V3 development workflow for PageTrace (Firefox & Chrome).
  Use this skill when modifying manifests, build scripts, background service workers, permissions,
  web_accessible_resources, or running build, test, and verification checks.
---

# WebExtension MV3 Cross-Browser Workflow

PageTrace targets both **Firefox MV3** and **Chrome MV3** from a shared TypeScript codebase bundled via Rollup ([build.mjs](file:///d:/Projects/PageTrace/build.mjs)).

## Entry Points & Bundle Formats

Defined in [build.mjs](file:///d:/Projects/PageTrace/build.mjs):
- `background` (`src/background/index.ts`) — bundled as ES module (`format: 'es'`)
- `content` (`src/content/index.ts`) — bundled as IIFE (`PT_content`)
- `overlay` (`src/overlay/index.ts`) — bundled as IIFE (`PT_overlay`)
- `options` (`src/options/index.ts`) — bundled as IIFE (`PT_options`)
- `popup` (`src/popup/index.ts`) — bundled as IIFE (`PT_popup`)
- `search` (`src/search-window/index.ts`) — bundled as IIFE (`PT_search`)

All dynamic imports are inlined (`inlineDynamicImports: true`), and `__BROWSER__` is replaced at build time with `"firefox"` or `"chrome"`. Common modules are structured in `src/common/` ([search-utils.ts](file:///d:/Projects/PageTrace/src/common/search-utils.ts), [settings.ts](file:///d:/Projects/PageTrace/src/common/settings.ts), [tags.ts](file:///d:/Projects/PageTrace/src/common/tags.ts)).

## Cross-Browser Manifest Synchronization

Whenever you add or change permissions, commands, icons, content scripts, or accessible resources, update **both** manifests in lockstep:

| Feature | [manifests/manifest.firefox.json](file:///d:/Projects/PageTrace/manifests/manifest.firefox.json) | [manifests/manifest.chrome.json](file:///d:/Projects/PageTrace/manifests/manifest.chrome.json) |
| :--- | :--- | :--- |
| Background | `"background": { "scripts": ["background.js"], "type": "module" }` | `"background": { "service_worker": "background.js", "type": "module" }` |
| Options UI | `"options_ui": { "page": "options.html", "open_in_tab": true }` | `"options_page": "options.html"` |
| Icons | Uses `.svg` (`icons/icon16.svg` .. `icon128.svg`) | Uses `.png` (`icons/icon16.png` .. `icon128.png`) |
| Gecko settings | Includes `browser_specific_settings.gecko` (`id`, `strict_min_version`, `data_collection_permissions`) | Omitted |

## Manifest V3 & Security Rules

1. **Use `webextension-polyfill`**:
   - Always import `browser from 'webextension-polyfill'` and use promise-based `browser.*` APIs instead of raw `chrome.*` callbacks.
2. **Ephemeral Background Context**:
   - The background script/service worker can be terminated when idle. Never rely on unpersisted in-memory variables across events without a fallback to IndexedDB (`src/db/index.ts`) or `browser.storage`.
   - Use `browser.alarms` instead of `setInterval` or long `setTimeout` timers in `src/background/`.
3. **No Direct `innerHTML` Assignment**:
   - `web-ext lint` flags unsafe `innerHTML` assignments (`UNSAFE_VAR_ASSIGNMENT`). Always use `setSafeHtml(element, html)` from [src/common/tags.ts](file:///d:/Projects/PageTrace/src/common/tags.ts) or safe DOM APIs (`textContent`, `createElement`).
4. **Typed Messaging**:
   - Define every new runtime message interface in [src/types/index.ts](file:///d:/Projects/PageTrace/src/types/index.ts) and add it to the `ExtensionMessage` union type.

## Testing Architecture

Unit tests run via **Vitest** with in-memory IndexedDB emulation provided by `fake-indexeddb`:
- [tests/setup.ts](file:///d:/Projects/PageTrace/tests/setup.ts) initializes the IndexedDB environment and polyfills.
- [tests/db.test.ts](file:///d:/Projects/PageTrace/tests/db.test.ts) covers Dexie transactions, cascade deletions, and incremental sync hooks.
- [tests/search-engine.test.ts](file:///d:/Projects/PageTrace/tests/search-engine.test.ts) verifies MiniSearch indexing, note boosts, and snippet highlights.
- [tests/search-utils-and-tags.test.ts](file:///d:/Projects/PageTrace/tests/search-utils-and-tags.test.ts) verifies query operator parsing, date range filters, markdown citations, and tag normalization.

## Verification Checklist

Run these commands after making code or manifest changes:

```bash
npm run type-check
npm test
npm run build
npm run lint
```

- `npm run type-check` runs `tsc --noEmit` in strict mode.
- `npm test` executes the complete Vitest test suite.
- `npm run build` bundles both `dist/firefox` and `dist/chrome`.
- `npm run lint` validates `dist/firefox` using `web-ext lint` (must pass with 0 errors and 0 warnings).
- `npm run package:firefox` creates the production ZIP archive for Mozilla Add-ons (AMO) in `dist/artifacts/`.
