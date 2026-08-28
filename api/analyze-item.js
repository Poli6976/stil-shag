/* ============================================================================
   POST /api/analyze-item — разбор фото вещи через GigaChat (Sber)

   Почему GigaChat, а не Claude/GPT: Anthropic и OpenAI официально не обслуживают
   Россию (аккаунт можно потерять даже через VPN), а GigaChat — российский сервис,
   доступен по ключу самозанятого/ИП напрямую, без обходных схем.

   Нужно два секрета в переменных окружения (Vercel → Settings → Environment Variables):
     GIGACHAT_AUTH_KEY  — Authorization key из личного кабинета GigaChat API
                          (developers.sber.ru → проект GigaChat API → Авторизационные данные)
     GIGACHAT_SCOPE     — GIGACHAT_API_PERS (для физлица/самозанятого) или
                          GIGACHAT_API_B2B (для юрлица) — уточнить при подключении тарифа,
                          по умолчанию ниже стоит GIGACHAT_API_PERS

   Важные грабли, из-за которых это НЕ заработает "из коробки" без доп. действий:
   1. GigaChat использует сертификат НУЦ Минцифры — обычный Node.js ему не доверяет
      без явной передачи корневого сертификата. Он уже лежит в проекте:
      certs/russian_trusted_root_ca.pem (скачан с gu-st.ru — официальное зеркало
      сертификата Минцифры, тот же файл, что и на портале Госуслуг). Подключается
      через https.Agent внутри lib/gigachat.js — переносить/удалять файл нельзя.
   2. Тело запроса ограничено ~4.5 МБ (лимит Vercel serverless) — на фронтенде
      фото пережимается перед отправкой (см. js/wizard.js), но лишняя проверка
      есть и здесь.

   OAuth-токен, загрузка файла и сам чат-запрос вынесены в lib/gigachat.js —
   тот же клиент использует api/compose-look.js (сборка полного образа).
   ============================================================================ */

const { checkRateLimit } = require('../lib/rateLimit');
const { requireUser } = require('../lib/auth');
const { getAccessToken, uploadFile, chatWithImage } = require('../lib/gigachat');

const SYSTEM_PROMPT =
  'Ты — ассистент стилиста. Тебе показывают фото одной вещи одежды или аксессуара. ' +
  'Опиши её кратко и по делу в 2-4 предложениях: тип вещи, цвет, крой/силуэт, ткань или ' +
  'фактура (если видно), заметные детали (принт, декор, длина). Пиши как для карточки ' +
  'товара — начни СРАЗУ с названия вещи (например «Рубашка в клетку, зелёно-белая...»), ' +
  'БЕЗ вводных фраз вроде «На фото изображена», «На фотографии видно» и подобных — они не ' +
  'несут информации и лишь съедают место. Конкретно, без "прекрасная" и прочих оценочных ' +
  'слов. Если на фото не вещь одежды/аксессуар, а что-то другое — так и напиши одним ' +
  'предложением. Про мелкие детали (принт, вышивка, значок) пиши только то, в чём ' +
  'действительно уверена/уверен по картинке — не угадывай конкретный сюжет или персонажа ' +
  '(например, если не можешь разобрать, что именно изображено, пиши обобщённо: "силуэт ' +
  'животного", "мелкий рисунок", а не выдумывай "сова" или "монстр", если это не точно так).';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Только POST' });
    return;
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(503).json({ error: 'Вход и оплата пока не настроены на сервере.' });
    return;
  }
  if (!process.env.GIGACHAT_AUTH_KEY) {
    res.status(503).json({ error: 'Разбор фото пока не настроен на сервере (нет GIGACHAT_AUTH_KEY).' });
    return;
  }

  var user = await requireUser(req);
  if (!user) {
    res.status(401).json({ error: 'Нужно войти по email.' });
    return;
  }

  var allowed = await checkRateLimit(req, 'analyze-item', { windowSeconds: 600, maxHits: 5 });
  if (!allowed) {
    res.status(429).json({ error: 'Слишком много запросов подряд. Попробуйте через несколько минут.' });
    return;
  }

  try {
    var body = req.body || {};
    var dataUrl = body.image;
    if (!dataUrl || typeof dataUrl !== 'string') {
      res.status(400).json({ error: 'Нет фото в запросе.' });
      return;
    }
    var match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
      res.status(400).json({ error: 'Некорректный формат фото.' });
      return;
    }
    var mime = match[1];
    var imageBuffer = Buffer.from(match[2], 'base64');
    if (imageBuffer.length > 4.2 * 1024 * 1024) {
      res.status(413).json({ error: 'Фото слишком большое — попробуйте другое или сожмите его.' });
      return;
    }

    var token = await getAccessToken();
    var fileId = await uploadFile(token, imageBuffer, mime);
    var description = await chatWithImage(token, SYSTEM_PROMPT, 'Опиши вещь на фото.', fileId);

    res.status(200).json({ description: description });
  } catch (err) {
    console.error('analyze-item error:', err);
    res.status(502).json({ error: 'Не получилось разобрать фото. Попробуйте ещё раз или опишите вещь текстом.' });
  }
};
