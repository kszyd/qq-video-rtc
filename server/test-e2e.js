// 信令服务端到端协议测试
// 模拟两个客户端：alice(拨号) 与 bob(被叫)，走完整通话流程
const WebSocket = require('ws');

const URL = process.env.URL || 'ws://127.0.0.1:9000';
const results = [];
function check(name, cond) {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
}

function client(id, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const inbox = [];
    const waiters = {};
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', id, name })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'registered') { registered = msg; return; } // 存注册回执
      const w = waiters[msg.type];
      if (w) { delete waiters[msg.type]; w(msg); }
      else inbox.push(msg);
    });
    ws.on('error', reject);
    let registered = null;
    // 等注册回执返回，确保 ws open 且服务端已登记
    const readyTimer = setInterval(() => {
      if (registered) {
        clearInterval(readyTimer);
        // 丢弃注册瞬间的广播(contacts等), 避免污染后续主动查询
        inbox.length = 0;
        resolve(ws);
      }
    }, 20);
    setTimeout(() => { clearInterval(readyTimer); }, 4000);
    ws.next = (type, timeout = 5000) => {
      // 先查收件箱，没有就等
      const idx = inbox.findIndex(m => m.type === type);
      if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
      return new Promise((res, rej) => {
        waiters[type] = res;
        setTimeout(() => rej(new Error('等待 ' + type + ' 超时')), timeout);
      });
    };
    ws.sendMsg = (o) => ws.send(JSON.stringify(o));
    ws.drainInbox = () => { inbox.length = 0; };
  });
}

async function main() {
  const alice = await client('alice', '爱丽丝');
  const bob = await client('bob', '鲍勃');

  // 1. 双方注册后，等广播排空，再主动查询联系人列表
  await new Promise(r => setTimeout(r, 300));
  alice.sendMsg({ type: 'contacts' });
  bob.sendMsg({ type: 'contacts' });
  const aliceContacts = await alice.next('contacts');
  const bobContacts = await bob.next('contacts');
  check('联系人列表含对方且在线', 
    aliceContacts.list.some(u => u.id === 'bob' && u.online) &&
    bobContacts.list.some(u => u.id === 'alice' && u.online));

  // 2. alice 拨号 bob
  alice.sendMsg({ type: 'call', callee: 'bob' });
  const calling = await alice.next('calling');
  const incoming = await bob.next('incoming');
  check('拨号:主叫收到calling', calling.callee === 'bob');
  check('拨号:被叫收到incoming', incoming.caller === 'alice' && incoming.callerName === '爱丽丝');

  // 3. bob 接听
  bob.sendMsg({ type: 'accept', caller: 'alice' });
  const accepted = await alice.next('accepted');
  const peerReady = await bob.next('peer-ready');
  check('接听:主叫收到accepted', accepted.callee === 'bob');
  check('接听:被叫收到peer-ready', peerReady.peer === 'alice');

  // 4. SDP/ICE 双向转发
  alice.sendMsg({ type: 'sdp', to: 'bob', sdp: 'sdp-alice-offer' });
  bob.sendMsg({ type: 'ice', to: 'alice', candidate: 'ice-bob-1' });
  const sdpAtBob = await bob.next('sdp');
  const iceAtAlice = await alice.next('ice');
  check('SDP转发到被叫', sdpAtBob.from === 'alice' && sdpAtBob.sdp === 'sdp-alice-offer');
  check('ICE转发到主叫', iceAtAlice.from === 'bob' && iceAtAlice.candidate === 'ice-bob-1');

  // 5. 挂断
  alice.sendMsg({ type: 'hangup', peer: 'bob' });
  const hangupAtBob = await bob.next('hangup');
  check('挂断通知到被叫', hangupAtBob.by === 'alice');

  // 6. 通话记录
  alice.sendMsg({ type: 'calls' });
  const callsAlice = await alice.next('calls');
  check('通话记录含本次(alice视角)', callsAlice.list.some(c => c.caller === 'alice' && c.callee === 'bob'));
  bob.sendMsg({ type: 'calls' });
  const callsBob = await bob.next('calls');
  check('通话记录含本次(bob视角)', callsBob.list.some(c => c.caller === 'alice' && c.callee === 'bob'));

  // 7. 离线通知
  bob.close();
  await new Promise(r => setTimeout(r, 400));
  alice.drainInbox(); // 清掉积压的 contacts 广播, 只取本次查询结果
  alice.sendMsg({ type: 'contacts' });
  const aliceContacts2 = await alice.next('contacts');
  check('bob离线后,alice联系人状态更新', !aliceContacts2.list.some(u => u.id === 'bob' && u.online));

  alice.close();

  const fails = results.filter(r => !r.pass);
  console.log('\n===== ' + (fails.length ? fails.length + ' 失败' : '全部通过') + ' (' + results.length + ' 项) =====');
  process.exit(fails.length ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃:', e.message); process.exit(1); });