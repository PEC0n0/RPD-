// SyncWatch 后台 Service Worker：仅负责按需创建/常驻 offscreen 文档。
//
// 重要：数据路由【不】经过本 SW —— MV3 的 SW 空闲约 30s 会被回收，
// 若靠它转发消息，SW 一死整个连接就断（表现为「刚开始能同步、过一会失效」）。
// 因此由常驻的 offscreen 文档直接与 content script / popup 通信。

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WEB_RTC'],
        justification: '保持 WebRTC 信令连接与 DataChannel 常驻，用于实时同步',
      });
    } catch {
      // 并发创建 / 已存在时忽略；offscreen 会在下次 ensure 或自身加载时再处理
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[SyncWatch:SW] 收到消息:', msg && msg.type);
  if (msg.type === 'ensure-offscreen') {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 异步响应
  }

  // content script 的视频状态：转发给常驻的 offscreen 文档（用独立类型避免重复处理）
  if (msg.type === 'video-state') {
    console.log('[SyncWatch:SW] 收到页面视频状态并转发:', msg.payload && msg.payload.action);
    chrome.runtime
      .sendMessage({ type: 'dc-video-state', payload: msg.payload })
      .catch(() => {});
    sendResponse({ ok: true });
  }

  // content script 的页面同步请求：转发给 offscreen（用独立类型避免重复处理）
  if (msg.type === 'sync-page') {
    chrome.runtime
      .sendMessage({ type: 'dc-sync-page', url: msg.url, title: msg.title })
      .catch(() => {});
    sendResponse({ ok: true });
  }

  // 反向：offscreen 把「发给活动标签页内容脚本」交给 SW 执行（SW 的 chrome.tabs 一定可用）
  if (msg.type === 'tabs-send-active') {
    const message = msg.message;
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(async (tabs) => {
        for (const tab of tabs) {
          if (tab.id == null) continue;
          try {
            const res = await chrome.tabs.sendMessage(tab.id, message);
            if (res) {
              sendResponse({ ok: true, result: res });
              return;
            }
          } catch {
            /* ignore */
          }
        }
        sendResponse({ ok: true, result: null });
      })
      .catch(() => sendResponse({ ok: false, result: null }));
    return true; // 异步响应
  }

  // 导航当前活动标签页到对方页面（不新开标签，避免堆叠与声音杂糅）；无活动标签页时回退新建
  if (msg.type === 'navigate-active') {
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(async (tabs) => {
        for (const tab of tabs) {
          if (tab.id == null) continue;
          try {
            await chrome.tabs.update(tab.id, { url: msg.url });
            console.log('[SyncWatch:SW] 已导航当前标签页:', msg.url);
            sendResponse({ ok: true });
            return;
          } catch (e) {
            console.log('[SyncWatch:SW] tabs.update 失败:', e && e.message);
          }
        }
        await chrome.tabs.create({ url: msg.url });
        sendResponse({ ok: true });
      })
      .catch((e) => {
        console.log('[SyncWatch:SW] 导航失败:', e && e.message);
        sendResponse({ ok: false, error: e && e.message });
      });
    return true;
  }

  return false;
});

// 浏览器启动 / 插件安装时，自动拉起 offscreen（offscreen 会读取已保存凭据自动重连）
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen();
});
