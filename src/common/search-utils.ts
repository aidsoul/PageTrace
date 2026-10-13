import type { SearchResult, SearchSortOption, SearchTypeFilter } from '@/types/index';
import { normalizeTagName } from '@/common/tags';

// Shared URL and text normalization helpers
export function normalizePageUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return rawUrl.split('#')[0]?.replace(/\/$/, '') ?? rawUrl;
  }
}

export function normalizeIndexedText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function extractHostnameLower(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

// Inline operator aliases for English and Russian search queries
export const TYPE_ALIASES: Record<string, SearchTypeFilter> = {
  all: 'all',
  все: 'all',
  всё: 'all',
  text: 'text',
  текст: 'text',
  tag: 'tag',
  tags: 'tag',
  index: 'tag',
  indexes: 'tag',
  тег: 'tag',
  теги: 'tag',
  индекс: 'tag',
  индексы: 'tag',
  media: 'media',
  file: 'media',
  files: 'media',
  image: 'media',
  images: 'media',
  doc: 'media',
  docs: 'media',
  медиа: 'media',
  файл: 'media',
  файлы: 'media',
};

export const SORT_ALIASES: Record<string, SearchSortOption> = {
  relevance: 'relevance',
  rel: 'relevance',
  релевантность: 'relevance',
  newest: 'newest',
  new: 'newest',
  date: 'newest',
  новые: 'newest',
  дата: 'newest',
  oldest: 'oldest',
  old: 'oldest',
  старые: 'oldest',
  title: 'title_asc',
  'title-asc': 'title_asc',
  title_asc: 'title_asc',
  az: 'title_asc',
  название: 'title_asc',
  ая: 'title_asc',
  'title-desc': 'title_desc',
  title_desc: 'title_desc',
  za: 'title_desc',
  яа: 'title_desc',
  visits: 'visits_desc',
  'visits-desc': 'visits_desc',
  visits_desc: 'visits_desc',
  most_visited: 'visits_desc',
  mostvisited: 'visits_desc',
  popular: 'visits_desc',
  посещения: 'visits_desc',
  визиты: 'visits_desc',
  популярные: 'visits_desc',
  частые: 'visits_desc',
  'visits-asc': 'visits_asc',
  visits_asc: 'visits_asc',
  least_visited: 'visits_asc',
  leastvisited: 'visits_asc',
  rare: 'visits_asc',
  редкие: 'visits_asc',
};

export interface ParsedSearchQuery {
  textQuery: string;
  type?: SearchTypeFilter;
  tags: string[];
  domain?: string;
  sort?: SearchSortOption;
  dateFrom?: number;
  dateTo?: number;
  minVisits?: number;
  maxVisits?: number;
}

export function parseDateStringToStart(val: string): number | undefined {
  const m = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, month - 1, d, 0, 0, 0, 0);
  const time = dt.getTime();
  return Number.isNaN(time) ? undefined : time;
}

export function parseDateStringToEnd(val: string): number | undefined {
  const m = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return undefined;
  const y = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, month - 1, d, 23, 59, 59, 999);
  const time = dt.getTime();
  return Number.isNaN(time) ? undefined : time;
}

