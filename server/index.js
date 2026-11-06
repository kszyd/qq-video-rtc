// 信令服务 - 主服务
// WebSocket 服务：设备注册、联系人列表、拨号/接听/挂断、SDP/ICE 转发、通话记录、群聊
const WebSocket = require('ws');
const http = require('http');
const store = require('./store');

const PORT = process.env.SIGNAL_PORT || 9001;
const PUBLIC_URL = process.env.PUBLIC_URL || 'ws://192.168.199.100:9001';
const TURN_URL = process.env.TURN_URL || 'turn:192.168.199.100:3478?transport=udp';
const TURN_USER = process.env.TURN_USER || 'videotv';
const TURN_PASS = process.env.TURN_PASS || 'videotv123';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/' || req.url === '/index.html') {
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, 'public', 'index.html');
    try {
      const html = fs.readFileSync(file);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    } catch (e) {
      res.writeHead(500);
      res.end('index.html 未找到');
      return;
    }
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, online: store.online.size }));
    return;
  }
  res.end(JSON.stringify({ ok: true, service: 'videotv' }));
});

const wss = new WebSocket.Server({ server });

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
function sendError(ws, msg) {
  send(ws, { type: 'error', message: msg });
}

wss.on('connection', (ws) => {
  ws.userId = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { sendError(ws, '非法JSON'); return; }
    handle(ws, msg);
  });
  ws.on('close', () => {
    if (ws.userId) {
      store.setOffline(ws.userId);
      broadcastOnline();
    }
  });
});

function handle(ws, msg) {
  switch (msg.type) {
    case 'register': return onRegister(ws, msg);
    case 'contacts': return onContacts(ws);
    case 'call': return onCall(ws, msg);
    case 'accept': return onAccept(ws, msg);
    case 'reject': return onReject(ws, msg);
    case 'hangup': return onHangup(ws, msg);
    case 'sdp': return onSdp(ws, msg);
    case 'ice': return onIce(ws, msg);
    case 'calls': return onCalls(ws, msg);
    // 群组相关
    case 'group-create': return onGroupCreate(ws, msg);
    case 'group-invite': return onGroupInvite(ws, msg);
    case 'group-call': return onGroupCall(ws, msg);
    case 'group-join': return onGroupJoin(ws, msg);
    default: sendError(ws, '未知消息类型: ' + msg.type);
  }
}

function onRegister(ws, msg) {
  if (!msg.id) { sendError(ws, '缺少id'); return; }
  const id = String(msg.id);
  const old = store.getWs(id);
  if (old && old !== ws) {
    send(old, { type: 'kicked', message: '该账号已在其他设备登录' });
    try { old.close(); } catch (e) {}
  }
  store.upsertUser(id, msg.name);
  store.setOnline(id, ws);
  ws.userId = id;
  send(ws, {
    type: 'registered',
    id,
    name: store.getUser(id).name,
    serverInfo: { publicUrl: PUBLIC_URL, turn: { url: TURN_URL, username: TURN_USER, credential: TURN_PASS } },
  });
  broadcastOnline();
}

function onContacts(ws) {
  send(ws, { type: 'contacts', list: store.listUsers() });
}

function onCall(ws, msg) {
  const caller = ws.userId;
  if (!caller) { sendError(ws, '未注册'); return; }
  const callee = String(msg.callee);
  const u = store.getUser(callee);
  if (!u) { sendError(ws, '对方不存在'); return; }
  if (!store.isOnline(callee)) {
    store.addCall({ caller, callee, start: Date.now(), status: 'missed', type: 'single' });
    send(ws, { type: 'callee-offline', callee });
    return;
  }
  send(store.getWs(callee), { type: 'incoming', caller, callerName: store.getUser(caller).name });
  send(ws, { type: 'calling', callee, calleeName: u.name });
}

function onAccept(ws, msg) {
  const callee = ws.userId;
  if (!callee) { sendError(ws, '未注册'); return; }
  const caller = String(msg.caller);
  const callerWs = store.getWs(caller);
  if (!callerWs) { sendError(ws, '主叫已离线'); return; }
  store.addCall({ caller, callee, start: Date.now(), status: 'active', type: 'single' });
  send(callerWs, { type: 'accepted', callee, calleeName: store.getUser(callee).name });
  send(ws, { type: 'peer-ready', peer: caller, peerName: store.getUser(caller).name });
}

