// Лічильник "типу" — content script (ізольований світ розширення).
// Субтитри приходять із inject.js (головний світ сторінки) через postMessage.

// \b у JS не працює з кирилицею, тому межі слова — через \p{L} і прапорець u.
const WORD_RE = /(?<!\p{L})(типу|тіпа|типа|типе)(?!\p{L})/giu;

// Рахуємо лише оригінальну українську доріжку. Автодубльовані відео мають ще
// англійський трек, і плеєр може обрати його за замовчуванням.
const TARGET_LANGS = ['uk'];

// На сторінці кілька #top-level-buttons-computed (у прихованих панелях теж),
// тому обмежуємося видимим блоком метаданих під плеєром.
const BUTTONS_SELECTOR = 'ytd-watch-metadata #top-level-buttons-computed';

const CAPTIONS_TIMEOUT_MS = 8000;

const counts = new Map(); // videoId -> number
let currentVideoId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getVideoId() {
  return new URL(location.href).searchParams.get('v');
}

function countWords(text) {
  return (text.match(WORD_RE) || []).length;
}

// Витягує текст із відповіді timedtext: json3 або XML (srv1/srv3).
function extractText(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    return (data.events || [])
      .flatMap((ev) => ev.segs || [])
      .map((seg) => seg.utf8 || '')
      .join(' ');
  }
  const doc = new DOMParser().parseFromString(trimmed, 'text/xml');
  return doc.documentElement ? doc.documentElement.textContent : '';
}

// ---------- UI ----------

function formatCount(n) {
  return n.toLocaleString('uk-UA');
}

function renderCounter(count) {
  const container = document.querySelector(BUTTONS_SELECTOR);
  if (!container) return false;

  let el = document.querySelector('.typu-counter');
  if (!el) {
    el = document.createElement('div');
    el.className = 'typu-counter';
    el.title = 'Скільки разів у відео прозвучало «типу»';
    // YouTube вмикає Trusted Types CSP, тому innerHTML тут кидає помилку — будуємо через DOM.
    for (const [cls, text] of [['typu-counter-icon', '🎙️'], ['typu-counter-count', ''], ['typu-counter-label', 'типу']]) {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      el.appendChild(span);
    }
    const likeBlock = container.querySelector('segmented-like-dislike-button-view-model');
    if (likeBlock) likeBlock.insertAdjacentElement('afterend', el);
    else container.prepend(el);
  }
  el.querySelector('.typu-counter-count').textContent = count === null ? '…' : formatCount(count);
  el.classList.toggle('typu-counter--loading', count === null);
  return true;
}

function removeCounter() {
  const el = document.querySelector('.typu-counter');
  if (el) el.remove();
}

// Чекає на появу елемента (YouTube домальовує сторінку асинхронно).
function waitFor(selector, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const found = document.querySelector(selector);
    if (found) return resolve(found);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
  });
}

// ---------- Обмін з inject.js ----------

function post(msg) {
  window.postMessage(msg, location.origin);
}

// Надсилає команду в inject.js і чекає на відповідь певного типу для цього відео.
function ask(request, replyType, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const onMessage = (e) => {
      if (e.source !== window || !e.data || e.data.type !== replyType || e.data.videoId !== request.videoId) return;
      cleanup();
      resolve(e.data);
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
    window.addEventListener('message', onMessage);
    post(request);
  });
}

async function waitForCount(videoId, timeoutMs) {
  const started = Date.now();
  while (!counts.has(videoId) && Date.now() - started < timeoutMs && currentVideoId === videoId) {
    await sleep(250);
  }
  return counts.has(videoId);
}

// Порожні відповіді timedtext (запит пішов до готовності pot-токена) — за відео.
const emptyResponses = new Set();

// Чекає на підрахунок або на сигнал про порожню відповідь.
async function waitForCountOrEmpty(videoId, timeoutMs) {
  emptyResponses.delete(videoId);
  const started = Date.now();
  while (Date.now() - started < timeoutMs && currentVideoId === videoId) {
    if (counts.has(videoId)) return 'count';
    if (emptyResponses.has(videoId)) return 'empty';
    await sleep(250);
  }
  return 'timeout';
}

// ---------- Отримання субтитрів ----------

