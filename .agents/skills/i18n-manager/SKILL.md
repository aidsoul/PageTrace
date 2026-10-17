---
name: i18n-manager
description: >-
  Manage localization and translations in PageTrace (src/i18n/).
  Use this skill when adding or editing UI strings, HTML templates, modals, toasts,
  or adding support for a new language.
---

# Localization (i18n) Management Guide

PageTrace uses a strongly-typed, modular localization system located in `src/i18n/` rather than static `_locales/*.json` files, allowing instant runtime language switching without restarting the browser.

## Core Files

- [src/i18n/types.ts](file:///d:/Projects/PageTrace/src/i18n/types.ts) — `LocaleTranslations` interface defining all translation keys and function signatures (`options`, `popup`, `search`, `overlay`, `content`, `background`).
- [src/i18n/locales/en.ts](file:///d:/Projects/PageTrace/src/i18n/locales/en.ts) — English translations (default fallback language).
- [src/i18n/locales/ru.ts](file:///d:/Projects/PageTrace/src/i18n/locales/ru.ts) — Russian translations.
- [src/i18n/index.ts](file:///d:/Projects/PageTrace/src/i18n/index.ts) — `LOCALES` registry, `AVAILABLE_LANGUAGES`, `getLocale()`, and `applyI18nToDOM()`.

## Workflow: Adding or Updating UI Strings

Whenever you introduce or change any user-facing text in Options, Popup, Search Window, Overlay, Content Script, or Context Menu:

1. **Declare the key in `LocaleTranslations`** ([src/i18n/types.ts](file:///d:/Projects/PageTrace/src/i18n/types.ts)):
   - Place the property under the matching namespace (`options`, `popup`, `search`, `overlay`, `content`, `background`).
   - Use `string` for static text or typed formatter functions (e.g., `(count: number) => string`) for dynamic/pluralized text.
   - Suffix keys containing HTML markup with `Html` (e.g., `hintHtml`, `deleteConfirmTextHtml`).

2. **Add translations to all locale files**:
   - Update [src/i18n/locales/en.ts](file:///d:/Projects/PageTrace/src/i18n/locales/en.ts).
   - Update [src/i18n/locales/ru.ts](file:///d:/Projects/PageTrace/src/i18n/locales/ru.ts).

3. **Bind in HTML or TypeScript**:
   - **Static HTML templates** (`options.html`, `popup.html`, `search.html`) or Shadow DOM containers:
     Use `data-i18n*` attributes processed by `applyI18nToDOM(root, lang)`:
     - `data-i18n="section.key"` — sets `textContent`
     - `data-i18n-html="section.keyHtml"` — parses via `setSafeHtml()`
     - `data-i18n-placeholder="section.placeholder"` — sets input/textarea `placeholder`
     - `data-i18n-title="section.title"` — sets element `title`
     - `data-i18n-aria-label="section.aria"` — sets `aria-label`
     - `data-i18n-page-title="section.pageTitle"` on `<html>` — sets `document.title`
   - **Dynamic TypeScript rendering**:
     Fetch the active dictionary with `const t = getLocale(lang);` and reference `t.overlay.resultsCount(count)`.

## Workflow: Adding a New Language

1. Create `src/i18n/locales/<code>.ts` exporting `const <code>: LocaleTranslations = { ... }`.
2. Register the locale in [src/i18n/index.ts](file:///d:/Projects/PageTrace/src/i18n/index.ts) inside `LOCALES` and `AVAILABLE_LANGUAGES`.
3. Update relative time or locale-specific helpers in [src/common/tags.ts](file:///d:/Projects/PageTrace/src/common/tags.ts) (`formatTimeAgo`, `TagColorDef`) if needed.
4. Run `npm run type-check` and `npm test` to verify all keys in `LocaleTranslations` are implemented and all tests pass.
