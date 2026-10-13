import Dexie, { type Table } from 'dexie';
import browser from 'webextension-polyfill';
import type { PageRecord, TextChunk, MediaItem, CustomTagIndex, AutoTagRule } from '@/types/index';
import { getSettings } from '@/common/settings';
import { matchUrlPattern, normalizeTagName } from '@/common/tags';
import { normalizePageUrl, normalizeIndexedText } from '@/common/search-utils';

export { normalizePageUrl, normalizeIndexedText };

export interface DbSearchSyncHooks {
  onPageUpserted?: (
    page: PageRecord,
    chunks: TextChunk[],
    media: MediaItem[],
    revision: number,
  ) => void;
  onCustomIndexUpserted?: (
    item: CustomTagIndex,
    page: PageRecord | undefined,
    revision: number,
  ) => void;
  onCustomIndexesDeleted?: (ids: number[], revision: number) => void;
  onPagesDeleted?: (pageIds: number[], customIndexIds: number[], revision: number) => void;
  onDatabaseCleared?: (revision: number) => void;
}

let searchSyncHooks: DbSearchSyncHooks | null = null;

export function setSearchSyncHooks(hooks: DbSearchSyncHooks | null): void {
  searchSyncHooks = hooks;
}

export class PageTraceDB extends Dexie {
  pages!: Table<PageRecord, number>;
  text_chunks!: Table<TextChunk, number>;
  media_items!: Table<MediaItem, number>;
  custom_indexes!: Table<CustomTagIndex, number>;

  constructor() {
    super('PageTraceDB');

    this.version(1).stores({
      pages: '++id, url, lastAccessedAt, createdAt, sizeBytes',
      text_chunks: '++id, pageId, depth, createdAt',
      media_items: '++id, pageId, type, extension, createdAt',
    });

    this.version(2).stores({
      custom_indexes: '++id, pageId, name, url, createdAt',
    });

    this.version(3).stores({
      pages: '++id, url, lastAccessedAt, createdAt, sizeBytes, *tags',
      custom_indexes: '++id, pageId, name, url, createdAt',
    });

    this.version(4)
      .stores({
        pages: '++id, url, lastAccessedAt, createdAt, sizeBytes, *tags, visitCount',
        custom_indexes: '++id, pageId, name, url, createdAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('pages')
          .toCollection()
          .modify((page: PageRecord) => {
            if (typeof page.visitCount !== 'number') {
              page.visitCount = 1;
            }
          });
      });
  }
}

export const db = new PageTraceDB();

// Track database revision timestamp in storage.local so search UIs can skip redundant index rebuilds
let localRevisionCounter = Date.now();

export function getLocalDbRevision(): number {
  return localRevisionCounter;
}

function bumpDbRevision(): number {
  const next = Date.now();
  localRevisionCounter = next > localRevisionCounter ? next : localRevisionCounter + 1;
  try {
    browser.storage.local.set({ pt_db_rev: localRevisionCounter }).catch(() => {});
  } catch {
    // Ignore if storage.local is unavailable
  }
  return localRevisionCounter;
}

function getMediaUniqueKey(m: Pick<MediaItem, 'type' | 'url' | 'title' | 'alt' | 'filename'>): string {
  if (m.url) {
    return `${m.type}:${normalizePageUrl(m.url).toLowerCase()}`;
  }
  return `${m.type}:${normalizeIndexedText(m.title || m.alt || m.filename)}`;
}

export async function deletePagesCascade(pageIds: number[]): Promise<void> {
  if (pageIds.length === 0) return;
  await db.transaction('rw', db.pages, db.text_chunks, db.media_items, db.custom_indexes, async () => {
    await db.text_chunks.where('pageId').anyOf(pageIds).delete();
    await db.media_items.where('pageId').anyOf(pageIds).delete();
    await db.custom_indexes.where('pageId').anyOf(pageIds).delete();
    await db.pages.bulkDelete(pageIds);
  });
}

export async function deletePageById(pageId: number): Promise<void> {
  const customIndexIds = (await db.custom_indexes.where('pageId').equals(pageId).primaryKeys()) as number[];
  await deletePagesCascade([pageId]);
  const rev = bumpDbRevision();
  searchSyncHooks?.onPagesDeleted?.([pageId], customIndexIds, rev);
}

