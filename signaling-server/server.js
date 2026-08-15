import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);

/**
 * 房间结构：
 * rooms: Map<roomId, { password: string, members: Map<clientId, { ws, role }> }>
 * role: 'offerer' | 'answerer'（先进入者为 offerer，负责发起 offer）
 */

const rooms = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`[signaling] listening on ws://0.0.0.0:${PORT}`);
});

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function findPeer(room, selfId) {
  for (const [id, member] of room.members) {
    if (id !== selfId) return member;
  }
  return null;
}

const MAX_MEMBERS = 20;

function memberList(room) {
  return Array.from(room.members.entries()).map(([id, m]) => ({ id, nickname: m.nickname }));
}

function handleJoin(ws, msg) {
  const roomId = String(msg.room || '').trim();
  const password = String(msg.password ?? '');

  if (!roomId) {
    return send(ws, { type: 'error', code: 'BAD_ROOM', message: '房间号不能为空' });
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = { password, members: new Map() };
    rooms.set(roomId, room);
  }

  if (room.password !== password) {
    return send(ws, { type: 'error', code: 'WRONG_PASSWORD', message: '密码错误' });
  }

  if (room.members.size >= MAX_MEMBERS) {
    return send(ws, { type: 'error', code: 'ROOM_FULL', message: '房间已满' });
  }

  const nickname = String(msg.nickname || '').trim() || '匿名';
  ws.roomId = roomId;
  room.members.set(ws.id, { ws, nickname });

  send(ws, { type: 'joined', room: roomId, peerCount: room.members.size, members: memberList(room) });

  // 通知所有成员当前人数（含新成员）
  for (const [, member] of room.members) {
    send(member.ws, { type: 'peer-joined', peerCount: room.members.size, members: memberList(room) });
  }
}

function broadcast(ws, msg) {
  const room = ws.roomId ? rooms.get(ws.roomId) : null;
  if (!room) return;
  for (const [id, member] of room.members) {
    if (id !== ws.id) send(member.ws, msg);
  }
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (msg.type) {
    case 'join':
      return handleJoin(ws, msg);
    case 'offer':
    case 'answer':
    case 'ice':
    case 'data':
      return broadcast(ws, msg);
    case 'ping':
      return send(ws, { type: 'pong', ts: Date.now() });
    default:
      return;
  }
}

function leave(ws) {
  if (!ws.roomId) return;
  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.members.delete(ws.id);

  if (room.members.size === 0) {
    rooms.delete(ws.roomId);
  } else {
    for (const [, member] of room.members) {
      send(member.ws, { type: 'peer-left', peerCount: room.members.size, members: memberList(room) });
    }
  }
  ws.roomId = null;
}

wss.on('connection', (ws) => {
  ws.id = 'c' + nextId++;
  ws.roomId = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => handleMessage(ws, raw));

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// 心跳：清理失联连接
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);
