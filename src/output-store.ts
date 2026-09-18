import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export type OutputChunk = { cursor: number; stream: 'stdout' | 'stderr' | 'terminal'; data: string; timestamp: string };
type Record = OutputChunk & { end: number };
type Session = { next: number; oldest: number; bytes: number; chunks: Record[]; file?: string };
export type OutputRead = { chunks: OutputChunk[]; nextCursor: number; hasMore: boolean; truncated: boolean; oldestCursor: number };

export class OutputStore {
  private readonly sessions = new Map<string, Session>();
  private readonly memoryBytes: number;
  private readonly directory: string;
  private readonly spillToDisk: boolean;
  constructor(options: { memoryBytes?: number; directory?: string; spillToDisk?: boolean } = {}) {
    this.memoryBytes = options.memoryBytes ?? 1024 * 1024;
    this.directory = options.directory ?? join(process.env.TMPDIR ?? '/tmp', 'ssh-bridge');
    this.spillToDisk = options.spillToDisk ?? true;
  }
  append(id: string, stream: OutputChunk['stream'], data: Buffer | string) {
    const value = data.toString(); if (!value) return;
    if (!this.spillToDisk && Buffer.byteLength(value) > this.memoryBytes) {
      for (let offset = 0; offset < value.length; offset += this.memoryBytes) this.append(id, stream, value.slice(offset, offset + this.memoryBytes));
      return;
    }
    const state = this.sessions.get(id) ?? { next: 0, oldest: 0, bytes: 0, chunks: [] };
    const start = state.next; const end = start + Buffer.byteLength(value);
    const record: Record = { cursor: start, end, stream, data: value, timestamp: new Date().toISOString() };
    state.next = end; state.bytes += end - start;
    if (state.bytes > this.memoryBytes && this.spillToDisk) {
      mkdirSync(this.directory, { recursive: true }); state.file ??= join(this.directory, `${id}.jsonl`);
      appendFileSync(state.file, `${JSON.stringify(record)}\n`); state.chunks = []; state.oldest = 0;
    } else {
      state.chunks.push(record);
      while (!this.spillToDisk && state.bytes > this.memoryBytes && state.chunks.length) {
        const removed = state.chunks.shift()!; state.bytes -= removed.end - removed.cursor; state.oldest = removed.end;
      }
    }
    this.sessions.set(id, state);
  }
  read(id: string, cursor = 0, maxBytes = 32 * 1024): OutputRead {
    const state = this.sessions.get(id); if (!state) return { chunks: [], nextCursor: cursor, hasMore: false, truncated: false, oldestCursor: 0 };
    const records = state.file ? readFileSync(state.file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record) : state.chunks;
    const truncated = cursor < state.oldest; let used = 0; const chunks: OutputChunk[] = [];
    for (const record of records) {
      if (record.end <= Math.max(cursor, state.oldest)) continue;
      const offset = Math.max(cursor, state.oldest, record.cursor); const data = record.data.slice(offset - record.cursor);
      const room = Math.max(0, maxBytes - used); if (!room) break;
      const part = data.slice(0, room); chunks.push({ cursor: offset, stream: record.stream, data: part, timestamp: record.timestamp }); used += Buffer.byteLength(part);
      if (part.length < data.length) break;
    }
    const last = chunks.at(-1); const nextCursor = last ? last.cursor + Buffer.byteLength(last.data) : Math.max(cursor, state.oldest);
    return { chunks, nextCursor, hasMore: nextCursor < state.next, truncated, oldestCursor: state.oldest };
  }
  clear(id: string) { const state = this.sessions.get(id); if (state?.file) rmSync(state.file, { force: true }); this.sessions.delete(id); }
}
