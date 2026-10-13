import MiniSearch, { type Options as MiniSearchOptions } from 'minisearch';
import type {
  TextChunk,
  MediaItem,
  PageRecord,
  SearchResult,
  CustomTagIndex,
  SearchFilterOptions,
  SearchTypeFilter,
  SearchSortOption,
} from '@/types/index';
import { normalizeTagName, matchUrlPattern } from '@/common/tags';
import {
  extractHostnameLower,
  normalizeIndexedText,
  parseSearchQuery,
  compareSortableItems,
  sortSearchResults,
  extractInlineOperators,
  toggleInlineOperatorToken,
  TYPE_ALIASES,
  SORT_ALIASES,
  groupResultsByPage,
  formatMarkdownQuote,
  getAutocompleteTokenInfo,
  generateSearchSuggestions,
  applySuggestionToQuery,
  type ParsedSearchQuery,
  type SortableItem,
  type GroupedSearchResult,
  type SearchSuggestionItem,
  type AutocompleteTokenInfo,
} from '@/common/search-utils';
import { setSearchSyncHooks } from '@/db/index';

export {
  parseSearchQuery,
  compareSortableItems,
  sortSearchResults,
  extractInlineOperators,
  toggleInlineOperatorToken,
  groupResultsByPage,
  formatMarkdownQuote,
  getAutocompleteTokenInfo,
  generateSearchSuggestions,
  applySuggestionToQuery,
  TYPE_ALIASES,
  SORT_ALIASES,
  type ParsedSearchQuery,
  type SortableItem,
  type GroupedSearchResult,
  type SearchSuggestionItem,
  type AutocompleteTokenInfo,
};

// In-memory search index built from DB records

export interface SearchDoc {
  id: string;
  numericId: number;
  pageId: number;
  url: string;
  hostnameLower: string;
  urlLower: string;
  title: string;
  favicon: string;
  text: string;
  /** Optional user note or comment */
  note?: string;
  selector: string;
  type: 'text' | 'media' | 'tag';
  tagName?: string;
  tagNameLower: string;
  normTags: string[];
  tags?: string[];
  createdAt?: number;
  visitCount?: number;
}

export interface SerializedSearchIndexSnapshot {
  version: 1;
  revision: number;
  indexJson: string;
  docs: SearchDoc[];
}

let searchIndex: MiniSearch<SearchDoc> | null = null;
let allSearchDocs: SearchDoc[] = [];
let indexedDocCount = 0;
let indexedRevision = -1;

