# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Що це

«Типу лічильник» — Chrome-розширення (Manifest V3), яке рахує слово-паразит «типу» (і варіанти тіпа/типа/типе) в українських субтитрах YouTube-відео і показує число в рядку кнопок під плеєром, поруч із лайком/дизлайком. Зроблено для подкасту «Радіо Кнопка» (@radio_knopka_podcast). Спілкування з користувачем — українською.

Збірки немає: файли в корені і є розширенням. Тестів немає; перевірка — ручна або через скрипт знімків.

## Команди

```bash
npm run check         # синтаксис inject.js/content.js + валідність manifest.json
npm run zip           # typu-counter-<version>.zip для Chrome Web Store (version береться з package.json — тримати синхронно з manifest.json)
npm install && npm run screenshots   # знімки для стора в store/ + наскрізний тест реального розширення (відкриває вікно Chrome)
```

Локальна перевірка руками: `chrome://extensions` → Developer mode → Load unpacked → ця папка. Після змін у коді — Reload на картці розширення. Логи розширення в консолі сторінки мають префікс `[Typu]`.

## Архітектура: два світи й обмін повідомленнями

Ключова складність — YouTube віддає субтитри лише на запит із токеном `pot`, який генерує сам плеєр. Прямий `fetch` на `/api/timedtext` повертає 200 і порожнє тіло. Тому розширення не завантажує субтитри саме, а змушує плеєр зробити це і перехоплює відповідь.

- **inject.js** — content script у `world: MAIN`, `run_at: document_start`. Патчить `XMLHttpRequest.prototype.open` і `window.fetch`, ловить відповіді `/api/timedtext`, тримає їх у `Map` за ключем `videoId:lang` і шле в isolated world через `window.postMessage`. Також керує плеєром через `#movie_player` API (`getPlayerResponse`, `loadModule/unloadModule('captions')`, `setOption('captions','track',…)`), бо з isolated world до об'єктів сторінки доступу немає.
- **content.js** — звичайний content script (isolated world). Оркеструє процес, рахує слова, малює UI, слухає `yt-navigate-finish` (YouTube — SPA, сторінка не перезавантажується між відео).

Протокол повідомлень (усі `postMessage` з перевіркою `e.source === window`):

| Повідомлення | Напрям | Сенс |
|---|---|---|
| `TYPU_REQUEST {videoId, langs}` | content → inject | віддай уже перехоплене, якщо є |
| `TYPU_SELECT_TRACK {videoId, langs}` | content → inject | обери трек, запам'ятай стан для відновлення |
| `TYPU_TRACK_RESULT {status: selected\|no-track\|no-player}` | inject → content | результат вибору |
| `TYPU_CAPTIONS {videoId, lang, tlang, body}` | inject → content | тіло субтитрів (json3 або XML) |
| `TYPU_CAPTIONS_EMPTY {videoId, lang}` | inject → content | плеєр отримав порожню відповідь |
| `TYPU_RESTORE {videoId}` | content → inject | поверни субтитри в стан до втручання |

Потік для нового відео: `onNavigate` → `TYPU_REQUEST` (кеш) → `TYPU_SELECT_TRACK` (до 5 спроб, бо плеєр може ще не переключитися) → чекати `TYPU_CAPTIONS` або `TYPU_CAPTIONS_EMPTY` → на порожню відповідь перевибрати трек (до 3 разів, пауза 1.5 с) → `TYPU_RESTORE`. Якщо API плеєра недоступне — запасний шлях кліком по `.ytp-subtitles-button`.

## Неочевидні рішення (не ламати)

- **Кирилиця і `\b`**: межа слова `\b` у JS працює лише з ASCII. Підрахунок через `(?<!\p{L})(…)(?!\p{L})` з прапорцем `u`.
- **Мова треку**: рахуємо лише `TARGET_LANGS = ['uk']` і ігноруємо `tlang` (автопереклад). Автодубльовані випуски мають ще `en`-трек, і плеєр з англійським інтерфейсом обирає його за замовчуванням — без примусового вибору лічильник показував би 0. Ручні субтитри мають пріоритет над `asr`.
- **Порожня перша відповідь**: перший запит плеєра часто йде до готовності `pot`, повертається порожнім, і плеєр його сам не повторює. Звідси `TYPU_CAPTIONS_EMPTY` і перевибір треку. У `selectTrack` навмисно `unloadModule` → `loadModule` → `setOption`, інакше повторний вибір того самого треку запиту не робить.
- **Trusted Types**: YouTube вмикає CSP `require-trusted-types-for`, тому `innerHTML` кидає помилку. UI будується лише через `createElement`/`textContent`.
- **Селектор контейнера**: на сторінці три `#top-level-buttons-computed` (два в прихованих панелях). Правильний — `ytd-watch-metadata #top-level-buttons-computed`; вставка після `segmented-like-dislike-button-view-model`.
- **Стилі**: пігулка звірена з кнопкою Share: висота 40px, радіус 20px, `padding 0 16px`, `margin 0 8px`, фон `rgba(0,0,0,.05)` / hover `.1`; темна тема через `html[dark]` — `rgba(255,255,255,.1)` / `.2`. У YouTube hover без transition, тому його тут теж немає. Між числом і словом `margin-left: .25em` (ширина пробілу), між іконкою і числом 6px.
- **Дозволи**: лише `host_permissions` на `https://www.youtube.com/*`, без `scripting`/`storage`/фонового скрипта. Не додавати без потреби — це ускладнює модерацію в сторі.

## Тестування на YouTube

- Контрольні відео: `IiPHFerpnjg` (соло-випуск, 349 «типу», треки `en:asr`+`uk:asr`), `Xf7WLdRbwtg` (з гостем, 81, плеєр за замовчуванням бере `en-US`). Відео без субтитрів для негативного тесту: `MGkWSAnoDOI`.
- Headless Chrome і звичайний puppeteer **не отримують валідний `pot`** — субтитри порожні. Робочий варіант тільки headful + `puppeteer-extra-plugin-stealth` (див. `scripts/store-screenshots.js`). Це обмеження середовища, а не баг розширення.
- `npm run screenshots` інколи пропускає (`SKIP`) перший знімок: перше завантаження у свіжому профілі Chrome найповільніше. Просто перезапустити; попередній файл при `SKIP` не перезаписується.
- У вбудованому браузері Claude Code розширення не встановлюється; там можна лише виконати код скриптів на сторінці (`inject.js` + стилі + `content.js`, обгорнутий в IIFE) — content.js не використовує `chrome.*` API, тому це працює.

## Публікація

`store/listing.md` — тексти картки й відповіді для Privacy practices; `PRIVACY.md` — політика двома мовами (потребує публічного URL, у кінці плейсхолдери для email); `store/*.png` — знімки 1280×800. Назва розширення — поле `name` у `manifest.json`; при зміні підняти `version` і перезібрати zip.
