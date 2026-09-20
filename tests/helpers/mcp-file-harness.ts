import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Server, utils, type Connection } from 'ssh2';

export type Fixture = {
  data: Buffer;
  size?: number;
  mode?: number;
  afterSize?: number;
  afterMtime?: number;
  readError?: boolean;
};

// A real loopback SSH/SFTP peer with only synthetic files; no user credentials.
export async function startHarness() {
  const files = new Map<string, Fixture>();
  const connections = new Set<Connection>();
  const metrics = { open: 0, close: 0, read: 0 };
  const password = randomUUID();
  const token = randomUUID();
  const key = utils.generateKeyPairSync('ed25519');
  const ssh = new Server({ hostKeys: [key.private] }, (client) => {
    connections.add(client);
    client.on('error', () => undefined);
    client.once('close', () => connections.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === password) ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map<string, { file: Fixture; statsCalls: number }>();
        const attrs = (file: Fixture, later = false) => ({
          size: later ? (file.afterSize ?? file.size ?? file.data.length) : (file.size ?? file.data.length),
          mode: file.mode ?? 0o100644,
          uid: 1000, gid: 1000, atime: 1000,
          mtime: later ? (file.afterMtime ?? 1000) : 1000
        });
        sftp.on('STAT', (id, path) => {
          const file = files.get(path);
          if (file) sftp.attrs(id, attrs(file)); else sftp.status(id, 2, 'No such file');
        });
        sftp.on('OPEN', (id, path, flags) => {
          const file = files.get(path);
          if (!file) return sftp.status(id, 2, 'No such file');
          if (flags !== 1) return sftp.status(id, 3, 'Read only');
          const handle = Buffer.from(randomUUID());
          handles.set(handle.toString(), { file, statsCalls: 0 });
          metrics.open++;
          sftp.handle(id, handle);
        });
        sftp.on('FSTAT', (id, handle) => {
          const opened = handles.get(handle.toString());
          if (!opened) return sftp.status(id, 4, 'Invalid handle');
          sftp.attrs(id, attrs(opened.file, opened.statsCalls++ > 0));
        });
        sftp.on('READ', (id, handle, offset, length) => {
          const opened = handles.get(handle.toString());
          if (!opened) return sftp.status(id, 4, 'Invalid handle');
          metrics.read++;
          if (opened.file.readError) return sftp.status(id, 4, 'Simulated read failure');
          if (offset >= opened.file.data.length) return sftp.status(id, 1, 'EOF');
          // Deliberately return short reads, not the entire requested range.
          sftp.data(id, opened.file.data.subarray(offset, offset + Math.min(length, 32 * 1024)));
        });
        sftp.on('CLOSE', (id, handle) => {
          handles.delete(handle.toString()); metrics.close++;
          sftp.status(id, 0);
        });
      });
    }));
  });
  let child: ChildProcess | undefined;
  let temp = '';
  async function close() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const guard = setTimeout(() => child?.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(guard); }
    }
    for (const client of connections) client.end();
    await new Promise<void>((resolve) => ssh.close(() => resolve()));
    if (temp) await rm(temp, { recursive: true, force: true });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      ssh.once('error', reject); ssh.listen(0, '127.0.0.1', resolve);
    });
    const reserve = createServer();
    await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reserve.close(e => e ? reject(e) : resolve()));
    temp = await mkdtemp(join(tmpdir(), 'ssh-bridge-image-test-'));
    const configPath = join(temp, 'servers.json');
    await writeFile(configPath, JSON.stringify({ servers: { test: {
      host: '127.0.0.1', port: (ssh.address() as { port: number }).port,
      username: 'test', password
    } } }), { mode: 0o600 });
    const built = process.env.SSH_BRIDGE_TEST_BUILT === '1';
    child = spawn(process.execPath, built ? ['dist/src/index.js'] : ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
        SSH_BRIDGE_CONFIG: configPath, MCP_AUTH_TOKEN: token }
    });
    let log = '';
    child.stdout?.on('data', b => { log = (log + b).slice(-6000); });
    child.stderr?.on('data', b => { log = (log + b).slice(-6000); });
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    const baseUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Test server exited: ${log}`);
      try { ready = (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await sleep(50);
    }
    if (!ready) throw new Error(`Test server did not become ready: ${log}`);
    let requestId = 0;
    let protocolVersion = '2025-11-25';
    async function rpc(method: string, params: unknown = {}) {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': protocolVersion },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
      });
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body)}`);
      return body.result;
    }
    const initialized = await rpc('initialize', { protocolVersion,
      capabilities: {}, clientInfo: { name: 'image-integration-test', version: '1.0.0' } });
    protocolVersion = initialized.protocolVersion;
    return { files, metrics, baseUrl, rpc, close,
      call: (args: Record<string, unknown>) => rpc('tools/call', { name: 'file.read', arguments: { server: 'test', ...args } }) };
  } catch (error) { await close(); throw error; }
}