function getMiniSearchOptions(): MiniSearchOptions<SearchDoc> {
  return {
    fields: ['tagName', 'text', 'title', 'note'],
    storeFields: [
      'numericId',
      'pageId',
      'url',
      'hostnameLower',
      'urlLower',
      'title',
      'favicon',
      'text',
      'note',
      'selector',
      'type',
      'tagName',
      'tagNameLower',
      'normTags',
      'tags',
      'createdAt',
      'visitCount',
    ],
    searchOptions: {
      fuzzy: 0.2,
      prefix: true,
      boost: { tagName: 10.0, title: 2.0, note: 1.5 },
    },
    tokenize: (text) => {
      // Split words for both Cyrillic and Latin text
      return text.toLowerCase().split(/[\s\-_.,;:!?()[\]{}'"«»]+/u).filter(Boolean);
    },
    processTerm: (term) => term.toLowerCase(),
  };
}

function buildIndex(): MiniSearch<SearchDoc> {
  return new MiniSearch<SearchDoc>(getMiniSearchOptions());
}

export function isIndexInitialized(): boolean {
  return searchIndex !== null;
}

export function getIndexedRevision(): number {
  return indexedRevision;
}

export function setIndexedRevision(revision: number): void {
  indexedRevision = revision;
}

export function getIndex(): MiniSearch<SearchDoc> {
  if (!searchIndex) searchIndex = buildIndex();
  return searchIndex;
}

export function getIndexedCount(): number {
  return indexedDocCount;
}

// Return unique normalized tags present across all indexed documents
export function getAvailableTags(): string[] {
  const tagSet = new Set<string>();
  for (const doc of allSearchDocs) {
    for (const t of doc.normTags) {
      tagSet.add(t);
    }
  }
  return Array.from(tagSet).sort();
}

// Return unique lowercased hostnames present across all indexed documents
export function getAvailableDomains(): string[] {
  const domainSet = new Set<string>();
  for (const doc of allSearchDocs) {
    if (doc.hostnameLower) {
      domainSet.add(doc.hostnameLower);
    }
  }
  return Array.from(domainSet).sort();
}

function buildCustomTagDoc(tag: CustomTagIndex, page?: PageRecord): SearchDoc {
  const url = tag.url || page?.url || '';
  const pageTags = page?.tags || [];
  const allTags = tag.name ? Array.from(new Set([tag.name, ...pageTags])) : pageTags;
  const normTags = Array.from(new Set(allTags.map(normalizeTagName).filter(Boolean)));

  return {
    id: `tag:${tag.id}`,
    numericId: tag.id!,
    pageId: tag.pageId,
    url,
    hostnameLower: extractHostnameLower(url),
    urlLower: url.toLowerCase(),
    title: tag.pageTitle || page?.title || '',
    favicon: tag.favicon || page?.favicon || '',
    text: tag.text,
    note: tag.note || undefined,
    selector: tag.selector,
    type: 'tag',
    tagName: tag.name,
    tagNameLower: (tag.name || '').toLowerCase(),
    normTags,
    tags: allTags,
    createdAt: tag.createdAt || page?.lastAccessedAt || page?.createdAt,
    visitCount: page?.visitCount ?? 1,
  };
}

function buildPageChunkAndMediaDocs(
  page: PageRecord,
  chunks: TextChunk[],
  media: MediaItem[],
): SearchDoc[] {
  const docs: SearchDoc[] = [];
  if (page.id === undefined) return docs;

  const hostnameLower = extractHostnameLower(page.url);
  const urlLower = page.url.toLowerCase();
  const normTags = Array.from(new Set((page.tags || []).map(normalizeTagName).filter(Boolean)));
  const pageCreatedAt = page.lastAccessedAt || page.createdAt;
  const pageVisitCount = page.visitCount ?? 1;

  const seenText = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.id === undefined) continue;
    const key = `${page.url}|${normalizeIndexedText(chunk.text)}`;
    if (seenText.has(key)) continue;
    seenText.add(key);

    docs.push({
      id: `text:${chunk.id}`,
      numericId: chunk.id,
      pageId: page.id,
      url: page.url,
      hostnameLower,
      urlLower,
      title: page.title,
      favicon: page.favicon,
      text: chunk.text,
      selector: chunk.selector,
      type: 'text',
      tagNameLower: '',
      normTags,
      tags: page.tags || [],
      createdAt: pageCreatedAt,
      visitCount: pageVisitCount,
    });
  }

  const seenMedia = new Set<string>();
  for (const item of media) {
    if (item.id === undefined) continue;
    const label = [item.alt, item.title, item.filename].filter(Boolean).join(' ');
    const mediaText = label || item.url;
    const key = `${page.url}|${normalizeIndexedText(item.url || mediaText)}`;
    if (seenMedia.has(key)) continue;
    seenMedia.add(key);

    docs.push({
      id: `media:${item.id}`,
      numericId: item.id,
      pageId: page.id,
      url: page.url,
      hostnameLower,
      urlLower,
      title: page.title,
      favicon: page.favicon,
      text: mediaText,
      selector: item.url,
      type: 'media',
      tagNameLower: '',
      normTags,
      tags: page.tags || [],
      createdAt: pageCreatedAt,
      visitCount: pageVisitCount,
    });
  }

  return docs;
}

