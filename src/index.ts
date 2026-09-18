import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import 'dotenv/config';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { BridgeService } from './bridge-service.js';

const config = await loadConfig();
const bridge = new BridgeService(config);
const app = createMcpFastifyApp();
const mcpToken = process.env.MCP_AUTH_TOKEN;
function authorized(request: { headers: { authorization?: string } }) {
  if (!mcpToken) return true;
  const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
  const a = Buffer.from(supplied); const b = Buffer.from(mcpToken);
  return a.length === b.length && timingSafeEqual(a, b);
}
await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/' });
await app.register(fastifyStatic, { root: join(process.cwd(), 'node_modules'), prefix: '/vendor/', decorateReply: false });
app.get('/admin', async (_request, reply) => reply.sendFile('admin.html'));
await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 'ssh-bridge REST API', version: '0.1.0' }, tags: [{ name: 'server' }, { name: 'exec' }, { name: 'terminal' }] } });
await app.register(swaggerUi, { routePrefix: '/docs' });
app.get('/openapi.json', async () => app.swagger());
const outputQuery = { type: 'object', properties: { cursor: { type: 'integer', minimum: 0, description: '读取起始游标，首次读取可省略' }, maxBytes: { type: 'integer', minimum: 1, maximum: 1048576, description: '本次最多返回的字节数，默认 32KB，最大 1MB' } } };