export async function deletePageByUrl(url: string): Promise<void> {
  const cleanUrl = normalizePageUrl(url);
  const pages = await db.pages.where('url').equals(cleanUrl).toArray();
  const pageIds = pages.map((p) => p.id!).filter((id): id is number => id !== undefined);
  if (pageIds.length > 0) {
    const customIndexIds = (await db.custom_indexes.where('pageId').anyOf(pageIds).primaryKeys()) as number[];
    await deletePagesCascade(pageIds);
    const rev = bumpDbRevision();
    searchSyncHooks?.onPagesDeleted?.(pageIds, customIndexIds, rev);
  }
}

// Upsert a page and its chunks/media in one transaction, deduplicating items
export async function upsertPage(
  rawUrl: string,
  title: string,
  favicon: string,
  chunks: Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[],
  media: Omit<MediaItem, 'id' | 'pageId' | 'createdAt'>[],
): Promise<void> {
  const now = Date.now();
  const url = normalizePageUrl(rawUrl);

  const autoTags: string[] = [];
  try {
    const s = await getSettings();
    if (s.autoTagRules && s.autoTagRules.length > 0) {
      for (const rule of s.autoTagRules) {
        if (matchUrlPattern(rule.pattern, url)) {
          const norm = normalizeTagName(rule.tag);
          if (norm && !autoTags.includes(norm)) {
            autoTags.push(norm);
          }
        }
      }
    }
  } catch {}

  // Deduplicate incoming chunks by normalized text
  const uniqueChunks: Omit<TextChunk, 'id' | 'pageId' | 'createdAt'>[] = [];
  const seenChunkTexts = new Set<string>();
  for (const c of chunks) {
    const norm = normalizeIndexedText(c.text);
    if (!norm || seenChunkTexts.has(norm)) continue;
    seenChunkTexts.add(norm);
    uniqueChunks.push({ ...c, text: c.text.trim() });
  }

  // Deduplicate incoming media
  const uniqueMedia: Omit<MediaItem, 'id' | 'pageId' | 'createdAt'>[] = [];
  const seenMediaKeys = new Set<string>();
  for (const m of media) {
    const key = getMediaUniqueKey(m);
    if (!key || seenMediaKeys.has(key)) continue;
    seenMediaKeys.add(key);
    uniqueMedia.push(m);
  }

  const chunksBytes = uniqueChunks.reduce(
    (s, c) => s + (c.text.length + (c.selector?.length || 0)) * 2 + 32,
    0,
  );
  const mediaBytes = uniqueMedia.reduce(
    (s, m) =>
      s +
      ((m.url?.length || 0) +
        (m.alt?.length || 0) +
        (m.title?.length || 0) +
        (m.filename?.length || 0)) *
        2 +
      32,
    0,
  );
  const metaBytes =
    ((url.length || 0) + (title?.length || 0) + (favicon?.length || 0)) * 2 + 64;
  const totalSizeBytes = chunksBytes + mediaBytes + metaBytes;

  let savedPage!: PageRecord;
  let savedChunks: TextChunk[] = [];
  let savedMedia: MediaItem[] = [];

  await db.transaction('rw', db.pages, db.text_chunks, db.media_items, async () => {
    const existing =
      (await db.pages.where('url').equals(url).first()) ||
      (rawUrl !== url ? await db.pages.where('url').equals(rawUrl).first() : undefined);

    let pageId: number;

    if (existing && existing.id !== undefined) {
      pageId = existing.id;
      const mergedTags = Array.from(
        new Set([...(existing.tags || []).map(normalizeTagName), ...autoTags].filter(Boolean)),
      );
      const visitCount = (existing.visitCount ?? 1) + 1;

      savedPage = {
        id: pageId,
        url,
        title: title || existing.title,
        favicon: favicon || existing.favicon,
        createdAt: existing.createdAt,
        lastAccessedAt: now,
        sizeBytes: totalSizeBytes,
        tags: mergedTags,
        visitCount,
      };

      await db.pages.update(pageId, {
        url,
        title: savedPage.title,
        favicon: savedPage.favicon,
        lastAccessedAt: now,
        sizeBytes: totalSizeBytes,
        tags: mergedTags,
        visitCount,
      });

      await db.text_chunks.where('pageId').equals(pageId).delete();
      await db.media_items.where('pageId').equals(pageId).delete();
    } else {
      const visitCount = 1;
      pageId = (await db.pages.add({
        url,
        title,
        favicon,
        createdAt: now,
        lastAccessedAt: now,
        sizeBytes: totalSizeBytes,
        tags: autoTags,
        visitCount,
      })) as number;

      savedPage = {
        id: pageId,
        url,
        title,
        favicon,
        createdAt: now,
        lastAccessedAt: now,
        sizeBytes: totalSizeBytes,
        tags: autoTags,
        visitCount,
      };
    }

    if (uniqueChunks.length > 0) {
      const chunkRecords = uniqueChunks.map((c) => ({ ...c, pageId, createdAt: now }));
      const chunkIds = (await db.text_chunks.bulkAdd(chunkRecords, { allKeys: true })) as number[];
      savedChunks = chunkRecords.map((c, idx) => ({ ...c, id: chunkIds[idx] }));
    }

    if (uniqueMedia.length > 0) {
      const mediaRecords = uniqueMedia.map((m) => ({ ...m, pageId, createdAt: now }));
      const mediaIds = (await db.media_items.bulkAdd(mediaRecords, { allKeys: true })) as number[];
      savedMedia = mediaRecords.map((m, idx) => ({ ...m, id: mediaIds[idx] }));
    }
  });

  const rev = bumpDbRevision();
  searchSyncHooks?.onPageUpserted?.(savedPage, savedChunks, savedMedia, rev);
}

