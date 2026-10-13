// i18n manager and locale registry

import { en } from './locales/en';
import { ru } from './locales/ru';
import type { LocaleTranslations } from './types';
import { setSafeHtml } from '@/common/tags';

export * from './types';
export { en } from './locales/en';
export { ru } from './locales/ru';

export interface LanguageOption {
  code: string;
  name: string;
}

// Available locales registry
export const LOCALES: Record<string, LocaleTranslations> = {
  en,
  ru,
};

export const AVAILABLE_LANGUAGES: LanguageOption[] = [
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
];

export const DEFAULT_LANGUAGE = 'en';

export function getLocale(lang?: string): LocaleTranslations {
  if (lang && LOCALES[lang]) {
    return LOCALES[lang];
  }
  return LOCALES[DEFAULT_LANGUAGE] || en;
}

export function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  return path.split('.').reduce((acc: unknown, part: string) => {
    if (acc && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

// Translates elements with data-i18n-* attributes in the given DOM subtree
export function applyI18nToDOM(root: Document | ShadowRoot | HTMLElement, lang?: string): void {
  const currentLocale = getLocale(lang);
  const effectiveLang = lang && LOCALES[lang] ? lang : DEFAULT_LANGUAGE;

  const selector = '[data-i18n], [data-i18n-html], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria-label]';
  const elements = Array.from(root.querySelectorAll<HTMLElement>(selector));

  if (root instanceof HTMLElement && root.matches(selector)) {
    elements.unshift(root);
  }

  elements.forEach((el) => {
    const textKey = el.getAttribute('data-i18n');
    if (textKey) {
      const val = getNestedValue(currentLocale, textKey);
      if (typeof val === 'string') {
        el.textContent = val;
      }
    }

    const htmlKey = el.getAttribute('data-i18n-html');
    if (htmlKey) {
      const val = getNestedValue(currentLocale, htmlKey);
      if (typeof val === 'string') {
        setSafeHtml(el, val);
      }
    }

    const placeholderKey = el.getAttribute('data-i18n-placeholder');
    if (placeholderKey && 'placeholder' in el) {
      const val = getNestedValue(currentLocale, placeholderKey);
      if (typeof val === 'string') {
        (el as HTMLInputElement | HTMLTextAreaElement).placeholder = val;
      }
    }

    const titleKey = el.getAttribute('data-i18n-title');
    if (titleKey) {
      const val = getNestedValue(currentLocale, titleKey);
      if (typeof val === 'string') {
        el.title = val;
      }
    }

    const ariaKey = el.getAttribute('data-i18n-aria-label');
    if (ariaKey) {
      const val = getNestedValue(currentLocale, ariaKey);
      if (typeof val === 'string') {
        el.setAttribute('aria-label', val);
      }
    }
  });

  // Update document title and lang attribute when available
  const doc = 'documentElement' in root ? (root as Document) : root.ownerDocument;
  if (doc?.documentElement) {
    doc.documentElement.lang = effectiveLang;
    const pageTitleKey = doc.documentElement.getAttribute('data-i18n-page-title');
    if (pageTitleKey) {
      const val = getNestedValue(currentLocale, pageTitleKey);
      if (typeof val === 'string') {
        doc.title = val;
      }
    }
  }
}
