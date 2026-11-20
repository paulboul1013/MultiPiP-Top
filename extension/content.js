// MultiPiP Top — 注入來源分頁（每個 frame）的內容腳本
// 以 video.captureStream() 擷取畫面，透過同機 WebRTC 傳給小窗；
// 小窗的播放控制經由 port 回傳到這裡操作原始 <video>。聲音留在來源分頁播放。
(() => {
  if (globalThis.__multipip) return;

  let chosen = null;

  function score(v) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area < 80 * 45 && !v.videoWidth) return -1;
    let s = Math.max(area, (v.videoWidth * v.videoHeight) / 8, 1);
    if (!v.paused && !v.ended) s *= 4;
    if (v.readyState >= 2) s *= 2;
    return s;
  }

  function findVideos(root, out) {
    for (const v of root.querySelectorAll('video')) out.push(v);
    // 開放的 shadow DOM（部分播放器元件）
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) findVideos(el.shadowRoot, out);
    return out;
  }

  function pick() {
    let best = null, bestScore = -1;
    for (const v of findVideos(document, [])) {
      const s = score(v);
      if (s > bestScore) { best = v; bestScore = s; }
    }
    return best && bestScore >= 0 ? { video: best, score: bestScore } : null;
  }

  globalThis.__multipip = {
    probe() {
      const p = pick();
      if (!p) return null;
      chosen = p.video;
      return {
        score: p.score,
        playing: !p.video.paused,
        width: p.video.videoWidth,
        height: p.video.videoHeight,
      };
    },
  };

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'multipip') startSession(port);
  });

  function startSession(port) {
    const video = chosen?.isConnected ? chosen : pick()?.video;
    const post = (m) => { try { port.postMessage(m); } catch {} };
    if (!video) {
      post({ type: 'error', code: 'no_video', message: '來源頁面已找不到影片（可能已重新整理或換頁）。' });
      port.disconnect();
      return;
    }

    let stream;
    try {
      stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    } catch (e) {
      const msg = e.name === 'SecurityError'
        ? '此影片來自其他網域且未開放 CORS，或受 DRM 保護，瀏覽器不允許擷取畫面。'
        : `無法擷取影片：${e.message}`;
      post({ type: 'error', code: 'capture_failed', message: msg });
      port.disconnect();
      return;
    }

    const pc = new RTCPeerConnection();
    let sender = null;
    let negotiated = false;
    let closed = false;

    const liveTrack = () => stream.getVideoTracks().find((t) => t.readyState === 'live');

    async function negotiate() {
      if (negotiated) return;
      negotiated = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      post({ type: 'offer', sdp: pc.localDescription.toJSON() });
    }

    function attach() {
      const t = liveTrack();
      if (!t) return false;
      if (sender) sender.replaceTrack(t).catch(() => {});
      else sender = pc.addTrack(t, stream);
      return true;
    }

    // 影片換來源（例如播放清單下一支、廣告切換）時 captureStream 會換 track
    const onAddTrack = () => {
      if (attach() && !negotiated) negotiate().catch(fail);
    };
    stream.addEventListener('addtrack', onAddTrack);

    pc.onicecandidate = (e) => post({ type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });

    function fail(e) {
      post({ type: 'error', code: 'webrtc_failed', message: `建立影片串流失敗：${e?.message || e}` });
    }

    // 播放狀態同步
    let lastTime = 0;
    function sendState() {
      const d = video.duration;
      post({
        type: 'state',
        paused: video.paused,
        ended: video.ended,
        muted: video.muted,
        volume: video.volume,
        currentTime: video.currentTime,
        duration: Number.isFinite(d) ? d : null,
        width: video.videoWidth,
        height: video.videoHeight,
        title: document.title,
      });
    }
    const onTime = () => {
      const now = performance.now();
      if (now - lastTime > 250) { lastTime = now; sendState(); }
    };
    const events = ['play', 'pause', 'volumechange', 'durationchange', 'ended', 'loadedmetadata', 'seeked', 'resize'];
    events.forEach((ev) => video.addEventListener(ev, sendState));
    video.addEventListener('timeupdate', onTime);

    port.onMessage.addListener(async (m) => {
      try {
        if (m.type === 'start') {
          sendState();
          if (attach()) await negotiate();
          else post({ type: 'status', message: '等待影片開始載入…' });
        } else if (m.type === 'answer') {
          await pc.setRemoteDescription(m.sdp);
        } else if (m.type === 'ice') {
          if (m.candidate) await pc.addIceCandidate(m.candidate);
        } else if (m.type === 'cmd') {
          control(m);
        }
      } catch (e) {
        fail(e);
      }
    });

    function control(m) {
      switch (m.action) {
        case 'toggle':
          if (video.paused || video.ended) video.play().catch(() => {});
          else video.pause();
          break;
        case 'play': video.play().catch(() => {}); break;
        case 'pause': video.pause(); break;
        case 'seek':
          if (Number.isFinite(video.duration)) video.currentTime = Math.min(Math.max(0, m.time), video.duration);
          break;
        case 'seekBy':
          if (Number.isFinite(video.duration)) video.currentTime = Math.min(Math.max(0, video.currentTime + m.delta), video.duration);
          break;
        case 'volume':
          video.volume = Math.min(Math.max(0, m.value), 1);
          if (m.value > 0 && video.muted) video.muted = false;
          break;
        case 'mute': video.muted = !!m.value; break;
      }
      sendState();
    }

    port.onDisconnect.addListener(() => {
      if (closed) return;
      closed = true;
      events.forEach((ev) => video.removeEventListener(ev, sendState));
      video.removeEventListener('timeupdate', onTime);
      stream.removeEventListener('addtrack', onAddTrack);
      pc.close();
      stream.getTracks().forEach((t) => t.stop()); // 只停止擷取，不影響原影片播放
    });
  }
})();
