// 验证 offscreen.js 中的 RTT 时钟校准公式：
//   peerClockOffset = ((t1 - t0) + (t2 - t3)) / 2
// 其中 t0/t3 为本端时钟，t1/t2 为对端时钟；结果 = 对端时钟 - 本端时钟。
// 用法：node tests/clock-sync.test.js

function computeOffset(t0, t1, t2, t3) {
  return (t1 - t0 + (t2 - t3)) / 2;
}

function assertClose(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(
      `断言失败: ${msg} (actual=${actual}, expected=${expected}, tol=${tol})`
    );
  }
}

// 场景 1：对称延迟，时钟偏移 +5000ms（对端快 5 秒）应被精确恢复
{
  const OFFSET = 5000;
  const d1 = 20;
  const d2 = 20;
  const t0 = 0;
  const t1 = t0 + OFFSET + d1; // 对端接收（对端时钟）
  const t2 = t1; // 对端回复
  const t3 = t2 - OFFSET + d2; // 本端接收
  assertClose(computeOffset(t0, t1, t2, t3), OFFSET, 1e-9, '对称延迟下应精确恢复时钟偏移');
}

// 场景 2：非对称延迟 d1=20, d2=80，误差应恰为 (d1-d2)/2 = -30ms
{
  const OFFSET = -2000; // 对端慢 2 秒
  const d1 = 20;
  const d2 = 80;
  const t0 = 0;
  const t1 = t0 + OFFSET + d1;
  const t2 = t1;
  const t3 = t2 - OFFSET + d2;
  assertClose(
    computeOffset(t0, t1, t2, t3),
    OFFSET + (d1 - d2) / 2,
    1e-9,
    '非对称延迟误差应为 (d1-d2)/2'
  );
}

// 场景 3：用偏移校正对端时间戳到本端时钟，得到正确的已流逝时间
{
  const OFFSET = 5000; // 对端 - 本端
  const peerTs = 10000; // 对端时钟下的时间戳
  const myNow = 15000; // 本端当前时间
  const corrected = peerTs - OFFSET; // 换算到本端时钟
  assertClose(myNow - corrected, 10000, 1e-9, '校正后的已流逝时间应正确');
}

console.log('✔ 时钟校准公式测试通过');
