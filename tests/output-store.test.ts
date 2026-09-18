import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputStore } from '../src/output-store.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('OutputStore', () => {
  it('reads output in byte-sized pages with a stable cursor', async () => {
    const store = new OutputStore({ memoryBytes: 1024 });
    store.append('x', 'stdout', 'abcdef');
    store.append('x', 'stderr', '12');
    expect(await store.read('x', 0, 4)).toMatchObject({ nextCursor: 4, hasMore: true, truncated: false });
    expect((await store.read('x', 4, 10)).chunks.map((c) => c.data).join('')).toBe('ef12');
  });

  it('spills large output to disk without changing the read contract', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ssh-bridge-')); dirs.push(dir);
    const store = new OutputStore({ memoryBytes: 3, directory: dir });
    store.append('x', 'stdout', 'abcdef');
    expect((await store.read('x', 0, 6)).chunks[0].data).toBe('abcdef');
    expect((await store.read('x', 0, 6)).nextCursor).toBe(6);
  });

  it('reports truncation after the retention limit is exceeded', async () => {
    const store = new OutputStore({ memoryBytes: 3, spillToDisk: false });
    store.append('x', 'stdout', 'abcdef');
    expect(await store.read('x', 0, 10)).toMatchObject({ truncated: true, oldestCursor: 3 });
  });
});
