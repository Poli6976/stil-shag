/* ============ Образ по фото — вызывает POST /api/compose-look (GigaChat + YandexART) ============
   В отличие от js/wizard.js (статический демо-шаблон), здесь реальный вызов ИИ: фото уходит на
   сервер, GigaChat распознаёт вещь и расписывает образ по слоям, YandexART рисует одну картинку
   на весь образ. Генерация занимает до ~30 секунд — это нормально, не зависание. */

(function () {
  var LAYER_LABELS = ['Верх', 'Низ', 'Верхняя одежда', 'Обувь', 'Аксессуары', 'Причёска', 'Макияж'];

  var root = document.getElementById('lookBuilder');
  var authGate = document.getElementById('lbAuthGate');
  if (!root) return;

  var state = { dataUrl: null, session: null };

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* та же логика сжатия фото, что и в wizard.js — без неё даже обычное фото с телефона
     легко превышает лимит тела запроса на сервере */
  function resizeImageFile(file, maxDim) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Не удалось прочитать файл.')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('Не удалось открыть изображение.')); };
        img.onload = function () {
          var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          var w = Math.max(1, Math.round(img.width * scale));
          var h = Math.max(1, Math.round(img.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderUpload() {
    root.innerHTML = '';

    var box = el('div', 'lb-upload');
    var preview = document.createElement('img');
    preview.className = 'lb-preview';
    preview.alt = '';

    var btn = el('button', 'btn-3d btn-3d--rect', 'Загрузить фото');
    btn.type = 'button';

    var removeBtn = el('button', 'wizard-back', 'Удалить фото');
    removeBtn.type = 'button';
    removeBtn.style.display = 'none';

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.position = 'absolute';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';

    var DEFAULT_STATUS = 'На фото должны быть вы (или любой человек) — в вещи, вокруг которой хотим собрать образ; так ИИ точно поймёт, что это за вещь. Лицо можно не показывать. Результат — рисованный референс на условной модели, а не ваше фото в образе.';
    var status = el('p', 'lb-status', DEFAULT_STATUS);

    var consentWrap = el('label', 'wizard-consent');
    var consentCheckbox = document.createElement('input');
    consentCheckbox.type = 'checkbox';
    consentWrap.appendChild(consentCheckbox);
    consentWrap.appendChild(el('span', null,
      'Согласен(на) на обработку фото (включая внешность) и параметров тела сервисами распознавания ' +
      'изображений GigaChat и генерации YandexART — для сборки образа. Фото не хранится после ответа. ' +
      'Подробнее — <a href="legal-privacy.html" target="_blank" rel="noopener">Политика конфиденциальности</a>.'
    ));

    var itemHintField = el('div', 'wizard-field');
    var itemHintLabel = el('label', null, 'Уточните деталь одежды — необязательно, поможет ИИ точнее распознать вещь');
    itemHintLabel.setAttribute('for', 'lbItemHint');
    var itemHintInput = el('input', 'wizard-input');
    itemHintInput.id = 'lbItemHint';
    itemHintInput.type = 'text';
    itemHintInput.placeholder = 'Например: это куртка, а не рубашка';
    itemHintField.appendChild(itemHintLabel);
    itemHintField.appendChild(itemHintInput);

    var fitField = el('div', 'wizard-field');
    var fitLabel = el('label', null, 'Рост и размер — необязательно, но поможет с посадкой и длиной вещей');
    fitLabel.setAttribute('for', 'lbFit');
    var fitInput = el('input', 'wizard-input');
    fitInput.id = 'lbFit';
    fitInput.type = 'text';
    fitInput.placeholder = 'Например: 165 см, 44 размер';
    fitField.appendChild(fitLabel);
    fitField.appendChild(fitInput);

    var goBtn = el('a', 'btn-3d btn-3d--rect', 'Собрать образ');
    goBtn.href = '#';
    goBtn.setAttribute('disabled', '');
    goBtn.setAttribute('aria-disabled', 'true');

    function updateGoBtn() {
      if (state.dataUrl && consentCheckbox.checked) {
        goBtn.removeAttribute('disabled');
        goBtn.removeAttribute('aria-disabled');
      } else {
        goBtn.setAttribute('disabled', '');
        goBtn.setAttribute('aria-disabled', 'true');
      }
    }
    consentCheckbox.addEventListener('change', updateGoBtn);

    btn.addEventListener('click', function () { input.click(); });

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (!/^image\//.test(file.type)) {
        status.textContent = 'Это не похоже на фото — выберите картинку.';
        status.className = 'lb-status lb-status--error';
        return;
      }
      status.textContent = 'Обрабатываю фото…';
      status.className = 'lb-status';
      resizeImageFile(file, 1024).then(function (dataUrl) {
        state.dataUrl = dataUrl;
        preview.src = dataUrl;
        preview.style.display = 'block';
        removeBtn.style.display = '';
        status.textContent = 'Фото готово — можно собирать образ.';
        status.className = 'lb-status lb-status--ok';
        updateGoBtn();
      }).catch(function (err) {
        status.textContent = (err && err.message) || 'Не получилось обработать фото.';
        status.className = 'lb-status lb-status--error';
      });
    });

    removeBtn.addEventListener('click', function () {
      state.dataUrl = null;
      preview.src = '';
      preview.style.display = 'none';
      removeBtn.style.display = 'none';
      input.value = ''; // без этого повторный выбор того же файла не сработает
      status.textContent = DEFAULT_STATUS;
      status.className = 'lb-status';
      updateGoBtn();
    });

    box.appendChild(preview);
    box.appendChild(btn);
    box.appendChild(removeBtn);
    box.appendChild(input);
    box.appendChild(status);
    box.appendChild(consentWrap);
    root.appendChild(box);

    var fieldsRow = el('div', 'lb-fields-row');
    fieldsRow.appendChild(itemHintField);
    fieldsRow.appendChild(fitField);
    root.appendChild(fieldsRow);

    var actions = el('div', 'lb-actions');
    goBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (goBtn.hasAttribute('disabled') || !state.dataUrl || !consentCheckbox.checked) return;
      submitLook(status, goBtn, fitInput.value, itemHintInput.value);
    });
    actions.appendChild(goBtn);
    root.appendChild(actions);
  }

  function submitLook(status, goBtn, fit, itemHint) {
    goBtn.setAttribute('disabled', '');
    goBtn.setAttribute('aria-disabled', 'true');
    status.textContent = 'Разбираю фото и собираю образ — это может занять до 30 секунд…';
    status.className = 'lb-status';

    fetch('api/compose-look', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (state.session ? state.session.access_token : '')
      },
      body: JSON.stringify({ image: state.dataUrl, fit: fit, itemHint: itemHint })
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            var err = new Error(data.error || 'Не получилось собрать образ.');
            err.status = res.status;
            throw err;
          });
        }
        return res.json();
      })
      .then(renderResult)
      .catch(function (err) {
        if (err && err.status === 402) {
          status.innerHTML = '';
          status.className = 'lb-status lb-status--error';
          status.appendChild(document.createTextNode((err.message || 'Первый образ уже использован.') + ' '));
          var link = document.createElement('a');
          link.href = 'cabinet.html';
          link.textContent = 'Пополнить баланс';
          status.appendChild(link);
        } else {
          status.textContent = (err && err.message) || 'Не получилось собрать образ. Попробуйте ещё раз.';
          status.className = 'lb-status lb-status--error';
        }
        goBtn.removeAttribute('disabled');
        goBtn.removeAttribute('aria-disabled');
      });
  }

  function renderResult(data) {
    root.innerHTML = '';

    root.appendChild(el('span', 'wizard-result__badge', 'Собрано ИИ-стилистом · референс, не примерка'));
    root.appendChild(el('h2', null, 'Референс вашего образа'));
    root.appendChild(el('p', 'wizard-result__note',
      'Картинка ниже — рисованная иллюстрация того, как может выглядеть образ, а не фотография вас в готовом виде.'
    ));

    if (data.image) {
      var img = document.createElement('img');
      img.className = 'lb-result-image';
      img.src = data.image;
      img.alt = 'Иллюстрация собранного образа';
      root.appendChild(img);
    }

    var layers = data.layers || {};
    var layersBlock = el('div', 'wizard-result__block');
    layersBlock.appendChild(el('div', 'wizard-result__block-title', '👕 Образ по слоям'));
    var dl = el('dl', 'wizard-layers');
    LAYER_LABELS.forEach(function (key) {
      if (!layers[key]) return;
      dl.appendChild(el('dt', null, key));
      dl.appendChild(el('dd', null, escapeHtml(layers[key])));
    });
    layersBlock.appendChild(dl);
    root.appendChild(layersBlock);

    if (data.why) {
      var whyBlock = el('div', 'wizard-result__block');
      whyBlock.appendChild(el('div', 'wizard-result__block-title', '💡 Почему именно так'));
      whyBlock.appendChild(el('p', 'wizard-why', escapeHtml(data.why)));
      root.appendChild(whyBlock);
    }

    var restartWrap = el('div', 'lb-restart');
    var restartBtn = el('button', 'wizard-back', 'Собрать другой образ');
    restartBtn.type = 'button';
    restartBtn.addEventListener('click', renderUpload);
    restartWrap.appendChild(restartBtn);
    root.appendChild(restartWrap);
  }

  if (authGate && window.stilAuthGate) {
    window.stilAuthGate.renderGate(authGate, function (session) {
      state.session = session;
      renderUpload();
    });
  } else {
    renderUpload();
  }
})();
