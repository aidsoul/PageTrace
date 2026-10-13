import { describe, it, expect } from 'vitest';
import {
  normalizeTagName,
  matchUrlPattern,
  escapeHtml,
  escapeAttr,
  renderTagBadge,
  formatTimeAgo,
} from '@/common/tags';
import {
  normalizePageUrl,
  normalizeIndexedText,
  extractHostnameLower,
  parseSearchQuery,
  extractInlineOperators,
  toggleInlineOperatorToken,
  sortSearchResults,
  groupResultsByPage,
  formatMarkdownQuote,
  getAutocompleteTokenInfo,
  generateSearchSuggestions,
  applySuggestionToQuery,
} from '@/common/search-utils';
import type { SearchResult } from '@/types/index';

describe('Tag normalization and URL pattern matching', () => {
  it('normalizes tag names to uppercase, strips # and special chars, replaces spaces, and caps at 12 chars', () => {
    expect(normalizeTagName('  #wiki  ')).toBe('WIKI');
    expect(normalizeTagName('###my tag')).toBe('MY_TAG');
    expect(normalizeTagName('a<b"c>d\'e&f')).toBe('ABCDEF');
    expect(normalizeTagName('verylongtagname123')).toBe('VERYLONGTAGN');
    expect(normalizeTagName('   ')).toBe('');
  });

  it('matches domain, subdomain, and path wildcards accurately', () => {
    expect(matchUrlPattern('wikipedia.org/*', 'https://ru.wikipedia.org/wiki/Test')).toBe(true);
    expect(matchUrlPattern('wikipedia.org', 'https://en.wikipedia.org/wiki/Main_Page')).toBe(true);
    expect(matchUrlPattern('*.habr.com/*', 'https://m.habr.com/ru/articles/123/')).toBe(true);
    expect(matchUrlPattern('github.com/org/*', 'https://github.com/org/repo/issues')).toBe(true);
    expect(matchUrlPattern('github.com/org/*', 'https://github.com/other/repo')).toBe(false);
    expect(matchUrlPattern('example.com', 'https://notexample.com/page')).toBe(false);
    expect(matchUrlPattern('', 'https://example.com')).toBe(false);
  });

  it('escapes HTML and attribute strings safely', () => {
    expect(escapeHtml('<script>alert("xss" & \'1\')</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;1&#39;)&lt;/script&gt;',
    );
    expect(escapeAttr('value"with<quotes>')).toBe('value&quot;with&lt;quotes&gt;');
  });

  it('renders tag badges and formats relative time', () => {
    const badge = renderTagBadge('dev', [{ name: 'DEV', colorId: 'emerald' }], 'clickable');
    expect(badge).toContain('#DEV');
    expect(badge).toContain('pt-tag-badge clickable');

    const now = Date.now();
    expect(formatTimeAgo(now - 10_000, 'en')).toBe('just now');
    expect(formatTimeAgo(now - 10_000, 'ru')).toBe('только что');
    expect(formatTimeAgo(now - 5 * 60_000, 'en')).toBe('5 min ago');
    expect(formatTimeAgo(now - 3 * 3600_000, 'ru')).toBe('3 ч назад');
  });
});

describe('Search utilities and inline query operators', () => {
  it('normalizes page URLs by removing hash fragments and trailing slashes', () => {
    expect(normalizePageUrl('https://example.com/docs/#section-1')).toBe('https://example.com/docs');
    expect(normalizePageUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizePageUrl('https://example.com/path?a=1#top')).toBe('https://example.com/path?a=1');
  });

  it('normalizes indexed text and extracts lowercase hostnames', () => {
    expect(normalizeIndexedText('  Hello   \n  World  ')).toBe('hello world');
    expect(extractHostnameLower('https://Sub.Example.COM/path')).toBe('sub.example.com');
  });

  it('parses English and Russian inline operators (#tag, tag:, site:, type:, sort:)', () => {
    const parsedEn = parseSearchQuery('#wiki tag:dev site:github.com type:media sort:newest async hooks');
    expect(parsedEn).toEqual({
      textQuery: 'async hooks',
      tags: ['WIKI', 'DEV'],
      domain: 'github.com',
      type: 'media',
      sort: 'newest',
    });

    const parsedRu = parseSearchQuery('тег:заметки сайт:habr.com тип:теги сорт:старые реакт');
    expect(parsedRu).toEqual({
      textQuery: 'реакт',
      tags: ['ЗАМЕТКИ'],
      domain: 'habr.com',
      type: 'tag',
      sort: 'oldest',
    });

    const parsedVisits = parseSearchQuery('query visits:>3 sort:visits');
    expect(parsedVisits.minVisits).toBe(4);
    expect(parsedVisits.sort).toBe('visits_desc');

    const parsedVisitsRu = parseSearchQuery('запрос визиты:2..5 сорт:редкие');
    expect(parsedVisitsRu.minVisits).toBe(2);
    expect(parsedVisitsRu.maxVisits).toBe(5);
    expect(parsedVisitsRu.sort).toBe('visits_asc');

    const parsedVisitsKeywords = parseSearchQuery('test visits:multiple');
    expect(parsedVisitsKeywords.minVisits).toBe(2);
  });

  it('extracts inline type and sort operators and toggles operator tokens in query input', () => {
    expect(extractInlineOperators('type:tag sort:az query')).toEqual({
      type: 'tag',
      sort: 'title_asc',
    });

    const added = toggleInlineOperatorToken('react hooks', '#DEV');
    expect(added).toBe('react hooks #DEV ');

    const removed = toggleInlineOperatorToken(added, '#dev');
    expect(removed).toBe('react hooks ');
  });

  it('sorts search results by relevance (tags boosted first), date, and title', () => {
    const baseResults: SearchResult[] = [
      {
        id: 1,
        pageId: 1,
        url: 'https://b.com',
        title: 'Beta Page',
        favicon: '',
        text: 'body chunk',
        selector: 'p',
        type: 'text',
        createdAt: 1000,
        visitCount: 1,
        snippet: 'body chunk',
        score: 50,
      },
      {
        id: 2,
        pageId: 1,
        url: 'https://a.com',
        title: 'Alpha Page',
        favicon: '',
        text: 'saved bookmark',
        selector: 'p',
        type: 'tag',
        tagName: 'FAV',
        createdAt: 3000,
        visitCount: 10,
        snippet: 'saved bookmark',
        score: 10,
      },
      {
        id: 3,
        pageId: 2,
        url: 'https://c.com',
        title: 'Gamma Page',
        favicon: '',
        text: 'newer body',
        selector: 'p',
        type: 'text',
        createdAt: 2000,
        visitCount: 5,
        snippet: 'newer body',
        score: 80,
      },
    ];

    const byRelevance = sortSearchResults(baseResults, 'relevance');
    expect(byRelevance.map((r) => r.id)).toEqual([2, 3, 1]);

    const byNewest = sortSearchResults(baseResults, 'newest');
    expect(byNewest.map((r) => r.id)).toEqual([2, 3, 1]);

    const byOldest = sortSearchResults(baseResults, 'oldest');
    expect(byOldest.map((r) => r.id)).toEqual([1, 3, 2]);

    const byTitleAsc = sortSearchResults(baseResults, 'title_asc');
    expect(byTitleAsc.map((r) => r.title)).toEqual(['Alpha Page', 'Beta Page', 'Gamma Page']);

    const byTitleDesc = sortSearchResults(baseResults, 'title_desc');
    expect(byTitleDesc.map((r) => r.title)).toEqual(['Gamma Page', 'Beta Page', 'Alpha Page']);

    const byVisitsDesc = sortSearchResults(baseResults, 'visits_desc');
    expect(byVisitsDesc.map((r) => r.id)).toEqual([2, 3, 1]);

    const byVisitsAsc = sortSearchResults(baseResults, 'visits_asc');
    expect(byVisitsAsc.map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it('correctly filters urls according to blacklist and whitelist rules', () => {
    function isUrlAllowed(
      url: string,
      mode: 'blacklist' | 'whitelist',
      blacklist: string[],
      whitelist: string[],
    ): boolean {
      if (mode === 'whitelist') {
        if (!whitelist.length) return false;
        return whitelist.some((p) => matchUrlPattern(p, url));
      }
      return !blacklist.some((p) => matchUrlPattern(p, url));
    }

    const testUrl = 'https://docs.github.com/en/actions';

    // Blacklist mode: allowed if not in blacklist
    expect(isUrlAllowed(testUrl, 'blacklist', ['mail.google.com'], [])).toBe(true);
    expect(isUrlAllowed(testUrl, 'blacklist', ['*.github.com/*'], [])).toBe(false);

    // Whitelist mode: allowed only if in whitelist
    expect(isUrlAllowed(testUrl, 'whitelist', [], ['github.com/*'])).toBe(true);
    expect(isUrlAllowed(testUrl, 'whitelist', [], ['wikipedia.org/*'])).toBe(false);
    expect(isUrlAllowed(testUrl, 'whitelist', [], [])).toBe(false);
  });

  it('parses date filters (after, before, date presets) in English and Russian', () => {
    const parsedEn = parseSearchQuery('query after:2026-05-01 before:2026-05-10');
    expect(parsedEn.textQuery).toBe('query');
    expect(parsedEn.dateFrom).toBe(new Date(2026, 4, 1, 0, 0, 0, 0).getTime());
    expect(parsedEn.dateTo).toBe(new Date(2026, 4, 10, 23, 59, 59, 999).getTime());

    const parsedRu = parseSearchQuery('поиск после:2026-05-01 до:2026-05-10');
    expect(parsedRu.textQuery).toBe('поиск');
    expect(parsedRu.dateFrom).toBe(new Date(2026, 4, 1, 0, 0, 0, 0).getTime());
    expect(parsedRu.dateTo).toBe(new Date(2026, 4, 10, 23, 59, 59, 999).getTime());

    const todayParsed = parseSearchQuery('date:today');
    expect(todayParsed.dateFrom).toBeDefined();
    expect(todayParsed.dateTo).toBeDefined();

    const ruPeriod = parseSearchQuery('период:неделя');
    expect(ruPeriod.dateFrom).toBeDefined();
    expect(ruPeriod.dateTo).toBeDefined();

    const operators = extractInlineOperators('type:media after:2026-01-01');
    expect(operators.type).toBe('media');
    expect(operators.dateFrom).toBe(new Date(2026, 0, 1, 0, 0, 0, 0).getTime());
  });

  it('groups multiple search results by normalized page URL', () => {
    const results: SearchResult[] = [
      {
        id: 1,
        pageId: 10,
        url: 'https://example.com/docs#intro',
        title: 'Docs Intro',
        favicon: '',
        text: 'first chunk',
        selector: 'h1',
        type: 'text',
        createdAt: 1000,
        snippet: 'first chunk',
        score: 10,
      },
      {
        id: 2,
        pageId: 10,
        url: 'https://example.com/docs#details',
        title: 'Docs Details',
        favicon: '',
        text: 'second chunk',
        selector: 'p',
        type: 'text',
        createdAt: 2000,
        snippet: 'second chunk',
        score: 8,
      },
      {
        id: 3,
        pageId: 20,
        url: 'https://example.com/other',
        title: 'Other Page',
        favicon: '',
        text: 'other text',
        selector: 'div',
        type: 'text',
        createdAt: 3000,
        snippet: 'other text',
        score: 5,
      },
    ];

    const grouped = groupResultsByPage(results);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.primary.id).toBe(1);
    expect(grouped[0]?.subMatches).toHaveLength(1);
    expect(grouped[0]?.subMatches[0]?.id).toBe(2);
    expect(grouped[1]?.primary.id).toBe(3);
    expect(grouped[1]?.subMatches).toHaveLength(0);
  });

  it('formats markdown blockquotes with page title link and clean whitespace', () => {
    const quote = formatMarkdownQuote('  Important   point \n here  ', 'Page Title', 'https://example.com');
    expect(quote).toBe('> Important point here\n— [Page Title](https://example.com)');

    const quoteFallback = formatMarkdownQuote('snippet', '', 'https://example.com/article');
    expect(quoteFallback).toBe('> snippet\n— [https://example.com/article](https://example.com/article)');
  });

  it('extracts autocomplete token info, generates suggestions, and applies them to query', () => {
    const query = 'react #dev docs';
    const tokenInfo = getAutocompleteTokenInfo(query, 9);
    expect(tokenInfo).toEqual({
      token: '#dev',
      start: 6,
      end: 10,
      prefix: '#',
      filter: 'dev',
    });

    const suggestions = generateSearchSuggestions(
      tokenInfo!,
      ['DEV', 'REACT', 'WIKI'],
      ['github.com', 'habr.com'],
    );
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    expect(suggestions[0]?.label).toBe('#DEV');

    const applied = applySuggestionToQuery(query, tokenInfo!, suggestions[0]!);
    expect(applied.newQuery).toBe('react #DEV  docs');
    expect(applied.newCursorPos).toBe(11);

    const siteToken = getAutocompleteTokenInfo('site:git', 8);
    expect(siteToken?.prefix).toBe('site:');
    const siteSuggestions = generateSearchSuggestions(siteToken!, [], ['github.com', 'gitlab.com']);
    expect(siteSuggestions.some((s) => s.label === 'site:github.com')).toBe(true);

    const operatorToken = getAutocompleteTokenInfo('af', 2);
    const opSuggestions = generateSearchSuggestions(operatorToken!, [], []);
    expect(opSuggestions.some((s) => s.label === 'after:')).toBe(true);
  });
});