// Rebuild search index from database records
export async function rebuildIndex(
  pages: PageRecord[],
  chunks: TextChunk[],
  media: MediaItem[],
  customIndexes: CustomTagIndex[] = [],
  revision?: number,
): Promise<void> {
  const idx = buildIndex();
  const docs: SearchDoc[] = [];

  const pageMap = new Map(pages.map((p) => [p.id!, p]));
  const pageHostnameMap = new Map<number, { hostnameLower: string; urlLower: string; normTags: string[] }>();

  for (const p of pages) {
    if (p.id !== undefined) {
      const normTags = Array.from(new Set((p.tags || []).map(normalizeTagName).filter(Boolean)));
      pageHostnameMap.set(p.id, {
        hostnameLower: extractHostnameLower(p.url),
        urlLower: p.url.toLowerCase(),
        normTags,
      });
    }
  }

  const seenTextPerPage = new Set<string>();
  const seenMediaPerPage = new Set<string>();
  const seenTagPerPage = new Set<string>();

  for (const tag of customIndexes) {
    if (tag.id === undefined) continue;
    const page = pageMap.get(tag.pageId);
    const url = tag.url || page?.url || '';
    const key = `${url}|${normalizeIndexedText(tag.name)}|${normalizeIndexedText(tag.text)}`;
    if (seenTagPerPage.has(key)) continue;
    seenTagPerPage.add(key);

    docs.push(buildCustomTagDoc(tag, page));
  }

  for (const chunk of chunks) {
    if (chunk.id === undefined) continue;
    const page = pageMap.get(chunk.pageId);
    if (!page) continue;
    const key = `${page.url}|${normalizeIndexedText(chunk.text)}`;
    if (seenTextPerPage.has(key)) continue;
    seenTextPerPage.add(key);

    const pageMeta = pageHostnameMap.get(chunk.pageId);
    docs.push({
      id: `text:${chunk.id}`,
      numericId: chunk.id,
      pageId: chunk.pageId,
      url: page.url,
      hostnameLower: pageMeta?.hostnameLower ?? extractHostnameLower(page.url),
      urlLower: pageMeta?.urlLower ?? page.url.toLowerCase(),
      title: page.title,
      favicon: page.favicon,
      text: chunk.text,
      selector: chunk.selector,
      type: 'text',
      tagNameLower: '',
      normTags: pageMeta?.normTags ?? [],
      tags: page.tags || [],
      createdAt: page.lastAccessedAt || page.createdAt,
      visitCount: page.visitCount ?? 1,
    });
  }

  for (const item of media) {
    if (item.id === undefined) continue;
    const page = pageMap.get(item.pageId);
    if (!page) continue;
    const label = [item.alt, item.title, item.filename].filter(Boolean).join(' ');
    const mediaText = label || item.url;
    const key = `${page.url}|${normalizeIndexedText(item.url || mediaText)}`;
    if (seenMediaPerPage.has(key)) continue;
    seenMediaPerPage.add(key);

    const pageMeta = pageHostnameMap.get(item.pageId);
    docs.push({
      id: `media:${item.id}`,
      numericId: item.id,
      pageId: item.pageId,
      url: page.url,
      hostnameLower: pageMeta?.hostnameLower ?? extractHostnameLower(page.url),
      urlLower: pageMeta?.urlLower ?? page.url.toLowerCase(),
      title: page.title,
      favicon: page.favicon,
      text: mediaText,
      selector: item.url,
      type: 'media',
      tagNameLower: '',
      normTags: pageMeta?.normTags ?? [],
      tags: page.tags || [],
      createdAt: page.lastAccessedAt || page.createdAt,
      visitCount: page.visitCount ?? 1,
    });
  }

  if (docs.length > 0) {
    idx.addAll(docs);
  }

  searchIndex = idx;
  allSearchDocs = docs;
  indexedDocCount = docs.length;
  if (revision !== undefined) {
    indexedRevision = revision;
  }
}

// Incremental index operations

export function upsertPageInIndex(
  page: PageRecord,
  chunks: TextChunk[],
  media: MediaItem[],
  revision?: number,
): void {
  if (!searchIndex || page.id === undefined) return;

  const pageId = page.id;
  const pageTags = page.tags || [];
  const remainingDocs: SearchDoc[] = [];

  for (const doc of allSearchDocs) {
    if (doc.pageId === pageId) {
      if (doc.type === 'text' || doc.type === 'media') {
        if (searchIndex.has(doc.id)) {
          searchIndex.discard(doc.id);
        }
        continue;
      }
      if (doc.type === 'tag') {
        const allTags = doc.tagName ? Array.from(new Set([doc.tagName, ...pageTags])) : pageTags;
        const normTags = Array.from(new Set(allTags.map(normalizeTagName).filter(Boolean)));
        const updatedTagDoc: SearchDoc = {
          ...doc,
          title: doc.title || page.title,
          favicon: doc.favicon || page.favicon,
          tags: allTags,
          normTags,
          visitCount: page.visitCount ?? doc.visitCount ?? 1,
        };
        if (searchIndex.has(doc.id)) {
          searchIndex.replace(updatedTagDoc);
        } else {
          searchIndex.add(updatedTagDoc);
        }
        remainingDocs.push(updatedTagDoc);
        continue;
      }
    }
    remainingDocs.push(doc);
  }

  const newPageDocs = buildPageChunkAndMediaDocs(page, chunks, media);
  for (const doc of newPageDocs) {
    if (searchIndex.has(doc.id)) {
      searchIndex.replace(doc);
    } else {
      searchIndex.add(doc);
    }
    remainingDocs.push(doc);
  }

  allSearchDocs = remainingDocs;
  indexedDocCount = allSearchDocs.length;
  if (revision !== undefined) {
    indexedRevision = revision;
  }
}

