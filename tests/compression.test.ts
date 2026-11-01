import { describe, it, expect } from 'vitest';
import {
  compressText,
  decompressText,
  safeCompressText,
  safeDecompressText,
  isCompressionSupported,
} from '@/common/compression';

describe('Native stream-based text compression', () => {
  it('correctly detects stream compression support in runtime', () => {
    expect(isCompressionSupported).toBe(true);
  });

  it('compresses and decompresses text losslessly', async () => {
    const original =
      'PageTrace is a privacy-first browser extension for local full-text search across visited web pages and bookmarks. ' +
      'It indexes headings, paragraphs, and media items directly in IndexedDB without sending any data to remote servers.';

    const compressed = await compressText(original);
    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(compressed.length).toBeLessThan(original.length);

    const decompressed = await decompressText(compressed);
    expect(decompressed).toBe(original);
  });

  it('safely handles short and empty texts without compressing when below threshold', async () => {
    const shortText = 'Short line';
    const result = await safeCompressText(shortText);
    expect(result).toBeNull();

    const emptyDecompressed = await safeDecompressText(undefined);
    expect(emptyDecompressed).toBeNull();
  });

  it('handles multi-byte unicode and cyrillic characters accurately', async () => {
    const cyrillic =
      'Локальный полнотекстовый поиск по страницам браузера с поддержкой тегов, цитат и быстрых хоткеев. ' +
      'Позволяет мгновенно находить ранее прочитанные статьи и фрагменты текста.';

    const compressed = await safeCompressText(cyrillic);
    expect(compressed).not.toBeNull();
    const decompressed = await safeDecompressText(compressed!);
    expect(decompressed).toBe(cyrillic);
  });
});

