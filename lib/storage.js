/* ============================================================================
   Хранилище картинок в самой базе (таблица files, db/postgres/schema.sql) —
   вместо Supabase Storage с 2026-10-23. Пути объектов те же, что были:
     looks/{user_id}/{look_id}.jpg  — приватные, только по подписанной ссылке;
     avatars/{user_id}/avatar.jpg   — публичные;
     site-looks/{uuid}.jpg          — публичные (примеры образов на сайте).

   Отдаёт картинки api/files.js. Подписанная ссылка — как у Supabase: адрес с
   временем истечения и подписью HMAC (секрет AUTH_SECRET), без токена входа в
   адресе. Подделать или продлить её без секрета нельзя.
   ============================================================================ */

const crypto = require('crypto');
const db = require('./db');

const PUBLIC_BUCKETS = ['avatars', 'site-looks'];
const BUCKETS = ['looks'].concat(PUBLIC_BUCKETS);

function signingKey() {
  if (!process.env.AUTH_SECRET) throw new Error('AUTH_SECRET не настроен на сервере.');
  return crypto.createHmac('sha256', process.env.AUTH_SECRET).update('files-v1').digest();
}

function signature(bucket, path, expires) {
  return crypto.createHmac('sha256', signingKey()).update(bucket + '\n' + path + '\n' + expires).digest('base64url');
}

async function upload(bucket, path, buffer, contentType) {
  await db.query(
    'insert into files (bucket, path, content_type, data, size_bytes) values ($1, $2, $3, $4, $5) ' +
    'on conflict (bucket, path) do update set content_type = excluded.content_type, data = excluded.data, ' +
    'size_bytes = excluded.size_bytes, updated_at = now()',
    [bucket, path, contentType || 'image/jpeg', buffer, buffer.length]
  );
}

async function remove(bucket, paths) {
  if (!paths.length) return;
  await db.query('delete from files where bucket = $1 and path = any($2::text[])', [bucket, paths]);
}

/* Ссылка на приватную картинку, действует ttlSeconds. */
function signedUrl(bucket, path, ttlSeconds) {
  var expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return '/api/files?b=' + encodeURIComponent(bucket) + '&p=' + encodeURIComponent(path) +
    '&e=' + expires + '&s=' + signature(bucket, path, expires);
}

/* version — чтобы браузер не показывал старую картинку из кэша после замены. */
function publicUrl(bucket, path, version) {
  return '/api/files?b=' + encodeURIComponent(bucket) + '&p=' + encodeURIComponent(path) +
    (version ? '&v=' + encodeURIComponent(version) : '');
}

/* Проверка запроса к api/files.js: true — можно отдавать. */
function isAllowed(bucket, path, expires, sig) {
  if (BUCKETS.indexOf(bucket) === -1 || typeof path !== 'string' || !path || path.length > 300) return false;
  if (PUBLIC_BUCKETS.indexOf(bucket) !== -1) return true;
  var exp = parseInt(expires, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000) || typeof sig !== 'string') return false;
  var expected = Buffer.from(signature(bucket, path, exp));
  var given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

async function read(bucket, path) {
  return db.one('select content_type, data, updated_at from files where bucket = $1 and path = $2', [bucket, path]);
}

module.exports = { upload, remove, signedUrl, publicUrl, isAllowed, read, PUBLIC_BUCKETS };
