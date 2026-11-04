// 诊断: 注册两个客户端后, 查询 contacts 原始返回
const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:9000';

function reg(id, name) {
  return new Promise((res) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', id, name })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'registered') {
        ws.reg = m;
        ws.send2 = (o) => ws.send(JSON.stringify(o));
        res(ws);
      } else {
        console.log('[' + id + '] 收到:', JSON.stringify(m));
      }
    });
  });
}

(async () => {
  const a = await reg('alice', '爱丽丝');
  const b = await reg('bob', '鲍勃');
  // 两方都注册完, 稍等让在线状态更新
  setTimeout(() => {
    console.log('--- alice 查询 contacts ---');
    a.send2({ type: 'contacts' });
  }, 500);
  setTimeout(() => {
    console.log('--- bob 查询 contacts ---');
    b.send2({ type: 'contacts' });
  }, 800);
  setTimeout(() => process.exit(0), 2000);
})();