// RPD通用一起看 offscreen 文档：常驻宿主，持有 WebSocket（信令 + 数据中转）。
// 同步消息直接经信令服务器中转（无需 WebRTC P2P），彻底规避 NAT 穿透问题。

const DEFAULT_SIGNAL_URL = 'wss://rpd-together.onrender.com';

let ws = null;
let room = null;
let signalUrl = DEFAULT_SIGNAL_URL;
let currentPassword = '';
let intentionalLeave = false;
let reconnectTimer = null;
let rejoinDelay = 2000;
let autoFollowSetting = true;
let myNickname = '匿名';

let status = {
  state: 'idle', // idle | connecting | connected | synced | reconnecting | error | disconnected
  room: null,
  role: null,
  peer: false,
  dataChannel: false, // 现在表示「数据通道已建立」（双方都在线，可中转）
  members: [],
  error: null,
};

function postStatus() {
  chrome.runtime.sendMessage({ type: 'status', status: { ...status } }).catch(() => {});
}

function notifyPopup(message) {
  chrome.runtime.sendMessage({ type: 'datachannel-message', message }).catch(() => {});
}

let lastDebugNotify = 0;
function debugNotify(text) {
  const now = Date.now();
  if (now - lastDebugNotify < 2000) return;
  lastDebugNotify = now;
  notifyPopup({ type: 'debug', text });
}

function sendSignal(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendDataToPeer(payload) {
  sendSignal({ type: 'data', payload });
}

async function sendToActiveTab(msg) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'tabs-send-active', message: msg });
    return res && res.result;
  } catch {
    return null;
  }
}

async function requestPageInfoFromActiveTab() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'tabs-send-active',
      message: { __syncwatch: true, type: 'get-page-info' },
    });
    if (res && res.result && res.result.url) return res.result;
  } catch {
    /* ignore */
  }
  return null;
}

// ---------- 信令处理 ----------

function onSignal(msg) {
  switch (msg.type) {
    case 'joined':
      room = msg.room;
      status.peer = msg.peerCount > 1;
      status.dataChannel = msg.peerCount > 1;
      status.state = msg.peerCount > 1 ? 'synced' : 'connected';
      status.members = msg.members || [];
      status.error = null;
      rejoinDelay = 2000;
      postStatus();
      break;

    case 'peer-joined':
      status.peer = true;
      status.dataChannel = true;
      status.state = 'synced';
      status.members = msg.members || [];
      postStatus();
      break;

    case 'peer-left':
      {
        const hasPeer = msg.peerCount > 1;
        status.peer = hasPeer;
        status.dataChannel = hasPeer;
        status.state = hasPeer ? 'synced' : 'connected';
        status.members = msg.members || [];
        postStatus();
      }
      break;

    case 'error':
      status.state = 'error';
      status.error = msg.message || msg.code;
      postStatus();
      if (msg.code === 'ROOM_FULL') scheduleRejoin();
      break;

    case 'data':
      handleData(msg.payload);
      break;

    default:
      break;
  }
}

function handleData(payload) {
  if (!payload) return;
  if (payload.type === 'video-state') {
    const nick = payload.payload && payload.payload.nickname;
    debugNotify((nick ? nick + ' ' : '') + '调整了进度');
    sendToActiveTab({ type: 'video-state', payload: payload.payload });
  } else if (payload.type === 'url-sync') {
    const nick = payload.payload && payload.payload.nickname;
    debugNotify((nick ? nick + ' ' : '') + '同步了页面');
    handleIncomingUrlSync(payload.payload);
  } else {
    notifyPopup(payload);
  }
}

function setError(context, err) {
  status.state = 'error';
  status.error = context + ': ' + (err?.message || err);
  postStatus();
}

// ---------- 连接与重连 ----------

function scheduleRejoin() {
  if (reconnectTimer || intentionalLeave || status.state === 'idle') return;
  status.state = 'reconnecting';
  postStatus();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!intentionalLeave && room) {
      join({ room, password: currentPassword, signalUrl });
    }
  }, rejoinDelay);
  rejoinDelay = Math.min(rejoinDelay * 2, 30000);
}

function join({ room: roomId, password, signalUrl: url, nickname }) {
  if (room === roomId && ws && ws.readyState === WebSocket.OPEN && status.state !== 'idle') {
    postStatus();
    return;
  }

  teardown();
  intentionalLeave = false;
  currentPassword = password;
  myNickname = String(nickname || '').trim() || '匿名';
  room = roomId;
  signalUrl = url || DEFAULT_SIGNAL_URL;
  status = {
    state: 'connecting',
    room: roomId,
    role: null,
    peer: false,
    dataChannel: false,
    members: [],
    error: null,
  };
  postStatus();

  try {
    const socket = new WebSocket(signalUrl);
    ws = socket;

    socket.onopen = () => sendSignal({ type: 'join', room: roomId, password, nickname: myNickname });

    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onSignal(msg);
    };

    socket.onclose = () => {
      if (ws !== socket) return;
      if (intentionalLeave || status.state === 'idle') return;
      status.state = 'disconnected';
      postStatus();
      scheduleRejoin();
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      if (status.state === 'idle') return;
      status.state = 'error';
      status.error = '无法连接信令服务器：' + signalUrl;
      postStatus();
      scheduleRejoin();
    };
  } catch (e) {
    setError('创建信令连接失败', e);
    scheduleRejoin();
  }
}

