import { randomUUID } from 'node:crypto';
import type { Client, ClientChannel, Stats, Attributes } from 'ssh2';
import type { ServerConfig } from './config.js';
import { OutputStore } from './output-store.js';
import { SshManager } from './ssh.js';

type Execution = { conn: Client; channel?: ClientChannel; done: boolean; exitCode?: number | null; timer?: NodeJS.Timeout };
type Terminal = { conn: Client; channel: ClientChannel };

function typeOf(stats: Stats | Attributes) {
  const mode = stats.mode ?? 0;
  const kind = mode & 0o170000;
  if (kind === 0o040000) return 'directory' as const;
  if (kind === 0o100000) return 'file' as const;
  if (kind === 0o120000) return 'symlink' as const;
  return 'other' as const;
}

// Bound image payloads independently from the existing 1 MiB base64 page size.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function imageMimeType(data: Buffer) {
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png' as const;
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg' as const;
  }
  const signature = data.subarray(0, 6).toString('ascii');
  if (data.length >= 13 && (signature === 'GIF87a' || signature === 'GIF89a')) {
    return 'image/gif' as const;
  }
  if (data.length >= 16 && data.subarray(0, 4).toString('ascii') === 'RIFF'
      && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp' as const;
  }
  throw new Error('Unsupported image content; supported formats: PNG, JPEG, GIF, WebP');
}

export class BridgeService {
  readonly executions = new Map<string, Execution>(); readonly terminals = new Map<string, Terminal>();
  constructor(private readonly config: Record<string, ServerConfig>, private readonly ssh = new SshManager(), private readonly output = new OutputStore()) {}
  listServers() { return Object.entries(this.config).map(([id, item]) => ({ id, name: item.name ?? id })); }
  async status(id: string) { const conn = await this.ssh.connect(this.server(id)); conn.end(); return { server: id, status: 'online' as const }; }
  async start(id: string, command: string, timeoutSeconds?: number) { const executionId = randomUUID(); const conn = await this.ssh.connect(this.server(id)); const state: Execution = { conn, done: false }; this.executions.set(executionId, state); if (timeoutSeconds) state.timer = setTimeout(() => { state.channel?.signal('TERM'); state.done = true; state.exitCode = null; conn.end(); }, timeoutSeconds * 1000); void this.ssh.exec(conn, command, (stream, data) => this.output.append(executionId, stream, data), (code) => { if (state.timer) clearTimeout(state.timer); state.done = true; state.exitCode = code; conn.end(); }).then((channel) => { state.channel = channel; }).catch((error) => { if (state.timer) clearTimeout(state.timer); this.output.append(executionId, 'stderr', String(error)); state.done = true; conn.end(); }); return { executionId, status: 'running' as const }; }
  readExecution(id: string, cursor = 0, maxBytes = 32 * 1024) { if (!this.executions.has(id)) throw new Error('Unknown execution'); const state = this.executions.get(id)!; return { ...this.output.read(id, cursor, maxBytes), done: state.done, exitCode: state.exitCode }; }
  writeExecution(id: string, data: string) { const state = this.executions.get(id); if (!state?.channel) throw new Error('Execution is not writable'); state.channel.write(data); return { written: true }; }
  signalExecution(id: string, signal: 'INT' | 'TERM' | 'KILL' = 'TERM') { const state = this.executions.get(id); if (!state) throw new Error('Unknown execution'); state.channel?.signal(signal); if (!state.channel) state.conn.end(); return { stopped: true, signal }; }
  async openTerminal(id: string, cols = 120, rows = 40) { const conn = await this.ssh.connect(this.server(id)); const channel = await this.ssh.shell(conn, cols, rows); const terminalId = randomUUID(); this.terminals.set(terminalId, { conn, channel }); channel.on('data', (data: Buffer) => this.output.append(terminalId, 'terminal', data)); channel.stderr.on('data', (data: Buffer) => this.output.append(terminalId, 'terminal', data)); return { terminalId, status: 'open' as const }; }
  readTerminal(id: string, cursor = 0, maxBytes = 32 * 1024) { if (!this.terminals.has(id)) throw new Error('Unknown terminal'); return this.output.read(id, cursor, maxBytes); }
  writeTerminal(id: string, data: string) { const terminal = this.terminals.get(id); if (!terminal) throw new Error('Unknown terminal'); terminal.channel.write(data); return { written: true }; }
  closeTerminal(id: string) { const terminal = this.terminals.get(id); if (!terminal) throw new Error('Unknown terminal'); terminal.channel.close(); terminal.conn.end(); this.terminals.delete(id); this.output.clear(id); return { closed: true }; }
  async statFile(id: string, path: string) {
    const conn = await this.ssh.connect(this.server(id));
    try {
      const sftp = await this.ssh.sftp(conn); const stats = await this.ssh.stat(sftp, path);
      return { path, type: typeOf(stats), size: stats.size, mode: stats.mode, uid: stats.uid, gid: stats.gid, atime: new Date(stats.atime * 1000).toISOString(), mtime: new Date(stats.mtime * 1000).toISOString() };
    } finally { conn.end(); }
  }
  async listFiles(id: string, path: string) {
    const conn = await this.ssh.connect(this.server(id));
    try {
      const sftp = await this.ssh.sftp(conn); const list = await this.ssh.readdir(sftp, path);
      return list.map((item) => ({ name: item.filename, longname: item.longname, type: typeOf(item.attrs), size: item.attrs.size, mode: item.attrs.mode, uid: item.attrs.uid, gid: item.attrs.gid, atime: new Date(item.attrs.atime * 1000).toISOString(), mtime: new Date(item.attrs.mtime * 1000).toISOString() }));
    } finally { conn.end(); }
  }
  async readFile(id: string, path: string, offset = 0, maxBytes = 1024 * 1024) {
    if (offset < 0) throw new Error('offset must be >= 0');
    if (maxBytes <= 0 || maxBytes > 1024 * 1024) throw new Error('maxBytes must be between 1 and 1048576');
    const conn = await this.ssh.connect(this.server(id));
    try {
      const sftp = await this.ssh.sftp(conn); const stats = await this.ssh.stat(sftp, path);
      if (!stats.isFile()) throw new Error('Path is not a file');
      const { data, bytesRead } = await this.ssh.read(sftp, path, offset, maxBytes);
      const nextOffset = offset + bytesRead;
      return { path, offset, nextOffset, size: stats.size, hasMore: nextOffset < stats.size, encoding: 'base64' as const, data: data.toString('base64') };
    } finally { conn.end(); }
  }
  async readImage(id: string, path: string) {
    const conn = await this.ssh.connect(this.server(id));
    try {
      const sftp = await this.ssh.sftp(conn);
      const data = await this.ssh.readCompleteFile(sftp, path, MAX_IMAGE_BYTES);
      return { path, size: data.length, mimeType: imageMimeType(data), data: data.toString('base64') };
    } finally {
      conn.end();
    }
  }
  private server(id: string) { const server = this.config[id]; if (!server) throw new Error(`Unknown server: ${id}`); return server; }
}