app.get('/api/servers', { schema: { tags: ['server'], summary: '获取服务器列表', description: '返回当前配置的所有 SSH 服务器。' } }, async () => bridge.listServers());
app.get('/api/servers/:server/status', { schema: { tags: ['server'], summary: '检查服务器状态', description: '通过 SSH 建立连接并检查服务器是否可用。', params: { type: 'object', required: ['server'], properties: { server: { type: 'string', description: '服务器配置 ID' } } } } }, async (r) => bridge.status((r.params as { server: string }).server));
app.post('/api/executions', { schema: { tags: ['exec'], summary: '启动 SSH 命令', description: '在指定服务器上异步执行非交互式 Shell 命令。', body: { type: 'object', required: ['server', 'command'], properties: { server: { type: 'string', description: '服务器配置 ID' }, command: { type: 'string', description: '要执行的 Shell 命令' }, timeoutSeconds: { type: 'integer', minimum: 1, description: '命令超时时间，单位为秒' } } } } }, async (r) => { const b = r.body as { server: string; command: string; timeoutSeconds?: number }; return bridge.start(b.server, b.command, b.timeoutSeconds); });
app.get('/api/executions/:executionId/output', { schema: { tags: ['exec'], summary: '读取命令输出', description: '按游标分页读取 stdout/stderr 输出。', params: { type: 'object', required: ['executionId'], properties: { executionId: { type: 'string', description: '命令执行 ID' } } }, querystring: outputQuery } }, async (r) => { const p = r.params as { executionId: string }; const q = r.query as { cursor?: number; maxBytes?: number }; return bridge.readExecution(p.executionId, q.cursor, q.maxBytes); });
app.post('/api/executions/:executionId/input', { schema: { tags: ['exec'], summary: '写入命令输入', description: '向支持标准输入的 SSH 命令写入数据。', body: { type: 'object', required: ['data'], properties: { data: { type: 'string', description: '写入 stdin 的文本内容' } } } } }, async (r) => bridge.writeExecution((r.params as { executionId: string }).executionId, (r.body as { data: string }).data));
app.post('/api/executions/:executionId/signal', { schema: { tags: ['exec'], summary: '终止命令执行', description: '向远端命令发送中断信号。', body: { type: 'object', properties: { signal: { type: 'string', enum: ['INT', 'TERM', 'KILL'], default: 'TERM', description: '信号类型：INT、TERM 或 KILL' } } } } }, async (r) => { const p = r.params as { executionId: string }; return bridge.signalExecution(p.executionId, (r.body as { signal?: 'INT' | 'TERM' | 'KILL' }).signal); });
app.post('/api/terminals', { schema: { tags: ['terminal'], summary: '打开交互式终端', description: '通过 SSH 创建带 PTY 的交互式终端。', body: { type: 'object', required: ['server'], properties: { server: { type: 'string', description: '服务器配置 ID' }, cols: { type: 'integer', default: 120, description: '终端列数' }, rows: { type: 'integer', default: 40, description: '终端行数' } } } } }, async (r) => { const b = r.body as { server: string; cols?: number; rows?: number }; return bridge.openTerminal(b.server, b.cols, b.rows); });
app.get('/api/terminals/:terminalId/output', { schema: { tags: ['terminal'], summary: '读取终端输出', description: '按游标分页读取 PTY 终端输出。', params: { type: 'object', required: ['terminalId'], properties: { terminalId: { type: 'string', description: '终端会话 ID' } } }, querystring: outputQuery } }, async (r) => { const p = r.params as { terminalId: string }; const q = r.query as { cursor?: number; maxBytes?: number }; return bridge.readTerminal(p.terminalId, q.cursor, q.maxBytes); });
app.post('/api/terminals/:terminalId/input', { schema: { tags: ['terminal'], summary: '写入终端输入', description: '向 PTY 终端写入键盘输入或 Shell 命令。', body: { type: 'object', required: ['data'], properties: { data: { type: 'string', description: '写入终端的文本内容' } } } } }, async (r) => bridge.writeTerminal((r.params as { terminalId: string }).terminalId, (r.body as { data: string }).data));
app.delete('/api/terminals/:terminalId', { schema: { tags: ['terminal'], summary: '关闭终端', description: '关闭 PTY 通道和对应 SSH 连接。', params: { type: 'object', required: ['terminalId'], properties: { terminalId: { type: 'string', description: '终端会话 ID' } } } } }, async (r) => bridge.closeTerminal((r.params as { terminalId: string }).terminalId));

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] });
function createServer() { const s = new McpServer({ name: 'ssh-bridge', version: '0.1.0' });
  s.registerTool('server.list', { description: '获取当前配置的 SSH 服务器列表。', inputSchema: {} }, async () => text(bridge.listServers()));
  s.registerTool('server.status', { description: '检查指定服务器的 SSH 连接状态。', inputSchema: { server: z.string().describe('服务器配置 ID') } }, async ({ server }) => text(await bridge.status(server)));
  s.registerTool('exec.start', { description: '在指定服务器上启动非交互式 SSH 命令。', inputSchema: { server: z.string().describe('服务器配置 ID'), command: z.string().describe('要执行的 Shell 命令'), timeoutSeconds: z.number().int().positive().optional().describe('命令超时时间，单位为秒') } }, async ({ server, command, timeoutSeconds }) => text(await bridge.start(server, command, timeoutSeconds)));
  s.registerTool('exec.read', { description: '按游标分页读取命令 stdout/stderr 输出。', inputSchema: { executionId: z.string().describe('命令执行 ID'), cursor: z.number().int().nonnegative().optional().describe('读取起始游标'), maxBytes: z.number().int().positive().max(1048576).optional().describe('本次最多返回的字节数') } }, async ({ executionId, cursor, maxBytes }) => text(bridge.readExecution(executionId, cursor, maxBytes)));
  s.registerTool('exec.write', { description: '向支持标准输入的 SSH 命令写入数据。', inputSchema: { executionId: z.string().describe('命令执行 ID'), data: z.string().describe('写入 stdin 的文本内容') } }, async ({ executionId, data }) => text(bridge.writeExecution(executionId, data)));
  s.registerTool('exec.signal', { description: '向远端命令发送中断信号。', inputSchema: { executionId: z.string().describe('命令执行 ID'), signal: z.enum(['INT', 'TERM', 'KILL']).default('TERM').describe('信号类型') } }, async ({ executionId, signal }) => text(bridge.signalExecution(executionId, signal)));
  s.registerTool('terminal.open', { description: '通过 SSH 创建带 PTY 的交互式终端。', inputSchema: { server: z.string().describe('服务器配置 ID'), cols: z.number().int().positive().default(120).describe('终端列数'), rows: z.number().int().positive().default(40).describe('终端行数') } }, async ({ server, cols, rows }) => text(await bridge.openTerminal(server, cols, rows)));
  s.registerTool('terminal.read', { description: '按游标分页读取 PTY 终端输出。', inputSchema: { terminalId: z.string().describe('终端会话 ID'), cursor: z.number().int().nonnegative().optional().describe('读取起始游标'), maxBytes: z.number().int().positive().max(1048576).optional().describe('本次最多返回的字节数') } }, async ({ terminalId, cursor, maxBytes }) => text(bridge.readTerminal(terminalId, cursor, maxBytes)));
  s.registerTool('terminal.write', { description: '向 PTY 终端写入键盘输入或 Shell 命令。', inputSchema: { terminalId: z.string().describe('终端会话 ID'), data: z.string().describe('写入终端的文本内容') } }, async ({ terminalId, data }) => text(bridge.writeTerminal(terminalId, data)));
  s.registerTool('terminal.close', { description: '关闭 PTY 通道和对应 SSH 连接。', inputSchema: { terminalId: z.string().describe('终端会话 ID') } }, async ({ terminalId }) => text(bridge.closeTerminal(terminalId))); return s; }
app.post('/mcp', async (request, reply) => { if (!authorized(request)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: 'Unauthorized' }); const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); const server = createServer(); reply.raw.on('close', () => { void transport.close(); void server.close(); }); await server.connect(transport); await transport.handleRequest(request.raw, reply.raw, request.body); });
for (const method of ['get', 'delete'] as const) app[method]('/mcp', async (_r, reply) => reply.code(405).send({ error: 'MCP endpoint accepts POST only' }));
app.get('/health', async () => ({ status: 'ok' }));
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
