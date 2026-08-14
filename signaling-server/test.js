// 信令服务器自检脚本：验证房间/密码/双人协商/消息透传
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

  // 1. A 首次进入 -> 创建房间，密码以其输入的为准，成为 offerer
  A.send({ type: 'join', room: 'r1', password: '123' });
  const aJoined = await A.wait('joined');
  assert(aJoined.role === 'offerer', '首位成员应为 offerer');
  assert(aJoined.peerCount === 1, '加入后 peerCount 应为 1');

  // 2. B 加入（先验证错误密码，再正确加入）
  B.send({ type: 'join', room: 'r1', password: 'bad' });
  const bErr = await B.wait('error');
  assert(bErr.code === 'WRONG_PASSWORD', 'B 错误密码应被拒绝');

  B.send({ type: 'join', room: 'r1', password: '123' });
  const bJoined = await B.wait('joined');
  assert(bJoined.role === 'answerer', '次位成员应为 answerer');

  await A.wait('peer-joined');
  await B.wait('peer-joined');

  // 3. 消息透传：offer / answer / ice
  A.send({ type: 'offer', sdp: { type: 'offer', sdp: 'fake-offer' } });
  const bOffer = await B.wait('offer');
  assert(bOffer.sdp.sdp === 'fake-offer', 'offer 应透传给 B');

  B.send({ type: 'answer', sdp: { type: 'answer', sdp: 'fake-answer' } });
  const aAnswer = await A.wait('answer');
  assert(aAnswer.sdp.sdp === 'fake-answer', 'answer 应透传给 A');

  A.send({ type: 'ice', candidate: { candidate: 'candidate-1' } });
  const bIce = await B.wait('ice');
  assert(bIce.candidate.candidate === 'candidate-1', 'ice 应透传给 B');

  // 4. 房间满：第三人应被拒绝
  const C = await makeClient('C').open();
  C.send({ type: 'join', room: 'r1', password: '123' });
  const cErr = await C.wait('error');
  assert(cErr.code === 'ROOM_FULL', '第三人应被拒绝（ROOM_FULL）');
  C.close();

  // 5. 掉线：A 断开，B 应收到 peer-left
  A.close();
  const bLeft = await B.wait('peer-left');
  assert(bLeft.peerCount === 1, 'A 离开后 B 的 peerCount 应为 1');

  // 6. 重连：A 重新加入，应获得与现存成员(B, answerer)相反的角色 -> offerer
  const A2 = await makeClient('A2').open();
  A2.send({ type: 'join', room: 'r1', password: '123' });
  const a2Joined = await A2.wait('joined');
  assert(a2Joined.role === 'offerer', '重连者应获得与现存成员相反的角色（offerer）');

  await B.wait('peer-joined');
  await A2.wait('peer-joined');

  // 7. 重连后消息透传仍正常
  A2.send({ type: 'offer', sdp: { type: 'offer', sdp: 're-offer' } });
  const bReoffer = await B.wait('offer');
  assert(bReoffer.sdp.sdp === 're-offer', '重连后 offer 仍应透传给 B');

  A2.close();
  B.close();
  console.log('✔ 信令服务器全部测试通过');
  process.exit(0);
}

main().catch((err) => {
  console.error('✘ 测试失败:', err.message);
  process.exit(1);
});
