#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT_DIR"

TMP_HOME="${TMPDIR:-/tmp}/mb-uniassistant-home"
MAP_FILE="${TMPDIR:-/tmp}/assistant-directory-map.json"
MOCK_GATEWAY_PORT="${MOCK_GATEWAY_PORT:-8081}"
OPENCODE_HOST="${OPENCODE_HOST:-127.0.0.1}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
BRIDGE_ROOT_DIR="${BRIDGE_ROOT_DIR:-/tmp/bridge-root}"
ASSISTANT_ROOT_DIR="${ASSISTANT_ROOT_DIR:-/tmp/general-root}"
ASSISTANT_ID="${ASSISTANT_ID:-general}"
BOOTSTRAP_TITLE="${BOOTSTRAP_TITLE:-bridge-bootstrap-session}"

GW_PID=""
OPENCODE_PID=""

resolve_port() {
  local preferred_port="$1"
  node --input-type=module - "$preferred_port" <<'EOF'
import net from 'node:net';

const preferredPort = Number(process.argv[2] ?? '0');

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const resolvedPort = typeof address === 'object' && address ? address.port : port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(resolvedPort);
      });
    });
  });
}

try {
  const resolved = await listenOn(preferredPort).catch(async () => listenOn(0));
  process.stdout.write(String(resolved));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
EOF
}

cleanup() {
  if [[ -n "$GW_PID" ]]; then
    kill "$GW_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$OPENCODE_PID" ]]; then
    kill "$OPENCODE_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_http() {
  local url="$1"
  local attempts="${2:-30}"
  local sleep_seconds="${3:-1}"

  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done

  return 1
}

RESOLVED_GATEWAY_PORT="$(resolve_port "$MOCK_GATEWAY_PORT")"
RESOLVED_OPENCODE_PORT="$(resolve_port "$OPENCODE_PORT")"

if [[ "$RESOLVED_GATEWAY_PORT" != "$MOCK_GATEWAY_PORT" ]]; then
  echo "[port] gateway port $MOCK_GATEWAY_PORT is busy, using $RESOLVED_GATEWAY_PORT"
fi

if [[ "$RESOLVED_OPENCODE_PORT" != "$OPENCODE_PORT" ]]; then
  echo "[port] opencode port $OPENCODE_PORT is busy, using $RESOLVED_OPENCODE_PORT"
fi

rm -rf "$TMP_HOME"
mkdir -p "$TMP_HOME/.config/opencode"

cat >"$MAP_FILE" <<EOF
{
  "$ASSISTANT_ID": {
    "directory": "$ASSISTANT_ROOT_DIR"
  }
}
EOF

cat >"$TMP_HOME/.config/opencode/opencode.json" <<EOF
{
  "plugin": ["file://$PLUGIN_DIR"]
}
EOF

echo "[1/4] starting mock gateway on ws://$OPENCODE_HOST:$RESOLVED_GATEWAY_PORT/ws/agent ..."
cd "$PLUGIN_DIR"
ASSISTANT_ID="$ASSISTANT_ID" OPENCODE_HOST="$OPENCODE_HOST" OPENCODE_PORT="$RESOLVED_OPENCODE_PORT" MOCK_GATEWAY_PORT="$RESOLVED_GATEWAY_PORT" \
node --input-type=module <<'EOF' &
import http from 'node:http';
import { WebSocketServer } from 'ws';

const assistantId = process.env.ASSISTANT_ID ?? 'persona-1';
const host = process.env.OPENCODE_HOST ?? '127.0.0.1';
const port = Number(process.env.MOCK_GATEWAY_PORT ?? '8081');
const opencodePort = Number(process.env.OPENCODE_PORT ?? '4096');
let createdToolSessionId = '';
let closeSessionSent = false;