// Update lastAccessedAt when a page is opened from search results
export async function touchPageAccess(params: { pageId?: number; url?: string }): Promise<void> {
  const now = Date.now();
  if (params.pageId !== undefined) {
    await db.pages.update(params.pageId, { lastAccessedAt: now });
    return;
  }
  if (params.url) {
    const cleanUrl = normalizePageUrl(params.url);
    const page =
      (await db.pages.where('url').equals(cleanUrl).first()) ||
      (params.url !== cleanUrl ? await db.pages.where('url').equals(params.url).first() : undefined);
    if (page?.id !== undefined) {
      await db.pages.update(page.id, { lastAccessedAt: now });
    }
  }
}

export async function getIndexSnapshot(): Promise<{
  pages: PageRecord[];
  chunks: TextChunk[];
  media: MediaItem[];
  customIndexes: CustomTagIndex[];
}> {
  const [pages, chunks, media, customIndexes] = await Promise.all([
    db.pages.toArray(),
    db.text_chunks.toArray(),
    db.media_items.toArray(),
    db.custom_indexes.toArray(),
  ]);
  return { pages, chunks, media, customIndexes };
}

// Custom user-created indexes (bookmarks on selected text)
export interface CustomIndexResult {
  id: number;
  duplicate: boolean;
}

