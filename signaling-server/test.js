// 信令服务器自检脚本：验证房间/密码/多人广播/掉线
// 用法：先启动服务器（npm start），再执行 node test.js
import WebSocket from 'ws';

const SIGNAL_URL = process.env.SIGNAL_URL || 'ws://localhost:8787';

function assert(cond, message) {
  if (!cond) throw new Error('断言失败: ' + message);
}

function makeClient(label) {
  const ws = new WebSocket(SIGNAL_URL);
  const pending = []; // 已收到但尚未被消费的消息
  const waiters = []; // 等待特定类型的消费者
  const log = [];

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    log.push(msg);
    const wi = waiters.findIndex((w) => w.type === msg.type);
    if (wi >= 0) {
      const w = waiters.splice(wi, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      pending.push(msg);
    }
  });

  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  return {
    ws,
    log,
    async open() {
      await opened;
      return this;
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    wait(type, timeout = 3000) {
      const idx = pending.findIndex((m) => m.type === type);
      if (idx >= 0) return Promise.resolve(pending.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.timer === timer);
          if (i >= 0) waiters.splice(i, 1);
          reject(
            new Error(
              `${label}: 等待 "${type}" 超时。已收到: ${JSON.stringify(log)}`
            )
          );
        }, timeout);
        waiters.push({ type, resolve, reject, timer });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function main() {
  const A = await makeClient('A').open();
  const B = await makeClient('B').open();
  const C = await makeClient('C').open();

  // 1. A 首次进入 -> 创建房间，peerCount=1
  A.send({ type: 'join', room: 'r1', password: '123' });
  const aJoined = await A.wait('joined');
  assert(aJoined.peerCount === 1, 'A 加入后 peerCount 应为 1');

  // 2. B 错误密码被拒，正确加入 -> peerCount=2
  B.send({ type: 'join', room: 'r1', password: 'bad' });
  const bErr = await B.wait('error');
  assert(bErr.code === 'WRONG_PASSWORD', 'B 错误密码应被拒绝');

  B.send({ type: 'join', room: 'r1', password: '123' });
  const bJoined = await B.wait('joined');
  assert(bJoined.peerCount === 2, 'B 加入后 peerCount 应为 2');
  await A.wait('peer-joined');
  await B.wait('peer-joined');

  // 3. C 加入（多人，不再 ROOM_FULL）-> peerCount=3
  C.send({ type: 'join', room: 'r1', password: '123' });
  const cJoined = await C.wait('joined');
  assert(cJoined.peerCount === 3, 'C 加入后 peerCount 应为 3（多人）');
  await A.wait('peer-joined');
  await B.wait('peer-joined');
  await C.wait('peer-joined');

  // 4. data 广播：A 发 data，B 和 C 都应收到
  A.send({ type: 'data', payload: { type: 'test', text: 'hello-multi' } });
  const bData = await B.wait('data');
  const cData = await C.wait('data');
  assert(bData.payload.text === 'hello-multi', 'B 应收到 A 的 data');
  assert(cData.payload.text === 'hello-multi', 'C 应收到 A 的 data');

  // 5. 掉线：A 断开，B 和 C 应收到 peer-left（peerCount=2）
  A.close();
  const bLeft = await B.wait('peer-left');
  const cLeft = await C.wait('peer-left');
  assert(bLeft.peerCount === 2, 'A 离开后 B 的 peerCount 应为 2');
  assert(cLeft.peerCount === 2, 'A 离开后 C 的 peerCount 应为 2');

  B.close();
  C.close();
  console.log('✔ 信令服务器全部测试通过');
  process.exit(0);
}

main().catch((err) => {
  console.error('✘ 测试失败:', err.message);
  process.exit(1);
});
