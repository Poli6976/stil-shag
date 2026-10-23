/* ============================================================================
   Перенос данных из Supabase в собственную базу PostgreSQL (2026-10-23).

   Запуск (переменные — в файле .env.migrate, он в .gitignore и на сайт не
   попадает; scripts/ тоже не публикуется — см. .vercelignore):
     node --env-file=.env.migrate scripts/migrate-from-supabase.js

     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — откуда (только чтение);
     DATABASE_URL (+ DATABASE_CA или DATABASE_SSL=off) — куда; схема
     db/postgres/schema.sql должна быть уже применена.

   Что переносится: пользователи (id и email из auth.users — id сохраняются,
   поэтому все связи остаются), все таблицы сайта и картинки, на которые
   ссылаются записи (образы, аватарки, примеры образов). Коды входа, сессии
   и счётчики лимитов не переносятся — клиенткам один раз придётся войти
   заново по коду.

   Повторный запуск безопасен и нужен: перед переключением сайта его
   запускают ещё раз — новые строки добавятся, изменённые обновятся
   (по первичному ключу). В конце — сверка количества строк.
   ============================================================================ */

const TABLES = [
  // порядок важен: сначала то, на что ссылаются другие таблицы
  { name: 'wallets', key: ['user_id'] },
  { name: 'wallet_transactions', key: ['id'] },
  { name: 'payments', key: ['id'], deferColumns: ['order_id'] },
  { name: 'orders', key: ['id'] },
  { name: 'discount_credits', key: ['id'] },
  { name: 'saved_looks', key: ['id'] },
  { name: 'style_profiles', key: ['user_id'] },
  { name: 'look_ratings', key: ['look_id'] },
  { name: 'partners', key: ['id'] },
  { name: 'partner_codes', key: ['id'] },
  { name: 'reviews', key: ['id'] },
  { name: 'site_looks', key: ['id'] }
];

const PAGE = 500;

async function fetchAll(supabase, table, orderBy) {
  var rows = [];
  for (var from = 0; ; from += PAGE) {
    var result = await supabase.from(table).select('*').order(orderBy, { ascending: true }).range(from, from + PAGE - 1);
    if (result.error) throw new Error(table + ': ' + result.error.message);
    rows = rows.concat(result.data || []);
    if (!result.data || result.data.length < PAGE) return rows;
  }
}

async function fetchUsers(supabase) {
  var users = [];
  for (var page = 1; ; page++) {
    var result = await supabase.auth.admin.listUsers({ page: page, perPage: 1000 });
    if (result.error) throw new Error('auth.users: ' + result.error.message);
    var batch = (result.data && result.data.users) || [];
    users = users.concat(batch);
    if (batch.length < 1000) return users;
  }
}

async function targetColumns(client, table) {
  var result = await client.query(
    "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1",
    [table]
  );
  var map = {};
  result.rows.forEach(function (r) { map[r.column_name] = r.data_type; });
  return map;
}

function toParam(value, dataType) {
  if (value === undefined) return null;
  if (dataType === 'jsonb' || dataType === 'json') return value === null ? null : JSON.stringify(value);
  return value;
}

/* Вставить или обновить строки по первичному ключу. Колонки — только те, что есть и там, и там. */
async function upsertRows(client, table, key, rows, columnsInfo, skipColumns) {
  if (!rows.length) return { written: 0, skippedColumns: [] };
  var seen = {};
  rows.forEach(function (row) { Object.keys(row).forEach(function (c) { seen[c] = true; }); });
  var sourceColumns = Object.keys(seen);
  var columns = sourceColumns.filter(function (c) { return columnsInfo[c] && skipColumns.indexOf(c) === -1; });
  var skipped = sourceColumns.filter(function (c) { return !columnsInfo[c]; });
  var updates = columns.filter(function (c) { return key.indexOf(c) === -1; });
  var sql = 'insert into ' + table + ' (' + columns.join(', ') + ') values (' +
    columns.map(function (c, i) { return '$' + (i + 1) + (columnsInfo[c] === 'jsonb' ? '::jsonb' : ''); }).join(', ') + ') ' +
    'on conflict (' + key.join(', ') + ') ' +
    (updates.length ? 'do update set ' + updates.map(function (c) { return c + ' = excluded.' + c; }).join(', ') : 'do nothing');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    await client.query(sql, columns.map(function (c) { return toParam(row[c], columnsInfo[c]); }));
  }
  return { written: rows.length, skippedColumns: skipped };
}

async function copyFile(supabase, client, bucket, path, log) {
  var exists = await client.query('select 1 from files where bucket = $1 and path = $2', [bucket, path]);
  if (exists.rows.length) return 'exists';
  var result = await supabase.storage.from(bucket).download(path);
  if (result.error || !result.data) {
    log('  ! нет файла ' + bucket + '/' + path + ': ' + ((result.error && result.error.message) || 'пусто'));
    return 'missing';
  }
  var buffer = Buffer.from(await result.data.arrayBuffer());
  var type = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
  await client.query(
    'insert into files (bucket, path, content_type, data, size_bytes) values ($1, $2, $3, $4, $5) on conflict (bucket, path) do nothing',
    [bucket, path, type, buffer, buffer.length]
  );
  return 'copied';
}