async function verifySessionDeleted(toolSessionId) {
  const url = `http://${host}:${opencodePort}/session/${toolSessionId}`;
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(url);
    if (response.status === 404) {
      console.log(`[gw] close_session.verify deleted_after_close session=${toolSessionId} status=404`);
      return;
    }

    const body = await response.text();
    console.log(`[gw] close_session.verify retry session=${toolSessionId} status=${response.status} body=${body}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log(`[gw] close_session.verify failed session=${toolSessionId} still_exists=true`);
}

const server = http.createServer((_, res) => {
  res.writeHead(200);
  res.end('ok');
});

const wss = new WebSocketServer({ server, path: '/ws/agent' });

wss.on('connection', (ws) => {
  console.log('[gw] connected');

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    console.log('[gw] <=', JSON.stringify(msg));

    if (msg.type === 'register') {
      ws.send(JSON.stringify({ type: 'register_ok' }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'status_query' })), 50);
      return;
    }

    if (msg.type === 'status_response') {
      ws.send(JSON.stringify({
        type: 'invoke',
        welinkSessionId: 'wl-create-1',
        action: 'create_session',
        payload: {
          title: 'uniassistant-manual-check',
          assistantId,
        },
      }));
      console.log('[gw] => invoke:create_session');
      return;
    }

    if (msg.type === 'session_created') {
      createdToolSessionId = msg.toolSessionId;
      ws.send(JSON.stringify({
        type: 'invoke',
        welinkSessionId: 'wl-chat-1',
        action: 'chat',
        payload: {
          toolSessionId: msg.toolSessionId,
          text: 'hello from manual verification',
          assistantId,
        },
      }));
      console.log('[gw] => invoke:chat');
      return;
    }

    if ((msg.type === 'tool_done' || msg.type === 'tool_error') && msg.welinkSessionId === 'wl-chat-1' && !closeSessionSent) {
      closeSessionSent = true;
      ws.send(JSON.stringify({
        type: 'invoke',
        welinkSessionId: 'wl-close-1',
        action: 'close_session',
        payload: {
          toolSessionId: createdToolSessionId,
        },
      }));
      console.log('[gw] => invoke:close_session');
      setTimeout(() => {
        void verifySessionDeleted(createdToolSessionId);
      }, 1200);
      return;
    }
  });
});

server.listen(port, host, () => {
  console.log(`[gw] listening on ws://${host}:${port}/ws/agent`);
});
EOF
GW_PID="$!"

sleep 1

echo "[2/4] starting opencode on http://$OPENCODE_HOST:$RESOLVED_OPENCODE_PORT ..."
HOME="$TMP_HOME" \
USERPROFILE="$TMP_HOME" \
XDG_CONFIG_HOME="$TMP_HOME/.config" \
OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
BRIDGE_ENABLED=true \
BRIDGE_AUTH_AK=test-ak \
BRIDGE_AUTH_SK=test-sk \
BRIDGE_GATEWAY_URL="ws://$OPENCODE_HOST:$RESOLVED_GATEWAY_PORT/ws/agent" \
BRIDGE_GATEWAY_CHANNEL=uniassistant \
BRIDGE_DIRECTORY="$BRIDGE_ROOT_DIR" \
BRIDGE_ASSISTANT_DIRECTORY_MAP_FILE="$MAP_FILE" \
BRIDGE_DEBUG=true \
opencode serve --hostname "$OPENCODE_HOST" --port "$RESOLVED_OPENCODE_PORT" --print-logs --log-level DEBUG &
OPENCODE_PID="$!"

if ! wait_for_http "http://$OPENCODE_HOST:$RESOLVED_OPENCODE_PORT/global/health" 30 1; then
  echo "opencode server did not become ready in time" >&2
  exit 1
fi

echo "[3/5] bootstrapping opencode session so plugin initializes ..."
curl -fsS "http://$OPENCODE_HOST:$RESOLVED_OPENCODE_PORT/session" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"$BOOTSTRAP_TITLE\"}" >/dev/null

cat <<EOF
[4/5] expected log checkpoints
- action.create_session.started
  resolvedDirectory=$ASSISTANT_ROOT_DIR
  resolvedDirectorySource=mapping
- session_directory.session_get.directory_resolved
  directory=$ASSISTANT_ROOT_DIR
- action.close_session.started
  toolSessionId=<same toolSessionId>
- [gw] close_session.verify deleted_after_close
  status=404

manual check for close_session directory forwarding:
- inspect opencode logs for the DELETE request of the same session id
- expected: request path is /session/<toolSessionId>
- expected: query contains directory=$ASSISTANT_ROOT_DIR

bridge root directory:
  $BRIDGE_ROOT_DIR
assistant mapped directory:
  $ASSISTANT_ROOT_DIR
mapping file:
  $MAP_FILE
gateway url:
  ws://$OPENCODE_HOST:$RESOLVED_GATEWAY_PORT/ws/agent
opencode url:
  http://$OPENCODE_HOST:$RESOLVED_OPENCODE_PORT

[5/5] wait for logs, press Ctrl+C after verification
EOF

wait "$OPENCODE_PID"
