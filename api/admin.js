/* ============================================================================
   Единая точка для служебных действий владельца сайта — только для него,
   ни одна из веток не ссылается ниоткуда со страниц для покупателей.

   Раньше это было несколько отдельных файлов (api/generate-code.js для кодов
   «Примерки», плюс ручное подтверждение СБП, убранное 2026-08-28 вместе с
   самим ручным каналом) — на Hobby-плане Vercel лимит 12 serverless-функций
   на деплой, и он уже был выбран целиком существующими api/*.js (см.
   .env.example). Отдельные файлы пробили бы лимит, поэтому все служебные
   действия сведены в один файл с action-роутингом вместо мелких. Если в
   будущем понадобится ещё одно админ-действие — добавлять веткой сюда же,
   не новым файлом.

   Все ветки требуют ADMIN_KEY (lib/adminAuth.js) — без него ничего не
   выполняется:
     GET  query {action:'list-partners'} + заголовок X-Admin-Key
       — список партнёров со статистикой (admin-generate-code.html)
     POST body {action:'add-partner', adminKey, name, contact, notes}
       — завести нового партнёра
     POST body {action:'set-partner-status', adminKey, partnerId, status}
       — активировать/деактивировать партнёра (история кодов не удаляется)
     POST body {action:'delete-partner', adminKey, partnerId}
       — удалить партнёра насовсем (partner_codes каскадно удалится вслед за
       ним — on delete cascade в db/schema.sql; уже погашенные покупательницами
       коды в discount_credits при этом не трогаются, они хранятся отдельно)
     POST body {action:'generate-code', adminKey, partnerId, count, note}
       — выдать партнёру пачку кодов скидки программы «Примерка» (по умолчанию
       1, максимум 50 за раз)
     GET  query {action:'list-site-looks'} + заголовок X-Admin-Key
       — список примеров образов для admin-looks.html (публичный список для
       how-it-works.html отдаёт отдельно api/reviews.js, action=list-looks)
     POST body {action:'add-site-look', adminKey, image, caption}
       — добавить пример образа: image — data URL (base64 JPEG), сохраняется
       в хранилище site-looks (lib/storage.js), caption — подпись под картинкой
     POST body {action:'delete-site-look', adminKey, id}
       — удалить пример образа насовсем (файл из хранилища + запись)
     POST body {action:'gift-look', adminKey, email, count}
       — подарить образы (1–5) в запас по email: продавцу-партнёру на пробу.
       Аккаунта может ещё не быть — он заводится сразу, и когда человек
       войдёт по коду с этой почтой, образы уже ждут в кабинете.
   ============================================================================ */

const crypto = require('crypto');
const { checkAdminKey } = require('../lib/adminAuth');
const { generateCode, sanitizeRef } = require('../lib/partnerCode');
const db = require('../lib/db');
const storage = require('../lib/storage');
const { normalizeEmail } = require('../lib/auth');

const SITE_LOOKS_BUCKET = 'site-looks';

module.exports = async function handler(req, res) {
  var action = (req.query && req.query.action) || (req.body && req.body.action);

  if (req.method === 'GET' && action === 'list-partners') {
    return handleListPartners(req, res);
  }
  if (req.method === 'POST' && action === 'add-partner') {
    return handleAddPartner(req, res);
  }
  if (req.method === 'POST' && action === 'set-partner-status') {
    return handleSetPartnerStatus(req, res);
  }
  if (req.method === 'POST' && action === 'delete-partner') {
    return handleDeletePartner(req, res);
  }
  if (req.method === 'POST' && action === 'generate-code') {
    return handleGenerateCode(req, res);
  }
  if (req.method === 'GET' && action === 'list-site-looks') {
    return handleListSiteLooks(req, res);
  }
  if (req.method === 'POST' && action === 'add-site-look') {
    return handleAddSiteLook(req, res);
  }
  if (req.method === 'POST' && action === 'delete-site-look') {
    return handleDeleteSiteLook(req, res);
  }
  if (req.method === 'POST' && action === 'gift-look') {
    return handleGiftLook(req, res);
  }
  res.status(400).json({ error: 'Неизвестное действие.' });
};

