/* ============================================================================
   Профиль стиля клиентки — ТЗ v5, разделы 7 и 10 (2026-10-18).
     - подсказки для полей «Рост и размер» и «Вещь» (до 5 последних значений,
       без повторов) — видны на любом устройстве после входа;
     - прошлые ответы анкеты о внешности и стиле (hair/metal/sun/style) —
       подставляются в повторную анкету;
     - оценки образов «Нравится / Не моё» с причинами.
   Всё пишет и читает только service-role ключом (RLS в db/schema.sql не даёт
   клиенту делать это напрямую) — тот же принцип, что у saved_looks.
   Профиль (ответы и подсказки) хранится только при включённом согласии
   remember; выключение согласия стирает сохранённое. Оценка привязана к
   конкретному образу и удаляется вместе с ним (on delete cascade).
   ============================================================================ */

const { getSupabaseAdmin } = require('./supabaseAdmin');

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

async function readRow(supabase, userId) {
  var result = await supabase
    .from('style_profiles')
    .select('remember, answers, fit_history, item_history')
    .eq('user_id', userId)
    .maybeSingle();
  if (result.error) throw result.error;
  return result.data;
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

async function writeRow(supabase, userId, profile) {
  var result = await supabase.from('style_profiles').upsert({
    user_id: userId,
    remember: profile.remember,
    answers: profile.answers,
    fit_history: profile.fitHistory,
    item_history: profile.itemHistory,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (result.error) throw result.error;
}

async function getProfile(userId) {
  var supabase = getSupabaseAdmin();
  var profile = toProfile(await readRow(supabase, userId));

  var ratings = await supabase
    .from('look_ratings')
    .select('rating, reasons')
    .eq('user_id', userId);
  if (ratings.error) throw ratings.error;

  var summary = { likes: 0, dislikes: 0, reasons: {} };
  (ratings.data || []).forEach(function (r) {
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
  var supabase = getSupabaseAdmin();
  var profile = value ? toProfile(await readRow(supabase, userId)) : emptyProfile();
  profile.remember = !!value;
  await writeRow(supabase, userId, profile);
  return profile;
}

/* Вызывается анкетой после того, как образ собран. Без согласия — ничего не пишет.
   fit сохраняется только если клиентка дала согласие на данные о фигуре и это не подростковый режим
   (проверка и на клиенте, и здесь). */
async function rememberAnswers(userId, params) {
  var supabase = getSupabaseAdmin();
  var profile = toProfile(await readRow(supabase, userId));
  if (!profile.remember) return profile;

  if (params.fit && params.fitConsent === true && params.isTeen !== true) {
    profile.fitHistory = pushHistory(profile.fitHistory, params.fit);
  }
  if (params.item) profile.itemHistory = pushHistory(profile.itemHistory, params.item);
  var answers = cleanAnswers(params.answers);
  Object.keys(answers).forEach(function (key) { profile.answers[key] = answers[key]; });

  await writeRow(supabase, userId, profile);
  return profile;
}

async function forgetSuggestion(userId, kind, value) {
  var supabase = getSupabaseAdmin();
  var profile = toProfile(await readRow(supabase, userId));
  var v = cleanText(value, MAX_VALUE_LENGTH).toLowerCase();
  if (kind === 'fit') profile.fitHistory = profile.fitHistory.filter(function (x) { return String(x).toLowerCase() !== v; });
  if (kind === 'item') profile.itemHistory = profile.itemHistory.filter(function (x) { return String(x).toLowerCase() !== v; });
  await writeRow(supabase, userId, profile);
  return profile;
}

async function clearSuggestions(userId) {
  var supabase = getSupabaseAdmin();
  var profile = toProfile(await readRow(supabase, userId));
  profile.fitHistory = [];
  profile.itemHistory = [];
  await writeRow(supabase, userId, profile);
  return profile;
}

async function forgetAnswer(userId, key) {
  var supabase = getSupabaseAdmin();
  var profile = toProfile(await readRow(supabase, userId));
  if (Object.prototype.hasOwnProperty.call(ANSWER_VALUES, key)) delete profile.answers[key];
  await writeRow(supabase, userId, profile);
  return profile;
}

/* «Сбросить всё»: ответы, подсказки и все оценки. Согласие остаётся как было. */
async function resetProfile(userId) {
  var supabase = getSupabaseAdmin();
  var row = await readRow(supabase, userId);
  var profile = emptyProfile();
  profile.remember = !!(row && row.remember);
  await writeRow(supabase, userId, profile);
  var del = await supabase.from('look_ratings').delete().eq('user_id', userId);
  if (del.error) throw del.error;
  return profile;
}

/* Оценка образа. true — сохранено; false — образа с таким id у этого пользователя нет. */
async function rateLook(userId, lookId, rating, reasons, comment) {
  var supabase = getSupabaseAdmin();
  var own = await supabase.from('saved_looks').select('id').eq('id', lookId).eq('user_id', userId).maybeSingle();
  if (own.error) throw own.error;
  if (!own.data) return false;

  if (rating === null) {
    var del = await supabase.from('look_ratings').delete().eq('look_id', lookId).eq('user_id', userId);
    if (del.error) throw del.error;
    return true;
  }

  var cleanReasons = rating === 'dislike' && Array.isArray(reasons)
    ? reasons.filter(function (r, i, arr) { return RATING_REASONS.indexOf(r) !== -1 && arr.indexOf(r) === i; })
    : [];
  var result = await supabase.from('look_ratings').upsert({
    look_id: lookId,
    user_id: userId,
    rating: rating,
    reasons: cleanReasons,
    comment: rating === 'dislike' ? (cleanText(comment, MAX_COMMENT_LENGTH) || null) : null,
    created_at: new Date().toISOString()
  }, { onConflict: 'look_id' });
  if (result.error) throw result.error;
  return true;
}

/* Оценки для списка образов в кабинете: { lookId: { rating, reasons } }. */
async function ratingsForLooks(userId, lookIds) {
  if (!lookIds.length) return {};
  var supabase = getSupabaseAdmin();
  var result = await supabase
    .from('look_ratings')
    .select('look_id, rating, reasons')
    .eq('user_id', userId)
    .in('look_id', lookIds);
  if (result.error) throw result.error;
  var map = {};
  (result.data || []).forEach(function (r) { map[r.look_id] = { rating: r.rating, reasons: r.reasons || [] }; });
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
