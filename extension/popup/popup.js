const DEFAULT_SIGNAL_URL = 'wss://rpd-together.onrender.com';

const $ = (id) => document.getElementById(id);

const roomInput = $('room');
const passwordInput = $('password');
const nicknameInput = $('nickname');
const signalInput = $('signalUrl');
const joinBtn = $('joinBtn');
const leaveBtn = $('leaveBtn');
const syncBtn = $('syncBtn');
const autoFollow = $('autoFollow');
const testBtn = $('testBtn');
const testInput = $('testText');
const hint = $('hint');
const logEl = $('log');
const stateBadge = $('stateBadge');

const STATE_TEXT = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接（等待对方）',
  synced: '已同步',
  reconnecting: '重连中…',
  error: '错误',
  disconnected: '已断开',
};

function setHint(text) {
  hint.textContent = text || '';
}

function setBadge(status) {
  stateBadge.textContent = STATE_TEXT[status.state] || status.state;
  stateBadge.className = 'badge';
  if (status.state === 'synced') stateBadge.classList.add('synced');
  else if (status.state === 'connected') stateBadge.classList.add('connected');
  else if (status.state === 'error') stateBadge.classList.add('error');
}

function renderStatus(status) {
  setBadge(status);
  $('stState').textContent = STATE_TEXT[status.state] || status.state;
  const members = status.members || [];
  $('memberList').textContent = members.length
    ? members.map((m) => m.nickname).join('、')
    : '—';
  $('stPeer').textContent = status.peer ? '在线' : '—';
  const dcEl = $('stDc');
  dcEl.textContent = status.dataChannel ? '已建立' : '未建立';
  dcEl.className = status.dataChannel ? 'ok' : '';
  if (status.error) setHint(status.error);
}

function appendLog(message) {
  const div = document.createElement('div');
  const time = new Date().toLocaleTimeString();
  if (message.type === 'debug') {
    div.textContent = `[${time}] 🔄 ${message.text}`;
  } else if (message.type === 'hello' || message.type === 'test' || message.type === 'url-offer') {
    div.textContent = `[${time}] ${message.text || message.type}`;
  } else {
    div.textContent = `[${time}] ${JSON.stringify(message)}`;
  }
  logEl.prepend(div);
}

// 接收 offscreen 广播的状态与 DataChannel 消息
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') {
    renderStatus(msg.status);
  } else if (msg.type === 'datachannel-message') {
    appendLog(msg.message);
  }
});

async function joinRoom() {
  const room = roomInput.value.trim();
  const password = passwordInput.value;
  const signalUrl = signalInput.value.trim() || DEFAULT_SIGNAL_URL;
  const nickname = nicknameInput.value.trim() || '匿名';

  if (!room) {
    setHint('请输入房间号');
    return;
  }
  setHint('');
  await chrome.storage.local.set({ room, password, signalUrl, autoFollow: autoFollow.checked, nickname });
  // 确保 offscreen 文档存在（由后台 SW 创建）
  await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
  chrome.runtime.sendMessage({ type: 'join', room, password, signalUrl, nickname }).catch(() => {});
}

joinBtn.addEventListener('click', joinRoom);

leaveBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'leave' }).catch(() => {});
  setHint('');
});

syncBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'sync-current-page' }).catch(() => {});
  setHint('已发送同步请求');
});

autoFollow.addEventListener('change', () => {
  chrome.storage.local.set({ autoFollow: autoFollow.checked });
});

testBtn.addEventListener('click', () => {
  chrome.runtime
    .sendMessage({ type: 'send-test', text: testInput.value || 'hello' })
    .catch(() => {});
});

testInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') testBtn.click();
});

// 初始化：恢复设置（含密码）、拉取状态
chrome.storage.local.get(['room', 'password', 'signalUrl', 'autoFollow', 'nickname'], (v) => {
  if (v.room) roomInput.value = v.room;
  if (v.password) passwordInput.value = v.password;
  signalInput.value = v.signalUrl || DEFAULT_SIGNAL_URL;
  autoFollow.checked = v.autoFollow !== false;
  if (v.nickname) nicknameInput.value = v.nickname;
  chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => {});
});

// 收款码点击放大：在新标签页打开原图，便于扫码
document.querySelectorAll('.qr-img').forEach((img) => {
  img.addEventListener('click', () => {
    const path = img.getAttribute('src').replace('../', '');
    chrome.tabs.create({ url: chrome.runtime.getURL(path) }).catch(() => {});
  });
});
