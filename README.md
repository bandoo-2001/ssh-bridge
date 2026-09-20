# ssh-bridge

`ssh-bridge` 是一个基于 MCP 和 REST API 的 SSH 远程操作服务，供 ChatGPT、AI Agent、Apifox 或其他 HTTP 客户端连接 Linux 服务器、执行命令和使用交互式终端。

核心目标：

- 通过 MCP 调用 SSH 能力
- 提供等价的 REST API
- 普通命令和交互式终端共用同一套业务层
- 大输出使用游标分页，避免一次性返回全部内容
- 支持 SSH 私钥认证和密码认证
- 提供可直接测试的 Swagger UI 和可导入 Apifox 的 OpenAPI JSON

## 技术栈

- Node.js 22+
- TypeScript
- Fastify
- MCP TypeScript SDK v2
- Streamable HTTP
- `ssh2`
- Zod
- Swagger / OpenAPI 3.0.3
- Vitest

## 安装

```bash
npm install
npm run build
```

## 配置服务器

默认配置文件为项目目录下的 `servers.yaml`，也可以通过 `SSH_BRIDGE_CONFIG` 指定路径。

### 私钥认证

```yaml
servers:
  prod-01:
    name: 生产服务器
    host: 203.0.113.10
    port: 22
    username: deploy
    privateKey: /home/user/.ssh/id_ed25519
    passphrase: 可选的私钥口令
```

### 密码认证

```yaml
servers:
  test-01:
    name: 测试服务器
    host: 192.168.1.20
    port: 22
    username: root
    password: 请替换为实际密码
```

`privateKey` 和 `password` 至少配置一个。两者同时配置时优先使用私钥认证。

建议限制配置文件权限：

```bash
chmod 600 servers.yaml
```

不要把包含真实密码、私钥路径口令或其他敏感信息的配置提交到 Git。

## 启动

### MCP 认证

配置 `MCP_AUTH_TOKEN` 后，`/mcp` 要求使用 Bearer Token：

```bash
MCP_AUTH_TOKEN=请替换为随机长令牌 SSH_BRIDGE_CONFIG=servers.yaml npm start
```

本地开发环境也可以把 Token 放在项目根目录 `.env` 中。`.env` 已被 Git 忽略，不能提交到仓库。

ChatGPT 连接时使用：

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

未配置 `MCP_AUTH_TOKEN` 时，为兼容本地开发，MCP 不启用认证；连接公网或 Tunnel 前必须配置。

使用默认配置文件：

```bash
npm start
```

使用指定配置文件：

```bash
SSH_BRIDGE_CONFIG=/absolute/path/to/servers.yaml npm start
```

开发模式：

```bash
npm run dev
```

默认监听：

```text
http://127.0.0.1:3000
```

也可以通过环境变量修改：

```bash
HOST=127.0.0.1 PORT=3000 npm start
```

## Swagger 和 OpenAPI

Swagger UI：

```text
http://127.0.0.1:3000/docs/
```

Swagger UI 支持 `Try it out`，可以直接填写参数并测试 REST API。

OpenAPI JSON：

```text
http://127.0.0.1:3000/openapi.json
```

OpenAPI JSON 可直接导入 Apifox。

## REST API

### 服务器

```http
GET /api/servers
GET /api/servers/{server}/status
```

### 普通命令

启动命令：

```http
POST /api/executions
Content-Type: application/json
```

```json
{
  "server": "prod-01",
  "command": "uname -a",
  "timeoutSeconds": 60
}
```

读取输出：

```http
GET /api/executions/{executionId}/output?cursor=0&maxBytes=32768
```

写入 stdin：

```http
POST /api/executions/{executionId}/input
Content-Type: application/json
```

```json
{
  "data": "输入内容\n"
}
```

发送信号：

```http
POST /api/executions/{executionId}/signal
Content-Type: application/json
```

```json
{
  "signal": "TERM"
}
```

支持的信号：`INT`、`TERM`、`KILL`。

### 交互式终端

打开终端：

```http
POST /api/terminals
Content-Type: application/json
```

```json
{
  "server": "prod-01",
  "cols": 120,
  "rows": 40
}
```

读取终端输出：

```http
GET /api/terminals/{terminalId}/output?cursor=0&maxBytes=32768
```

写入终端：

```http
POST /api/terminals/{terminalId}/input
Content-Type: application/json
```

```json
{
  "data": "ls -la\n"
}
```

关闭终端：

```http
DELETE /api/terminals/{terminalId}
```

## 输出分页

普通命令输出、日志、文件内容和终端输出统一按照 SSH 输出处理。

读取接口支持：

- `cursor`：读取起始位置，首次读取可省略
- `maxBytes`：本次最多读取的字节数，最大 1 MB
- `nextCursor`：下一次读取使用的游标
- `hasMore`：是否还有未读取内容
- `truncated`：早期输出是否已经被保留策略截断

典型流程：

```text
exec.start
    ↓
executionId
    ↓
exec.read(cursor=0)
    ↓
nextCursor
    ↓
exec.read(cursor=nextCursor)
```

