/* ============================================================================
   Общий клиент GigaChat (Sber) — OAuth-токен, загрузка файла, chat completion
   с картинкой во вложении. Используется в api/analyze-item.js и
   api/compose-look.js, чтобы не дублировать сертификат/агент/протокол в
   каждом эндпоинте отдельно.

   Про сертификат НУЦ Минцифры (certs/russian_trusted_root_ca.pem) и лимит
   тела запроса — см. комментарий в api/analyze-item.js, они относятся к
   любому обращению к gigachat.devices.sberbank.ru, не только к разбору вещи.
   ============================================================================ */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CA_CERT = fs.readFileSync(path.join(process.cwd(), 'certs', 'russian_trusted_root_ca.pem'));
const AGENT = new https.Agent({ ca: CA_CERT });

const OAUTH_HOST = 'ngw.devices.sberbank.ru';
const OAUTH_PORT = 9443;
const API_HOST = 'gigachat.devices.sberbank.ru';

function httpsJson(hostname, port, requestPath, method, headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port, path: requestPath, method, headers, agent: AGENT, timeout: 20000 },
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

async function getAccessToken() {
  var scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  var body = 'scope=' + encodeURIComponent(scope);
  var res = await httpsJson(OAUTH_HOST, OAUTH_PORT, '/api/v2/oauth', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'RqUID': crypto.randomUUID(),
    'Authorization': 'Basic ' + process.env.GIGACHAT_AUTH_KEY,
    'Content-Length': Buffer.byteLength(body)
  }, body);
  if (res.status !== 200 || !res.body.access_token) {
    throw new Error('GigaChat oauth failed: ' + res.status + ' ' + JSON.stringify(res.body));
  }
  return res.body.access_token;
}

function uploadFile(token, imageBuffer, mime) {
  var boundary = '----stil' + crypto.randomBytes(12).toString('hex');
  var filename = 'item.' + (mime.indexOf('png') !== -1 ? 'png' : 'jpg');
  var head =
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    'Content-Type: ' + mime + '\r\n\r\n';
  var purposeField =
    '\r\n--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="purpose"\r\n\r\n' +
    'general\r\n';
  var tail = '--' + boundary + '--\r\n';
  var bodyBuffer = Buffer.concat([
    Buffer.from(head, 'utf8'),
    imageBuffer,
    Buffer.from(purposeField, 'utf8'),
    Buffer.from(tail, 'utf8')
  ]);

  return httpsJson(API_HOST, 443, '/api/v1/files', 'POST', {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': bodyBuffer.length
  }, bodyBuffer).then(function (res) {
    if (res.status !== 200 || !res.body.id) {
      throw new Error('GigaChat file upload failed: ' + res.status + ' ' + JSON.stringify(res.body));
    }
    return res.body.id;
  });
}

/* fileId необязателен — без него это обычный текстовый чат без вложения. */
function chatWithImage(token, systemPrompt, userText, fileId, opts) {
  opts = opts || {};
  var payload = JSON.stringify({
    model: opts.model || process.env.GIGACHAT_MODEL || 'GigaChat-2-Max',
    temperature: opts.temperature != null ? opts.temperature : 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText, attachments: fileId ? [fileId] : undefined }
    ]
  });
  return httpsJson(API_HOST, 443, '/api/v1/chat/completions', 'POST', {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }, payload).then(function (res) {
    var text = res.body && res.body.choices && res.body.choices[0] && res.body.choices[0].message
      ? res.body.choices[0].message.content
      : null;
    if (res.status !== 200 || !text) {
      throw new Error('GigaChat completion failed: ' + res.status + ' ' + JSON.stringify(res.body));
    }
    return text.trim();
  });
}

module.exports = { getAccessToken, uploadFile, chatWithImage };
