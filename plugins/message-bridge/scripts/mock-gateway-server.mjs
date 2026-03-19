#!/usr/bin/env node
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.argv[2] ?? 8081);
const scenario = process.argv[3] ?? 'connect-register';

let wsRef = null;
const eventCounts = new Map();
let directoryCreateSent = false;
let directoryChatSent = false;

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('mock-gateway');
});

const wss = new WebSocketServer({ server, path: '/ws/agent' });

wss.on('connection', (ws) => {
  wsRef = ws;
  console.log('[mock-gateway] ws open');

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      const type = parsed?.type ?? 'unknown';

      if (type === 'tool_event' && parsed?.event?.type) {
        const eventType = parsed.event.type;
        console.log('[mock-gateway] tool_event:' + eventType);
        eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);
        if (scenario === 'permission-roundtrip' && eventType === 'permission.asked') {
          const props = parsed.event?.properties ?? {};
          const toolSessionId = props.sessionID;
          const permissionId = props.id;
          if (toolSessionId && permissionId) {
            ws.send(JSON.stringify({
              type: 'invoke',
              welinkSessionId: 'wl-permission-smoke',
              action: 'permission_reply',
              payload: { toolSessionId, permissionId, response: 'once' },
            }));
            console.log('[mock-gateway] invoke:permission_reply');
          }
        }
        return;
      }

      if (scenario === 'directory-context' && type === 'status_response' && !directoryCreateSent) {
        console.log('[mock-gateway] status_response');
        directoryCreateSent = true;
        ws.send(JSON.stringify({
          type: 'invoke',
          welinkSessionId: 'wl-directory-create',
          action: 'create_session',
          payload: { title: 'bridge-directory-e2e' },
        }));
        console.log('[mock-gateway] invoke:create_session');
        return;
      }

      if (scenario === 'directory-context' && type === 'session_created' && !directoryChatSent) {
        console.log('[mock-gateway] session_created');
        const toolSessionId = parsed?.toolSessionId;
        if (typeof toolSessionId === 'string' && toolSessionId) {
          directoryChatSent = true;
          ws.send(JSON.stringify({
            type: 'invoke',
            welinkSessionId: 'wl-directory-chat',
            action: 'chat',
            payload: {
              toolSessionId,
              text: 'E2E verify BRIDGE_DIRECTORY reuse',
            },
          }));
          console.log('[mock-gateway] invoke:chat');
        }
        return;
      }

      console.log('[mock-gateway] ' + type);
      if (type === 'register') {
        ws.send(JSON.stringify({ type: 'register_ok' }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'status_query' })), 50);
      }
    } catch {
      console.log('[mock-gateway] raw');
    }
  });

  ws.on('close', () => {
    wsRef = null;
    console.log('[mock-gateway] ws close');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log('[mock-gateway] listening on 127.0.0.1:' + port);
});