export async function addCustomIndex(item: {
  url: string;
  pageTitle: string;
  favicon: string;
  name: string;
  text: string;
  note?: string;
  selector: string;
}): Promise<CustomIndexResult> {
  const now = Date.now();
  const cleanUrl = normalizePageUrl(item.url);
  const trimmedText = item.text.trim();
  const finalName = item.name.trim() || trimmedText;
  const cleanNote = item.note?.trim() || undefined;

  const normText = normalizeIndexedText(trimmedText);
  const normName = normalizeIndexedText(finalName);

  let page =
    (await db.pages.where('url').equals(cleanUrl).first()) ||
    (item.url !== cleanUrl ? await db.pages.where('url').equals(item.url).first() : undefined);

  const pageCustomCandidates = await Promise.all([
    page?.id !== undefined ? db.custom_indexes.where('pageId').equals(page.id).toArray() : Promise.resolve([]),
    db.custom_indexes.where('url').equals(cleanUrl).toArray(),
  ]);
  const seenCandidateIds = new Set<number>();
  const candidates: CustomTagIndex[] = [];
  for (const list of pageCustomCandidates) {
    for (const ci of list) {
      if (ci.id !== undefined && !seenCandidateIds.has(ci.id)) {
        seenCandidateIds.add(ci.id);
        candidates.push(ci);
      }
    }
  }

  const duplicateIndex = candidates.find((ci) => {
    const ciNormText = normalizeIndexedText(ci.text);
    const ciNormName = normalizeIndexedText(ci.name);
    return (normText && ciNormText === normText) || (normName && ciNormName === normName);
  });

  if (duplicateIndex && duplicateIndex.id !== undefined) {
    return { id: duplicateIndex.id, duplicate: true };
  }

  let pageId: number;
  if (!page) {
    pageId = (await db.pages.add({
      url: cleanUrl,
      title: item.pageTitle || cleanUrl,
      favicon: item.favicon || '',
      createdAt: now,
      lastAccessedAt: now,
      sizeBytes: trimmedText.length * 2,
    })) as number;
    page = {
      id: pageId,
      url: cleanUrl,
      title: item.pageTitle || cleanUrl,
      favicon: item.favicon || '',
      createdAt: now,
      lastAccessedAt: now,
      sizeBytes: trimmedText.length * 2,
    };
  } else {
    pageId = page.id!;
    await db.pages.update(pageId, { lastAccessedAt: now });
  }

  const record: CustomTagIndex = {
    pageId,
    url: cleanUrl,
    pageTitle: item.pageTitle || cleanUrl,
    favicon: item.favicon || '',
    name: finalName,
    text: trimmedText,
    note: cleanNote,
    selector: item.selector || '',
    createdAt: now,
  };

  const id = (await db.custom_indexes.add(record)) as number;
  record.id = id;

  const rev = bumpDbRevision();
  searchSyncHooks?.onCustomIndexUpserted?.(record, page, rev);
  return { id, duplicate: false };
}

export async function deleteCustomIndex(id: number): Promise<void> {
  await db.custom_indexes.delete(id);
  const rev = bumpDbRevision();
  searchSyncHooks?.onCustomIndexesDeleted?.([id], rev);
}

export async function updateCustomIndex(
  id: number,
  changes: Partial<Pick<CustomTagIndex, 'name' | 'text' | 'note' | 'selector' | 'pageTitle' | 'url'>>,
): Promise<{ updated: boolean; duplicate: boolean }> {
  const existing = await db.custom_indexes.get(id);
  if (!existing) return { updated: false, duplicate: false };

  const nextText = changes.text !== undefined ? changes.text.trim() : existing.text;
  const nextName =
    changes.name !== undefined
      ? changes.name.trim() || nextText
      : existing.name;
  const nextUrl = changes.url !== undefined ? normalizePageUrl(changes.url) : normalizePageUrl(existing.url);
  const nextNote = changes.note !== undefined ? changes.note.trim() || undefined : existing.note;

  const normText = normalizeIndexedText(nextText);
  const normName = normalizeIndexedText(nextName);

  const [byPageId, byUrl] = await Promise.all([
    db.custom_indexes.where('pageId').equals(existing.pageId).toArray(),
    db.custom_indexes.where('url').equals(nextUrl).toArray(),
  ]);
  const candidates = [...byPageId, ...byUrl];

  const hasDuplicate = candidates.some((ci) => {
    if (ci.id === id) return false;
    const ciNormText = normalizeIndexedText(ci.text);
    const ciNormName = normalizeIndexedText(ci.name);
    return (normText && ciNormText === normText) || (normName && ciNormName === normName);
  });

  if (hasDuplicate) {
    return { updated: false, duplicate: true };
  }

  const updates: Partial<CustomTagIndex> = {
    name: nextName,
    text: nextText,
    note: nextNote,
  };
  if (changes.selector !== undefined) {
    updates.selector = changes.selector;
  }
  if (changes.pageTitle !== undefined) {
    updates.pageTitle = changes.pageTitle;
  }
  if (changes.url !== undefined) {
    updates.url = nextUrl;
  }

  await db.custom_indexes.update(id, updates);
  const page = await db.pages.get(existing.pageId);
  const updatedRecord: CustomTagIndex = { ...existing, ...updates, id };
  const rev = bumpDbRevision();
  searchSyncHooks?.onCustomIndexUpserted?.(updatedRecord, page, rev);
  return { updated: true, duplicate: false };
}

export async function getAllCustomIndexes(): Promise<CustomTagIndex[]> {
  return await db.custom_indexes.orderBy('createdAt').reverse().toArray();
}

