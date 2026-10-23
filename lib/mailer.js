/* ============================================================================
   Отправка писем с кодом для входа — через SMTP почтового ящика в России
   (Яндекс Почта), вместо писем Supabase с 2026-10-23.

   SMTP_HOST  — smtp.yandex.ru
   SMTP_PORT  — 465 (шифрование сразу)
   SMTP_USER  — адрес ящика, например stil-shag@yandex.ru
   SMTP_PASS  — пароль приложения из настроек Яндекс ID (не пароль от ящика)
   MAIL_FROM  — необязательно, «Стиль <stil-shag@yandex.ru>»

   В письме нет ни одной ссылки — только код: почтовые антивирусы (list.ru)
   сами «нажимают» ссылки во входящих и сжигали одноразовый вход раньше
   человека.
   ============================================================================ */

const nodemailer = require('nodemailer');

let transport = null;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (transport) return transport;
  var port = parseInt(process.env.SMTP_PORT || '465', 10);
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return transport;
}

async function sendLoginCode(email, code, ttlMinutes) {
  var from = process.env.MAIL_FROM || ('Стиль <' + process.env.SMTP_USER + '>');
  var text =
    'Здравствуйте!\n\n' +
    'Ваш код для входа на сайт «Стиль — твой шаг по жизни»: ' + code + '\n\n' +
    'Код действует ' + ttlMinutes + ' минут. Введите его на сайте, в окне входа.\n' +
    'Если вы не запрашивали код — просто удалите это письмо.\n';
  var html =
    '<p>Здравствуйте!</p>' +
    '<p>Ваш код для входа на сайт «Стиль — твой шаг по жизни»:</p>' +
    '<p style="font-size:28px;font-weight:bold;letter-spacing:4px">' + code + '</p>' +
    '<p>Код действует ' + ttlMinutes + ' минут. Введите его на сайте, в окне входа.<br>' +
    'Если вы не запрашивали код — просто удалите это письмо.</p>';
  await getTransport().sendMail({ from: from, to: email, subject: 'Код для входа — ' + code, text: text, html: html });
}

module.exports = { isConfigured, sendLoginCode };
