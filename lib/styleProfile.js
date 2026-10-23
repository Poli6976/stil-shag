/* ============================================================================
   Профиль стиля клиентки — ТЗ v5, разделы 7 и 10 (2026-10-18).
     - подсказки для полей «Рост и размер» и «Вещь» (до 5 последних значений,
       без повторов) — видны на любом устройстве после входа;
     - прошлые ответы анкеты о внешности и стиле (hair/metal/sun/style) —
       подставляются в повторную анкету;
     - оценки образов «Нравится / Не моё» с причинами.
   Всё пишет и читает только серверный код (браузер к базе не подключается) —
   тот же принцип, что у saved_looks.
   Профиль (ответы и подсказки) хранится только при включённом согласии
   remember; выключение согласия стирает сохранённое. Оценка привязана к
   конкретному образу и удаляется вместе с ним (on delete cascade).
   ============================================================================ */

const db = require('./db');

const MAX_HISTORY = 5;
const MAX_VALUE_LENGTH = 120;
const MAX_COMMENT_LENGTH = 300;

/* Только известные ключи и значения — те же, что в js/wizard.js (COLOR_QUESTIONS, шаг style). */
const ANSWER_VALUES = {
  hair: ['blond', 'light_brown', 'brown', 'dark', 'red', 'grey'],
  metal: ['gold', 'silver', 'both', 'unknown'],
  sun: ['tan', 'burn', 'unknown'],
  style: ['classic', 'casual', 'bold']
};

const RATING_REASONS = ['Цвет', 'Фасон', 'Не мой стиль', 'Не под повод', 'Слишком смело', 'Слишком скучно', 'Другое'];

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanAnswers(answers) {
  var out = {};
  if (!answers || typeof answers !== 'object') return out;
  Object.keys(ANSWER_VALUES).forEach(function (key) {
    if (ANSWER_VALUES[key].indexOf(answers[key]) !== -1) out[key] = answers[key];
  });
  return out;
}

/* Новое значение — первым, без повторов (без учёта регистра), не больше MAX_HISTORY. */
function pushHistory(list, value) {
  var v = cleanText(value, MAX_VALUE_LENGTH);
  var current = Array.isArray(list) ? list : [];
  if (!v) return current;
  var lower = v.toLowerCase();
  return [v].concat(current.filter(function (x) { return String(x).toLowerCase() !== lower; })).slice(0, MAX_HISTORY);
}

function emptyProfile() {
  return { remember: false, answers: {}, fitHistory: [], itemHistory: [] };
}

async function readRow(userId) {
  return db.one('select remember, answers, fit_history, item_history from style_profiles where user_id = $1', [userId]);
}

function toProfile(row) {
  if (!row) return emptyProfile();
  return {
    remember: !!row.remember,
    answers: row.answers || {},
    fitHistory: row.fit_history || [],
    itemHistory: row.item_history || []
  };
}

async function writeRow(userId, profile) {
  await db.query(
    'insert into style_profiles (user_id, remember, answers, fit_history, item_history, updated_at) ' +
    'values ($1, $2, $3::jsonb, $4::text[], $5::text[], now()) on conflict (user_id) do update set ' +
    'remember = excluded.remember, answers = excluded.answers, fit_history = excluded.fit_history, ' +
    'item_history = excluded.item_history, updated_at = now()',
    [userId, !!profile.remember, JSON.stringify(profile.answers || {}), profile.fitHistory, profile.itemHistory]
  );
}

async function getProfile(userId) {
  var profile = toProfile(await readRow(userId));

  var ratings = await db.query('select rating, reasons from look_ratings where user_id = $1', [userId]);

  var summary = { likes: 0, dislikes: 0, reasons: {} };
  ratings.rows.forEach(function (r) {
    if (r.rating === 'like') summary.likes++;
    if (r.rating === 'dislike') {
      summary.dislikes++;
      (r.reasons || []).forEach(function (reason) { summary.reasons[reason] = (summary.reasons[reason] || 0) + 1; });
    }
  });

  return { profile: profile, ratings: summary };
}

/* Включить/выключить запоминание. Выключение стирает ответы и подсказки. */
async function setRemember(userId, value) {
  var profile = value ? toProfile(await readRow(userId)) : emptyProfile();
  profile.remember = !!value;
  await writeRow(userId, profile);
  return profile;
}

