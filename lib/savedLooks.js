/* ============================================================================
   Сохранённые образы клиентки ("Мои образы" в личном кабинете) — хранение,
   список и удаление результата api/looks/charge.js. Пишет и удаляет только
   серверный код — браузер к базе не подключается; сервер сам решает, что
   разрешено, не веря телу запроса. Картинки — в таблице files (lib/storage.js).
   ============================================================================ */

const db = require('./db');
const storage = require('./storage');

const BUCKET = 'looks';
const SIGNED_URL_TTL_SECONDS = 300;

/* imageBuffer — готовый JPEG (тот же base64, что уходит в ответ клиенту).
   Путь объекта включает userId первым сегментом — как было в Supabase Storage. */
async function saveLook(userId, params) {
  var row = await db.one(
    'insert into saved_looks (user_id, layers, why, fit) values ($1, $2::jsonb, $3, $4) returning id',
    [userId, JSON.stringify(params.layers || {}), params.why || null, params.fit || null]
  );
  var lookId = row.id;

  if (!params.imageBuffer) return { id: lookId, imagePath: null };

  var path = userId + '/' + lookId + '.jpg';
  try {
    await storage.upload(BUCKET, path, params.imageBuffer, 'image/jpeg');
  } catch (err) {
    /* Текст уже сохранён, картинка — нет. Не откатываем текстовую запись:
       лучше показать в кабинете образ без картинки, чем потерять весь
       результат из-за сбоя загрузки файла. */
    console.error('saveLook: не удалось сохранить картинку:', err && err.message);
    return { id: lookId, imagePath: null };
  }

  try {
    await db.query('update saved_looks set image_path = $1 where id = $2', [path, lookId]);
  } catch (err) {
    console.error('saveLook: не удалось записать путь картинки:', err && err.message);
  }

  return { id: lookId, imagePath: path };
}

async function listLooks(userId) {
  var result = await db.query(
    'select id, layers, why, fit, image_path, created_at from saved_looks where user_id = $1 order by created_at desc',
    [userId]
  );
  return result.rows.map(function (row) {
    return {
      id: row.id,
      layers: row.layers,
      why: row.why,
      fit: row.fit,
      createdAt: row.created_at,
      imageUrl: row.image_path ? storage.signedUrl(BUCKET, row.image_path, SIGNED_URL_TTL_SECONDS) : null
    };
  });
}

/* true — образ найден у ЭТОГО пользователя и удалён (файл + запись).
   false — такого id у него нет (чужой или несуществующий) — тогда ничего не
   трогаем и не уточняем, чужой это id или опечатка, чтобы не давать способ
   угадывать чужие id перебором ответов. */
async function deleteLook(userId, lookId) {
  var deleted = await deleteLooks(userId, [lookId]);
  return deleted.length > 0;
}

/* 2026-10-17 (ТЗ v5, раздел 8) — удаление группой. Берём только те id, что принадлежат ЭТОМУ
   пользователю (фильтр user_id на сервере), чужие/несуществующие молча пропускаем — как и deleteLook,
   не подсказываем, какие из них чужие. Возвращает массив реально удалённых id. */
async function deleteLooks(userId, lookIds) {
  var result = await db.query(
    'delete from saved_looks where user_id = $1 and id = any($2::uuid[]) returning id, image_path',
    [userId, lookIds]
  );
  var paths = result.rows.map(function (r) { return r.image_path; }).filter(Boolean);
  if (paths.length) {
    try {
      await storage.remove(BUCKET, paths);
    } catch (err) {
      console.error('deleteLooks: не удалось удалить файлы картинок:', err && err.message);
    }
  }
  return result.rows.map(function (r) { return r.id; });
}

module.exports = { saveLook: saveLook, listLooks: listLooks, deleteLook: deleteLook, deleteLooks: deleteLooks };