export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const tags: string[] = [];
  let type: SearchTypeFilter | undefined;
  let domain: string | undefined;
  let sort: SearchSortOption | undefined;
  let dateFrom: number | undefined;
  let dateTo: number | undefined;
  let minVisits: number | undefined;
  let maxVisits: number | undefined;
  const textTokens: string[] = [];

  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);

  for (const token of tokens) {
    if (token.startsWith('#') && token.length > 1) {
      const norm = normalizeTagName(token.slice(1));
      if (norm && !tags.includes(norm)) tags.push(norm);
      continue;
    }

    const colonIdx = token.indexOf(':');
    if (colonIdx > 0 && colonIdx < token.length - 1) {
      const key = token.slice(0, colonIdx).toLowerCase();
      const val = token.slice(colonIdx + 1).trim();

      if ((key === 'tag' || key === 'тег') && val) {
        const norm = normalizeTagName(val);
        if (norm && !tags.includes(norm)) tags.push(norm);
        continue;
      }

      if ((key === 'site' || key === 'domain' || key === 'сайт' || key === 'домен') && val) {
        domain = val.toLowerCase();
        continue;
      }

      if ((key === 'type' || key === 'is' || key === 'тип') && val) {
        const mapped = TYPE_ALIASES[val.toLowerCase()];
        if (mapped) {
          type = mapped;
          continue;
        }
      }

      if ((key === 'sort' || key === 'order' || key === 'сорт' || key === 'сортировка') && val) {
        const mapped = SORT_ALIASES[val.toLowerCase()];
        if (mapped) {
          sort = mapped;
          continue;
        }
      }

      if ((key === 'after' || key === 'после' || key === 'from' || key === 'с') && val) {
        const t = parseDateStringToStart(val);
        if (t !== undefined) {
          dateFrom = t;
          continue;
        }
      }

      if ((key === 'before' || key === 'до' || key === 'to' || key === 'по') && val) {
        const t = parseDateStringToEnd(val);
        if (t !== undefined) {
          dateTo = t;
          continue;
        }
      }

      if (
        (key === 'visits' ||
          key === 'visit' ||
          key === 'посещений' ||
          key === 'визитов' ||
          key === 'визиты' ||
          key === 'посещения') &&
        val
      ) {
        const vLower = val.toLowerCase();
        if (vLower === 'multiple' || vLower === 'повторные' || vLower === 'частые') {
          minVisits = 2;
          continue;
        }
        if (vLower === 'frequent' || vLower === 'много') {
          minVisits = 3;
          continue;
        }
        if (vLower === 'once' || vLower === 'разовые' || vLower === 'один') {
          minVisits = 1;
          maxVisits = 1;
          continue;
        }
        const rangeMatch = vLower.match(/^(\d+)\.\.(\d+)$/);
        if (rangeMatch) {
          minVisits = Number(rangeMatch[1]);
          maxVisits = Number(rangeMatch[2]);
          continue;
        }
        if (
          vLower.startsWith('<=') ||
          vLower.startsWith('<') ||
          vLower.startsWith('max:') ||
          vLower.startsWith('макс:')
        ) {
          const num = Number(vLower.replace(/^(?:<=|<|макс:|max:)/, ''));
          if (!Number.isNaN(num)) {
            maxVisits = vLower.startsWith('<') && !vLower.startsWith('<=') ? Math.max(0, num - 1) : num;
          }
          continue;
        }
        if (
          vLower.startsWith('>=') ||
          vLower.startsWith('>') ||
          vLower.startsWith('min:') ||
          vLower.startsWith('мин:')
        ) {
          const num = Number(vLower.replace(/^(?:>=|>|мин:|min:)/, ''));
          if (!Number.isNaN(num)) {
            minVisits = vLower.startsWith('>') && !vLower.startsWith('>=') ? num + 1 : num;
          }
          continue;
        }
        const num = Number(vLower);
        if (!Number.isNaN(num) && num > 0) {
          minVisits = num;
          continue;
        }
      }

      if ((key === 'date' || key === 'дата' || key === 'период') && val) {
        const vLower = val.toLowerCase();
        const now = new Date();
        if (vLower === 'today' || vLower === 'сегодня') {
          dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
          dateTo = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
          continue;
        }
        if (vLower === 'week' || vLower === 'неделя' || vLower === '7d' || vLower === '7д') {
          dateFrom = Date.now() - 7 * 24 * 60 * 60 * 1000;
          dateTo = Date.now();
          continue;
        }
        if (vLower === 'month' || vLower === 'месяц' || vLower === '30d' || vLower === '30д') {
          dateFrom = Date.now() - 30 * 24 * 60 * 60 * 1000;
          dateTo = Date.now();
          continue;
        }
        const startT = parseDateStringToStart(val);
        const endT = parseDateStringToEnd(val);
        if (startT !== undefined && endT !== undefined) {
          dateFrom = startT;
          dateTo = endT;
          continue;
        }
      }
    }

    textTokens.push(token);
  }

  return {
    textQuery: textTokens.join(' '),
    type,
    tags,
    domain,
    sort,
    dateFrom,
    dateTo,
    minVisits,
    maxVisits,
  };
}

export function extractInlineOperators(rawQuery: string): {
  type?: SearchTypeFilter;
  sort?: SearchSortOption;
  dateFrom?: number;
  dateTo?: number;
  minVisits?: number;
  maxVisits?: number;
} {
  const parsed = parseSearchQuery(rawQuery);
  return {
    type: parsed.type,
    sort: parsed.sort,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    minVisits: parsed.minVisits,
    maxVisits: parsed.maxVisits,
  };
}