/* Вызывается анкетой после того, как образ собран. Без согласия — ничего не пишет.
   fit сохраняется только если клиентка дала согласие на данные о фигуре и это не подростковый режим
   (проверка и на клиенте, и здесь). */
async function rememberAnswers(userId, params) {
  var profile = toProfile(await readRow(userId));
  if (!profile.remember) return profile;

  if (params.fit && params.fitConsent === true && params.isTeen !== true) {
    profile.fitHistory = pushHistory(profile.fitHistory, params.fit);
  }
  if (params.item) profile.itemHistory = pushHistory(profile.itemHistory, params.item);
  var answers = cleanAnswers(params.answers);
  Object.keys(answers).forEach(function (key) { profile.answers[key] = answers[key]; });

  await writeRow(userId, profile);
  return profile;
}

async function forgetSuggestion(userId, kind, value) {
  var profile = toProfile(await readRow(userId));
  var v = cleanText(value, MAX_VALUE_LENGTH).toLowerCase();
  if (kind === 'fit') profile.fitHistory = profile.fitHistory.filter(function (x) { return String(x).toLowerCase() !== v; });
  if (kind === 'item') profile.itemHistory = profile.itemHistory.filter(function (x) { return String(x).toLowerCase() !== v; });
  await writeRow(userId, profile);
  return profile;
}

async function clearSuggestions(userId) {
  var profile = toProfile(await readRow(userId));
  profile.fitHistory = [];
  profile.itemHistory = [];
  await writeRow(userId, profile);
  return profile;
}

async function forgetAnswer(userId, key) {
  var profile = toProfile(await readRow(userId));
  if (Object.prototype.hasOwnProperty.call(ANSWER_VALUES, key)) delete profile.answers[key];
  await writeRow(userId, profile);
  return profile;
}

/* «Сбросить всё»: ответы, подсказки и все оценки. Согласие остаётся как было. */
async function resetProfile(userId) {
  var row = await readRow(userId);
  var profile = emptyProfile();
  profile.remember = !!(row && row.remember);
  await writeRow(userId, profile);
  await db.query('delete from look_ratings where user_id = $1', [userId]);
  return profile;
}

/* Оценка образа. true — сохранено; false — образа с таким id у этого пользователя нет. */
async function rateLook(userId, lookId, rating, reasons, comment) {
  var own = await db.one('select id from saved_looks where id = $1 and user_id = $2', [lookId, userId]);
  if (!own) return false;

  if (rating === null) {
    await db.query('delete from look_ratings where look_id = $1 and user_id = $2', [lookId, userId]);
    return true;
  }

  var cleanReasons = rating === 'dislike' && Array.isArray(reasons)
    ? reasons.filter(function (r, i, arr) { return RATING_REASONS.indexOf(r) !== -1 && arr.indexOf(r) === i; })
    : [];
  await db.query(
    'insert into look_ratings (look_id, user_id, rating, reasons, comment, created_at) values ($1, $2, $3, $4::text[], $5, now()) ' +
    'on conflict (look_id) do update set rating = excluded.rating, reasons = excluded.reasons, ' +
    'comment = excluded.comment, created_at = now()',
    [lookId, userId, rating, cleanReasons, rating === 'dislike' ? (cleanText(comment, MAX_COMMENT_LENGTH) || null) : null]
  );
  return true;
}

/* Оценки для списка образов в кабинете: { lookId: { rating, reasons } }. */
async function ratingsForLooks(userId, lookIds) {
  if (!lookIds.length) return {};
  var result = await db.query(
    'select look_id, rating, reasons from look_ratings where user_id = $1 and look_id = any($2::uuid[])',
    [userId, lookIds]
  );
  var map = {};
  result.rows.forEach(function (r) { map[r.look_id] = { rating: r.rating, reasons: r.reasons || [] }; });
  return map;
}

module.exports = {
  RATING_REASONS: RATING_REASONS,
  getProfile: getProfile,
  setRemember: setRemember,
  rememberAnswers: rememberAnswers,
  forgetSuggestion: forgetSuggestion,
  clearSuggestions: clearSuggestions,
  forgetAnswer: forgetAnswer,
  resetProfile: resetProfile,
  rateLook: rateLook,
  ratingsForLooks: ratingsForLooks
};
