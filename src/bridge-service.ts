import { randomUUID } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';
import type { ServerConfig } from './config.js';
import { OutputStore, type OutputRead } from './output-store.js';
import { SshManager } from './ssh.js';

type Execution = { conn: Client; channel?: ClientChannel; done: boolean; exitCode?: number | null; timer?: NodeJS.Timeout };
type Terminal = { conn: Client; channel: ClientChannel };

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
  private server(id: string) { const server = this.config[id]; if (!server) throw new Error(`Unknown server: ${id}`); return server; }
}
