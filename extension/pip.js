// MultiPiP Top — 影片小窗頁面
// 1. 透過 port 與來源分頁的 content.js 建立 WebRTC，顯示影片並回傳播放控制。
// 2. 由「這個頁面」呼叫 connectNative，Edge 才會把這個小窗的 HWND 以 --parent-window 交給 host。

const HOST = 'com.ztop.multipip';

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tab'));
let frameId = Number(params.get('frame')) || 0;

// 標題識別碼：host 會確認 --parent-window 指到的視窗標題含有它，才執行置頂
const token = 'pip#' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).padStart(6, '0').slice(-6);
let srcTitle = '';

const $ = (id) => document.getElementById(id);
const video = $('video');
const ui = {
  overlay: $('overlay'), overlayText: $('overlay-text'), overlayBtn: $('overlay-btn'),
  srcTitle: $('src-title'), pin: $('pin'), pinLabel: $('pin-label'), pinError: $('pin-error'),
  close: $('close'), play: $('play'), time: $('time'), seek: $('seek'), dur: $('dur'),
  mute: $('mute'), vol: $('vol'),
};

function setTitle(t) {
  if (t !== undefined) srcTitle = t;
  document.title = `${srcTitle || 'MultiPiP'} · ${token}`;
  ui.srcTitle.textContent = srcTitle;
  ui.srcTitle.title = srcTitle;
}

// ================================================================ 置頂（Native Messaging）

let native = null;
let reqSeq = 0;
let topmost = { state: 'pending', want: true };

function renderPin(state, message) {
  topmost.state = state;
  ui.pin.dataset.state = state;
  ui.pinLabel.textContent = {
    pending: '置頂中…',
    on: '已置頂',
    off: '未置頂',
    error: '未置頂 · 重試',
  }[state];
  ui.pin.title = {
    pending: '正在請求 Windows 輔助程式',
    on: '此小窗保持在最上方，點一下取消 (T)',
    off: '點一下讓此小窗保持在最上方 (T)',
    error: '點一下重試',
  }[state];
  ui.pinError.hidden = state !== 'error';
  ui.pinError.textContent = message || '';
  document.body.classList.toggle('pin-attention', state === 'error');
}

function friendlyNativeError(raw) {
  const s = raw || '';
  if (/not found/i.test(s)) return 'Windows 輔助程式尚未安裝或未註冊。請執行 scripts\\install.cmd 後按「重試」。影片仍可正常播放。';
  if (/forbidden/i.test(s)) return '輔助程式的 allowed_origins 不包含此擴充功能 ID，請以正確 ID 重新執行安裝腳本。';
  if (/failed to start/i.test(s)) return '無法啟動 Windows 輔助程式（pip_host.exe 可能被移動或刪除），請重新安裝。';
  if (/exited/i.test(s)) return 'Windows 輔助程式已意外結束，請按「重試」。';
  return `與 Windows 輔助程式的連線失敗：${s}`;
}

const HOST_ERRORS = {
  parent_window_zero: 'Edge 沒有提供此小窗的視窗代號，無法置頂。',
  invalid_window: 'Edge 提供的視窗代號無效，無法置頂。',
  not_browser_window: '視窗代號不是 Edge 視窗，已拒絕置頂。',
  not_edge_window: '視窗代號不屬於 Edge，已拒絕置頂。',
  window_mismatch: '無法確認視窗代號就是這個小窗，已拒絕置頂。',
  window_gone: '小窗已關閉。',
};

function connectNative() {
  try {
    native = chrome.runtime.connectNative(HOST);
  } catch (e) {
    native = null;
    renderPin('error', friendlyNativeError(e.message));
    return false;
  }
  native.onMessage.addListener((m) => {
    if (m.op !== 'setTopmost' || m.id !== reqSeq) return; // 只採用最新一次請求的結果
    if (m.ok) {
      renderPin(m.topmost ? 'on' : 'off');
    } else {
      renderPin('error', (HOST_ERRORS[m.error] || '置頂失敗。') + (m.message ? `（${m.message}）` : ''));
    }
  });
  native.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || 'Native host has exited.';
    native = null;
    renderPin('error', friendlyNativeError(err));
  });
  return true;
}

function requestTopmost(enabled) {
  topmost.want = enabled;
  if (!native && !connectNative()) return;
  renderPin('pending');
  try {
    native.postMessage({ op: 'setTopmost', enabled, titleToken: token, id: ++reqSeq });
  } catch (e) {
    native = null;
    renderPin('error', friendlyNativeError(e.message));
  }
}

function onPinClick() {
  if (topmost.state === 'pending') return;
  if (topmost.state === 'error') requestTopmost(topmost.want);
  else requestTopmost(topmost.state !== 'on');
}
ui.pin.addEventListener('click', onPinClick);

// ================================================================ 來源影片（WebRTC）

let port = null;
let pc = null;
let sourceFailed = false;
let state = null;

function showOverlay(text, { retry = false } = {}) {
  ui.overlay.hidden = false;
  ui.overlayText.textContent = text;
  ui.overlayBtn.hidden = !retry;
}
function hideOverlay() { ui.overlay.hidden = true; }

function teardownSource() {
  if (port) { try { port.disconnect(); } catch {} port = null; }
  if (pc) { pc.close(); pc = null; }
  video.srcObject = null;
}

