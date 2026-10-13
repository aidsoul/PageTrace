import { describe, it, expect, beforeEach } from 'vitest';
import {
  rebuildIndex,
  search,
  highlightSnippet,
  getIndexedCount,
  getAvailableTags,
  getAvailableDomains,
  upsertPageInIndex,
  upsertCustomIndexInSearch,
  removeCustomIndexesFromSearch,
  removePagesFromIndex,
  clearSearchIndex,
  serializeSearchIndex,
  hydrateSearchIndex,
  getIndexedRevision,
} from '@/search/index';
import type { PageRecord, TextChunk, MediaItem, CustomTagIndex } from '@/types/index';

describe('MiniSearch engine, incremental updates, and snapshot caching', () => {
  const samplePages: PageRecord[] = [
    {
      id: 1,
      url: 'https://developer.mozilla.org/en-US/docs/Web/IndexedDB',
      title: 'IndexedDB API Reference',
      favicon: '',
      createdAt: 1000,
      lastAccessedAt: 2000,
      sizeBytes: 512,
      tags: ['DOCS', 'DEV'],
    },
    {
      id: 2,
      url: 'https://ru.wikipedia.org/wiki/Браузер',
      title: 'Браузер — Википедия',
      favicon: '',
      createdAt: 1500,
      lastAccessedAt: 3000,
      sizeBytes: 512,
      tags: ['WIKI'],
    },
  ];

  const sampleChunks: TextChunk[] = [
    {
      id: 10,
      pageId: 1,
      text: 'IndexedDB is a low-level API for client-side storage of significant amounts of structured data.',
      selector: 'article > p:nth-of-type(1)',
      depth: 0,
      createdAt: 2000,
    },
    {
      id: 11,
      pageId: 2,
      text: 'Веб-браузер позволяет просматривать веб-страницы и выполнять полнотекстовый поиск.',
      selector: 'div.mw-parser-output > p',
      depth: 0,
      createdAt: 3000,
    },
  ];

  const sampleMedia: MediaItem[] = [
    {
      id: 20,
      pageId: 1,
      type: 'document',
      url: 'https://developer.mozilla.org/guide.pdf',
      alt: '',
      title: 'IndexedDB Architecture Diagram',
      filename: 'guide.pdf',
      extension: 'pdf',
      createdAt: 2000,
    },
  ];

  const sampleCustomIndexes: CustomTagIndex[] = [
    {
      id: 30,
      pageId: 1,
      url: 'https://developer.mozilla.org/en-US/docs/Web/IndexedDB',
      pageTitle: 'IndexedDB API Reference',
      favicon: '',
      name: 'STORAGE_TIP',
      text: 'Use transactions for atomic IndexedDB operations',
      note: 'Crucial for multi-table consistency',
      selector: 'blockquote',
      createdAt: 2500,
    },
  ];

  beforeEach(async () => {
    await rebuildIndex(samplePages, sampleChunks, sampleMedia, sampleCustomIndexes, 101);
  });

  it('indexes Latin and Cyrillic documents, prioritizes custom tags, and filters by operators', () => {
    expect(getIndexedCount()).toBe(4);
    expect(getIndexedRevision()).toBe(101);
    expect(getAvailableTags()).toEqual(['DEV', 'DOCS', 'STORAGE_TIP', 'WIKI']);

    const idbResults = search('IndexedDB');
    expect(idbResults.length).toBeGreaterThanOrEqual(2);
    expect(idbResults[0]?.type).toBe('tag');
    expect(idbResults[0]?.tagName).toBe('STORAGE_TIP');
    expect(idbResults[0]?.note).toBe('Crucial for multi-table consistency');

    const noteResults = search('consistency');
    expect(noteResults).toHaveLength(1);
    expect(noteResults[0]?.tagName).toBe('STORAGE_TIP');
    expect(noteResults[0]?.note).toBe('Crucial for multi-table consistency');

    const cyrillicResults = search('полнотекстовый поиск');
    expect(cyrillicResults).toHaveLength(1);
    expect(cyrillicResults[0]?.pageId).toBe(2);

    const mediaOnly = search('type:media');
    expect(mediaOnly).toHaveLength(1);
    expect(mediaOnly[0]?.type).toBe('media');

    const domainFiltered = search('site:wikipedia.org');
    expect(domainFiltered).toHaveLength(1);
    expect(domainFiltered[0]?.pageId).toBe(2);
  });

  it('supports incremental page and custom index updates without full rebuild', () => {
    const newPage: PageRecord = {
      id: 3,
      url: 'https://github.com/lucaong/minisearch',
      title: 'MiniSearch Documentation',
      favicon: '',
      createdAt: 4000,
      lastAccessedAt: 4000,
      sizeBytes: 256,
      tags: ['DEV'],
    };
    const newChunks: TextChunk[] = [
      {
        id: 12,
        pageId: 3,
        text: 'MiniSearch is a tiny but powerful in-memory fulltext search engine for JavaScript.',
        selector: 'p',
        depth: 0,
        createdAt: 4000,
      },
    ];

    upsertPageInIndex(newPage, newChunks, [], 102);
    expect(getIndexedCount()).toBe(5);
    expect(getIndexedRevision()).toBe(102);
    expect(search('fulltext search engine')).toHaveLength(1);

    // Update page 3 with new chunk text
    upsertPageInIndex(
      newPage,
      [
        {
          id: 13,
          pageId: 3,
          text: 'Updated chunk with incremental indexing support.',
          selector: 'p',
          depth: 0,
          createdAt: 4500,
        },
      ],
      [],
      103,
    );
    expect(search('fulltext search engine')).toHaveLength(0);
    expect(search('incremental indexing')).toHaveLength(1);

    // Upsert and remove a custom tag index incrementally
    upsertCustomIndexInSearch(
      {
        id: 31,
        pageId: 3,
        url: newPage.url,
        pageTitle: newPage.title,
        favicon: '',
        name: 'BOOKMARK',
        text: 'Fast serialization via toJSON and loadJSON',
        selector: 'code',
        createdAt: 5000,
      },
      newPage,
      104,
    );
    expect(search('loadJSON')).toHaveLength(1);

    removeCustomIndexesFromSearch([31], 105);
    expect(search('loadJSON')).toHaveLength(0);

    // Remove page 3 from index
    removePagesFromIndex([3], [], 106);
    expect(search('incremental indexing')).toHaveLength(0);
    expect(getIndexedCount()).toBe(4);
  });

  it('serializes and hydrates MiniSearch index snapshot accurately', () => {
    const snapshot = serializeSearchIndex(200);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.revision).toBe(200);

    clearSearchIndex(0);
    expect(getIndexedCount()).toBe(0);
    expect(search('IndexedDB')).toHaveLength(0);

    const hydrated = hydrateSearchIndex(snapshot);
    expect(hydrated).toBe(true);
    expect(getIndexedCount()).toBe(4);
    expect(getIndexedRevision()).toBe(200);

    const results = search('IndexedDB');
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]?.type).toBe('tag');
  });

  it('highlights matched terms and escapes untrusted HTML in snippets', () => {
    const snippet = highlightSnippet('Safe <b>HTML</b> & fast search engine', 'fast search');
    expect(snippet).toBe('Safe &lt;b&gt;HTML&lt;/b&gt; &amp; <mark>fast search</mark> engine');
  });

  it('extracts unique available domains from indexed pages', () => {
    const domains = getAvailableDomains();
    expect(domains).toContain('developer.mozilla.org');
    expect(domains).toContain('ru.wikipedia.org');
  });

  it('filters search results by date range using filter options and inline operators', () => {
    const resultsAfter = search('IndexedDB', { dateFrom: 2200 });
    expect(resultsAfter).toHaveLength(1);
    expect(resultsAfter[0]?.type).toBe('tag');
    expect(resultsAfter[0]?.createdAt).toBe(2500);

    const resultsBefore = search('IndexedDB', { dateTo: 2200, type: 'text' });
    expect(resultsBefore).toHaveLength(1);
    expect(resultsBefore[0]?.type).toBe('text');
    expect(resultsBefore[0]?.createdAt).toBe(2000);

    const resultsAllBefore = search('IndexedDB', { dateTo: 2200 });
    expect(resultsAllBefore).toHaveLength(2);

    const resultsOutRange = search('IndexedDB', { dateFrom: 5000 });
    expect(resultsOutRange).toHaveLength(0);
  });

  it('filters and sorts search results by visit count using options and inline operators', () => {
    upsertPageInIndex(
      {
        id: 3,
        url: 'https://example.com/popular',
        title: 'Popular IndexedDB Tutorial',
        favicon: '',
        createdAt: 4000,
        lastAccessedAt: 5000,
        sizeBytes: 1024,
        visitCount: 12,
      },
      [
        {
          id: 50,
          pageId: 3,
          text: 'Popular IndexedDB hands-on patterns and practices.',
          selector: 'main > p',
          depth: 0,
          createdAt: 4000,
        },
      ],
      [],
    );

    const results = search('IndexedDB');
    const popularResult = results.find((r) => r.pageId === 3);
    expect(popularResult?.visitCount).toBe(12);

    const minVisitsResults = search('IndexedDB', { minVisits: 5 });
    expect(minVisitsResults).toHaveLength(1);
    expect(minVisitsResults[0]?.pageId).toBe(3);

    const inlineVisitsResults = search('IndexedDB visits:>5');
    expect(inlineVisitsResults).toHaveLength(1);
    expect(inlineVisitsResults[0]?.pageId).toBe(3);

    const onceResults = search('IndexedDB visits:once');
    expect(onceResults.every((r) => r.visitCount === 1)).toBe(true);
    expect(onceResults.some((r) => r.pageId === 3)).toBe(false);

    const sortedDesc = search('IndexedDB', { sort: 'visits_desc' });
    expect(sortedDesc[0]?.pageId).toBe(3);
    expect(sortedDesc[0]?.visitCount).toBe(12);

    const sortedAsc = search('IndexedDB', { sort: 'visits_asc' });
    expect(sortedAsc[0]?.visitCount).toBe(1);
  });
});