function requireDbEnv(res) {
  if (!db.isConfigured()) {
    res.status(503).json({ error: 'Не настроено на сервере.' });
    return false;
  }
  return true;
}

/* Название — убираем кавычки-«ёлочки»/обычные кавычки и лишние пробелы, чтобы
   "Бутик «Анна»" и "бутик анна" считались одним и тем же партнёром.
   Контакт — если это в основном цифры (телефон), сравниваем по последним 10
   цифрам: "+7 999 123-45-67", "8 (999) 123-45-67" и "89991234567" — один и тот
   же номер в разном написании. Иначе (Telegram/email) — просто регистр+пробелы. */
function normalizePartnerText(str) {
  return String(str || '').trim().toLowerCase().replace(/[«»"']/g, '').replace(/\s+/g, ' ');
}
function normalizeContact(str) {
  var digits = String(str || '').replace(/\D/g, '');
  if (digits.length >= 10 && digits.length / String(str || '').trim().length > 0.5) {
    return digits.slice(-10);
  }
  return normalizePartnerText(str);
}

/* Сайтов-магазинов много и они похожи — при ручном приглашении партнёров легко
   случайно завести того же самого продавца второй раз. slug (единственное, что
   раньше проверялось на уникальность) для этого не годится — он генерируется
   из названия и при коллизии просто получает случайный суффикс, а не отказывает
   в добавлении. Ищем совпадение по названию ИЛИ по контакту среди уже
   существующих партнёров (независимо от активен/неактивен — неактивного тоже
   не нужно заводить повторно, проще снова его активировать). */
async function findDuplicatePartner(name, contact) {
  var result = await db.query('select id, name, contact, status from partners');
  var normName = normalizePartnerText(name);
  var normContact = contact ? normalizeContact(contact) : null;
  return result.rows.find(function (p) {
    if (normalizePartnerText(p.name) === normName) return true;
    if (normContact && p.contact && normalizeContact(p.contact) === normContact) return true;
    return false;
  }) || null;
}

async function handleListPartners(req, res) {
  if (!checkAdminKey(req.headers && req.headers['x-admin-key'])) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  try {
    var result = await db.query('select * from partner_stats order by created_at desc');
    res.status(200).json({ partners: result.rows });
  } catch (err) {
    console.error('admin list-partners error:', err);
    res.status(500).json({ error: 'Не получилось загрузить партнёров.' });
  }
}

async function handleAddPartner(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var name = String((req.body && req.body.name) || '').trim();
  if (!name) {
    res.status(400).json({ error: 'Укажите название партнёра.' });
    return;
  }
  var contact = String((req.body && req.body.contact) || '').trim() || null;
  var notes = String((req.body && req.body.notes) || '').trim() || null;
  var baseSlug = sanitizeRef(name).slice(0, 6);

  try {
    var duplicate = await findDuplicatePartner(name, contact);
    if (duplicate) {
      res.status(409).json({
        error: 'Такой партнёр уже есть: «' + duplicate.name + '»' +
          (duplicate.contact ? ' (' + duplicate.contact + ')' : '') +
          ', статус: ' + (duplicate.status === 'active' ? 'активен' : 'неактивен') +
          '. Проверьте список партнёров ниже, прежде чем добавлять повторно — сайтов много, но это тот же партнёр.'
      });
      return;
    }

    // baseSlug почти всегда свободен — цикл только на случай совпадения с
    // уже существующим партнёром (например, два партнёра с похожим названием).
    for (var attempt = 0; attempt < 5; attempt++) {
      var trySlug = attempt === 0 ? baseSlug : baseSlug + crypto.randomBytes(1).toString('hex').toUpperCase();
      try {
        var partner = await db.one(
          "insert into partners (name, slug, contact, status, notes) values ($1, $2, $3, 'active', $4) returning *",
          [name, trySlug, contact, notes]
        );
        res.status(200).json({ partner: partner });
        return;
      } catch (insertErr) {
        if (insertErr.code !== '23505') throw insertErr;
      }
    }
    res.status(500).json({ error: 'Не получилось создать уникальную метку партнёра — попробуйте другое название.' });
  } catch (err) {
    console.error('admin add-partner error:', err);
    res.status(500).json({ error: 'Не получилось добавить партнёра.' });
  }
}

async function handleSetPartnerStatus(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var partnerId = req.body && req.body.partnerId;
  var status = req.body && req.body.status;
  if (!partnerId || (status !== 'active' && status !== 'inactive')) {
    res.status(400).json({ error: 'Не хватает partnerId или status.' });
    return;
  }

  try {
    await db.query('update partners set status = $1 where id = $2', [status, partnerId]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin set-partner-status error:', err);
    res.status(500).json({ error: 'Не получилось изменить статус партнёра.' });
  }
}

async function handleDeletePartner(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var partnerId = req.body && req.body.partnerId;
  if (!partnerId) {
    res.status(400).json({ error: 'Не хватает partnerId.' });
    return;
  }

  try {
    await db.query('delete from partners where id = $1', [partnerId]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin delete-partner error:', err);
    res.status(500).json({ error: 'Не получилось удалить партнёра.' });
  }
}

async function handleGenerateCode(req, res) {
  if (!process.env.PARTNER_CODE_SECRET || !process.env.ADMIN_KEY) {
    res.status(503).json({ error: 'Генерация кодов пока не настроена на сервере.' });
    return;
  }
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var partnerId = req.body && req.body.partnerId;
  if (!partnerId) {
    res.status(400).json({ error: 'Выберите партнёра.' });
    return;
  }
  var count = parseInt((req.body && req.body.count) || 1, 10);
  if (!count || count < 1) count = 1;
  if (count > 50) count = 50;
  var note = String((req.body && req.body.note) || '').trim() || null;

  try {
    var partnerRow = await db.one('select id, slug from partners where id = $1', [partnerId]);
    if (!partnerRow) {
      res.status(404).json({ error: 'Партнёр не найден.' });
      return;
    }
    var slug = partnerRow.slug;

    var codes = [];
    var rows = [];
    for (var i = 0; i < count; i++) {
      // 3 случайных байта (6 hex-символов) поверх слага партнёра — коллизия
      // ref внутри одной пачки статистически ничтожна (< 1 на 16 млн), а без
      // уникального ref для каждого кода формула (lib/partnerCode.js) выдала
      // бы для всех кодов в пачке один и тот же код.
      var ref = (slug + crypto.randomBytes(3).toString('hex').toUpperCase()).slice(0, 12);
      var code = generateCode(process.env.PARTNER_CODE_SECRET, ref);
      codes.push(code);
      rows.push({ code: code, ref: ref });
    }

    await db.query(
      'insert into partner_codes (partner_id, code, ref, note) ' +
      'select $1, c, r, $4 from unnest($2::text[], $3::text[]) as t(c, r)',
      [partnerId, rows.map(function (r) { return r.code; }), rows.map(function (r) { return r.ref; }), note]
    );

    res.status(200).json({ codes: codes });
  } catch (err) {
    console.error('admin generate-code error:', err);
    res.status(500).json({ error: 'Не получилось выдать коды.' });
  }
}

async function handleListSiteLooks(req, res) {
  if (!checkAdminKey(req.headers && req.headers['x-admin-key'])) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  try {
    var result = await db.query(
      'select id, image_path, caption, sort_order, created_at from site_looks order by sort_order asc, created_at desc'
    );

    var looks = result.rows.map(function (row) {
      var publicUrl = /^assets\//.test(row.image_path)
        ? '/' + row.image_path
        : storage.publicUrl(SITE_LOOKS_BUCKET, row.image_path);
      return { id: row.id, caption: row.caption, sortOrder: row.sort_order, createdAt: row.created_at, imageUrl: publicUrl };
    });
    res.status(200).json({ looks: looks });
  } catch (err) {
    console.error('admin list-site-looks error:', err);
    res.status(500).json({ error: 'Не получилось загрузить образы.' });
  }
}

async function handleAddSiteLook(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var caption = String((req.body && req.body.caption) || '').trim().slice(0, 300);
  if (!caption) {
    res.status(400).json({ error: 'Добавьте подпись к образу.' });
    return;
  }
  var image = req.body && req.body.image;
  var match = typeof image === 'string' && image.match(/^data:image\/(jpeg|jpg|png);base64,(.+)$/);
  if (!match) {
    res.status(400).json({ error: 'Не получилось прочитать картинку — загрузите фото ещё раз.' });
    return;
  }
  var buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 6 * 1024 * 1024) {
    res.status(400).json({ error: 'Файл слишком большой.' });
    return;
  }

  try {
    var path = crypto.randomUUID() + '.jpg';
    await storage.upload(SITE_LOOKS_BUCKET, path, buffer, match[1] === 'png' ? 'image/png' : 'image/jpeg');
    var inserted = await db.one('insert into site_looks (image_path, caption) values ($1, $2) returning id', [path, caption]);
    res.status(200).json({ ok: true, id: inserted.id });
  } catch (err) {
    console.error('admin add-site-look error:', err);
    res.status(500).json({ error: 'Не получилось добавить образ.' });
  }
}

async function handleDeleteSiteLook(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var id = req.body && req.body.id;
  if (!id) {
    res.status(400).json({ error: 'Не хватает id.' });
    return;
  }

  try {
    var deleted = await db.one('delete from site_looks where id = $1 returning image_path', [id]);
    if (!deleted) {
      res.status(404).json({ error: 'Образ не найден.' });
      return;
    }
    if (!/^assets\//.test(deleted.image_path)) {
      try {
        await storage.remove(SITE_LOOKS_BUCKET, [deleted.image_path]);
      } catch (removeErr) {
        console.error('admin delete-site-look: не удалось удалить файл:', removeErr && removeErr.message);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('admin delete-site-look error:', err);
    res.status(500).json({ error: 'Не получилось удалить образ.' });
  }
}

/* Подарок образов в запас по email. Заказ GIFT_LOOK за 0 ₽ — для истории (видно, кому и когда дарили). */
async function handleGiftLook(req, res) {
  if (!checkAdminKey(req.body && req.body.adminKey)) {
    res.status(401).json({ error: 'Неверный админ-ключ.' });
    return;
  }
  if (!requireDbEnv(res)) return;

  var email = normalizeEmail(req.body && req.body.email);
  if (!email) {
    res.status(400).json({ error: 'Проверьте адрес почты — похоже, в нём опечатка.' });
    return;
  }
  var count = parseInt((req.body && req.body.count) || 1, 10);
  if (!count || count < 1 || count > 5) {
    res.status(400).json({ error: 'Подарить можно от 1 до 5 образов за раз.' });
    return;
  }

  try {
    var result = await db.transaction(async function (client) {
      var existing = (await client.query('select id from users where email = $1', [email])).rows[0];
      var userId = existing
        ? existing.id
        : (await client.query('insert into users (email) values ($1) returning id', [email])).rows[0].id;
      await client.query('insert into wallets (user_id) values ($1) on conflict (user_id) do nothing', [userId]);
      var wallet = (await client.query(
        'update wallets set looks_in_stock = looks_in_stock + $2, updated_at = now() where user_id = $1 returning looks_in_stock',
        [userId, count]
      )).rows[0];
      await client.query(
        "insert into orders (user_id, package_code, price_kopecks, status, done_at, answers) values ($1, 'GIFT_LOOK', 0, 'done', now(), $2::jsonb)",
        [userId, JSON.stringify({ gift: count })]
      );
      return { newUser: !existing, looksInStock: wallet.looks_in_stock };
    });
    res.status(200).json({ ok: true, email: email, newUser: result.newUser, looksInStock: result.looksInStock });
  } catch (err) {
    console.error('admin gift-look error:', err && err.message);
    res.status(500).json({ error: 'Не получилось подарить образ.' });
  }
}