function onReject(ws, msg) {
  const callee = ws.userId;
  if (!callee) { sendError(ws, '未注册'); return; }
  const caller = String(msg.caller);
  const callerWs = store.getWs(caller);
  if (callerWs) {
    store.addCall({ caller, callee, start: Date.now(), status: 'rejected', type: 'single' });
    send(callerWs, { type: 'rejected', callee });
  }
}

function onHangup(ws, msg) {
  const who = ws.userId;
  if (!who) return;
  const peer = String(msg.peer);
  const peerWs = store.getWs(peer);
  if (peerWs) send(peerWs, { type: 'hangup', by: who });
  
  // 结束通话记录
  const activeCall = store.listCalls(who).find(c => c.status === 'active' && (c.caller === who || c.callee === who));
  if (activeCall) store.updateCall(activeCall.id, { end: Date.now(), status: 'ended' });
}

function onSdp(ws, msg) {
  const from = ws.userId;
  const to = String(msg.to);
  const toWs = store.getWs(to);
  if (toWs) send(toWs, { type: 'sdp', from, sdp: msg.sdp });
}

function onIce(ws, msg) {
  const from = ws.userId;
  const to = String(msg.to);
  const toWs = store.getWs(to);
  if (toWs) send(toWs, { type: 'ice', from, candidate: msg.candidate });
}

function onCalls(ws, msg) {
  if (!ws.userId) return;
  // 管理端(不传self)看全部记录；普通用户传self看自己的
  if (msg.self) {
    send(ws, { type: 'calls', list: store.listCalls(String(msg.self)) });
  } else {
    send(ws, { type: 'calls', list: store.listCalls() });
  }
}

// ---------------- 群组信令 (Mesh 拓扑) ----------------
function onGroupCreate(ws, msg) {
  const ownerId = ws.userId;
  if (!ownerId) { sendError(ws, '未注册'); return; }
  const group = store.createGroup(ownerId, msg.name || '新群组');
  send(ws, { type: 'group-created', group });
}

function onGroupInvite(ws, msg) {
  const inviter = ws.userId;
  if (!inviter) { sendError(ws, '未注册'); return; }
  const { gid, targetId } = msg;
  const group = store.addUserToGroup(gid, targetId);
  if (!group) { sendError(ws, '群组不存在'); return; }
  
  const targetWs = store.getWs(targetId);
  if (targetWs) {
    send(targetWs, { type: 'group-invited', gid, groupName: group.name, inviter });
  }
  send(ws, { type: 'group-invited-ok', gid, targetId });
}

function onGroupCall(ws, msg) {
  const caller = ws.userId;
  if (!caller) { sendError(ws, '未注册'); return; }
  const { gid } = msg;
  const group = store.getGroup(gid);
  if (!group) { sendError(ws, '群组不存在'); return; }

  // 1. 记录群通话
  store.addCall({ caller, callee: 'group', groupId: gid, start: Date.now(), status: 'active', type: 'group' });

  // 2. 通知所有在线成员 (除了自己)
  group.members.forEach(mid => {
    if (mid === caller) return;
    const midWs = store.getWs(mid);
    if (midWs) {
      send(midWs, { type: 'incoming-group', gid, caller, callerName: store.getUser(caller).name, members: group.members });
    }
  });
  send(ws, { type: 'group-calling', gid, members: group.members });
}

function onGroupJoin(ws, msg) {
  const joiner = ws.userId;
  if (!joiner) { sendError(ws, '未注册'); return; }
  const { gid } = msg;
  const group = store.getGroup(gid);
  if (!group) { sendError(ws, '群组不存在'); return; }

  // 通知群内所有其他在线成员：有人加入了，现在请与我建连接
  group.members.forEach(mid => {
    if (mid === joiner) return;
    const midWs = store.getWs(mid);
    if (midWs) {
      send(midWs, { type: 'group-member-joined', gid, joiner, joinerName: store.getUser(joiner).name });
    }
  });
  send(ws, { type: 'group-joined-ok', gid, members: group.members });
}

function broadcastOnline() {
  const list = store.listUsers();
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.userId) {
      send(c, { type: 'contacts', list });
    }
  });
}

server.listen(PORT, () => {
  console.log(`[signal] listening on :${PORT}`);
  console.log(`[signal] public: ${PUBLIC_URL}`);
  console.log(`[signal] turn: ${TURN_URL} (${TURN_USER})`);
});