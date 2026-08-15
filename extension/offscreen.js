// SyncWatch offscreen 文档：常驻宿主，持有 WebSocket（信令）与 RTCPeerConnection + DataChannel（P2P）。
// 同时是数据路由中枢：直接与 content script（chrome.tabs）和 popup（chrome.runtime）通信，
// 不依赖后台 SW 转发，避免 SW 被回收后断连。

const DEFAULT_SIGNAL_URL = 'wss://rpd-together.onrender.com';

// 免费 STUN（Google）+ 免费 TURN 兜底（Open Relay Project）
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

let ws = null;
let pc = null;
let dataChannel = null;
let room = null;
let signalUrl = DEFAULT_SIGNAL_URL;
let currentPassword = '';

let intentionalLeave = false;
let reconnectTimer = null;
let rejoinDelay = 2000;
let renegotiateTimer = null;
let clockSyncTimer = null;
let peerClockOffset = 0; // 对端时钟 - 本端时钟（毫秒）
let autoFollowSetting = true; // 加载时读取一次，避免每次收消息都查 storage

let status = {
  state: 'idle', // idle | connecting | connected | synced | reconnecting | error | disconnected
  room: null,
  role: null, // offerer | answerer
  peer: false,
  dataChannel: false,
  error: null,
};

// ---------- 对外通信 ----------

function postStatus() {
  chrome.runtime.sendMessage({ type: 'status', status: { ...status } }).catch(() => {});
}

function notifyPopup(message) {
  chrome.runtime.sendMessage({ type: 'datachannel-message', message }).catch(() => {});
}

// 节流：把关键视频事件同步显示到 popup 日志，便于诊断（无需看 offscreen 控制台）
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

async function sendToActiveTab(msg) {
  // 经 SW 执行 chrome.tabs（offscreen 文档可能没有 chrome.tabs 权限）
  try {
    const res = await chrome.runtime.sendMessage({ type: 'tabs-send-active', message: msg });
    return res && res.result;
  } catch {
    return null;
  }
}

async function requestPageInfoFromActiveTab() {
  // 经 SW 执行 chrome.tabs（同上）
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
      status.role = msg.role;
      status.state = 'connected';
      status.error = null;
      rejoinDelay = 2000;
      postStatus();
      ensurePeer();
      break;

    case 'peer-joined':
      status.peer = true;
      postStatus();
      ensurePeer();
      if (status.role === 'offerer') createOffer();
      break;

    case 'offer':
      ensurePeer();
      pc.setRemoteDescription(msg.sdp)
        .then(() => createAnswer())
        .catch((e) => setError('设置远端 offer 失败', e));
      break;

    case 'answer':
      pc.setRemoteDescription(msg.sdp).catch((e) => setError('设置远端 answer 失败', e));
      break;

    case 'ice':
      pc?.addIceCandidate(msg.candidate).catch(() => {
        /* 忽略过期 candidate */
      });
      break;

    case 'peer-left':
      status.peer = false;
      status.dataChannel = false;
      status.state = 'connected';
      teardownPeer();
      postStatus();
      break;

    case 'error':
      status.state = 'error';
      status.error = msg.message || msg.code;
      postStatus();
      if (msg.code === 'ROOM_FULL') scheduleRejoin();
      break;

    default:
      break;
  }
}

function setError(context, err) {
  status.state = 'error';
  status.error = context + ': ' + (err?.message || err);
  postStatus();
}

// ---------- WebRTC ----------

function ensurePeer() {
  if (pc) return;
  pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal({ type: 'ice', candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      status.peer = false;
      status.dataChannel = false;
      postStatus();
    }
  };

  if (status.role === 'offerer') {
    dataChannel = pc.createDataChannel('sync');
    setupDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (ev) => setupDataChannel(ev.channel);
  }
}

function setupDataChannel(dc) {
  dataChannel = dc;

  dc.onopen = () => {
    status.dataChannel = true;
    status.state = 'synced';
    postStatus();
    sendOverDataChannel({ type: 'hello', text: 'P2P 通道已建立' });
    sendOverDataChannel({ type: 'clock-sync', t0: Date.now() });
    startClockSyncLoop();
  };

  dc.onclose = () => {
    status.dataChannel = false;
    postStatus();
    scheduleRenegotiate();
  };

  dc.onmessage = (ev) => {
    let message;
    try {
      message = JSON.parse(ev.data);
    } catch {
      message = { type: 'raw', text: String(ev.data) };
    }

    if (message.type === 'clock-sync') {
      sendOverDataChannel({
        type: 'clock-sync-reply',
        t0: message.t0,
        t1: Date.now(),
        t2: Date.now(),
      });
      return;
    }

    if (message.type === 'clock-sync-reply') {
      peerClockOffset = (message.t1 - message.t0 + (message.t2 - Date.now())) / 2;
      return;
    }

    // 校正对端时间戳到本端时钟，供注入脚本做漂移补偿
    if (message.type === 'video-state' && message.payload) {
      console.log('[SyncWatch:offscreen] DC 收到对端视频状态:', message.payload.action);
      debugNotify('收到对端视频状态: ' + message.payload.action);
      message.payload.ts = (message.payload.ts ?? Date.now()) - peerClockOffset;
      sendToActiveTab(message);
      return;
    }

    if (message.type === 'url-sync') {
      debugNotify('收到对方页面: ' + ((message.payload && message.payload.url) || '').slice(0, 60));
      handleIncomingUrlSync(message);
      return;
    }

    // hello / test / url-offer 等：展示给 popup
    notifyPopup(message);
  };
}

