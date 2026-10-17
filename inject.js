// Запускається в головному світі сторінки (world: MAIN) до завантаження YouTube.
// 1) Перехоплює відповіді плеєра на /api/timedtext — вони містять токен `pot`,
//    без якого YouTube віддає порожні субтитри.
// 2) За командою з content.js перемикає трек субтитрів через API плеєра
//    (#movie_player.setOption), бо з ізольованого світу до нього немає доступу.
(() => {
  const store = new Map(); // `${videoId}:${lang}` -> body
  const restoreState = new Map(); // videoId -> { wasOn, prevLang }

  function post(msg) {
    window.postMessage(msg, location.origin);
  }

  function publish(url, body) {
    try {
      const params = new URL(url, location.origin).searchParams;
      const videoId = params.get('v');
      const lang = params.get('lang');
      const tlang = params.get('tlang'); // автопереклад — не оригінальна мова
      if (!videoId) return;
      if (!body) {
        // Порожня відповідь: зазвичай перший запит пішов ще до готовності pot-токена.
        // Плеєр сам не повторює запит, тож content.js має перевибрати трек.
        post({ type: 'TYPU_CAPTIONS_EMPTY', videoId, lang, tlang });
        return;
      }
      store.set(`${videoId}:${lang}`, body);
      post({ type: 'TYPU_CAPTIONS', videoId, lang, tlang, body });
    } catch (_) {}
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' && url.includes('/api/timedtext')) {
      this.addEventListener('load', () => publish(url, this.responseText));
    }
    return origOpen.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = async function (input) {
    const res = await origFetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input && input.url;
    if (url && url.includes('/api/timedtext')) {
      res.clone().text().then((body) => publish(url, body)).catch(() => {});
    }
    return res;
  };

  function getPlayer() {
    const p = document.querySelector('#movie_player');
    return p && typeof p.setOption === 'function' && typeof p.getPlayerResponse === 'function' ? p : null;
  }

  function isCaptionsOn() {
    const btn = document.querySelector('.ytp-subtitles-button');
    return !!btn && btn.getAttribute('aria-pressed') === 'true';
  }

  // Вибирає трек однією з бажаних мов. Ручні субтитри мають пріоритет над asr.
  function selectTrack(videoId, langs) {
    const player = getPlayer();
    if (!player) return { status: 'no-player' };

    const pr = player.getPlayerResponse() || {};
    if (pr.videoDetails && pr.videoDetails.videoId && pr.videoDetails.videoId !== videoId) {
      return { status: 'no-player' }; // плеєр ще не переключився на це відео
    }
    const tracks = (pr.captions && pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];

    let track = null;
    for (const lang of langs) {
      track = tracks.find((t) => t.languageCode === lang && t.kind !== 'asr') ||
              tracks.find((t) => t.languageCode === lang);
      if (track) break;
    }
    if (!track) return { status: 'no-track' };

    try {
      const wasOn = isCaptionsOn();
      let prevLang = null;
      try { const cur = player.getOption('captions', 'track'); prevLang = cur && cur.languageCode ? cur.languageCode : null; } catch (_) {}
      if (!restoreState.has(videoId)) restoreState.set(videoId, { wasOn, prevLang });

      // Перезавантажуємо модуль, щоб плеєр зробив новий запит навіть якщо цей трек уже обрано
      // (потрібно для повторної спроби після порожньої відповіді).
      try { player.unloadModule('captions'); } catch (_) {}
      try { player.loadModule('captions'); } catch (_) {}
      player.setOption('captions', 'track', { languageCode: track.languageCode, kind: track.kind });
      return { status: 'selected', lang: track.languageCode };
    } catch (e) {
      return { status: 'no-player', error: String(e) };
    }
  }

  // Повертає субтитри в стан, який був до нашого втручання.
  function restore(videoId) {
    const state = restoreState.get(videoId);
    restoreState.delete(videoId);
    const player = getPlayer();
    if (!state || !player) return;
    try {
      if (!state.wasOn) {
        player.unloadModule('captions');
      } else if (state.prevLang) {
        player.setOption('captions', 'track', { languageCode: state.prevLang });
      }
    } catch (_) {}
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    const { type, videoId } = e.data;

    if (type === 'TYPU_REQUEST') {
      for (const lang of e.data.langs || []) {
        const body = store.get(`${videoId}:${lang}`);
        if (body) { post({ type: 'TYPU_CAPTIONS', videoId, lang, tlang: null, body }); break; }
      }
    } else if (type === 'TYPU_SELECT_TRACK') {
      post({ type: 'TYPU_TRACK_RESULT', videoId, ...selectTrack(videoId, e.data.langs || []) });
    } else if (type === 'TYPU_RESTORE') {
      restore(videoId);
    }
  });
})();