export function upsertCustomIndexInSearch(
  tag: CustomTagIndex,
  page?: PageRecord,
  revision?: number,
): void {
  if (!searchIndex || tag.id === undefined) return;

  const doc = buildCustomTagDoc(tag, page);
  if (searchIndex.has(doc.id)) {
    searchIndex.replace(doc);
  } else {
    searchIndex.add(doc);
  }

  const existingIdx = allSearchDocs.findIndex((d) => d.id === doc.id);
  if (existingIdx >= 0) {
    allSearchDocs[existingIdx] = doc;
  } else {
    allSearchDocs.push(doc);
  }
  indexedDocCount = allSearchDocs.length;
  if (revision !== undefined) {
    indexedRevision = revision;
  }
}

export function removeCustomIndexesFromSearch(tagIds: number[], revision?: number): void {
  if (!searchIndex || tagIds.length === 0) return;

  const docIdsToRemove = new Set(tagIds.map((id) => `tag:${id}`));
  for (const docId of docIdsToRemove) {
    if (searchIndex.has(docId)) {
      searchIndex.discard(docId);
    }
  }

  allSearchDocs = allSearchDocs.filter((d) => !docIdsToRemove.has(d.id));
  indexedDocCount = allSearchDocs.length;
  if (revision !== undefined) {
    indexedRevision = revision;
  }
}

export function removePagesFromIndex(
  pageIds: number[],
  extraTagIds: number[] = [],
  revision?: number,
): void {
  if (!searchIndex) return;
  if (pageIds.length === 0 && extraTagIds.length === 0) return;

  const pageIdSet = new Set(pageIds);
  const extraTagDocIds = new Set(extraTagIds.map((id) => `tag:${id}`));
  const remainingDocs: SearchDoc[] = [];

  for (const doc of allSearchDocs) {
    if (pageIdSet.has(doc.pageId) || extraTagDocIds.has(doc.id)) {
      if (searchIndex.has(doc.id)) {
        searchIndex.discard(doc.id);
      }
    } else {
      remainingDocs.push(doc);
    }
  }

  allSearchDocs = remainingDocs;
  indexedDocCount = allSearchDocs.length;
  if (revision !== undefined) {
    indexedRevision = revision;
  }
}

export function clearSearchIndex(revision?: number): void {
  searchIndex = buildIndex();
  allSearchDocs = [];
  indexedDocCount = 0;
  if (revision !== undefined) {
    indexedRevision = revision;
  }
}

// Serialized index snapshot caching (toJSON / loadJSON)

export function serializeSearchIndex(revision = indexedRevision): SerializedSearchIndexSnapshot | null {
  if (!searchIndex) return null;
  return {
    version: 1,
    revision,
    indexJson: JSON.stringify(searchIndex.toJSON()),
    docs: allSearchDocs,
  };
}

export function hydrateSearchIndex(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const candidate = snapshot as Partial<SerializedSearchIndexSnapshot>;
  if (
    candidate.version !== 1 ||
    typeof candidate.indexJson !== 'string' ||
    !Array.isArray(candidate.docs)
  ) {
    return false;
  }

  try {
    const loaded = MiniSearch.loadJSON<SearchDoc>(candidate.indexJson, getMiniSearchOptions());
    searchIndex = loaded;
    allSearchDocs = candidate.docs;
    indexedDocCount = candidate.docs.length;
    if (typeof candidate.revision === 'number') {
      indexedRevision = candidate.revision;
    }
    return true;
  } catch {
    return false;
  }
}

// Register automatic incremental sync hooks with database layer
setSearchSyncHooks({
  onPageUpserted: (page, chunks, media, revision) => {
    upsertPageInIndex(page, chunks, media, revision);
  },
  onCustomIndexUpserted: (item, page, revision) => {
    upsertCustomIndexInSearch(item, page, revision);
  },
  onCustomIndexesDeleted: (ids, revision) => {
    removeCustomIndexesFromSearch(ids, revision);
  },
  onPagesDeleted: (pageIds, customIndexIds, revision) => {
    removePagesFromIndex(pageIds, customIndexIds, revision);
  },
  onDatabaseCleared: (revision) => {
    if (searchIndex) {
      clearSearchIndex(revision);
    }
  },
});

