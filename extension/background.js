// MultiPiP Top — 背景 service worker
// 負責：找影片、建立小窗、追蹤 來源 tabId ↔ 小窗 windowId、生命週期清理。
// 注意：置頂請求必須由小窗頁面（pip.js）呼叫 connectNative，
//       這裡呼叫的話 Edge 給 host 的 --parent-window 會是 0。

const POPUP_W = 480;
const POPUP_H = 300;
const MARGIN = 24;
const CASCADE = 36;

// service worker 隨時可能被回收，對應表存在 storage.session
async function getMap() {
  const { pipMap = {} } = await chrome.storage.session.get('pipMap');
  return pipMap;
}
function setMap(map) {
  return chrome.storage.session.set({ pipMap: map });
}

// 序列化對應表的讀寫，避免快速連按時開出兩個小窗
let lock = Promise.resolve();
function withLock(fn) {
  const p = lock.then(fn, fn);
  lock = p.catch(() => {});
  return p;
}

const isOwnPage = (url) => !!url && url.startsWith(chrome.runtime.getURL(''));

// ------------------------------------------------------------ 觸發

chrome.action.onClicked.addListener((tab) => openFor(tab));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'probe' && isOwnPage(sender.url)) {
    probeTab(msg.tabId).then(async (res) => {
      if (res.frameId !== undefined) {
        await withLock(async () => {
          const map = await getMap();
          if (map[msg.tabId]) { map[msg.tabId].frameId = res.frameId; await setMap(map); }
        });
      }
      sendResponse(res);
    });
    return true;
  }
});

// ------------------------------------------------------------ 找影片

async function probeTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__multipip?.probe() ?? null,
    });
    const best = results
      .filter((r) => r.result)
      .sort((a, b) => b.result.score - a.result.score)[0];
    if (!best) return { error: 'no_video', message: '此頁面找不到可播放的 <video> 影片。' };
    return { frameId: best.frameId, info: best.result };
  } catch (e) {
    return { error: 'no_access', message: `無法存取此頁面（${e.message}）。edge://、擴充功能商店等頁面不允許擷取。` };
  }
}

async function openFor(tab) {
  if (!tab?.id || isOwnPage(tab.url)) return;
  return withLock(async () => {
    const map = await getMap();
    const existing = map[tab.id];
    if (existing) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
        return;
      } catch {
        delete map[tab.id]; // 視窗已不存在，重新建立
      }
    }

    const res = await probeTab(tab.id);
    if (res.error) {
      notify(tab.id, res.message);
      return;
    }

    const pos = await popupPosition(tab.windowId, Object.keys(map).length);
    const url = chrome.runtime.getURL(`pip.html?tab=${tab.id}&frame=${res.frameId}`);
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      width: POPUP_W,
      height: POPUP_H,
      left: pos.left,
      top: pos.top,
      focused: false, // 焦點留在原分頁，方便接著開第二支影片
    });
    map[tab.id] = { windowId: win.id, frameId: res.frameId };
    await setMap(map);
  });
}

async function popupPosition(windowId, index) {
  try {
    const w = await chrome.windows.get(windowId);
    const step = (index % 6) * CASCADE;
    return {
      left: Math.max(0, w.left + w.width - POPUP_W - MARGIN - step),
      top: Math.max(0, w.top + w.height - POPUP_H - MARGIN - step),
    };
  } catch {
    return { left: 80 + index * CASCADE, top: 80 + index * CASCADE };
  }
}

// 在頁面顯示提示；受限頁面無法注入時改用工具列徽章
async function notify(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message],
      func: (text) => {
        const el = document.createElement('div');
        el.textContent = 'MultiPiP Top：' + text;
        el.style.cssText =
          'position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);' +
          'background:#1e293b;color:#fff;padding:10px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);max-width:80vw';
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 4000);
      },
    });
  } catch {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: 'MultiPiP Top：' + message });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: '' }).catch(() => {});
    }, 5000);
  }
}

// ------------------------------------------------------------ 生命週期

// 來源分頁關閉 → 關掉對應小窗（串流由 port 斷線自動釋放）
chrome.tabs.onRemoved.addListener((tabId) =>
  withLock(async () => {
    const map = await getMap();
    const entry = map[tabId];
    if (!entry) return;
    delete map[tabId];
    await setMap(map);
    chrome.windows.remove(entry.windowId).catch(() => {});
  }),
);

// 小窗關閉 → 清除對應狀態
chrome.windows.onRemoved.addListener((windowId) =>
  withLock(async () => {
    const map = await getMap();
    let changed = false;
    for (const [tabId, entry] of Object.entries(map)) {
      if (entry.windowId === windowId) { delete map[tabId]; changed = true; }
    }
    if (changed) await setMap(map);
  }),
);

// 分頁被預先轉譯替換時，搬移對應
chrome.tabs.onReplaced.addListener((added, removed) =>
  withLock(async () => {
    const map = await getMap();
    if (!map[removed]) return;
    map[added] = map[removed];
    delete map[removed];
    await setMap(map);
  }),
);