export function toggleInlineOperatorToken(currentQuery: string, operatorToken: string): string {
  const current = currentQuery.trim();
  const tokens = current ? current.split(/\s+/) : [];
  const lowerToken = operatorToken.toLowerCase();

  const existingIdx = tokens.findIndex((t) => t.toLowerCase() === lowerToken);
  if (existingIdx >= 0) {
    tokens.splice(existingIdx, 1);
  } else {
    tokens.push(operatorToken);
  }

  return tokens.join(' ') + (tokens.length > 0 ? ' ' : '');
}

export interface GroupedSearchResult {
  primary: SearchResult;
  subMatches: SearchResult[];
}

export function groupResultsByPage(results: SearchResult[]): GroupedSearchResult[] {
  const groups: GroupedSearchResult[] = [];
  const urlMap = new Map<string, GroupedSearchResult>();

  for (const r of results) {
    const normUrl = normalizePageUrl(r.url);
    const existing = urlMap.get(normUrl);
    if (existing) {
      existing.subMatches.push(r);
    } else {
      const group: GroupedSearchResult = {
        primary: r,
        subMatches: [],
      };
      urlMap.set(normUrl, group);
      groups.push(group);
    }
  }

  return groups;
}

export function formatMarkdownQuote(text: string, title: string, url: string): string {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  const cleanTitle = (title || url).trim();
  return `> ${cleanText}\n— [${cleanTitle}](${url})`;
}

export interface AutocompleteTokenInfo {
  token: string;
  start: number;
  end: number;
  prefix: string;
  filter: string;
}

export function getAutocompleteTokenInfo(
  query: string,
  cursorPos: number,
): AutocompleteTokenInfo | null {
  if (cursorPos < 0 || cursorPos > query.length) return null;
  const left = query.slice(0, cursorPos);
  const right = query.slice(cursorPos);

  const leftMatch = left.match(/[^\s]+$/);
  const rightMatch = right.match(/^[^\s]+/);

  const leftPart = leftMatch ? leftMatch[0] : '';
  const rightPart = rightMatch ? rightMatch[0] : '';

  const token = leftPart + rightPart;
  if (!token) return null;

  const start = cursorPos - leftPart.length;
  const end = cursorPos + rightPart.length;

  const colonIdx = token.indexOf(':');
  if (token.startsWith('#')) {
    return {
      token,
      start,
      end,
      prefix: '#',
      filter: token.slice(1).toLowerCase(),
    };
  }

  if (colonIdx > 0) {
    const prefix = token.slice(0, colonIdx + 1).toLowerCase();
    const filter = token.slice(colonIdx + 1).toLowerCase();
    return {
      token,
      start,
      end,
      prefix,
      filter,
    };
  }

  return {
    token,
    start,
    end,
    prefix: '',
    filter: token.toLowerCase(),
  };
}

export interface SearchSuggestionItem {
  label: string;
  insertText: string;
  category: 'tag' | 'domain' | 'type' | 'sort' | 'date' | 'operator';
  description?: string;
}

