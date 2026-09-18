#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
client="$task_root/.tools/tunnel-client/tunnel-client-runtime-cloudflared"

if [[ ! -x "$client" ]]; then
  echo "Tunnel client not found: $client" >&2
  exit 1
fi

load_env_value() {
  local name="$1"
  local value

  [[ -n "${!name:-}" || ! -f "$task_root/.env" ]] && return
  value="$(sed -n "s/^${name}=//p" "$task_root/.env" | head -n 1)"
  [[ -n "$value" ]] && export "$name=$value"
}

load_env_value MCP_AUTH_TOKEN
load_env_value CONTROL_PLANE_API_KEY
load_env_value CONTROL_PLANE_TUNNEL_ID

# tunnel-client 的 env: 语法会替换整个请求头值；因此单独构造 Bearer 值，
# 避免把密钥直接放进命令行参数。
if [[ -n "${MCP_AUTH_TOKEN:-}" ]]; then
  MCP_TUNNEL_AUTHORIZATION="Bearer $MCP_AUTH_TOKEN"
  export MCP_TUNNEL_AUTHORIZATION
fi

for required in CONTROL_PLANE_API_KEY CONTROL_PLANE_TUNNEL_ID MCP_AUTH_TOKEN; do
  if [[ -z "${!required:-}" ]]; then
    echo "Missing required environment variable: $required" >&2
    exit 1
  fi
done

exec "$client" run \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp.server-url "url=http://127.0.0.1:3000/mcp" \
  --mcp.extra-headers "Authorization: env:MCP_TUNNEL_AUTHORIZATION"
