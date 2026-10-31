// Native stream-based text compression using CompressionStream / DecompressionStream

export const isCompressionSupported =
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function compressText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function decompressText(data: Uint8Array): Promise<string> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return await new Response(stream).text();
}

export async function safeCompressText(text: string): Promise<Uint8Array | null> {
  if (!isCompressionSupported || text.length < 80) return null;
  try {
    return await compressText(text);
  } catch {
    return null;
  }
}

export async function safeDecompressText(data?: Uint8Array): Promise<string | null> {
  if (!data || !isCompressionSupported) return null;
  try {
    return await decompressText(data);
  } catch {
    return null;
  }
}

