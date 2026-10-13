import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  upsertPage,
  addCustomIndex,
  updateCustomIndex,
  deleteCustomIndex,
  cleanupExpired,
  evictLRU,
  clearPagesByTag,
  countPagesByTag,
  clearDatabase,
  getIndexSnapshot,
  getLocalDbRevision,
} from '@/db/index';
import { rebuildIndex, search, getIndexedRevision } from '@/search/index';

describe('PageTraceDB operations and automatic MiniSearch synchronization', () => {
  beforeEach(async () => {
    await clearDatabase();
    const snap = await getIndexSnapshot();
    await rebuildIndex(snap.pages, snap.chunks, snap.media, snap.customIndexes, getLocalDbRevision());
  });

  it('upserts pages with deduplicated chunks/media, applies auto-tags, and updates search index incrementally', async () => {
    const prevRev = getLocalDbRevision();

    await upsertPage(
      'https://en.wikipedia.org/wiki/TypeScript/#overview',
      'TypeScript - Wikipedia',
      'https://en.wikipedia.org/favicon.ico',
      [
        { text: 'TypeScript is a strongly typed programming language.', selector: 'p:1', depth: 0 },
        { text: '  typescript is a strongly typed programming language. ', selector: 'p:2', depth: 0 },
      ],
      [
        {
          type: 'image',
          url: 'https://en.wikipedia.org/ts-logo.png',
          alt: 'TypeScript Logo',
          title: 'TS',
          filename: 'ts-logo.png',
          extension: 'png',
        },
      ],
    );

    expect(getLocalDbRevision()).toBeGreaterThan(prevRev);
    expect(getIndexedRevision()).toBe(getLocalDbRevision());

    const pages = await db.pages.toArray();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.url).toBe('https://en.wikipedia.org/wiki/TypeScript');
    expect(pages[0]?.tags).toContain('WIKI');

    const chunks = await db.text_chunks.toArray();
    expect(chunks).toHaveLength(1);

    // Search works immediately via incremental hook without manual rebuildIndex
    const results = search('strongly typed');
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe('https://en.wikipedia.org/wiki/TypeScript');
  });

  it('adds, updates, deduplicates, and deletes custom indexes while keeping search in sync', async () => {
    const first = await addCustomIndex({
      url: 'https://github.com/dexie/Dexie.js/',
      pageTitle: 'Dexie.js Repository',
      favicon: '',
      name: 'DEXIE_NOTE',
      text: 'Minimalistic wrapper for IndexedDB',
      note: 'Very helpful library for client storage',
      selector: 'h1',
    });
    expect(first.duplicate).toBe(false);
    expect(search('Minimalistic wrapper')).toHaveLength(1);
    expect(search('helpful library')).toHaveLength(1);
    expect(search('helpful library')[0]?.note).toBe('Very helpful library for client storage');

    const dup = await addCustomIndex({
      url: 'https://github.com/dexie/Dexie.js',
      pageTitle: 'Dexie.js Repository',
      favicon: '',
      name: 'OTHER_NAME',
      text: '  minimalistic wrapper for indexeddb ',
      selector: 'h1',
    });
    expect(dup.duplicate).toBe(true);
    expect(dup.id).toBe(first.id);

    const updated = await updateCustomIndex(first.id, {
      name: 'IDB_WRAPPER',
      text: 'Reactive IndexedDB storage library',
      note: 'Updated personal comment',
    });
    expect(updated.updated).toBe(true);
    expect(search('Minimalistic')).toHaveLength(0);
    expect(search('Reactive IndexedDB')).toHaveLength(1);
    expect(search('Updated personal comment')).toHaveLength(1);
    expect(search('Reactive IndexedDB')[0]?.note).toBe('Updated personal comment');

    await deleteCustomIndex(first.id);
    expect(search('Reactive IndexedDB')).toHaveLength(0);
  });

  it('cleans up expired pages by TTL and cascades deletions to chunks, media, and custom indexes', async () => {
    await upsertPage(
      'https://example.com/old',
      'Old Article',
      '',
      [{ text: 'Legacy content from last month', selector: 'p', depth: 0 }],
      [],
    );
    const oldPage = await db.pages.where('url').equals('https://example.com/old').first();
    expect(oldPage?.id).toBeDefined();

    // Backdate lastAccessedAt to 40 days ago
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await db.pages.update(oldPage!.id!, { lastAccessedAt: fortyDaysAgo });

    await cleanupExpired(30);

    expect(await db.pages.count()).toBe(0);
    expect(await db.text_chunks.count()).toBe(0);
    expect(search('Legacy content')).toHaveLength(0);
  });

  it('evicts least-recently-used pages when storage exceeds maxSizeMb', async () => {
    await upsertPage(
      'https://example.com/1',
      'Alpha Entry',
      '',
      [{ text: 'Alpha old entry', selector: 'p', depth: 0 }],
      [],
    );
    await upsertPage(
      'https://example.com/2',
      'Beta Entry',
      '',
      [{ text: 'Beta recent item', selector: 'p', depth: 0 }],
      [],
    );

    const p1 = await db.pages.where('url').equals('https://example.com/1').first();
    const p2 = await db.pages.where('url').equals('https://example.com/2').first();
    await db.pages.update(p1!.id!, { lastAccessedAt: 1000, sizeBytes: 2 * 1024 * 1024 });
    await db.pages.update(p2!.id!, { lastAccessedAt: 2000, sizeBytes: 2 * 1024 * 1024 });

    // Limit to 2.5 MB -> should evict p1 (oldest) and keep p2
    await evictLRU(2.5);

    expect(await db.pages.count()).toBe(1);
    expect(search('Alpha')).toHaveLength(0);
    expect(search('Beta')).toHaveLength(1);
  });

  it('counts and clears pages by tag accurately', async () => {
    await upsertPage(
      'https://github.com/org/repo',
      'GitHub Repo',
      '',
      [{ text: 'Repository readme text', selector: 'p', depth: 0 }],
      [],
    );
    expect(await countPagesByTag('DEV')).toBe(1);

    const deletedCount = await clearPagesByTag('DEV');
    expect(deletedCount).toBe(1);
    expect(await countPagesByTag('DEV')).toBe(0);
    expect(search('Repository readme')).toHaveLength(0);
  });

  it('does not clean up or evict pages belonging to pinned domains', async () => {
    await upsertPage(
      'https://github.com/torvalds/linux',
      'Linux Kernel',
      '',
      [{ text: 'Linux kernel source code', selector: 'p', depth: 0 }],
      [],
    );
    await upsertPage(
      'https://transient-blog.com/post',
      'Blog Post',
      '',
      [{ text: 'Temporary blog post', selector: 'p', depth: 0 }],
      [],
    );

    const linuxPage = await db.pages.where('url').equals('https://github.com/torvalds/linux').first();
    const blogPage = await db.pages.where('url').equals('https://transient-blog.com/post').first();

    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    await db.pages.update(linuxPage!.id!, { lastAccessedAt: fortyDaysAgo, sizeBytes: 2 * 1024 * 1024 });
    await db.pages.update(blogPage!.id!, { lastAccessedAt: fortyDaysAgo, sizeBytes: 2 * 1024 * 1024 });

    await cleanupExpired(30, ['github.com/*']);

    expect(await db.pages.where('url').equals('https://transient-blog.com/post').first()).toBeUndefined();
    expect(await db.pages.where('url').equals('https://github.com/torvalds/linux').first()).toBeDefined();
    expect(search('Linux kernel')).toHaveLength(1);
    expect(search('Temporary blog')).toHaveLength(0);

    await evictLRU(1, ['github.com/*']);
    expect(await db.pages.where('url').equals('https://github.com/torvalds/linux').first()).toBeDefined();
    expect(search('Linux kernel')).toHaveLength(1);
  });

  it('tracks and increments visitCount across repeated upsertPage calls', async () => {
    const url = 'https://example.com/docs';
    await upsertPage(url, 'Docs V1', '', [{ text: 'Initial documentation text', selector: 'p', depth: 0 }], []);

    let record = await db.pages.where('url').equals(url).first();
    expect(record?.visitCount).toBe(1);

    await upsertPage(url, 'Docs V2', '', [{ text: 'Updated documentation text', selector: 'p', depth: 0 }], []);
    record = await db.pages.where('url').equals(url).first();
    expect(record?.visitCount).toBe(2);

    await upsertPage(url, 'Docs V3', '', [{ text: 'Third revision documentation text', selector: 'p', depth: 0 }], []);
    record = await db.pages.where('url').equals(url).first();
    expect(record?.visitCount).toBe(3);
  });
});