async function migrate(opts) {
  var supabase = opts.supabase;
  var pool = opts.pool;
  var log = opts.log || console.log;
  var report = {};

  var client = await pool.connect();
  try {
    // ---- пользователи ----
    var users = await fetchUsers(supabase);
    var userIds = {};
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      if (!u.email) { log('  ! пользователь ' + u.id + ' без email — пропущен'); continue; }
      await client.query(
        'insert into users (id, email, created_at, last_login_at) values ($1, $2, $3, $4) ' +
        'on conflict (id) do update set email = excluded.email, last_login_at = excluded.last_login_at',
        [u.id, String(u.email).trim().toLowerCase(), u.created_at || new Date().toISOString(), u.last_sign_in_at || null]
      );
      userIds[u.id] = true;
    }
    report.users = { source: users.length };
    log('users: ' + users.length);

    // ---- таблицы ----
    var deferred = [];
    for (var t = 0; t < TABLES.length; t++) {
      var spec = TABLES[t];
      var rows = await fetchAll(supabase, spec.name, spec.key[0]);
      var orphans = rows.filter(function (r) { return 'user_id' in r && r.user_id && !userIds[r.user_id]; });
      if (orphans.length) log('  ! ' + spec.name + ': ' + orphans.length + ' строк без пользователя — пропущены');
      rows = rows.filter(function (r) { return orphans.indexOf(r) === -1; });
      var info = await targetColumns(client, spec.name);
      var res = await upsertRows(client, spec.name, spec.key, rows, info, spec.deferColumns || []);
      if (res.skippedColumns.length) log('  · ' + spec.name + ': старые колонки не переносятся — ' + res.skippedColumns.join(', '));
      if (spec.deferColumns) deferred.push({ spec: spec, rows: rows });
      report[spec.name] = { source: rows.length + orphans.length, written: res.written, orphans: orphans.length };
      log(spec.name + ': ' + res.written);
    }
    // payments.order_id ссылается на orders, а orders.payment_id — на payments: связь дописываем вторым проходом
    for (var d = 0; d < deferred.length; d++) {
      var dspec = deferred[d].spec;
      for (var r = 0; r < deferred[d].rows.length; r++) {
        var drow = deferred[d].rows[r];
        for (var c = 0; c < dspec.deferColumns.length; c++) {
          var col = dspec.deferColumns[c];
          if (drow[col] == null) continue;
          await client.query('update ' + dspec.name + ' set ' + col + ' = $1 where ' + dspec.key[0] + ' = $2', [drow[col], drow[dspec.key[0]]]);
        }
      }
    }

    // ---- картинки ----
    var files = { copied: 0, exists: 0, missing: 0 };
    var refs = [];
    (await client.query('select image_path from saved_looks where image_path is not null')).rows
      .forEach(function (row) { refs.push(['looks', row.image_path]); });
    (await client.query('select avatar_path from wallets where avatar_path is not null')).rows
      .forEach(function (row) { refs.push(['avatars', row.avatar_path]); });
    (await client.query("select image_path from site_looks where image_path not like 'assets/%'")).rows
      .forEach(function (row) { refs.push(['site-looks', row.image_path]); });
    for (var f = 0; f < refs.length; f++) {
      files[await copyFile(supabase, client, refs[f][0], refs[f][1], log)]++;
    }
    report.files = files;
    log('files: скопировано ' + files.copied + ', уже было ' + files.exists + ', не найдено ' + files.missing);

    // ---- сверка ----
    var counts = {};
    var tablesToCount = ['users'].concat(TABLES.map(function (x) { return x.name; }));
    for (var k = 0; k < tablesToCount.length; k++) {
      counts[tablesToCount[k]] = (await client.query('select count(*)::int as n from ' + tablesToCount[k])).rows[0].n;
    }
    report.targetCounts = counts;
    return report;
  } finally {
    client.release();
  }
}

module.exports = { migrate: migrate };

if (require.main === module) {
  (async function () {
    var missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL'].filter(function (n) { return !process.env[n]; });
    if (missing.length) {
      console.error('Не заданы: ' + missing.join(', ') + ' (файл .env.migrate)');
      process.exit(1);
    }
    var { createClient } = require('@supabase/supabase-js');
    var supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    var { Pool } = require('pg');
    var pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'off' ? false : {
        ca: (process.env.DATABASE_CA || '').replace(/\\n/g, '\n'),
        rejectUnauthorized: true,
        checkServerIdentity: function () { return undefined; }
      },
      max: 1
    });
    try {
      var report = await migrate({ supabase: supabase, pool: pool });
      console.log('\nСверка (источник → новая база):');
      Object.keys(report.targetCounts).forEach(function (name) {
        var src = report[name] ? report[name].source - (report[name].orphans || 0) : '?';
        var dst = report.targetCounts[name];
        console.log('  ' + name + ': ' + src + ' → ' + dst + (src === dst ? '' : '   ← РАЗНИЦА'));
      });
    } catch (err) {
      console.error('Перенос прерван:', err.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