小输出保存在内存中，较大输出会写入临时目录：

```text
/tmp/ssh-bridge/
```

服务重启后，执行任务、终端会话和临时输出不会恢复。

## MCP API

MCP 使用 Streamable HTTP，入口为：

```text
POST http://127.0.0.1:3000/mcp
```

当前工具：

```text
server.list
server.status

exec.start
exec.read
exec.write
exec.signal

terminal.open
terminal.read
terminal.write
terminal.close

file.stat
file.list
file.read
```

MCP 和 REST 共用 `BridgeService`，不会分别实现 SSH 业务逻辑。

## SFTP 文件读取与图片返回

`file.stat` 获取文件信息，`file.list` 列出目录，`file.read` 读取文件。MCP 文件读取支持两种模式：

| 参数 | Base64 模式（默认） | 图片模式 |
| --- | --- | --- |
| `format` | `base64`，可省略 | `image` |
| `server` / `path` | 服务器配置 ID / 远程文件路径 | 相同 |
| `offset` | 起始字节偏移，默认 0 | 必须为 0，可省略 |
| `maxBytes` | 每页字节数，默认和最大均为 1 MiB | 必须省略 |
| 返回 | 原有 JSON 文本：Base64 数据及分页字段 | 文件元数据文本 + 原生 MCP `image` 内容块 |

图片模式一次返回整张图片，文件大小最多 **5 MiB（5,242,880 字节）**。这是本服务的安全上限，并非对所有 MCP 客户端限制的说明。支持按文件头识别 PNG、JPEG、GIF、WebP，不依赖文件扩展名；不做图片解码、转码或压缩。

图片请求示例（`tools/call` 的参数）：

```json
{
  "name": "file.read",
  "arguments": {
    "server": "password-server",
    "path": "/tmp/wechat.png",
    "format": "image"
  }
}
```

图片数据直接放在 `content` 中的 `type: image` 项，携带 `mimeType` 和 Base64 `data`，不再把整张图片包进 `type: text` 的 JSON 中。文本项只包含路径、大小、MIME 类型，不重复图片数据。

底层在同一 SFTP 文件句柄上循环读取，处理短读，并在结束前比较文件大小和修改时间。空文件、非普通文件、超限文件、提前 EOF、可检测到的读取期间变化会返回工具错误，句柄在退出前关闭。大小和修改时间检查不是文件快照，不能保证检测到所有同大小、同时间戳的并发覆写；截图应先保存完毕再读取。

此功能负责读取已有图片，不负责截取远程桌面，不创建公网下载地址。客户端能否显示图片或作为模型视觉输入，仍需在实际客户端验证。

原有 REST API 保持兼容，仍返回 JSON，不切换为图片响应：

```text
GET /api/files/stat?server=...&path=...
GET /api/files?server=...&path=...
GET /api/files/content?server=...&path=...&offset=0&maxBytes=1048576
```

更新后需重新构建、重启服务，并让 MCP 客户端重新发现 `file.read` 的参数定义。工具数量仍为 13 个，新增的是 `format` 参数，不是额外的工具。仅构建不会更新已运行进程；重启会丢失当前内存中的命令与终端会话。

集成测试在本机回环地址创建临时 HTTP 服务和只包含合成文件的 SSH/SFTP 服务，不使用真实服务器密码，结束后关闭测试进程并删除临时配置：

```text
npm test
npm run build
SSH_BRIDGE_TEST_BUILT=1 npm test -- tests/mcp-image.test.ts
```

注意：现有 `MCP_AUTH_TOKEN` 保护 `/mcp`，并不自动保护 `/api/*`。本次改动没有改变认证策略；REST 接口仍应限制在可信网络或额外加上认证。

## Secure MCP Tunnel

Tunnel Client 运行在本机，将 OpenAI 托管 Tunnel 的请求转发给本地 MCP 服务，无需开放入站公网端口。

下载并解压官方 `tunnel-client` 到项目 `.tools/tunnel-client/` 后，先在 OpenAI Platform Tunnel Settings 创建 Tunnel。然后在本机仅设置以下两个 OpenAI 凭据：

```bash
export CONTROL_PLANE_API_KEY="你的 Runtime API Key"
export CONTROL_PLANE_TUNNEL_ID="你的 tunnel_id"
./scripts/run-tunnel.sh
```

脚本从本地 `.env` 读取已配置的 `MCP_AUTH_TOKEN`，并作为上游 MCP 的 Bearer Token 转发；不会打印任何凭据。

## 测试和构建

```bash
npm test
npm run build
```

## 安全建议

当前服务默认只监听 `127.0.0.1`，适合本机使用。若需要远程访问，建议在反向代理层增加：

- HTTPS
- 身份认证
- 访问控制
- 请求限流
- 审计日志

不要直接把未认证的服务暴露到公网。命令执行权限等同于配置服务器账号本身的权限，应使用权限受限的 SSH 用户。
