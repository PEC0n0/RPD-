// SyncWatch content script（ISOLATED world）
// 在隔离世界直接控制页面 <video>，无需 MAIN-world 注入脚本，也无需 window.postMessage 桥接。

(() => {
  const SYNC_INTERVAL_MS = 1000; // 播放中周期性对时上报间隔
  const SUPPRESS_MS = 600; // 应用远端指令后，抑制本地事件上报的窗口
  const SEEK_THRESHOLD_S = 0.5; // 周期性对时时的最小纠正阈值（秒）

  let mainVideo = null;
  let suppressUntil = 0;
  let lastSyncAt = 0;
  let lastIncoming = null;
  let fabDot = null; // 悬浮面板上的视频检测状态点
  let unlockTimer = null; // 解锁浮层的兜底定时器
  let localSeekUntil = 0; // 本地刚拖动后，短暂忽略对端 sync，防止回弹

  const isSuppressed = () => Date.now() < suppressUntil;

  function updateVideoIndicator(found) {
    if (fabDot) {
      fabDot.style.background = found ? '#22c55e' : '#6b7280';
      fabDot.title = found ? '已检测到视频' : '未检测到视频';
    }
  }

  // 页面标识：去掉查询串、hash、尾斜杠，只按「域名+路径」判断是否同一视频页
  function pageKey(u) {
    if (!u) return '';
    let end = u.length;
    const qi = u.indexOf('?');
    const hi = u.indexOf('#');
    if (qi >= 0) end = Math.min(end, qi);
    if (hi >= 0) end = Math.min(end, hi);
    return u.slice(0, end).replace(/\/+$/, '');
  }

  // 选主视频：优先「可见 + 已有元数据」且面积最大者（避开广告/隐藏/占位视频）
  function pickMainVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      const visible = area > 0;
      const hasMeta = v.duration > 0;
      const tier = hasMeta && visible ? 3 : visible ? 2 : 1;
      const score = tier * 1e9 + area;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function reportState(action) {
    const v = mainVideo || pickMainVideo();
    if (!v) return;
    mainVideo = v;
    console.log('[SyncWatch] 上报视频状态:', action, 't=', Math.round(v.currentTime), 'playing=', !v.paused);
    chrome.runtime
      .sendMessage({
        type: 'video-state',
        payload: {
          action,
          currentTime: v.currentTime,
          playing: !v.paused,
          playbackRate: v.playbackRate || 1,
          duration: v.duration || 0,
          ts: Date.now(),
          url: location.href,
        },
      })
      .catch(() => {});
  }

  const onPlay = () => {
    if (!isSuppressed()) reportState('play');
  };
  const onPause = () => {
    if (!isSuppressed()) reportState('pause');
  };
  const onSeeked = () => {
    if (isSuppressed()) return;
    localSeekUntil = Date.now() + 2000; // 本地拖动后 2 秒内忽略对端 sync
    reportState('seek');
  };
  const onRateChange = () => {
    if (!isSuppressed()) reportState('rate');
  };
  const onTimeUpdate = () => {
    if (isSuppressed()) return;
    const now = Date.now();
    if (now - lastSyncAt < SYNC_INTERVAL_MS) return;
    lastSyncAt = now;
    reportState('sync');
  };

  function attach(v) {
    if (v.__syncwatchAttached) return;
    v.__syncwatchAttached = true;
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('timeupdate', onTimeUpdate);
  }

  function showUnlockOverlay() {
    if (document.getElementById('__sw_unlock')) return;
    console.log('[SyncWatch] 显示「开始同步播放」浮层');
    const div = document.createElement('div');
    div.id = '__sw_unlock';
    div.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;';
    const btn = document.createElement('div');
    btn.textContent = '点击开始同步播放';
    btn.style.cssText =
      'background:#111827;color:#fff;padding:18px 30px;border-radius:12px;' +
      'font:600 15px system-ui;border:1px solid #6366f1;';
    div.appendChild(btn);
    div.addEventListener('click', () => {
      div.remove();
      const v = mainVideo || pickMainVideo();
      if (!v) return;
      if (lastIncoming) applyDirect(v, lastIncoming);
    });
    document.documentElement.appendChild(div);
  }

  function applyDirect(v, state) {
    suppressUntil = Date.now() + SUPPRESS_MS;
    // 清除之前挂起的「解锁浮层」定时器，避免暂停后误弹（导致双方打架）
    if (unlockTimer) {
      clearTimeout(unlockTimer);
      unlockTimer = null;
    }
    if (state.playbackRate) {
      try {
        v.playbackRate = state.playbackRate;
      } catch {}
    }
    if (typeof state.currentTime === 'number') {
      try {
        v.currentTime = state.currentTime;
      } catch {}
    }
    if (state.playing) {
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          console.log('[SyncWatch] play() 被拦截:', e && e.name);
          showUnlockOverlay();
        });
      }
      // 兜底：300ms 后仍未播放，说明 play 未生效（自动播放被拦），显示解锁浮层
      unlockTimer = setTimeout(() => {
        unlockTimer = null;
        if (v.paused) showUnlockOverlay();
      }, 300);
    } else {
      v.pause();
    }
  }

  function applyState(payload) {
    console.log('[SyncWatch] 收到远端状态:', payload.action, 't=', Math.round(payload.currentTime), 'playing=', payload.playing);
    // 仅当双方在同一视频页面时才同步进度（各自可独立看其它视频）
    if (payload.url && pageKey(payload.url) !== pageKey(location.href)) {
      console.log('[SyncWatch] 忽略：页面不一致', payload.url, 'vs', location.href);
      return;
    }
    // 本地刚拖动过进度条时，短暂忽略对端的周期性 sync，防止回弹
    if (payload.action === 'sync' && Date.now() < localSeekUntil) {
      console.log('[SyncWatch] 忽略 sync（本地刚拖动过）');
      return;
    }
    // 先算出目标状态并缓存，即使本页视频还没加载，等视频出现时再应用
    const rate = payload.playbackRate || 1;
    const elapsed = (Date.now() - (payload.ts ?? Date.now())) / 1000;
    const target = payload.playing ? payload.currentTime + elapsed * rate : payload.currentTime;
    const state = { currentTime: target, playbackRate: rate, playing: !!payload.playing };
    lastIncoming = state;

    const v = mainVideo || pickMainVideo();
    if (!v) {
      console.log('[SyncWatch] 收到远端状态，但页面无视频（已缓存，稍后应用）');
      scanAndAttach();
      return;
    }
    mainVideo = v;

    const diff = Math.abs(v.currentTime - target);
    const playingMatches = v.paused === !state.playing;
    const rateMatches = Math.abs(v.playbackRate - rate) < 0.01;

    // 周期性对时且已对齐时，不打断本地播放
    if (payload.action === 'sync' && diff <= SEEK_THRESHOLD_S && playingMatches && rateMatches) {
      return;
    }

    applyDirect(v, state);
  }

  function scanAndAttach() {
    const v = pickMainVideo();
    updateVideoIndicator(!!v);
    if (v && v !== mainVideo) {
      mainVideo = v;
      attach(v);
      console.log('[SyncWatch] 已绑定主视频 duration=', v.duration, 'src=', (v.currentSrc || v.src || '').slice(0, 80));
      if (lastIncoming) applyDirect(v, lastIncoming);
    }
  }

  // ---------- 接收扩展后台消息 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.__syncwatch === true && msg.type === 'get-page-info') {
      sendResponse({ url: location.href, title: document.title });
      return;
    }

    if (msg.type === 'video-state') {
      applyState(msg.payload);
      sendResponse({ ok: true });
    }

    if (msg.__syncwatch === true && msg.type === 'navigate') {
      if (msg.url && location.href !== msg.url) {
        try {
          location.href = msg.url;
        } catch {}
      }
      sendResponse({ ok: true });
    }
  });

  // ---------- 悬浮面板（右上角）：视频状态点 + 同步按钮 ----------
  try {
    const fab = document.createElement('div');
    fab.style.cssText = [
      'position:fixed',
      'right:16px',
      'top:16px',
      'z-index:2147483646',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'background:rgba(17,24,39,0.85)',
      'color:#e5e7eb',
      'padding:6px 12px',
      'border-radius:20px',
      'font:13px system-ui,sans-serif',
      'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
      'user-select:none',
    ].join(';');

    fabDot = document.createElement('span');
    fabDot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#6b7280;flex:0 0 auto;';
    fab.appendChild(fabDot);

    const btn = document.createElement('span');
    btn.textContent = '⇄ 同步此页';
    btn.title = 'RPD通用一起看：同步当前页面给房间';
    btn.style.cssText = 'cursor:pointer;';
    btn.addEventListener('click', () => {
      // 带上当前页 URL + 当前视频进度
      const v = mainVideo || pickMainVideo();
      const video = v
        ? { currentTime: v.currentTime, playing: !v.paused, playbackRate: v.playbackRate || 1 }
        : null;
      chrome.runtime
        .sendMessage({ type: 'sync-page', url: location.href, title: document.title, video })
        .catch(() => {});
      btn.textContent = '✓ 已发送';
      setTimeout(() => {
        btn.textContent = '⇄ 同步此页';
      }, 1500);
    });
    fab.appendChild(btn);

    document.documentElement.appendChild(fab);
  } catch {
    /* ignore */
  }

  // ---------- 扫描并绑定视频 ----------
  let scanTimer = null;
  const observer = new MutationObserver(() => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndAttach();
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanAndAttach);
  } else {
    scanAndAttach();
  }
})();