export function generateSearchSuggestions(
  tokenInfo: AutocompleteTokenInfo,
  availableTags: string[],
  availableDomains: string[],
): SearchSuggestionItem[] {
  const { prefix, filter } = tokenInfo;
  const suggestions: SearchSuggestionItem[] = [];

  const KNOWN_OPERATORS = [
    { label: '#tag', insertText: '#', desc: 'Tag' },
    { label: 'tag:', insertText: 'tag:', desc: 'Tag' },
    { label: 'site:', insertText: 'site:', desc: 'Domain' },
    { label: 'type:', insertText: 'type:', desc: 'all | text | tag | media' },
    { label: 'sort:', insertText: 'sort:', desc: 'relevance | newest | oldest | title | visits' },
    { label: 'date:', insertText: 'date:', desc: 'today | week | month' },
    { label: 'after:', insertText: 'after:', desc: 'after:YYYY-MM-DD' },
    { label: 'before:', insertText: 'before:', desc: 'before:YYYY-MM-DD' },
    { label: 'visits:', insertText: 'visits:>1', desc: 'visits:>1 | visits:5' },
    { label: 'тег:', insertText: 'тег:', desc: 'Тег' },
    { label: 'сайт:', insertText: 'сайт:', desc: 'Домен' },
    { label: 'тип:', insertText: 'тип:', desc: 'текст | теги | медиа' },
    { label: 'сорт:', insertText: 'сорт:', desc: 'новые | старые | название | визиты' },
    { label: 'после:', insertText: 'после:', desc: 'после:ГГГГ-ММ-ДД' },
    { label: 'до:', insertText: 'до:', desc: 'до:ГГГГ-ММ-ДД' },
    { label: 'период:', insertText: 'период:', desc: 'сегодня | неделя | месяц' },
    { label: 'визиты:', insertText: 'визиты:>1', desc: 'визиты:>1 | визиты:5' },
  ];

  if (prefix === '#') {
    for (const tag of availableTags) {
      if (!filter || tag.toLowerCase().includes(filter)) {
        suggestions.push({
          label: `#${tag}`,
          insertText: `#${tag} `,
          category: 'tag',
          description: 'Tag',
        });
      }
    }
    return suggestions.slice(0, 10);
  }

  if (prefix === 'tag:' || prefix === 'тег:') {
    for (const tag of availableTags) {
      if (!filter || tag.toLowerCase().includes(filter)) {
        suggestions.push({
          label: `${prefix}${tag}`,
          insertText: `${prefix}${tag} `,
          category: 'tag',
          description: 'Tag',
        });
      }
    }
    return suggestions.slice(0, 10);
  }

  if (prefix === 'site:' || prefix === 'domain:' || prefix === 'сайт:' || prefix === 'домен:') {
    for (const dom of availableDomains) {
      if (!filter || dom.toLowerCase().includes(filter)) {
        suggestions.push({
          label: `${prefix}${dom}`,
          insertText: `${prefix}${dom} `,
          category: 'domain',
          description: 'Domain',
        });
      }
    }
    return suggestions.slice(0, 10);
  }

  if (prefix === 'type:' || prefix === 'тип:') {
    const isRu = prefix === 'тип:';
    const typeOptions = isRu
      ? [
          { label: 'все', val: 'все' },
          { label: 'текст', val: 'текст' },
          { label: 'теги', val: 'теги' },
          { label: 'медиа', val: 'медиа' },
        ]
      : [
          { label: 'all', val: 'all' },
          { label: 'text', val: 'text' },
          { label: 'tag', val: 'tag' },
          { label: 'media', val: 'media' },
        ];
    for (const opt of typeOptions) {
      if (!filter || opt.label.includes(filter)) {
        suggestions.push({
          label: `${prefix}${opt.label}`,
          insertText: `${prefix}${opt.val} `,
          category: 'type',
          description: 'Type',
        });
      }
    }
    return suggestions;
  }

  if (prefix === 'sort:' || prefix === 'сорт:' || prefix === 'сортировка:') {
    const isRu = prefix.startsWith('сорт');
    const sortOptions = isRu
      ? [
          { label: 'релевантность', val: 'релевантность' },
          { label: 'новые', val: 'новые' },
          { label: 'старые', val: 'старые' },
          { label: 'название', val: 'название' },
          { label: 'посещения', val: 'посещения' },
          { label: 'редкие', val: 'редкие' },
        ]
      : [
          { label: 'relevance', val: 'relevance' },
          { label: 'newest', val: 'newest' },
          { label: 'oldest', val: 'oldest' },
          { label: 'title', val: 'title' },
          { label: 'visits', val: 'visits' },
          { label: 'least-visited', val: 'least_visited' },
        ];
    for (const opt of sortOptions) {
      if (!filter || opt.label.includes(filter)) {
        suggestions.push({
          label: `${prefix}${opt.label}`,
          insertText: `${prefix}${opt.val} `,
          category: 'sort',
          description: 'Sort',
        });
      }
    }
    return suggestions;
  }

  if (
    prefix === 'visits:' ||
    prefix === 'визиты:' ||
    prefix === 'посещений:' ||
    prefix === 'посещения:'
  ) {
    const isRu = prefix.startsWith('визит') || prefix.startsWith('посещ');
    const visitOptions = isRu
      ? [
          { label: '>1 (повторные)', val: '>1' },
          { label: '>=3 (частые)', val: '>=3' },
          { label: '1 (разовые)', val: '1' },
        ]
      : [
          { label: '>1 (multiple)', val: '>1' },
          { label: '>=3 (frequent)', val: '>=3' },
          { label: '1 (single)', val: '1' },
        ];
    for (const opt of visitOptions) {
      if (!filter || opt.val.includes(filter) || opt.label.includes(filter)) {
        suggestions.push({
          label: `${prefix}${opt.label}`,
          insertText: `${prefix}${opt.val} `,
          category: 'operator',
          description: 'Visits',
        });
      }
    }
    return suggestions;
  }

  if (prefix === 'date:' || prefix === 'дата:' || prefix === 'период:') {
    const isRu = prefix === 'дата:' || prefix === 'период:';
    const dateOptions = isRu
      ? [
          { label: 'сегодня', val: 'сегодня', desc: 'Сегодня' },
          { label: 'неделя', val: 'неделя', desc: 'За 7 дней' },
          { label: 'месяц', val: 'месяц', desc: 'За 30 дней' },
        ]
      : [
          { label: 'today', val: 'today', desc: 'Today' },
          { label: 'week', val: 'week', desc: 'Past 7 days' },
          { label: 'month', val: 'month', desc: 'Past 30 days' },
        ];
    for (const opt of dateOptions) {
      if (!filter || opt.label.includes(filter)) {
        suggestions.push({
          label: `${prefix}${opt.label}`,
          insertText: `${prefix}${opt.val} `,
          category: 'date',
          description: opt.desc,
        });
      }
    }
    return suggestions;
  }

  if (prefix === 'after:' || prefix === 'после:' || prefix === 'before:' || prefix === 'до:') {
    const todayStr = new Date().toISOString().slice(0, 10);
    suggestions.push({
      label: `${prefix}${todayStr}`,
      insertText: `${prefix}${todayStr} `,
      category: 'date',
      description: 'YYYY-MM-DD',
    });
    return suggestions;
  }

  if (filter && filter.length >= 1) {
    for (const op of KNOWN_OPERATORS) {
      if (op.label.toLowerCase().startsWith(filter)) {
        suggestions.push({
          label: op.label,
          insertText: op.insertText,
          category: 'operator',
          description: op.desc,
        });
      }
    }
  }

  return suggestions.slice(0, 8);
}

