import { createHash } from 'node:crypto';
import { images, largePng } from './helpers/image-fixtures.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './helpers/mcp-file-harness.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
let harness: Awaited<ReturnType<typeof startHarness>>;
beforeAll(async () => {
  harness = await startHarness();
  harness.files.set('/shot.png', { data: png });
  harness.files.set('/note.txt', { data: Buffer.from('abcdef') });
}, 20000);
afterAll(async () => { await harness?.close(); });

describe('file.read MCP image mode (real HTTP and SFTP)', () => {
  it('returns a native image content block instead of a JSON text blob', async () => {
    const result = await harness.call({ path: '/shot.png', format: 'image' });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  });

  it('preserves default base64 pagination for existing clients', async () => {
    const result = await harness.call({ path: '/note.txt', offset: 1, maxBytes: 3 });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      path: '/note.txt', offset: 1, nextOffset: 4, size: 6,
      hasMore: true, encoding: 'base64', data: Buffer.from('bcd').toString('base64')
    });
  });
});

describe('file.read image safety and compatibility', () => {
  it('advertises the image option without changing the default mode', async () => {
    const { tools } = await harness.rpc('tools/list');
    const tool = tools.find((item: { name: string }) => item.name === 'file.read');
    expect(tools).toHaveLength(13);
    expect(tool.inputSchema.properties.format).toMatchObject({ enum: ['base64', 'image'], default: 'base64' });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('does not duplicate the image payload in text content', async () => {
    const result = await harness.call({ path: '/shot.png', format: 'image' });
    const metadata = result.content.find((item: { type: string }) => item.type === 'text');
    expect(JSON.parse(metadata.text)).toEqual({ path: '/shot.png', size: png.length, mimeType: 'image/png' });
    expect(metadata.text).not.toContain(png.toString('base64'));
  });

  it('rejects an offset in image mode rather than returning partial image bytes', async () => {
    const result = await harness.call({ path: '/shot.png', format: 'image', offset: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/offset/i);
  });

  it('rejects maxBytes in image mode instead of silently returning a partial image', async () => {
    const result = await harness.call({ path: '/shot.png', format: 'image', maxBytes: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/maxBytes/);
  });

  it('rejects non-images even when the filename ends in .png', async () => {
    harness.files.set('/fake.png', { data: Buffer.from('not an image') });
    const result = await harness.call({ path: '/fake.png', format: 'image' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unsupported image/i);
  });

  it('rejects an oversized file before reading its contents', async () => {
    harness.files.set('/huge.png', { data: png, size: 5 * 1024 * 1024 + 1 });
    const reads = harness.metrics.read;
    const result = await harness.call({ path: '/huge.png', format: 'image' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/5242880/);
    expect(harness.metrics.read).toBe(reads);
  });

  it('rejects unexpected EOF rather than returning a truncated image', async () => {
    harness.files.set('/truncated.png', { data: png, size: png.length + 1 });
    const result = await harness.call({ path: '/truncated.png', format: 'image' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/EOF|changed|incomplete/i);
  });

  it.each([
    ['size', { afterSize: png.length + 1 }],
    ['mtime', { afterMtime: 1001 }]
  ])('rejects files whose %s changed during reading', async (_name, changes) => {
    harness.files.set('/changing.png', { data: png, ...changes });
    const result = await harness.call({ path: '/changing.png', format: 'image' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/changed/i);
  });

  it.each([
    ['empty', { data: Buffer.alloc(0) }],
    ['directory', { data: png, mode: 0o040755 }],
    ['read-failure', { data: png, readError: true }]
  ])('rejects %s and closes the opened SFTP handle', async (name, fixture) => {
    harness.files.set(`/${name}`, fixture);
    const result = await harness.call({ path: `/${name}`, format: 'image' });
    expect(result.isError).toBe(true);
    await expect.poll(() => harness.metrics.open - harness.metrics.close).toBe(0);
  });

  it('reports a missing file as a tool error', async () => {
    const result = await harness.call({ path: '/missing.png', format: 'image' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no such file/i);
  });

  it('keeps REST file reads as base64 JSON', async () => {
    const response = await fetch(`${harness.baseUrl}/api/files/content?server=test&path=%2Fnote.txt&maxBytes=2`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ encoding: 'base64', data: 'YWI=', nextOffset: 2, hasMore: true });
  });
});


describe('image content integrity', () => {
  it.each(Object.entries(images))('detects %s from content, without relying on the extension', async (mimeType, bytes) => {
    harness.files.set('/image-without-extension', { data: bytes });
    const result = await harness.call({ path: '/image-without-extension', format: 'image' });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual({ type: 'image', mimeType, data: bytes.toString('base64') });
  });

  it('reads a complete image over 1 MiB despite short SFTP reads', async () => {
    const bytes = largePng();
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    harness.files.set('/large.png', { data: bytes });
    const opened = harness.metrics.open;
    const result = await harness.call({ path: '/large.png', format: 'image' });
    expect(result.isError).not.toBe(true);
    const image = result.content.find((item: { type: string }) => item.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    const returned = Buffer.from(image.data, 'base64');
    expect(returned.length).toBe(bytes.length);
    const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    expect(hash(returned)).toBe(hash(bytes));
    expect(harness.metrics.open - opened).toBe(1);
    await expect.poll(() => harness.metrics.open - harness.metrics.close).toBe(0);
  }, 15000);
});
