/* ============================================================================
   Клиент генерации картинки образа через Flux (Black Forest Labs, api.bfl.ai)
   — альтернативный провайдер к lib/yandexart.js. Тот же контракт: на входе
   готовый текстовый промпт (тот же buildLookImagePrompt из yandexart.js), на
   выходе base64 JPEG без data:-префикса — чтобы api/compose-look.js мог
   переключаться между провайдерами, не меняя ничего вокруг вызова.

   2026-09-18 — добавлено по просьбе клиента: YandexART регулярно обрезает
   фигуру и теряет часть вещей ансамбля на картинке даже после усиления
   промпта (см. комментарии в api/compose-look.js от 2026-09-16/17) — решили
   проверить, даёт ли Flux (FLUX1.1 [pro], сильная связка с текстом промпта)
   более надёжный результат по кадрированию.

   В отличие от YandexART (синхронный запрос-ответ), Flux API асинхронный:
   POST ставит задачу в очередь и сразу отвечает id + polling_url, дальше
   нужно опрашивать polling_url, пока status не станет "Ready", и скачать
   картинку по signed URL из result.sample (эта ссылка живёт всего 10 минут
   — скачиваем сразу же, как получили).

   Нужно одно значение в переменных окружения (Vercel → Settings →
   Environment Variables):
     FLUX_API_KEY — ключ из dashboard.bfl.ai → API → Keys
   Если переменной нет — api/compose-look.js просто продолжает использовать
   YandexART, этот модуль не вызывается вообще.
   ============================================================================ */

const https = require('https');

const API_HOST = 'api.bfl.ai';
const GENERATE_PATH = '/v1/flux-1-1-pro-generate';

/* Бюджет ожидания результата — сумма всех попыток опроса. Serverless-функция
   и так уже делает несколько последовательных вызовов GigaChat/YandexART в
   рамках одного запроса (см. api/compose-look.js), поэтому не растягиваем
   опрос дольше разумного: если Flux не ответил за это время — кидаем
   ошибку, а не подвешиваем весь запрос до тайм-аута функции на Vercel. */
const POLL_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 1500;

function httpsJson(hostname, method, requestPath, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port: 443, path: requestPath, method, headers, timeout: 30000 },
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

/* Скачивает готовую картинку по signed URL (result.sample) и отдаёт её как
   base64 — тем же форматом, что и generateLookImage() из yandexart.js. */
function fetchImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('Flux: не удалось скачать готовую картинку: ' + res.statusCode));
          return;
        }
        var chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
        res.on('error', reject);
      })
      .on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Возвращает base64 JPEG (без data:-префикса) готовой картинки образа —
   тот же контракт, что и generateLookImage(prompt, opts) в yandexart.js.
   opts.width/opts.height — необязательно, по умолчанию тот же портретный
   кадр 1024×1536 (2:3), что и у YandexART — тот же расчёт: квадратный кадр
   не оставляет места нарисовать фигуру в полный рост с обувью. */
async function generateLookImageFlux(prompt, opts) {
  opts = opts || {};
  var apiKey = process.env.FLUX_API_KEY;
  if (!apiKey) {
    throw new Error('Flux: FLUX_API_KEY не задан в переменных окружения');
  }

  var payload = JSON.stringify({
    prompt: prompt,
    width: opts.width || 1024,
    height: opts.height || 1536,
    output_format: 'jpeg',
    /* 0-6, чем выше — тем мяѳче модерация; 4 подобрано, чтобы не блокировать
       обычные описания одежды/телосложения ложными срабатываниями. */
    safety_tolerance: 4
  });
  var headers = {
    'x-key': apiKey,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };

  var submitRes = await httpsJson(API_HOST, 'POST', GENERATE_PATH, headers, payload);
  var pollingUrl = submitRes.body && submitRes.body.polling_url;
  if (submitRes.status !== 200 || !pollingUrl) {
    throw new Error('Flux: не удалось поставить задачу на генерацию: ' + submitRes.status + ' ' + JSON.stringify(submitRes.body));
  }

  var deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    var pollRes = await new Promise((resolve, reject) => {
      https
        .get(pollingUrl, { headers: { 'x-key': apiKey, accept: 'application/json' }, timeout: 15000 }, (res) => {
          var chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            var raw = Buffer.concat(chunks).toString('utf8');
            var parsed;
            try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = { raw: raw }; }
            resolve({ status: res.statusCode, body: parsed });
          });
        })
        .on('error', reject)
        .on('timeout', function () { this.destroy(new Error('timeout')); });
    });

    var status = pollRes.body && pollRes.body.status;
    if (status === 'Ready') {
      var sampleUrl = pollRes.body.result && pollRes.body.result.sample;
      if (!sampleUrl) {
        throw new Error('Flux: статус Ready, но result.sample отсутствует: ' + JSON.stringify(pollRes.body));
      }
      return await fetchImageAsBase64(sampleUrl);
    }
    if (status === 'Error' || status === 'Failed') {
      throw new Error('Flux: генерация завершилась ошибкой: ' + JSON.stringify(pollRes.body));
    }
    /* Pending/Processing/Queued — опрашиваем дальше. */
  }

  throw new Error('Flux: не дождались результата генерации за ' + POLL_TIMEOUT_MS + ' мс');
}

module.exports = {
  generateLookImageFlux: generateLookImageFlux
};