// Основний шлях: просимо inject.js обрати український трек через API плеєра.
// Плеєр сам робить запит timedtext із токеном, inject.js його перехоплює.
async function requestCaptions(videoId) {
  // Може, трек уже перехоплено (субтитри були увімкнені до нас).
  post({ type: 'TYPU_REQUEST', videoId, langs: TARGET_LANGS });
  await sleep(300);
  if (counts.has(videoId)) return;

  // Плеєр може з'явитися пізніше за кнопки під відео.
  await waitFor('#movie_player');
  if (currentVideoId !== videoId) return;

  // Плеєр інколи ще не переключився на нове відео — даємо кілька спроб.
  let result = null;
  for (let attempt = 0; attempt < 5 && currentVideoId === videoId; attempt++) {
    result = await ask({ type: 'TYPU_SELECT_TRACK', videoId, langs: TARGET_LANGS }, 'TYPU_TRACK_RESULT');
    if (result && result.status !== 'no-player') break;
    await sleep(500);
  }
  if (currentVideoId !== videoId) return;

  if (!result || result.status === 'no-player') {
    await requestCaptionsViaButton(videoId);
    return;
  }
  if (result.status === 'no-track') {
    console.log('[Typu] У відео немає українських субтитрів:', videoId);
    removeCounter();
    return;
  }

  // Перший запит плеєра часто йде до готовності pot-токена і повертається порожнім,
  // а сам плеєр його не повторює. Тому на порожню відповідь перевибираємо трек.
  let outcome = await waitForCountOrEmpty(videoId, CAPTIONS_TIMEOUT_MS);
  for (let retry = 0; retry < 3 && outcome === 'empty' && currentVideoId === videoId; retry++) {
    console.log('[Typu] Порожні субтитри, повторна спроба', retry + 1);
    await sleep(1500);
    await ask({ type: 'TYPU_SELECT_TRACK', videoId, langs: TARGET_LANGS }, 'TYPU_TRACK_RESULT');
    outcome = await waitForCountOrEmpty(videoId, CAPTIONS_TIMEOUT_MS);
  }
  post({ type: 'TYPU_RESTORE', videoId });

  if (outcome !== 'count' && currentVideoId === videoId) {
    console.log('[Typu] Не дочекалися субтитрів для', videoId);
    removeCounter();
  }
}

// Запасний шлях, якщо API плеєра недоступне: клацаємо кнопку CC.
// Рахуємо все одно лише цільову мову, тож якщо плеєр обере іншу — покажемо «немає».
async function requestCaptionsViaButton(videoId) {
  const btn = await waitFor('.ytp-subtitles-button');
  if (!btn || currentVideoId !== videoId) return;

  const wasOn = btn.getAttribute('aria-pressed') === 'true';
  if (wasOn) {
    btn.click();
    await sleep(200);
  }
  btn.click();

  const found = await waitForCount(videoId, CAPTIONS_TIMEOUT_MS);
  if (!wasOn && btn.getAttribute('aria-pressed') === 'true') btn.click();

  if (!found && currentVideoId === videoId) {
    console.log('[Typu] Субтитрів не знайдено для', videoId);
    removeCounter();
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data) return;

  if (e.data.type === 'TYPU_CAPTIONS_EMPTY') {
    if (!e.data.tlang && TARGET_LANGS.includes(e.data.lang)) emptyResponses.add(e.data.videoId);
    return;
  }
  if (e.data.type !== 'TYPU_CAPTIONS') return;
  const { videoId, lang, tlang, body } = e.data;

  // Ігноруємо інші мови та автопереклад.
  if (tlang || (lang && !TARGET_LANGS.includes(lang))) return;

  let count;
  try {
    count = countWords(extractText(body));
  } catch (err) {
    console.warn('[Typu] Не вдалося розібрати субтитри', err);
    return;
  }
  counts.set(videoId, count);
  console.log(`[Typu] ${videoId} (${lang}): «типу» ${count} раз(ів)`);
  if (videoId === currentVideoId) renderCounter(count);
});

// ---------- Навігація ----------

async function onNavigate() {
  removeCounter();

  if (!location.pathname.startsWith('/watch')) { currentVideoId = null; return; }

  const videoId = getVideoId();
  currentVideoId = videoId;
  if (!videoId) return;

  await waitFor(BUTTONS_SELECTOR);
  if (currentVideoId !== videoId) return;

  if (counts.has(videoId)) {
    renderCounter(counts.get(videoId));
  } else {
    renderCounter(null); // «…» поки чекаємо
    requestCaptions(videoId);
  }
}

document.addEventListener('yt-navigate-finish', onNavigate);
onNavigate();