// Check if a document matches type, tag, domain, date, and visit count filters
function matchesFilters(
  doc: Pick<
    SearchDoc,
    'type' | 'url' | 'hostnameLower' | 'urlLower' | 'tagNameLower' | 'normTags' | 'createdAt' | 'visitCount'
  >,
  effectiveType: SearchTypeFilter,
  effectiveTags: string[],
  effectiveDomain?: string,
  effectiveDateFrom?: number,
  effectiveDateTo?: number,
  effectiveMinVisits?: number,
  effectiveMaxVisits?: number,
): boolean {
  if (effectiveType && effectiveType !== 'all') {
    if (doc.type !== effectiveType) return false;
  }

  if (effectiveTags.length > 0) {
    const docNormTags = doc.normTags || [];
    const rawTagLower = doc.tagNameLower || '';
    for (const reqTag of effectiveTags) {
      const hasExact = docNormTags.includes(reqTag);
      const hasCustomNameMatch = rawTagLower ? rawTagLower.includes(reqTag.toLowerCase()) : false;
      if (!hasExact && !hasCustomNameMatch) {
        return false;
      }
    }
  }

  if (effectiveDomain) {
    const domQuery = effectiveDomain.toLowerCase();
    const hostLower = doc.hostnameLower || '';
    const urlLower = doc.urlLower || '';
    const matched =
      hostLower.includes(domQuery) ||
      urlLower.includes(domQuery) ||
      (domQuery.includes('*') && matchUrlPattern(domQuery, doc.url));
    if (!matched) return false;
  }

  if (effectiveDateFrom !== undefined) {
    if (!doc.createdAt || doc.createdAt < effectiveDateFrom) return false;
  }

  if (effectiveDateTo !== undefined) {
    if (!doc.createdAt || doc.createdAt > effectiveDateTo) return false;
  }

  const visits = doc.visitCount ?? 1;
  if (effectiveMinVisits !== undefined && visits < effectiveMinVisits) {
    return false;
  }

  if (effectiveMaxVisits !== undefined && visits > effectiveMaxVisits) {
    return false;
  }

  return true;
}

