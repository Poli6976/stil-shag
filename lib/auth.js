/* ============================================================================
   Вход по коду из письма и проверка залогиненного пользователя — вместо
   Supabase Auth с 2026-10-23 (таблицы users / login_codes / sessions,
   db/postgres/schema.sql).

   Как устроено:
     1. sendLoginCode — 6 цифр на email; в базе только HMAC от кода
        (AUTH_SECRET), код живёт CODE_TTL_MINUTES, новый код отменяет старые;
     2. verifyLoginCode — не больше MAX_ATTEMPTS неверных попыток на код;
        при успехе создаётся пользователь (если новый) и сессия;
     3. токен сессии — 32 случайных байта, браузеру отдаётся один раз,
        в базе — только sha256 от него;
     4. requireUser(req) — по заголовку Authorization: Bearer <токен>.
        Id пользователя ВСЕГДА берётся отсюда, а не из тела запроса — иначе
        клиент мог бы подставить чужой userId.
   ============================================================================ */

const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');
const { checkRateLimit } = require('./rateLimit');

const CODE_TTL_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 60;

function isConfigured() {
  return db.isConfigured() && !!process.env.AUTH_SECRET && mailer.isConfigured();
}

function normalizeEmail(value) {
  var email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function codeHash(email, code) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET).update('login-v1\n' + email + '\n' + code).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function emailBucket(email) {
  return 'login-email:' + crypto.createHash('sha256').update(email).digest('hex');
}

/* { ok: true } | { error, status } */
async function sendLoginCode(req, rawEmail) {
  var email = normalizeEmail(rawEmail);
  if (!email) return { status: 400, error: 'Проверьте адрес почты — похоже, в нём опечатка.' };

  var ipAllowed = await checkRateLimit(req, 'login-send', { windowSeconds: 3600, maxHits: 15 });
  if (!ipAllowed) return { status: 429, error: 'Слишком много попыток входа. Попробуйте через час.' };
  var emailAllowed = await checkRateLimit(null, emailBucket(email), { windowSeconds: 3600, maxHits: 5 });
  if (!emailAllowed) return { status: 429, error: 'Код уже отправлялся несколько раз. Проверьте папку «Спам» или попробуйте через час.' };

  var code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query('update login_codes set used_at = now() where email = $1 and used_at is null', [email]);
  await db.query(
    "insert into login_codes (email, code_hash, expires_at) values ($1, $2, now() + ($3 || ' minutes')::interval)",
    [email, codeHash(email, code), String(CODE_TTL_MINUTES)]
  );

  try {
    await mailer.sendLoginCode(email, code, CODE_TTL_MINUTES);
  } catch (err) {
    console.error('auth send-code: письмо не ушло:', err && err.message);
    return { status: 502, error: 'Не получилось отправить письмо. Попробуйте ещё раз через минуту.' };
  }
  return { ok: true };
}

function sessionResponse(token, user, expiresAt) {
  return {
    access_token: token,
    expires_at: Math.floor(new Date(expiresAt).getTime() / 1000),
    user: { id: user.id, email: user.email }
  };
}

/* { session } | { error, status } */
async function verifyLoginCode(rawEmail, rawCode) {
  var email = normalizeEmail(rawEmail);
  var code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
  if (!email || !/^\d{6}$/.test(code)) return { status: 400, error: 'Код — это 6 цифр из письма.' };

  return db.transaction(async function (client) {
    var row = (await client.query(
      'select id, code_hash, attempts, expires_at from login_codes ' +
      'where email = $1 and used_at is null order by created_at desc limit 1 for update',
      [email]
    )).rows[0];

    if (!row || new Date(row.expires_at) < new Date() || row.attempts >= MAX_ATTEMPTS) {
      return { status: 400, error: 'Код устарел. Запросите новый — он придёт на почту.' };
    }

    var expected = Buffer.from(row.code_hash);
    var given = Buffer.from(codeHash(email, code));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      await client.query('update login_codes set attempts = attempts + 1 where id = $1', [row.id]);
      var left = MAX_ATTEMPTS - row.attempts - 1;
      return {
        status: 400,
        error: left > 0
          ? 'Код не подошёл — проверьте и попробуйте снова.'
          : 'Код не подошёл несколько раз подряд. Запросите новый.'
      };
    }

    await client.query('update login_codes set used_at = now() where id = $1', [row.id]);
    var user = (await client.query(
      'insert into users (email, last_login_at) values ($1, now()) ' +
      'on conflict (email) do update set last_login_at = now() returning id, email',
      [email]
    )).rows[0];
    await client.query('insert into wallets (user_id) values ($1) on conflict (user_id) do nothing', [user.id]);

    var token = crypto.randomBytes(32).toString('base64url');
    var session = (await client.query(
      "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval) returning expires_at",
      [tokenHash(token), user.id, String(SESSION_DAYS)]
    )).rows[0];

    return { session: sessionResponse(token, user, session.expires_at) };
  });
}

function bearerToken(req) {
  var header = req.headers && (req.headers['authorization'] || req.headers['Authorization']);
  var token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : null;
  return token && token.length <= 200 ? token : null;
}

/* { id, email } или null. */
async function requireUser(req) {
  var token = bearerToken(req);
  if (!token) return null;
  try {
    var row = await db.one(
      'select u.id, u.email, s.last_seen_at from sessions s join users u on u.id = s.user_id ' +
      'where s.token_hash = $1 and s.expires_at > now()',
      [tokenHash(token)]
    );
    if (!row) return null;
    /* Отметка «был на сайте» — не чаще раза в час, чтобы не писать в базу на каждый запрос. */
    if (Date.now() - new Date(row.last_seen_at).getTime() > 3600 * 1000) {
      db.query('update sessions set last_seen_at = now() where token_hash = $1', [tokenHash(token)]).catch(function () {});
    }
    return { id: row.id, email: row.email };
  } catch (err) {
    console.error('requireUser error:', err && err.message);
    return null;
  }
}

/* Текущая сессия по токену — браузер проверяет, не истекла ли она. */
async function getSession(req) {
  var token = bearerToken(req);
  if (!token) return null;
  var row = await db.one(
    'select u.id, u.email, s.expires_at from sessions s join users u on u.id = s.user_id ' +
    'where s.token_hash = $1 and s.expires_at > now()',
    [tokenHash(token)]
  );
  return row ? sessionResponse(token, row, row.expires_at) : null;
}

async function logout(req) {
  var token = bearerToken(req);
  if (token) await db.query('delete from sessions where token_hash = $1', [tokenHash(token)]);
}

/* Уборка по расписанию (api/files.js, Vercel Cron). */
async function cleanup() {
  await db.query("delete from login_codes where created_at < now() - interval '1 day'");
  await db.query('delete from sessions where expires_at < now()');
  await db.query("delete from rate_limit_hits where created_at < now() - interval '1 day'");
}

module.exports = { isConfigured, requireUser, sendLoginCode, verifyLoginCode, getSession, logout, cleanup, normalizeEmail };
