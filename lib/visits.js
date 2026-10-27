/* ============================================================================
   Свой счётчик заходов — без cookie и без данных о человеке (в отличие от
   Яндекс.Метрики, которая включается только после согласия и поэтому видит
   не всех). Страница шлёт «открыта такая-то страница» (js/metrika.js →
   api/reviews.js?action=hit), здесь это складывается в счётчики по часам:
     page_views(hour, path, source, views, visits)
   IP, user-agent, адрес страницы-источника и время точнее часа НЕ хранятся.
   source — тип источника визита (поиск/соцсеть/мессенджер/напрямую) или метка
   из ссылки (?from=… / utm_source=…), например ссылка партнёра.

   Таблицу заводит сам код (create table if not exists) — отдельно запускать
   SQL на сервере не нужно; описание продублировано в db/postgres/schema.sql.
   ============================================================================ */

const db = require('./db');

let tableReady = null;

/* Два параллельных первых вызова на свежей базе могут столкнуться на create table —
   тогда второй падает; сбрасываем обещание, следующий вызов просто повторит. */
function ensureTable() {
  if (!tableReady) {
    tableReady = db.query(
      'create table if not exists page_views (' +
      '  hour    timestamptz not null,' +
      '  path    text not null,' +
      '  source  text not null,' +
      '  views   integer not null default 0,' +
      '  visits  integer not null default 0,' +
      '  primary key (hour, path, source)' +
      ')'
    ).catch(function (err) {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

const SOURCE_RULES = [
  [/(^|\.)(yandex\.[a-z]+|ya\.ru)$/, 'yandex'],
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)(vk\.com|vk\.ru|vk\.me)$/, 'vk'],
  [/(^|\.)(t\.me|telegram\.org|telegram\.me)$/, 'telegram'],
  [/(^|\.)max\.ru$/, 'max'],
  [/(^|\.)(wa\.me|whatsapp\.com|whatsapp\.net)$/, 'whatsapp'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)ok\.ru$/, 'ok'],
  [/(^|\.)dzen\.ru$/, 'dzen'],
  [/(^|\.)avito\.ru$/, 'avito'],
  [/(^|\.)mail\.ru$/, 'mail'],
  [/(^|\.)(bing\.com|duckduckgo\.com)$/, 'search']
];

const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|java\//i;

/* '/', '/obraz-po-foto.html', '/obraz-po-foto' → '/', '/obraz-po-foto'. Служебные и
   непохожие на страницу сайта пути не считаем. */
function normalizePath(raw) {
  var p = String(raw || '').split(/[?#]/)[0].toLowerCase();
  if (p === '' || p === '/' || p === '/index' || p === '/index.html') return '/';
  p = p.replace(/\.html$/, '').replace(/\/$/, '');
  if (!/^\/[a-z0-9-]{1,40}$/.test(p) || /^\/admin/.test(p)) return null;
  return p;
}

function classifySource(referrer, tag) {
  var t = String(tag || '').trim().toLowerCase();
  if (/^[a-z0-9_-]{1,32}$/.test(t)) return 'tag:' + t;
  var host = '';
  try { host = new URL(String(referrer || '')).hostname.toLowerCase(); } catch (e) { host = ''; }
  if (!host || /(^|\.)stil-shag\.ru$/.test(host) || /\.vercel\.app$/.test(host)) return 'direct';
  for (var i = 0; i < SOURCE_RULES.length; i++) {
    if (SOURCE_RULES[i][0].test(host)) return SOURCE_RULES[i][1];
  }
  return 'other';
}

/* body: { path, first, referrer, tag } — first: первая страница визита (вкладки);
   referrer/tag — откуда начался визит, браузер повторяет их на следующих страницах,
   чтобы все просмотры визита легли на один источник. */
async function recordHit(body, userAgent) {
  if (BOT_UA.test(String(userAgent || ''))) return false;
  var path = normalizePath(body && body.path);
  if (!path) return false;
  var first = !!(body && body.first);
  var source = classifySource(body && body.referrer, body && body.tag);

  await ensureTable();
  await db.query(
    'insert into page_views (hour, path, source, views, visits) ' +
    "values (date_trunc('hour', now()), $1, $2, 1, $3) " +
    'on conflict (hour, path, source) do update ' +
    'set views = page_views.views + 1, visits = page_views.visits + excluded.visits',
    [path, source, first ? 1 : 0]
  );
  return source;
}

module.exports = {
  ensureTable: ensureTable,
  recordHit: recordHit,
  classifySource: classifySource,
  normalizePath: normalizePath
};
