/* ============================================================================
   Подключение к собственной базе PostgreSQL (сервер в России) — вместо
   Supabase с 2026-10-23. Используется ТОЛЬКО внутри api/*.js: браузер к базе
   не подключается никогда, все проверки «кто звонит» — в lib/auth.js.

   Только параметризованные запросы: query('… where id = $1', [id]).

   DATABASE_URL     — postgres://stil:ПАРОЛЬ@АДРЕС:5432/stil
   DATABASE_CA      — сертификат сервера базы (PEM, тот же самоподписанный, что
                      на сервере). С ним соединение шифруется и сертификат
                      сверяется — подменить сервер посередине не выйдет.
   DATABASE_SSL=off — только для локальных тестов без шифрования.

   Пул маленький: на Vercel одновременно живёт несколько копий функции, у
   каждой свой пул, а у Postgres на маленьком сервере около 100 соединений.
   ============================================================================ */

const { Pool, types } = require('pg');

/* bigint (суммы в копейках, count(*)) приходит строкой — у нас все такие числа
   далеко меньше 2^53, читаем их как обычные числа, как это делал Supabase. */
types.setTypeParser(20, function (value) { return parseInt(value, 10); });

let pool = null;

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

function sslOptions() {
  if (process.env.DATABASE_SSL === 'off') return false;
  if (!process.env.DATABASE_CA) {
    throw new Error('DATABASE_CA не задан — без сертификата к базе не подключаемся.');
  }
  return {
    ca: process.env.DATABASE_CA.replace(/\\n/g, '\n'),
    rejectUnauthorized: true,
    /* Сертификат самоподписанный и выписан на IP-адрес сервера; сверяем сам
       сертификат (ca), имя хоста в нём не проверяем. */
    checkServerIdentity: function () { return undefined; }
  };
}

function getPool() {
  if (pool) return pool;
  if (!isConfigured()) throw new Error('DATABASE_URL не настроен на сервере.');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslOptions(),
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000
  });
  pool.on('error', function (err) {
    console.error('db pool error:', err && err.message);
  });
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params || []);
}

/* Первая строка результата или null. */
async function one(text, params) {
  var result = await query(text, params);
  return result.rows[0] || null;
}

/* Несколько запросов одной транзакцией: fn(client) получает клиент с тем же query(). */
async function transaction(fn) {
  var client = await getPool().connect();
  try {
    await client.query('begin');
    var value = await fn(client);
    await client.query('commit');
    return value;
  } catch (err) {
    try { await client.query('rollback'); } catch (e) { /* соединение уже сломано */ }
    throw err;
  } finally {
    client.release();
  }
}

/* Для тестов: подставить свой пул (например, к локальной базе). */
function setPoolForTests(customPool) {
  pool = customPool;
}

module.exports = { isConfigured, query, one, transaction, setPoolForTests };
