# SSH Bridge Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 完成统一 SSH 输出分页、生命周期管理和 Streamable HTTP MCP 接入。

**Architecture:** 普通 SSH exec 与 PTY 共用 OutputStore；小输出保存在内存，超过阈值后落盘。MCP 以无状态 Streamable HTTP 工作，业务 session 通过 executionId/terminalId 保存在进程内并自动清理。

**Tech Stack:** Node.js 22、TypeScript、ssh2、Fastify、MCP SDK v2、Zod、Vitest。

**Spec:** 本次用户确认的“单一输出模型 + 文件型分页存储”设计。

## Global Constraints

- 不新增 `file.*` API；文件内容继续通过 SSH 命令输出。
- 不引入数据库或额外运行时依赖。
- 外部读取以 `cursor` 和 `maxBytes` 分页。
- 不记录完整命令内容到日志。

### Task 1: OutputStore

**Files:** Create `tests/output-store.test.ts`; Modify `src/output-store.ts`

- [ ] 测试空读取、按字节分页、游标推进、内存上限截断和清理。
- [ ] 实现统一输出记录，返回 `chunks/nextCursor/hasMore/truncated/oldestCursor`。
- [ ] 超过内存阈值时写入临时文件，读取仍保持同一接口。
- [ ] 运行 `npm test -- tests/output-store.test.ts`。

### Task 2: SSH session lifecycle

**Files:** Create `src/execution.ts`, `src/terminal.ts`; Create `tests/execution.test.ts`; Modify `src/ssh.ts`

- [ ] 测试完成、失败、超时和分页读取的状态转换。
- [ ] 实现 ExecutionManager，保证 channel 初始化竞态、超时、信号和清理。
- [ ] 实现 TerminalManager，统一 terminal 输出、关闭和断线清理。
- [ ] 运行相关 Vitest 和 `npm run build`。

### Task 3: MCP integration

**Files:** Modify `src/index.ts`; Create `tests/http.test.ts`

- [ ] 测试 `/health`、`/mcp` POST 和非 POST 方法响应。
- [ ] 接入两个 manager，暴露 10 个既定工具，增加 `maxBytes/waitMs/timeoutSeconds`。
- [ ] 删除完整 command 日志，补充 405 路由和错误响应。
- [ ] 运行全量测试、构建并做一次本地 MCP 初始化请求检查。
