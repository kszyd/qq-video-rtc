// 信令服务 - 主服务
// WebSocket 服务：设备注册、联系人列表、拨号/接听/挂断、SDP/ICE 转发、通话记录
// 并发5路以下，纯JSON文件存储够用
const WebSocket = require('ws');
const http = require('http');
const store = require('./store');

const PORT = process.env.SIGNAL_PORT || 9001;
const PUBLIC_URL = process.env.PUBLIC_URL || 'ws://127.0.0.1:9001';
const TURN_URL = process.env.TURN_URL || 'turn:127.0.0.1:3478?transport=udp';
const TURN_USER = process.env.TURN_USER || 'qqvideo';
const TURN_PASS = process.env.TURN_PASS || 'qqvideo123';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 静态页面
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
  // 简单健康检查
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, online: store.online.size }));
    return;
  }
  res.end(JSON.stringify({ ok: true, service: 'qqvideo-signaling' }));
});

const wss = new WebSocket.Server({ server });

// 消息发送工具
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
function sendError(ws, msg) {
  send(ws, { type: 'error', message: msg });
}

// 每个连接挂一个 id
wss.on('connection', (ws) => {
  ws.userId = null;
  console.log('[conn] 新连接');

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      sendError(ws, '非法JSON');
      return;
    }
    handle(ws, msg);
  });

  ws.on('close', () => {
    if (ws.userId) {
      store.setOffline(ws.userId);
      broadcastOnline();
      console.log('[conn] 离线', ws.userId);
    }
  });

  ws.on('error', () => {});
});

// ---------------- 消息处理 ----------------
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
    default:
      sendError(ws, '未知消息类型: ' + msg.type);
  }
}

// 注册/登录：参数 {id, name}
function onRegister(ws, msg) {
  if (!msg.id) { sendError(ws, '缺少id'); return; }
  const id = String(msg.id);
  // 踢掉旧连接（同一设备重复登录）
  const old = store.getWs(id);
  if (old && old !== ws) {
    old.userId = null; // 标记为已顶替，旧连接发消息会被忽略
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
  console.log('[register]', id);
}

// 联系人列表
function onContacts(ws) {
  send(ws, { type: 'contacts', list: store.listUsers() });
}

// 拨号：{callee}
function onCall(ws, msg) {
  const caller = ws.userId;
  if (!caller) { sendError(ws, '未注册'); return; }
  const callee = String(msg.callee);
  const u = store.getUser(callee);
  if (!u) { sendError(ws, '对方不存在'); return; }
  if (!store.isOnline(callee)) {
    // 记录一次未接来电
    store.addCall({ caller, callee, start: Date.now(), status: 'missed' });
    send(ws, { type: 'callee-offline', callee });
    return;
  }
  // 通知被叫：incoming
  send(store.getWs(callee), { type: 'incoming', caller, callerName: store.getUser(caller).name });
  send(ws, { type: 'calling', callee, calleeName: u.name });
}

// 接听
function onAccept(ws, msg) {
  const callee = ws.userId;
  if (!callee) { sendError(ws, '未注册'); return; }
  const caller = String(msg.caller);
  const callerWs = store.getWs(caller);
  if (!callerWs) { sendError(ws, '主叫已离线'); return; }
  store.addCall({ caller, callee, start: Date.now(), status: 'active' });
  send(callerWs, { type: 'accepted', callee, calleeName: store.getUser(callee).name });
  send(ws, { type: 'peer-ready', peer: caller, peerName: store.getUser(caller).name });
}

// 拒接
function onReject(ws, msg) {
  const callee = ws.userId;
  if (!callee) { sendError(ws, '未注册'); return; }
  const caller = String(msg.caller);
  const callerWs = store.getWs(caller);
  if (callerWs) {
    store.addCall({ caller, callee, start: Date.now(), status: 'rejected' });
    send(callerWs, { type: 'rejected', callee });
  }
}

// 挂断
function onHangup(ws, msg) {
  const who = ws.userId;
  if (!who) return;
  const peer = String(msg.peer);
  const peerWs = store.getWs(peer);
  if (peerWs) send(peerWs, { type: 'hangup', by: who });
  // 通话记录在这里补结束时间(如果有对应活动通话)
  // 简单的处理：通知对面即可，记录由accept时那条补
}

// SDP 转发: {to, sdp}
function onSdp(ws, msg) {
  const from = ws.userId;
  const to = String(msg.to);
  const toWs = store.getWs(to);
  if (toWs) {
    send(toWs, { type: 'sdp', from, sdp: msg.sdp });
  } else {
    sendError(ws, '对方已离线');
  }
}

// ICE 转发: {to, candidate}
function onIce(ws, msg) {
  const from = ws.userId;
  const to = String(msg.to);
  const toWs = store.getWs(to);
  if (toWs) {
    send(toWs, { type: 'ice', from, candidate: msg.candidate });
  }
}

// 通话记录查询
function onCalls(ws, msg) {
  if (!ws.userId) return;
  const userId = msg.self || ws.userId;
  send(ws, { type: 'calls', list: store.listCalls(userId) });
}

// 广播在线状态变化
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