// Run search query and return scored, highlighted results
export function search(
  query: string,
  limitOrOptions?: number | SearchFilterOptions,
  filterOptions?: SearchFilterOptions,
): SearchResult[] {
  if (!searchIndex) return [];

  const limit = typeof limitOrOptions === 'number' ? limitOrOptions : 50;
  const options =
    typeof limitOrOptions === 'object' && limitOrOptions !== null
      ? limitOrOptions
      : filterOptions;

  const parsed = parseSearchQuery(query);
  const textQuery = parsed.textQuery.trim();

  // Merge UI filters with inline query operators
  const effectiveType: SearchTypeFilter =
    options?.type && options.type !== 'all'
      ? options.type
      : parsed.type || 'all';

  const effectiveTags = Array.from(
    new Set([
      ...(options?.tags || []).map(normalizeTagName),
      ...parsed.tags.map(normalizeTagName),
    ].filter(Boolean)),
  );

  const effectiveDomain = options?.domain?.trim() || parsed.domain;

  const effectiveSort: SearchSortOption =
    options?.sort && options.sort !== 'relevance'
      ? options.sort
      : parsed.sort || options?.sort || 'relevance';

  const effectiveDateFrom = options?.dateFrom ?? parsed.dateFrom;
  const effectiveDateTo = options?.dateTo ?? parsed.dateTo;
  const effectiveMinVisits = options?.minVisits ?? parsed.minVisits;
  const effectiveMaxVisits = options?.maxVisits ?? parsed.maxVisits;

  const hasMatchFilters =
    effectiveType !== 'all' ||
    effectiveTags.length > 0 ||
    Boolean(effectiveDomain) ||
    effectiveDateFrom !== undefined ||
    effectiveDateTo !== undefined ||
    effectiveMinVisits !== undefined ||
    effectiveMaxVisits !== undefined;

  if (!textQuery && !hasMatchFilters && effectiveSort === 'relevance') {
    return [];
  }

  let candidates: Array<SearchDoc & { score: number }> = [];

  if (textQuery) {
    const filterFn = hasMatchFilters
      ? (result: unknown) =>
          matchesFilters(
            result as SearchDoc,
            effectiveType,
            effectiveTags,
            effectiveDomain,
            effectiveDateFrom,
            effectiveDateTo,
            effectiveMinVisits,
            effectiveMaxVisits,
          )
      : undefined;

    let raw = searchIndex.search(textQuery, {
      fuzzy: 0.2,
      prefix: true,
      combineWith: 'AND',
      boost: { tagName: 10.0, title: 2.0 },
      ...(filterFn ? { filter: filterFn } : {}),
    });

    // Fall back to OR if strict AND yields no results
    if (raw.length === 0) {
      raw = searchIndex.search(textQuery, {
        fuzzy: 0.2,
        prefix: true,
        combineWith: 'OR',
        boost: { tagName: 10.0, title: 2.0 },
        ...(filterFn ? { filter: filterFn } : {}),
      });
    }

    candidates = raw as unknown as Array<SearchDoc & { score: number }>;
  } else {
    // Filter-only or sort-only browse mode
    candidates = allSearchDocs
      .filter((doc) =>
        matchesFilters(
          doc,
          effectiveType,
          effectiveTags,
          effectiveDomain,
          effectiveDateFrom,
          effectiveDateTo,
          effectiveMinVisits,
          effectiveMaxVisits,
        ),
      )
      .map((doc) => ({
        ...doc,
        score: (doc.createdAt || 0) / 1e12,
      }));
  }

  const sorted = candidates.sort((a, b) => compareSortableItems(a, b, effectiveSort));

  const seenResultKey = new Set<string>();
  const uniqueResults: typeof sorted = [];
  for (const r of sorted) {
    const normText = ((r.text as string) || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const key = `${r.type}:${r.url}:${normText}`;
    if (seenResultKey.has(key)) continue;
    seenResultKey.add(key);
    uniqueResults.push(r);
    if (uniqueResults.length >= limit) break;
  }

  return uniqueResults.map((r) => {
    const rawText = r.text as string;
    const tagName = r.tagName as string | undefined;
    const note = r.note as string | undefined;
    const notePart = note ? ` [${note}]` : '';
    const displaySource =
      r.type === 'tag' && tagName && tagName !== rawText
        ? `${tagName} — ${rawText}${notePart}`
        : `${rawText}${notePart}`;

    return {
      id: r.numericId as number,
      pageId: r.pageId as number,
      url: r.url as string,
      title: r.title as string,
      favicon: r.favicon as string,
      text: rawText,
      note,
      selector: r.selector as string,
      type: r.type as 'text' | 'media' | 'tag',
      tagName,
      tags: r.tags as string[] | undefined,
      createdAt: r.createdAt as number | undefined,
      visitCount: (r.visitCount as number | undefined) ?? 1,
      snippet: highlightSnippet(displaySource, textQuery),
      score: r.type === 'tag' ? r.score + 10000 : r.score,
    };
  });
}

// Wrap matched query terms in <mark> tags
function escapeSnippetHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

export function highlightSnippet(text: string, query: string, contextChars = 120): string {
  if (!text) return '';

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (!terms.length) {
    const raw = text.slice(0, contextChars * 2);
    return escapeSnippetHtml(raw) + (text.length > contextChars * 2 ? '…' : '');
  }

  // Sort terms by length descending to match longest terms first
  const sortedTerms = [...terms].sort((a, b) => b.length - a.length);

  // Group terms so adjacent words form a single continuous match
  const termGroup = `(?:${sortedTerms.join('|')})`;
  const mergePattern = new RegExp(`(${termGroup}+(?:\\s+${termGroup}+)*)`, 'giu');

  // Position excerpt context window around first match
  const firstMatch = mergePattern.exec(text);
  mergePattern.lastIndex = 0;

  let excerpt = text;
  if (firstMatch) {
    const start = Math.max(0, firstMatch.index - contextChars);
    const end = Math.min(text.length, firstMatch.index + firstMatch[0].length + contextChars);
    excerpt = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  } else {
    excerpt = text.slice(0, contextChars * 2) + (text.length > contextChars * 2 ? '…' : '');
  }

  let html = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mergePattern.exec(excerpt)) !== null) {
    const matchStart = match.index;
    const matchEnd = mergePattern.lastIndex;
    const matchText = match[0];

    if (matchStart > lastIndex) {
      html += escapeSnippetHtml(excerpt.slice(lastIndex, matchStart));
    }

    html += `<mark>${escapeSnippetHtml(matchText)}</mark>`;
    lastIndex = matchEnd;
  }

  if (lastIndex < excerpt.length) {
    html += escapeSnippetHtml(excerpt.slice(lastIndex));
  }

  // Merge adjacent marks
  html = html.replace(/<\/mark>(\s*)<mark>/gi, '$1');

  return html;
}