function isUrlPinned(url: string, pinnedPatterns?: string[]): boolean {
  if (!url || !pinnedPatterns || pinnedPatterns.length === 0) return false;
  return pinnedPatterns.some((pattern) => matchUrlPattern(pattern, url));
}

// Delete records older than ttlDays, skipping pinned domains
export async function cleanupExpired(ttlDays: number, pinnedDomains?: string[]): Promise<void> {
  if (ttlDays === 0) return;
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

  let pinned = pinnedDomains;
  if (!pinned) {
    try {
      const s = await getSettings();
      pinned = s.pinnedDomains;
    } catch {
      pinned = [];
    }
  }

  const expiredPages = await db.pages
    .where('lastAccessedAt')
    .below(cutoff)
    .toArray();

  const expiredIds = expiredPages
    .filter((p) => p.id !== undefined && !isUrlPinned(p.url, pinned))
    .map((p) => p.id as number);

  if (expiredIds.length > 0) {
    await deletePagesCascade(expiredIds);
    const rev = bumpDbRevision();
    searchSyncHooks?.onPagesDeleted?.(expiredIds, [], rev);
  }
}

// Remove oldest unpinned pages if total size exceeds maxSizeMb
export async function evictLRU(maxSizeMb: number, pinnedDomains?: string[]): Promise<void> {
  const maxBytes = maxSizeMb * 1024 * 1024;
  const pages = await db.pages.orderBy('lastAccessedAt').toArray();
  let total = pages.reduce((s, p) => s + (p.sizeBytes ?? 0), 0);

  if (total <= maxBytes) return;

  let pinned = pinnedDomains;
  if (!pinned) {
    try {
      const s = await getSettings();
      pinned = s.pinnedDomains;
    } catch {
      pinned = [];
    }
  }

  const idsToEvict: number[] = [];
  for (const page of pages) {
    if (total <= maxBytes) break;
    if (page.id !== undefined) {
      if (isUrlPinned(page.url, pinned)) {
        continue;
      }
      idsToEvict.push(page.id);
      total -= page.sizeBytes ?? 0;
    }
  }

  if (idsToEvict.length > 0) {
    await deletePagesCascade(idsToEvict);
    const rev = bumpDbRevision();
    searchSyncHooks?.onPagesDeleted?.(idsToEvict, [], rev);
  }
}

// Get storage usage and record counts
export interface StorageStats {
  bytes: number;
  mb: number;
  pagesCount: number;
  chunksCount: number;
  mediaCount: number;
  indexesCount: number;
}

export async function getStorageStats(): Promise<StorageStats> {
  let bytes = 0;

  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (typeof estimate.usage === 'number' && estimate.usage > 0) {
        bytes = estimate.usage;
      }
    } catch {
      // Fallback below
    }
  }

  const [pagesCount, chunksCount, mediaCount, indexesCount] = await Promise.all([
    db.pages.count(),
    db.text_chunks.count(),
    db.media_items.count(),
    db.custom_indexes.count(),
  ]);

  if (bytes === 0 && (pagesCount > 0 || indexesCount > 0)) {
    const [pages, customIndexes] = await Promise.all([
      db.pages.toArray(),
      db.custom_indexes.toArray(),
    ]);

    for (const p of pages) {
      bytes += p.sizeBytes || (((p.url?.length || 0) + (p.title?.length || 0) + (p.favicon?.length || 0)) * 2 + 64);
    }
    for (const ci of customIndexes) {
      bytes += ((ci.name?.length || 0) + (ci.text?.length || 0) + (ci.url?.length || 0) + (ci.pageTitle?.length || 0) + (ci.selector?.length || 0)) * 2 + 32;
    }
  }

  return {
    bytes,
    mb: bytes / 1024 / 1024,
    pagesCount,
    chunksCount,
    mediaCount,
    indexesCount,
  };
}

export async function getUsedStorageMb(): Promise<number> {
  const stats = await getStorageStats();
  return stats.mb;
}

// Clear entire database
export async function clearDatabase(): Promise<void> {
  await db.transaction('rw', db.pages, db.text_chunks, db.media_items, db.custom_indexes, async () => {
    await db.text_chunks.clear();
    await db.media_items.clear();
    await db.custom_indexes.clear();
    await db.pages.clear();
  });
  const rev = bumpDbRevision();
  searchSyncHooks?.onDatabaseCleared?.(rev);
}

