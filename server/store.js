// 信令服务 - 数据存储层
// 联系人 + 通话记录，持久化到 /data 目录(JSON文件)，容器重启不丢
// 并发5路以下，纯JSON文件够用；量大再换SQLite

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CALLS_FILE = path.join(DATA_DIR, 'calls.json');

// ---------------- 工具 ----------------
function load(file, def) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error('[store] load失败', file, e.message);
  }
  return def;
}
function save(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[store] save失败', file, e.message);
  }
}

// 内存态: id -> {ws, status}
const online = new Map();

// ---------------- 用户(联系人) ----------------
// users: { "id": {id, name, avatar, created} }
let users = load(USERS_FILE, {});

function upsertUser(id, name) {
  if (!users[id]) {
    users[id] = { id, name: name || id, avatar: '', created: Date.now() };
  } else {
    users[id].name = name || users[id].name;
  }
  users[id].lastSeen = Date.now();
  save(USERS_FILE, users);
  return users[id];
}

function listUsers() {
  return Object.values(users).map(u => ({
    ...u,
    online: online.has(u.id),
  }));
}

function getUser(id) {
  return users[id] || null;
}

// ---------------- 通话记录 ----------------
// calls: [{id, caller, callee, start, end, duration, status}]
let calls = load(CALLS_FILE, []);

function addCall(rec) {
  calls.push({ id: 'c' + Date.now() + Math.floor(Math.random() * 1000), ...rec });
  if (calls.length > 500) calls = calls.slice(-500); // 只留最近500条
  save(CALLS_FILE, calls);
  return calls[calls.length - 1];
}

function updateCall(id, patch) {
  const c = calls.find(x => x.id === id);
  if (c) Object.assign(c, patch);
  save(CALLS_FILE, calls);
  return c;
}

function listCalls(userId) {
  return calls
    .filter(c => c.caller === userId || c.callee === userId)
    .sort((a, b) => b.start - a.start);
}

// ---------------- 在线 ----------------
function setOnline(id, ws) {
  online.set(id, ws);
  const u = users[id];
  if (u) { u.online = true; u.lastSeen = Date.now(); }
}
function setOffline(id) {
  online.delete(id);
  const u = users[id];
  if (u) { u.online = false; u.lastSeen = Date.now(); }
}
function getWs(id) {
  return online.get(id) || null;
}
function isOnline(id) {
  return online.has(id);
}

module.exports = {
  upsertUser, listUsers, getUser,
  addCall, updateCall, listCalls,
  setOnline, setOffline, getWs, isOnline, online,
};