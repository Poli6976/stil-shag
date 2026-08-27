/* ============================================================================
   Сохранённые образы клиентки ("Мои образы" в личном кабинете) — хранение,
   список и удаление результата api/compose-look.js. Пишет и удаляет только
   service-role ключом (RLS в db/schema.sql не даёт клиенту делать это
   напрямую) — тот же принцип, что у кошелька: сервер сам решает, что
   разрешено, не веря телу запроса.
   ============================================================================ */

const { getSupabaseAdmin } = require('./supabaseAdmin');

const BUCKET = 'looks';
const SIGNED_URL_TTL_SECONDS = 300;

/* imageBuffer — готовый JPEG (тот же base64, что уходит в ответ клиенту).
   Путь объекта включает userId первым сегментом — совпадает со storage-
   политиками owner-only read/delete в db/schema.sql. */
async function saveLook(userId, params) {
  var supabase = getSupabaseAdmin();

  var insertResult = await supabase
    .from('saved_looks')
    .insert({ user_id: userId, layers: params.layers || {}, why: params.why || null, fit: params.fit || null })
    .select('id')
    .single();
  if (insertResult.error) throw insertResult.error;

  var lookId = insertResult.data.id;

  if (!params.imageBuffer) return { id: lookId, imagePath: null };

  var path = userId + '/' + lookId + '.jpg';
  var uploadResult = await supabase.storage.from(BUCKET).upload(path, params.imageBuffer, {
    contentType: 'image/jpeg',
    upsert: false
  });
  if (uploadResult.error) {
    /* Текст уже сохранён, картинка — нет. Не откатываем текстовую запись:
       лучше показать в кабинете образ без картинки, чем потерять весь
       результат из-за сбоя загрузки файла. */
    console.error('saveLook: не удалось загрузить картинку:', uploadResult.error);
    return { id: lookId, imagePath: null };
  }

  var updateResult = await supabase.from('saved_looks').update({ image_path: path }).eq('id', lookId);
  if (updateResult.error) console.error('saveLook: не удалось записать путь картинки:', updateResult.error);

  return { id: lookId, imagePath: path };
}

async function listLooks(userId) {
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('saved_looks')
    .select('id, layers, why, fit, image_path, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (result.error) throw result.error;

  return Promise.all(result.data.map(async function (row) {
    var imageUrl = null;
    if (row.image_path) {
      var signed = await supabase.storage.from(BUCKET).createSignedUrl(row.image_path, SIGNED_URL_TTL_SECONDS);
      if (!signed.error) imageUrl = signed.data.signedUrl;
    }
    return {
      id: row.id,
      layers: row.layers,
      why: row.why,
      fit: row.fit,
      createdAt: row.created_at,
      imageUrl: imageUrl
    };
  }));
}

/* true — образ найден у ЭТОГО пользователя и удалён (файл + запись).
   false — такого id у него нет (чужой или несуществующий) — тогда ничего не
   трогаем и не уточняем, чужой это id или опечатка, чтобы не давать способ
   угадывать чужие id перебором ответов. */
async function deleteLook(userId, lookId) {
  var supabase = getSupabaseAdmin();

  var selectResult = await supabase
    .from('saved_looks')
    .select('id, image_path')
    .eq('id', lookId)
    .eq('user_id', userId)
    .maybeSingle();
  if (selectResult.error) throw selectResult.error;
  if (!selectResult.data) return false;

  if (selectResult.data.image_path) {
    var removeResult = await supabase.storage.from(BUCKET).remove([selectResult.data.image_path]);
    if (removeResult.error) console.error('deleteLook: не удалось удалить файл картинки:', removeResult.error);
  }

  var deleteResult = await supabase.from('saved_looks').delete().eq('id', lookId).eq('user_id', userId);
  if (deleteResult.error) throw deleteResult.error;

  return true;
}

module.exports = { saveLook: saveLook, listLooks: listLooks, deleteLook: deleteLook };