// Count pages per tag and delete pages by tag
export async function countPagesForAllTags(
  tagNames: string[],
  autoRules?: AutoTagRule[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const uniqueNormTags = Array.from(new Set(tagNames.map(normalizeTagName).filter(Boolean)));
  if (uniqueNormTags.length === 0) return result;

  let rules = autoRules;
  if (!rules) {
    try {
      const s = await getSettings();
      rules = s.autoTagRules || [];
    } catch {
      rules = [];
    }
  }

  const [pages, customIndexes] = await Promise.all([
    db.pages.toArray(),
    db.custom_indexes.toArray(),
  ]);

  // Group rules by normalized tag
  const rulesByTag = new Map<string, AutoTagRule[]>();
  for (const r of rules) {
    const nt = normalizeTagName(r.tag);
    if (!nt) continue;
    const arr = rulesByTag.get(nt) || [];
    arr.push(r);
    rulesByTag.set(nt, arr);
  }

  // Group custom index pageIds by normalized name
  const customPageIdsByTag = new Map<string, Set<number>>();
  for (const ci of customIndexes) {
    if (!ci.pageId) continue;
    const nt = normalizeTagName(ci.name);
    if (!nt) continue;
    let set = customPageIdsByTag.get(nt);
    if (!set) {
      set = new Set<number>();
      customPageIdsByTag.set(nt, set);
    }
    set.add(ci.pageId);
  }

  for (const norm of uniqueNormTags) {
    const matchedPageIds = new Set<number>(customPageIdsByTag.get(norm));
    const matchingRules = rulesByTag.get(norm) || [];

    for (const page of pages) {
      if (!page.id || matchedPageIds.has(page.id)) continue;
      if (page.tags?.some((t) => normalizeTagName(t) === norm)) {
        matchedPageIds.add(page.id);
        continue;
      }
      if (matchingRules.length > 0 && matchingRules.some((r) => matchUrlPattern(r.pattern, page.url))) {
        matchedPageIds.add(page.id);
      }
    }

    result.set(norm, matchedPageIds.size);
  }

  return result;
}

export async function countPagesByTag(tagName: string, autoRules?: AutoTagRule[]): Promise<number> {
  const norm = normalizeTagName(tagName);
  if (!norm) return 0;
  const counts = await countPagesForAllTags([norm], autoRules);
  return counts.get(norm) ?? 0;
}

export async function clearPagesByTag(tagName: string, autoRules?: AutoTagRule[]): Promise<number> {
  const norm = normalizeTagName(tagName);
  if (!norm) return 0;

  let rules = autoRules;
  if (!rules) {
    try {
      const s = await getSettings();
      rules = s.autoTagRules || [];
    } catch {
      rules = [];
    }
  }

  const matchingRules = rules.filter((r) => normalizeTagName(r.tag) === norm);
  const [pages, customIndexes] = await Promise.all([
    db.pages.toArray(),
    db.custom_indexes.toArray(),
  ]);

  const matchedPageIds = new Set<number>();

  for (const page of pages) {
    if (!page.id) continue;
    if (page.tags?.some((t) => normalizeTagName(t) === norm)) {
      matchedPageIds.add(page.id);
      continue;
    }
    if (matchingRules.some((r) => matchUrlPattern(r.pattern, page.url))) {
      matchedPageIds.add(page.id);
      continue;
    }
  }

  const customIndexIdsToDelete: number[] = [];
  for (const ci of customIndexes) {
    if (normalizeTagName(ci.name) === norm) {
      if (ci.pageId) matchedPageIds.add(ci.pageId);
      if (ci.id !== undefined) customIndexIdsToDelete.push(ci.id);
    }
  }

  const ids = Array.from(matchedPageIds);
  if (ids.length > 0) {
    await deletePagesCascade(ids);
  }

  if (customIndexIdsToDelete.length > 0) {
    await db.custom_indexes.bulkDelete(customIndexIdsToDelete);
  }

  if (ids.length > 0 || customIndexIdsToDelete.length > 0) {
    const rev = bumpDbRevision();
    searchSyncHooks?.onPagesDeleted?.(ids, customIndexIdsToDelete, rev);
  }

  return ids.length;
}