async function createOffer() {
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: 'offer', sdp: offer });
  } catch (e) {
    setError('创建 offer 失败', e);
  }
}

async function createAnswer() {
  try {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type: 'answer', sdp: answer });
  } catch (e) {
    setError('创建 answer 失败', e);
  }
}

// ---------- 时钟校准 ----------

function startClockSyncLoop() {
  if (clockSyncTimer) return;
  clockSyncTimer = setInterval(() => {
    if (dataChannel && dataChannel.readyState === 'open') {
      sendOverDataChannel({ type: 'clock-sync', t0: Date.now() });
    }
  }, 30000);
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

function scheduleRenegotiate() {
  if (renegotiateTimer || !status.peer || status.role !== 'offerer') return;
  renegotiateTimer = setTimeout(() => {
    renegotiateTimer = null;
    if (pc && status.role === 'offerer' && status.peer && ws && ws.readyState === WebSocket.OPEN) {
      try {
        dataChannel = pc.createDataChannel('sync');
        setupDataChannel(dataChannel);
        createOffer();
      } catch {
        /* ignore */
      }
    }
  }, 1000);
}

function join({ room: roomId, password, signalUrl: url }) {
  // 已连同一房间且信令存活时，避免重复重建（popup 自动重连会触发）
  if (room === roomId && ws && ws.readyState === WebSocket.OPEN && status.state !== 'idle') {
    postStatus();
    return;
  }

  teardown();
  intentionalLeave = false;
  currentPassword = password;
  room = roomId;
  signalUrl = url || DEFAULT_SIGNAL_URL;
  peerClockOffset = 0;
  status = {
    state: 'connecting',
    room: roomId,
    role: null,
    peer: false,
    dataChannel: false,
    error: null,
  };
  postStatus();

  try {
    const socket = new WebSocket(signalUrl);
    ws = socket;

    socket.onopen = () => sendSignal({ type: 'join', room: roomId, password });

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
      if (ws !== socket) return; // 已被新连接替换
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

let pendingVideoState = null;
let pendingVideoUrl = null;
let pendingRetryTimer = null;
let pendingRetryCount = 0;

function handleIncomingUrlSync(message) {
  notifyPopup({ type: 'debug', text: 'handleIncomingUrlSync 被调用' });
  const url = message.payload && message.payload.url;
  const video = message.payload && message.payload.video;
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

// ---------- DataChannel 发送 ----------

function sendOverDataChannel(message) {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(JSON.stringify(message));
  }
}

// 页面同步：content 直发 + SW 转发可能各来一次，按 url 去重
let lastSyncPageUrl = null;
let lastSyncPageAt = 0;

function handleSyncPage(msg) {
  const url = msg && msg.url;
  if (!url) {
    notifyPopup({ type: 'debug', text: '❌ 未获取到 URL' });
    return;
  }
  const now = Date.now();
  if (url === lastSyncPageUrl && now - lastSyncPageAt < 500) return; // 去重
  lastSyncPageUrl = url;
  lastSyncPageAt = now;
  notifyPopup({ type: 'debug', text: '同步页面: ' + url.slice(0, 60) });
  sendOverDataChannel({ type: 'url-sync', payload: { url, title: msg.title, video: msg.video || null } });
}

// 视频状态可能经两条路径到达（content 直发 + SW 转发），按 action+ts 去重
let lastLocalVideoKey = null;
let lastLocalVideoAt = 0;

function handleLocalVideoState(payload) {
  if (!payload) return;
  const key = payload.action + ':' + payload.ts;
  const now = Date.now();
  if (key === lastLocalVideoKey && now - lastLocalVideoAt < 200) return;
  lastLocalVideoKey = key;
  lastLocalVideoAt = now;
  console.log('[SyncWatch:offscreen] 发送视频状态到 DC:', payload.action);
  debugNotify('发送视频状态到对端: ' + payload.action);
  sendOverDataChannel({ type: 'video-state', payload });
}

function sendTest(text) {
  sendOverDataChannel({ type: 'test', text: text || 'hello', ts: Date.now() });
}

// ---------- 清理 ----------

function teardownPeer() {
  try {
    dataChannel?.close();
  } catch {
    /* ignore */
  }
  try {
    pc?.close();
  } catch {
    /* ignore */
  }
  pc = null;
  dataChannel = null;
}

function teardown() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (renegotiateTimer) {
    clearTimeout(renegotiateTimer);
    renegotiateTimer = null;
  }
  if (clockSyncTimer) {
    clearInterval(clockSyncTimer);
    clockSyncTimer = null;
  }
  teardownPeer();
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
        console.log('[SyncWatch:offscreen] 同步页面, 获取到:', info);
        if (info && info.url) {
          debugNotify('同步页面: ' + info.url.slice(0, 60));
          sendOverDataChannel({ type: 'url-sync', payload: { url: info.url, title: info.title } });
        } else {
          debugNotify('同步页面失败: 未获取到 URL');
        }
      });
      break;
    case 'video-state':
    case 'dc-video-state':
      // content 直接发来（若 runtime 消息可达 offscreen）或经 SW 转发；去重后二选一
      handleLocalVideoState(msg.payload);
      break;
    default:
      break;
  }
  // 注意：不 return true（除 get-status 外均为单向消息，无需应答）
});

// 启动时若有已保存凭据，自动重连
chrome.storage.local.get(['room', 'password', 'signalUrl', 'autoFollow'], (v) => {
  autoFollowSetting = v.autoFollow !== false;
  if (v.room) {
    join({ room: v.room, password: v.password || '', signalUrl: v.signalUrl || DEFAULT_SIGNAL_URL });
  } else {
    postStatus();
  }
});