function connectSource() {
  teardownSource();
  sourceFailed = false;
  showOverlay('正在連線來源影片…');

  try {
    port = chrome.tabs.connect(tabId, { frameId, name: 'multipip' });
  } catch (e) {
    showOverlay(`無法連線來源分頁：${e.message}`, { retry: true });
    return;
  }
  const myPort = port;
  const myPc = (pc = new RTCPeerConnection());
  const send = (m) => { try { myPort.postMessage(m); } catch {} };

  myPc.onicecandidate = (e) => send({ type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
  myPc.ontrack = (e) => {
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  myPc.onconnectionstatechange = () => {
    if (myPc.connectionState === 'failed') showOverlay('影片串流連線失敗。', { retry: true });
  };

  myPort.onMessage.addListener(async (m) => {
    try {
      if (m.type === 'offer') {
        await myPc.setRemoteDescription(m.sdp);
        const answer = await myPc.createAnswer();
        await myPc.setLocalDescription(answer);
        send({ type: 'answer', sdp: myPc.localDescription.toJSON() });
      } else if (m.type === 'ice') {
        if (m.candidate) await myPc.addIceCandidate(m.candidate);
      } else if (m.type === 'state') {
        applyState(m);
      } else if (m.type === 'status') {
        showOverlay(m.message);
      } else if (m.type === 'error') {
        sourceFailed = true;
        showOverlay(m.message, { retry: true });
      }
    } catch (e) {
      showOverlay(`建立影片串流失敗：${e.message}`, { retry: true });
    }
  });

  myPort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port !== myPort) return; // 已被新的連線取代
    port = null;
    if (pc === myPc) { myPc.close(); pc = null; }
    if (!sourceFailed) showOverlay('與來源分頁的連線已中斷（分頁可能已重新整理或換頁）。', { retry: true });
  });

  send({ type: 'start' });
}

// 重新注入內容腳本並重新找影片（來源頁重新整理後使用）
async function reconnect() {
  showOverlay('重新尋找來源影片…');
  try {
    await chrome.tabs.get(tabId);
  } catch {
    showOverlay('來源分頁已關閉。');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'probe', tabId });
  if (res?.error) {
    showOverlay(res.message, { retry: true });
    return;
  }
  frameId = res.frameId;
  connectSource();
}
ui.overlayBtn.addEventListener('click', reconnect);

video.addEventListener('playing', hideOverlay);
video.addEventListener('loadeddata', hideOverlay);

// ================================================================ 播放控制

const cmd = (action, extra = {}) => { if (port) port.postMessage({ type: 'cmd', action, ...extra }); };

function fmt(t) {
  if (!Number.isFinite(t)) return '--:--';
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

let seeking = false;
function applyState(s) {
  state = s;
  ui.play.textContent = s.paused || s.ended ? '▶' : '❚❚';
  ui.mute.textContent = s.muted || s.volume === 0 ? '🔇' : '🔊';
  if (document.activeElement !== ui.vol) ui.vol.value = s.muted ? 0 : s.volume;
  const seekable = s.duration != null && s.duration > 0;
  ui.seek.disabled = !seekable;
  ui.dur.textContent = seekable ? fmt(s.duration) : '直播';
  ui.time.textContent = fmt(s.currentTime);
  if (seekable && !seeking) {
    ui.seek.max = s.duration;
    ui.seek.value = s.currentTime;
  }
  if (s.title && s.title !== srcTitle) setTitle(s.title);
}

ui.play.addEventListener('click', () => cmd('toggle'));
video.addEventListener('click', () => cmd('toggle'));
ui.mute.addEventListener('click', () => cmd('mute', { value: !(state?.muted) }));
ui.vol.addEventListener('input', () => cmd('volume', { value: Number(ui.vol.value) }));
ui.seek.addEventListener('input', () => { seeking = true; ui.time.textContent = fmt(Number(ui.seek.value)); });
ui.seek.addEventListener('change', () => { cmd('seek', { time: Number(ui.seek.value) }); seeking = false; });
ui.close.addEventListener('click', () => window.close());

document.addEventListener('keydown', (e) => {
  if (e.target === ui.seek || e.target === ui.vol) {
    if (e.key !== ' ' && e.key !== 'Escape') return;
  }
  switch (e.key) {
    case ' ': case 'k': cmd('toggle'); break;
    case 'm': case 'M': cmd('mute', { value: !(state?.muted) }); break;
    case 'ArrowLeft': cmd('seekBy', { delta: -5 }); break;
    case 'ArrowRight': cmd('seekBy', { delta: 5 }); break;
    case 'ArrowUp': cmd('volume', { value: Math.min(1, (state?.volume ?? 1) + 0.1) }); break;
    case 'ArrowDown': cmd('volume', { value: Math.max(0, (state?.volume ?? 1) - 0.1) }); break;
    case 't': case 'T': onPinClick(); break;
    case 'Escape': window.close(); return;
    default: return;
  }
  e.preventDefault();
});

// 滑鼠移動時顯示控制列
let hideTimer = 0;
function pokeUi() {
  document.body.classList.add('show-ui');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => document.body.classList.remove('show-ui'), 2500);
}
document.addEventListener('mousemove', pokeUi);
document.addEventListener('mouseleave', () => document.body.classList.remove('show-ui'));

// ================================================================ 啟動

(async () => {
  try {
    const tab = await chrome.tabs.get(tabId);
    setTitle(tab.title || '');
  } catch {
    setTitle('');
  }
  pokeUi();
  connectSource();
  // 等標題套用到視窗後再請求置頂（host 也會重試比對標題）
  setTimeout(() => requestTopmost(true), 150);
})();

window.addEventListener('pagehide', () => {
  teardownSource();
  if (native) { try { native.disconnect(); } catch {} }
});
