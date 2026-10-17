// Знімки для Chrome Web Store (1280×800) зі справжнім встановленим розширенням.
// Заразом це наскрізний тест: розширення завантажується в Chrome як unpacked і має показати число.
//
// Запуск:  npm install && npm run screenshots
// Результат: store/<name>-<theme>.png
//
// Чому так складно:
// - headless Chrome не отримує pot-токен від YouTube, субтитри приходять порожніми → потрібен headful;
// - звичайний puppeteer YouTube розпізнає як автоматизацію і теж віддає порожні субтитри → потрібен stealth;
// - тема і мова інтерфейсу задаються cookie PREF до завантаження, бо перемикання атрибута dark
//   на вже відмальованій сторінці ламає частину елементів (кнопка Subscribe).
const puppeteer = require('puppeteer-extra');
puppeteer.use(require('puppeteer-extra-plugin-stealth')());
const path = require('path');
const fs = require('fs');

const EXT = path.resolve(__dirname, '..');
const OUT = path.join(EXT, 'store');
fs.mkdirSync(OUT, { recursive: true });

const VIDEOS = [
  { id: 'IiPHFerpnjg', name: 'maturity', seek: 600 },
  { id: 'Xf7WLdRbwtg', name: 'designium', seek: 420 },
];
// f6=400 — темна тема, hl — мова інтерфейсу.
const THEMES = { light: 'hl=uk', dark: 'f6=400&hl=uk' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: false, pipe: true,
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--lang=uk-UA', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', '--no-first-run', '--no-default-browser-check'],
  });
  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', (m) => { if (m.text().includes('[Typu]')) console.log('PAGE:', m.text()); });

  for (const v of VIDEOS) {
    for (const [theme, pref] of Object.entries(THEMES)) {
      await page.setCookie({ name: 'PREF', value: pref, domain: '.youtube.com', path: '/' });
      await page.goto(`https://www.youtube.com/watch?v=${v.id}`, { waitUntil: 'domcontentloaded' });

      // До 60 с: розширення з трьома повторами після порожніх відповідей може працювати ~40 с,
      // а перше завантаження у свіжому профілі Chrome повільніше.
      let text = null;
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        text = await page.evaluate(() => document.querySelector('.typu-counter')?.textContent ?? null);
        if (text && !text.includes('…')) break;
      }
      console.log(v.id, theme, '→', text);
      if (!text || text.includes('…')) { console.log('SKIP', v.id, theme); continue; }

      // Пауза на кадрі з ведучими, без субтитрів поверх відео, бічна колонка невидима.
      await page.evaluate(async (seek) => {
        const p = document.querySelector('#movie_player');
        const vid = document.querySelector('video');
        try { p.unloadModule('captions'); } catch (_) {}
        if (vid) {
          await new Promise((res) => { vid.addEventListener('seeked', res, { once: true }); vid.currentTime = seek; setTimeout(res, 5000); });
          vid.pause();
        }
        const s = document.createElement('style');
        // visibility, а не display: інакше ytd-watch-flexy перераховує розмір плеєра і рядок кнопок іде за кадр
        s.textContent = '#secondary { visibility: hidden !important; } .ytp-chrome-bottom, .ytp-gradient-bottom { opacity: 0 !important; }';
        document.head.appendChild(s);
        window.scrollTo(0, 0);
      }, v.seek);
      await sleep(1500);

      const file = path.join(OUT, `${v.name}-${theme}.png`);
      await page.screenshot({ path: file });
      console.log('saved', file);
    }
  }

  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
