/* ============================================================================
   Клиент YandexART (Yandex Cloud) — генерация ОДНОЙ иллюстративной картинки
   на весь образ по текстовому описанию слоёв. Пришли сюда вместо Kandinsky/
   FusionBrain (lib/kandinsky.js, оставлен в проекте неиспользуемым) — сайт
   fusionbrain.ai был недоступен на момент подключения (503/502 у самого
   сервиса), YandexART работает так же (генерация картинки по тексту) и тоже
   оплачивается российской картой через Yandex Cloud.

   Генерация асинхронная: сначала POST запускает операцию, потом нужно
   опрашивать её статус, пока не появится готовая картинка.

   Нужны три значения в переменных окружения (Vercel → Settings → Environment Variables):
     YANDEX_API_KEY     — API-ключ сервисного аккаунта (роль yc.ai.imageGeneration.execute)
     YANDEX_FOLDER_ID    — ID каталога в Yandex Cloud (видно в адресной строке консоли)
   ============================================================================ */

const https = require('https');

const API_HOST = 'llm.api.cloud.yandex.net';
const OPERATION_HOST = 'operation.api.cloud.yandex.net';

function httpsJson(hostname, method, requestPath, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path: requestPath, method, headers, timeout: 20000 },
      (res) => {
        var chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          var raw = Buffer.concat(chunks).toString('utf8');
          var parsed;
          try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = { raw: raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function runGeneration(prompt, opts) {
  opts = opts || {};
  var folderId = process.env.YANDEX_FOLDER_ID;
  var payload = JSON.stringify({
    modelUri: 'art://' + folderId + '/yandex-art/latest',
    messages: [{ text: prompt.slice(0, 900), weight: 1 }],
    generationOptions: {
      mimeType: 'image/jpeg',
      aspectRatio: { widthRatio: opts.widthRatio || 1, heightRatio: opts.heightRatio || 1 }
    }
  });
  var headers = {
    'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY,
    'x-folder-id': folderId,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  return httpsJson(API_HOST, 'POST', '/foundationModels/v1/imageGenerationAsync', headers, payload)
    .then(function (res) {
      if (res.status !== 200 || !res.body.id) {
        throw new Error('YandexART: запуск генерации не удался: ' + res.status + ' ' + JSON.stringify(res.body));
      }
      return res.body.id;
    });
}

function checkOperation(operationId) {
  return httpsJson(OPERATION_HOST, 'GET', '/operations/' + operationId, {
    'Authorization': 'Api-Key ' + process.env.YANDEX_API_KEY
  }).then(function (res) {
    if (res.status !== 200) {
      throw new Error('YandexART: проверка операции не удалась: ' + res.status + ' ' + JSON.stringify(res.body));
    }
    return res.body;
  });
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

/* Опрашивает операцию, пока не done — обычно занимает несколько секунд.
   Как и с Kandinsky раньше: на Vercel Hobby-плане (лимит функции 10с) может
   не успеть — нужен Pro-план (60с) либо вынос в фон/очередь. */
async function waitForResult(operationId, maxAttempts) {
  maxAttempts = maxAttempts || 15;
  for (var i = 0; i < maxAttempts; i++) {
    await sleep(2000);
    var op = await checkOperation(operationId);
    if (op.done) {
      if (op.error) throw new Error('YandexART: ошибка генерации: ' + JSON.stringify(op.error));
      var image = op.response && op.response.image;
      if (!image) throw new Error('YandexART: операция завершена без картинки');
      return image; // base64 jpeg, без префикса data:
    }
  }
  throw new Error('YandexART: не дождались результата генерации');
}

/* Возвращает base64 JPEG (без data:-префикса) готовой картинки образа. */
async function generateLookImage(prompt, opts) {
  opts = opts || {};
  var operationId = await runGeneration(prompt, opts);
  return waitForResult(operationId, opts.maxAttempts);
}

module.exports = { generateLookImage };