// ---------- 页面同步 ----------

let pendingVideoState = null;
let pendingVideoUrl = null;
let pendingRetryTimer = null;
let pendingRetryCount = 0;

function handleIncomingUrlSync(payload) {
  notifyPopup({ type: 'debug', text: 'handleIncomingUrlSync 被调用' });
  const url = payload && payload.url;
  const video = payload && payload.video;
  console.log('[SyncWatch:offscreen] handleIncomingUrlSync 进入, url=', url, 'video=', video, 'autoFollow=', autoFollowSetting);

  if (autoFollowSetting && url) {
    pendingVideoState = video || null;
    pendingVideoUrl = url;
    notifyPopup({ type: 'debug', text: '正在请求打开页面…' });
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        notifyPopup({ type: 'debug', text: '❌ 打开页面超时（SW 未响应）' });
      }
    }, 3000);
    chrome.runtime
      .sendMessage({ type: 'navigate-active', url })
      .then((res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        notifyPopup({ type: 'debug', text: res && res.ok ? '✅ 已打开对方页面' : '❌ 打开页面失败' });
        if (res && res.ok && pendingVideoState) startPendingVideoRetry();
      })
      .catch((e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        notifyPopup({ type: 'debug', text: '❌ 打开页面异常: ' + (e && e.message) });
      });
  } else if (!autoFollowSetting) {
    notifyPopup({ type: 'url-offer', text: `对方分享页面：${url || ''}` });
  }
}

function startPendingVideoRetry() {
  if (pendingRetryTimer) clearTimeout(pendingRetryTimer);
  pendingRetryCount = 0;
  const step = () => {
    const st = pendingVideoState;
    if (!st || pendingRetryCount >= 5) {
      pendingRetryTimer = null;
      return;
    }
    pendingRetryCount++;
    sendToActiveTab({
      type: 'video-state',
      payload: {
        action: 'sync',
        currentTime: st.currentTime,
        playing: !!st.playing,
        playbackRate: st.playbackRate || 1,
        ts: Date.now(),
        url: pendingVideoUrl,
      },
    });
    pendingRetryTimer = setTimeout(step, 2000);
  };
  step();
}

let lastSyncPageUrl = null;
let lastSyncPageAt = 0;

function handleSyncPage(msg) {
  const url = msg && msg.url;
  if (!url) {
    notifyPopup({ type: 'debug', text: '❌ 未获取到 URL' });
    return;
  }
  const now = Date.now();
  if (url === lastSyncPageUrl && now - lastSyncPageAt < 500) return;
  lastSyncPageUrl = url;
  lastSyncPageAt = now;
  notifyPopup({ type: 'debug', text: '同步页面: ' + url.slice(0, 60) });
  sendDataToPeer({ type: 'url-sync', payload: { url, title: msg.title, video: msg.video || null, nickname: myNickname } });
}

function sendTest(text) {
  sendDataToPeer({ type: 'test', text: text || 'hello', ts: Date.now() });
}

// ---------- 视频状态（去重） ----------

let lastVideoKey = null;
let lastVideoAt = 0;

function sendVideoToPeer(payload) {
  if (!payload) return;
  const key = payload.action + ':' + payload.ts;
  const now = Date.now();
  if (key === lastVideoKey && now - lastVideoAt < 200) return;
  lastVideoKey = key;
  lastVideoAt = now;
  sendDataToPeer({ type: 'video-state', payload: { ...payload, nickname: myNickname } });
}

// ---------- 清理 ----------

function teardown() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pendingRetryTimer) {
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
  }
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  ws = null;
}

function doLeave() {
  intentionalLeave = true;
  teardown();
  status = {
    state: 'idle',
    room: null,
    role: null,
    peer: false,
    dataChannel: false,
    error: null,
  };
  postStatus();
}

// ---------- 接收来自 popup / content 的消息 ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'join':
      join(msg);
      break;
    case 'send-test':
      sendTest(msg.text);
      break;
    case 'get-status':
      postStatus();
      sendResponse({ ok: true });
      break;
    case 'leave':
      doLeave();
      break;
    case 'sync-page':
    case 'dc-sync-page':
      handleSyncPage(msg);
      break;
    case 'sync-current-page':
      requestPageInfoFromActiveTab().then((info) => {
        if (info && info.url) {
          debugNotify('同步页面: ' + info.url.slice(0, 60));
          sendDataToPeer({ type: 'url-sync', payload: { url: info.url, title: info.title, video: null } });
        } else {
          debugNotify('同步页面失败: 未获取到 URL');
        }
      });
      break;
    case 'video-state':
    case 'dc-video-state':
      sendVideoToPeer(msg.payload);
      break;
    default:
      break;
  }
});

// 启动时若有已保存凭据，自动重连
chrome.storage.local.get(['room', 'password', 'signalUrl', 'autoFollow', 'nickname'], (v) => {
  autoFollowSetting = v.autoFollow !== false;
  if (v.room) {
    join({
      room: v.room,
      password: v.password || '',
      signalUrl: v.signalUrl || DEFAULT_SIGNAL_URL,
      nickname: v.nickname,
    });
  } else {
    postStatus();
  }
});