export function applySuggestionToQuery(
  query: string,
  tokenInfo: AutocompleteTokenInfo,
  suggestion: SearchSuggestionItem,
): { newQuery: string; newCursorPos: number } {
  const before = query.slice(0, tokenInfo.start);
  const after = query.slice(tokenInfo.end);
  const newQuery = before + suggestion.insertText + after;
  const newCursorPos = before.length + suggestion.insertText.length;
  return { newQuery, newCursorPos };
}

// Shared result sorting helpers
export interface SortableItem {
  type: 'text' | 'media' | 'tag';
  score: number;
  createdAt?: number;
  title?: string;
  tagName?: string;
  url?: string;
  visitCount?: number;
}

export function compareSortableItems(a: SortableItem, b: SortableItem, sort: SearchSortOption): number {
  switch (sort) {
    case 'newest': {
      const diff = (b.createdAt || 0) - (a.createdAt || 0);
      return diff !== 0 ? diff : b.score - a.score;
    }
    case 'oldest': {
      const diff = (a.createdAt || 0) - (b.createdAt || 0);
      return diff !== 0 ? diff : b.score - a.score;
    }
    case 'title_asc': {
      const titleA = (a.title || a.tagName || a.url || '').trim();
      const titleB = (b.title || b.tagName || b.url || '').trim();
      const cmp = titleA.localeCompare(titleB, undefined, { sensitivity: 'base', numeric: true });
      return cmp !== 0 ? cmp : (b.createdAt || 0) - (a.createdAt || 0);
    }
    case 'title_desc': {
      const titleA = (a.title || a.tagName || a.url || '').trim();
      const titleB = (b.title || b.tagName || b.url || '').trim();
      const cmp = titleB.localeCompare(titleA, undefined, { sensitivity: 'base', numeric: true });
      return cmp !== 0 ? cmp : (b.createdAt || 0) - (a.createdAt || 0);
    }
    case 'visits_desc': {
      const vA = a.visitCount ?? 1;
      const vB = b.visitCount ?? 1;
      const diff = vB - vA;
      return diff !== 0 ? diff : (b.createdAt || 0) - (a.createdAt || 0);
    }
    case 'visits_asc': {
      const vA = a.visitCount ?? 1;
      const vB = b.visitCount ?? 1;
      const diff = vA - vB;
      return diff !== 0 ? diff : (b.createdAt || 0) - (a.createdAt || 0);
    }
    case 'relevance':
    default: {
      const aIsTag = a.type === 'tag';
      const bIsTag = b.type === 'tag';
      if (aIsTag && !bIsTag) return -1;
      if (!aIsTag && bIsTag) return 1;
      if (b.score !== a.score) return b.score - a.score;
      return (b.createdAt || 0) - (a.createdAt || 0);
    }
  }
}

export function sortSearchResults(results: SearchResult[], sort: SearchSortOption): SearchResult[] {
  return [...results].sort((a, b) => compareSortableItems(a, b, sort));
}
