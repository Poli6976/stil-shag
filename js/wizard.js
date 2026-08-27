/* ============ Онлайн-стилист: визард 3.1 (быстрый старт) + 3.2 (анкета) + 3.3/3.4 (демо-результат) ============
   Реального ИИ-стилиста пока нет — сайт статический, без бэкенда. Финальный экран честно
   показывает пример формата (подобранный по поводу/возрасту из ответов), а не выдаёт его
   за персональную генерацию. Подключение настоящей языковой модели — отдельный этап,
   когда определимся с бэкендом (см. раздел 6 структуры сайта). */

(function () {
  var STEPS = [
    { id: 'start', type: 'start' },
    {
      id: 'age',
      type: 'select',
      eyebrow: 'Вопрос 1',
      question: 'Какая возрастная группа?',
      hint: 'Чтобы верно откалибровать стиль — без лишней детализации.',
      options: [
        { value: 'adult', label: 'Взрослая' },
        { value: 'teen', label: 'Подросток (до 18)' }
      ]
    },
    {
      id: 'occasion',
      type: 'select',
      eyebrow: 'Вопрос 2',
      question: 'Какой повод?',
      options: [
        { value: 'office', label: 'Офис' },
        { value: 'walk', label: 'Прогулка' },
        { value: 'evening', label: 'Вечер' },
        { value: 'event', label: 'Мероприятие' }
      ]
    },
    {
      id: 'budget',
      type: 'select',
      eyebrow: 'Вопрос 3',
      question: 'Какой бюджет на докупку?',
      options: [
        { value: 'low', label: 'До 3 000 ₽' },
        { value: 'mid', label: '3 000–8 000 ₽' },
        { value: 'high', label: '8 000–15 000 ₽' },
        { value: 'any', label: 'Без ограничений' }
      ]
    },
    {
      id: 'wardrobe',
      type: 'text',
      optional: true,
      eyebrow: 'Вопрос 4 · можно пропустить',
      question: 'Что из подходящего уже есть в гардеробе?',
      placeholder: 'Например: чёрные лодочки, тонкий ремень…',
      hint: 'Если ничего не приходит в голову — просто нажмите «Далее», соберём образ с нуля.'
    },
    {
      id: 'fit',
      type: 'text',
      optional: true,
      sensitive: true,
      teenSkip: true,
      eyebrow: 'Вопрос 5 · можно пропустить',
      question: 'Рост и размер — если готовы поделиться',
      placeholder: 'Например: 165 см, 44 размер',
      hint: 'Не обязательно для результата — можно оставить пустым.'
    },
    {
      id: 'style',
      type: 'select',
      eyebrow: 'Последний вопрос',
      question: 'Какой стиль вам ближе?',
      options: [
        { value: 'classic', label: 'Классика' },
        { value: 'casual', label: 'Кэжуал' },
        { value: 'bold', label: 'Смелые эксперименты' }
      ]
    }
  ];

  var FOR_WHOM = [
    { value: 'self', label: 'Это для меня' },
    { value: 'daughter', label: 'Для дочери' },
    { value: 'friend', label: 'Для подруги' },
    { value: 'husband', label: 'Для мужа' },
    { value: 'son', label: 'Для сына' }
  ];

  var TEMPLATES = {
    office: {
      title: 'Офис',
      layers: {
        'Верх': 'Белая рубашка прямого кроя из плотного хлопка',
        'Низ': 'Тёмно-синие брюки со стрелками',
        'Верхняя одежда': 'Жакет в тон брюк, чуть длиннее среднего',
        'Обувь': 'Лодочки на устойчивом каблуке 5–6 см, нейтральный тон',
        'Аксессуары': 'Тонкий кожаный ремень и небольшая сумка-портфель',
        'Причёска': 'Гладкий низкий хвост или собранные волосы',
        'Макияж': 'Естественный тон кожи, акцент на бровях, нюдовая помада'
      },
      why: 'Чёткие линии и сдержанная палитра считываются как компетентность — яркий акцент здесь неуместен, поэтому весь характер образа ушёл в фактуру ткани.',
      products: [
        { name: 'Лодочки нейтрального тона', note: 'Устойчивый каблук 5–6 см' },
        { name: 'Тонкий кожаный ремень', note: 'В тон низу' },
        { name: 'Сумка-портфель', note: 'Небольшая, строгая форма' }
      ]
    },
    walk: {
      title: 'Прогулка',
      layers: {
        'Верх': 'Трикотажный джемпер оверсайз',
        'Низ': 'Прямые джинсы светлого индиго',
        'Верхняя одежда': 'Стёганая куртка или тренч — по погоде',
        'Обувь': 'Белые кроссовки или лоферы',
        'Аксессуары': 'Кросс-боди сумка, тонкий шарф',
        'Причёска': 'Свободные волны или собранный пучок',
        'Макияж': 'Лёгкий тон и бальзам для губ — акцент на отдых, не на макияж'
      },
      why: 'Свободный крой и мягкие ткани не сковывают движение, а один яркий акцент (шарф) не даёт образу выглядеть скучно.',
      products: [
        { name: 'Белые кроссовки', note: 'Универсальная модель' },
        { name: 'Кросс-боди сумка', note: 'Компактная, руки свободны' },
        { name: 'Тонкий шарф', note: 'Цветовой акцент образа' }
      ]
    },
    evening: {
      title: 'Вечер',
      layers: {
        'Верх': 'Шёлковая блуза с лёгким блеском',
        'Низ': 'Юбка-карандаш длины миди',
        'Верхняя одежда': 'Тонкий жакет или накидка на плечи',
        'Обувь': 'Туфли на каблуке с открытым носом',
        'Аксессуары': 'Клатч и серьги-капли',
        'Причёска': 'Лёгкие локоны или гладкий пучок с пробором',
        'Макияж': 'Акцент на глаза или губы — не оба сразу'
      },
      why: 'Блеск и вертикальные линии удлиняют силуэт, а один акцент в макияже держит образ собранным, а не перегруженным.',
      products: [
        { name: 'Туфли с открытым носом', note: 'Каблук 7–9 см' },
        { name: 'Клатч', note: 'Небольшой, в тон аксессуарам' },
        { name: 'Серьги-капли', note: 'Единственный яркий акцент' }
      ]
    },
    event: {
      title: 'Мероприятие',
      layers: {
        'Верх': 'Приталенный жакет без рукавов',
        'Низ': 'Брюки палаццо или юбка-миди',
        'Верхняя одежда': 'Жакет уже выполняет эту роль — верхний слой не нужен',
        'Обувь': 'Туфли на каблуке в тон брюк — визуально удлиняют ногу',
        'Аксессуары': 'Крупная брошь или серьги-каффы',
        'Причёска': 'Собранные волосы с чётким пробором',
        'Макияж': 'Чуть более насыщенный тон, чем для офиса — но без вечернего глиттера'
      },
      why: 'Монохромная связка верха и низа держит образ статусным, а один акцентный аксессуар не даёт ему слиться в одно пятно.',
      products: [
        { name: 'Туфли в тон брюк', note: 'Удлиняют силуэт' },
        { name: 'Крупная брошь', note: 'Единственный акцент' },
        { name: 'Клатч', note: 'В тон обуви' }
      ]
    },
    teen: {
      title: 'Комфорт и повод',
      layers: {
        'Верх': 'Однотонная водолазка или футболка спокойного цвета',
        'Низ': 'Прямые джинсы или брюки',
        'Верхняя одежда': 'Джинсовка или лёгкая куртка',
        'Обувь': 'Кроссовки или слипоны',
        'Аксессуары': 'Один яркий акцент — например, цветной рюкзак или заколка',
        'Причёска': 'Свободные волосы или хвост — то, что удобно',
        'Макияж': '— по возрасту не понадобится'
      },
      why: 'Комфорт и повод — на первом месте, а самовыражение уходит в один яркий цветной акцент, а не во весь образ.',
      products: [
        { name: 'Рюкзак с ярким принтом', note: 'Акцентная вещь образа' },
        { name: 'Кроссовки на смену', note: 'Универсальная пара' },
        { name: 'Заколки или резинки', note: 'Недорого, но заметно' }
      ]
    }
  };

  var TEMPLATES_MALE = {
    office: {
      title: 'Офис',
      layers: {
        'Верх': 'Рубашка классического кроя, однотонная или в мелкую клетку',
        'Низ': 'Тёмно-синие или серые брюки прямого кроя',
        'Верхняя одежда': 'Пиджак в тон брюк или контрастный, некрупная фактура',
        'Обувь': 'Дерби или оксфорды тёмно-коричневого или чёрного цвета',
        'Аксессуары': 'Ремень в тон обуви и простые часы — без лишних деталей',
        'Причёска': 'Короткая аккуратная стрижка, чёткие линии',
        'Уход': 'Гладко выбрит или аккуратно подстриженная борода'
      },
      why: 'Тёмный низ и нейтральный верх считываются как собранность — фактура ткани и посадка важнее ярких деталей, которых здесь и не нужно.',
      products: [
        { name: 'Дерби тёмно-коричневого цвета', note: 'Или чёрные — по тону брюк' },
        { name: 'Ремень в тон обуви', note: 'Простая гладкая кожа' },
        { name: 'Часы на кожаном ремешке', note: 'Единственный акцент-аксессуар' }
      ]
    },
    walk: {
      title: 'Прогулка',
      layers: {
        'Верх': 'Футболка или лёгкий свитер спокойного цвета',
        'Низ': 'Прямые джинсы или чиносы',
        'Верхняя одежда': 'Куртка-бомбер или худи — по погоде',
        'Обувь': 'Кроссовки нейтрального цвета',
        'Аксессуары': 'Рюкзак или сумка через плечо',
        'Причёска': 'Свободная укладка, без строгости',
        'Уход': 'Дневной уход за кожей — по погоде и типу кожи'
      },
      why: 'Свободный крой и мягкие ткани не сковывают движение, а нейтральная палитра позволяет менять верхнюю одежду по погоде без потери образа.',
      products: [
        { name: 'Кроссовки нейтрального цвета', note: 'Универсальная модель' },
        { name: 'Рюкзак', note: 'Компактный, руки свободны' },
        { name: 'Бейсболка или шапка', note: 'По погоде и настроению' }
      ]
    },
    evening: {
      title: 'Вечер',
      layers: {
        'Верх': 'Рубашка тёмного тона или тонкий свитер',
        'Низ': 'Тёмные брюки или чиносы',
        'Верхняя одежда': 'Пиджак без галстука — сдержанная элегантность',
        'Обувь': 'Челси или лоферы',
        'Аксессуары': 'Часы и, при желании, платок в нагрудный карман',
        'Причёска': 'Уложенные волосы, чёткий пробор или назад',
        'Уход': 'Свежий вид — бритьё накануне, увлажнение кожи'
      },
      why: 'Тёмная палитра без галстука держит образ на грани строгого и непринуждённого — ровно то, что нужно вечером без формального повода.',
      products: [
        { name: 'Лоферы или челси', note: 'Тёмная гладкая кожа' },
        { name: 'Платок в нагрудный карман', note: 'Необязательный, но заметный акцент' },
        { name: 'Часы', note: 'Единственный акцентный аксессуар' }
      ]
    },
    event: {
      title: 'Мероприятие',
      layers: {
        'Верх': 'Рубашка под пиджак, однотонная',
        'Низ': 'Костюмные брюки в тон пиджаку',
        'Верхняя одежда': 'Пиджак классического или приталенного кроя',
        'Обувь': 'Оксфорды в тон костюма',
        'Аксессуары': 'Галстук или бабочка, запонки по желанию',
        'Причёска': 'Строгая укладка',
        'Уход': 'Аккуратная борода или чистое бритьё'
      },
      why: 'Монохромный костюм держит образ статусным, а один акцент — галстук или бабочка — не даёт ему выглядеть безликим.',
      products: [
        { name: 'Оксфорды в тон костюма', note: 'Классическая шнуровка' },
        { name: 'Галстук или бабочка', note: 'Единственный цветной акцент' },
        { name: 'Запонки', note: 'Если рубашка под них' }
      ]
    },
    teen: {
      title: 'Комфорт и повод',
      layers: {
        'Верх': 'Однотонная футболка или худи спокойного цвета',
        'Низ': 'Прямые джинсы или брюки',
        'Верхняя одежда': 'Джинсовка или лёгкая куртка',
        'Обувь': 'Кроссовки',
        'Аксессуары': 'Один акцент — например, кепка или рюкзак с принтом',
        'Причёска': 'Свободная — то, что удобно',
        'Уход': '— по возрасту не понадобится'
      },
      why: 'Комфорт и повод — на первом месте, а самовыражение уходит в один яркий акцент, а не во весь образ.',
      products: [
        { name: 'Кроссовки на смену', note: 'Универсальная пара' },
        { name: 'Кепка или рюкзак с принтом', note: 'Акцентная вещь образа' },
        { name: 'Худи спокойного цвета', note: 'Базовый слой под куртку' }
      ]
    }
  };

  /* грубое распознавание категории вещи по ключевым словам — чтобы демо-шаблон не
     предлагал купить второй такой же слой поверх уже введённой вещи (например
     "низ: прямые джинсы" в ответ на "зелёные брюки"). Это не NLP и не ИИ, просто
     список слов, достаточный для честного демо; настоящее распознавание вещи —
     задача будущего ИИ-стилиста, не этого статического шаблона. */
  var ITEM_CATEGORY_KEYWORDS = [
    { category: 'dress', words: ['платье', 'сарафан'] },
    { category: 'Низ', words: ['брюки', 'джинсы', 'юбка', 'юбку', 'юбочка', 'шорты', 'легинсы', 'штаны', 'бриджи'] },
    { category: 'Верх', words: ['рубашка', 'рубашку', 'блуза', 'блузка', 'блузку', 'футболка', 'футболку', 'свитер', 'джемпер', 'водолазка', 'топ', 'кофта', 'кофту'] },
    { category: 'Верхняя одежда', words: ['пальто', 'куртка', 'куртку', 'плащ', 'пуховик', 'жакет', 'жакетом', 'пиджак', 'пиджака', 'тренч', 'кардиган'] },
    { category: 'Обувь', words: ['туфли', 'кроссовки', 'ботинки', 'сапоги', 'лодочки', 'сандалии', 'кеды'] }
  ];

  function detectItemCategory(itemText) {
    var text = (itemText || '').toLowerCase();
    for (var i = 0; i < ITEM_CATEGORY_KEYWORDS.length; i++) {
      var entry = ITEM_CATEGORY_KEYWORDS[i];
      for (var j = 0; j < entry.words.length; j++) {
        if (text.indexOf(entry.words[j]) !== -1) return entry.category;
      }
    }
    return null;
  }

  function applyItemToLayers(layers, itemText) {
    var result = {};
    Object.keys(layers).forEach(function (key) { result[key] = layers[key]; });
    if (!itemText || !itemText.trim()) return result;

    var quoted = 'Уже есть — это ваша вещь: «' + escapeHtml(itemText.trim()) + '»';
    var category = detectItemCategory(itemText);
    if (category === 'dress') {
      result['Верх'] = quoted + ' (выполняет роль верха и низа)';
      result['Низ'] = quoted + ' (выполняет роль верха и низа)';
    } else if (category && result[category] !== undefined) {
      result[category] = quoted;
    }
    return result;
  }

  var BUDGET_LABELS = {
    low: 'до 3 000 ₽',
    mid: '3 000–8 000 ₽',
    high: '8 000–15 000 ₽',
    any: 'без ограничений'
  };

  var answers = {};
  var stepIndex = 0;
  var currentSession = null;

  var root = document.getElementById('wizardStep');
  var progressLabel = document.getElementById('wizardProgressLabel');
  var progressFill = document.getElementById('wizardProgressFill');
  var authGate = document.getElementById('wizardAuthGate');

  if (!root) return;

  function visibleSteps() {
    return STEPS.filter(function (s) {
      return !(s.teenSkip && answers.age === 'teen');
    });
  }

  function updateProgress() {
    var steps = visibleSteps();
    var current = Math.min(stepIndex + 1, steps.length);
    progressLabel.textContent = 'Шаг ' + current + ' из ' + steps.length;
    progressFill.style.width = Math.round((current / steps.length) * 100) + '%';
  }

  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function goNext() {
    var steps = visibleSteps();
    if (stepIndex < steps.length - 1) {
      stepIndex++;
      render();
    } else {
      stepIndex = steps.length;
      chargeAndRenderResult();
    }
  }

  function buildTemplateResult() {
    var isMale = answers.forWhom === 'husband' || answers.forWhom === 'son';
    var templateSet = isMale ? TEMPLATES_MALE : TEMPLATES;
    var isTeen = answers.age === 'teen';
    var tpl = isTeen ? templateSet.teen : (templateSet[answers.occasion] || templateSet.office);
    var layers = applyItemToLayers(tpl.layers, answers.item);
    return { tpl: tpl, layers: layers };
  }

  /* Списывает право на образ (бесплатный первый / скидка / полная цена —
     см. lib/lookAccess.js) и только при успехе показывает результат. Слои
     считаются заранее из статичных шаблонов (бесплатно для нас) и уходят на
     сервер вместе со списанием — там по ним пробуют нарисовать картинку
     через YandexART (api/looks/charge.js), необязательный бонус к тексту. */
  function chargeAndRenderResult() {
    root.innerHTML = '';
    root.appendChild(el('p', 'wizard-step__hint', 'Оформляем ваш образ…'));

    var built = buildTemplateResult();

    fetch('api/looks/charge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + currentSession.access_token
      },
      body: JSON.stringify({ layers: built.layers, why: built.tpl.why, fit: answers.fit || '' })
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            var err = new Error(data.error || 'Не получилось оформить образ.');
            err.status = res.status;
            throw err;
          });
        }
        return res.json();
      })
      .then(function (data) {
        renderResult(built, data.image);
      })
      .catch(function (err) {
        root.innerHTML = '';
        root.appendChild(el('span', 'wizard-result__badge', err.status === 402 ? 'Нужна оплата' : 'Ошибка'));
        root.appendChild(el('h2', null, err.status === 402 ? 'Первый образ уже использован' : 'Не получилось'));
        root.appendChild(el('p', 'wizard-result__note', (err && err.message) || 'Попробуйте ещё раз.'));
        var link = el('a', 'btn-3d btn-3d--rect', 'Пополнить баланс в кабинете');
        link.href = 'cabinet.html';
        root.appendChild(link);
        renderRestartLinks();
      });
  }

  function goBack() {
    if (stepIndex > 0) {
      stepIndex--;
      render();
    }
  }

  function restart() {
    answers = {};
    stepIndex = 0;
    render();
  }

  function render() {
    var steps = visibleSteps();
    var step = steps[stepIndex];
    root.innerHTML = '';
    updateProgress();

    var canAdvance = false;

    if (step.type === 'start') {
      root.appendChild(el('span', 'wizard-step__eyebrow', 'Быстрый старт'));
      root.appendChild(el('h2', null, 'Вокруг какой вещи соберём образ?'));
      root.appendChild(el('p', 'wizard-step__hint', 'Подойдёт любая — та, что уже купили у партнёра, та, что давно лежит в шкафу, или та, что просто приглянулась. Опишите её своими словами, этого достаточно, чтобы начать.'));

      var toggleWrap = el('div', 'wizard-toggle');
      FOR_WHOM.forEach(function (opt) {
        var btn = el('button', 'wizard-toggle__opt' + (answers.forWhom === opt.value ? ' is-selected' : ''), opt.label);
        btn.type = 'button';
        btn.addEventListener('click', function () {
          answers.forWhom = opt.value;
          render();
        });
        toggleWrap.appendChild(btn);
      });
      if (!answers.forWhom) { answers.forWhom = 'self'; }
      root.appendChild(toggleWrap);

      var itemField = el('div', 'wizard-field');
      var itemLabel = el('label', null, 'Вещь');
      itemLabel.setAttribute('for', 'wizardItem');
      var itemInput = el('textarea', 'wizard-textarea');
      itemInput.id = 'wizardItem';
      itemInput.placeholder = 'Например: красная юбка миди';
      itemInput.value = answers.item || '';
      itemInput.addEventListener('input', function () {
        answers.item = itemInput.value;
        setNextEnabled(!!answers.item.trim());
      });
      itemField.appendChild(itemLabel);
      itemField.appendChild(itemInput);
      root.appendChild(itemField);

      var photoField = el('div', 'wizard-field');
      photoField.appendChild(el('label', null, 'Фото вещи (необязательно)'));

      var photoConsentWrap = el('label', 'wizard-consent');
      var photoConsentCheckbox = document.createElement('input');
      photoConsentCheckbox.type = 'checkbox';
      photoConsentWrap.appendChild(photoConsentCheckbox);
      photoConsentWrap.appendChild(el('span', null,
        'Согласен(на) на обработку фото вещи сервисом распознавания изображений GigaChat — фото ' +
        'уходит только туда и не хранится на сайте после ответа. Подробнее — ' +
        '<a href="legal-privacy.html" target="_blank" rel="noopener">Политика конфиденциальности</a>.'
      ));
      photoField.appendChild(photoConsentWrap);

      var photoRow = el('div', 'wizard-photo-row');
      var photoBtn = el('button', 'wizard-photo-btn', 'Загрузить фото');
      photoBtn.type = 'button';
      photoBtn.disabled = true;
      photoConsentCheckbox.addEventListener('change', function () {
        photoBtn.disabled = !photoConsentCheckbox.checked;
      });
      var photoInput = document.createElement('input');
      photoInput.type = 'file';
      photoInput.accept = 'image/*';
      photoInput.className = 'wizard-photo-input';
      photoBtn.addEventListener('click', function () { photoInput.click(); });
      var photoPreview = document.createElement('img');
      photoPreview.className = 'wizard-photo-preview';
      photoPreview.style.display = 'none';
      photoPreview.alt = '';
      var photoRemoveBtn = el('button', 'wizard-photo-remove', '× Удалить фото');
      photoRemoveBtn.type = 'button';
      photoRemoveBtn.style.display = 'none';
      photoRow.appendChild(photoBtn);
      photoRow.appendChild(photoPreview);
      photoRow.appendChild(photoRemoveBtn);

      var DEFAULT_PHOTO_HINT = 'Разберём фото и сами впишем описание в поле выше — его всегда можно поправить.';
      var photoStatus = el('p', 'wizard-photo-status', DEFAULT_PHOTO_HINT);

      function resetPhoto() {
        photoInput.value = '';
        photoPreview.src = '';
        photoPreview.style.display = 'none';
        photoRemoveBtn.style.display = 'none';
        photoStatus.textContent = DEFAULT_PHOTO_HINT;
        photoStatus.className = 'wizard-photo-status';
      }

      photoRemoveBtn.addEventListener('click', resetPhoto);

      photoInput.addEventListener('change', function () {
        var file = photoInput.files && photoInput.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          photoStatus.textContent = 'Это не похоже на фото — выберите картинку.';
          photoStatus.className = 'wizard-photo-status wizard-photo-status--error';
          return;
        }
        photoBtn.disabled = true;
        photoStatus.className = 'wizard-photo-status';
        photoStatus.textContent = 'Обрабатываю фото…';

        var dataUrlForPreview;
        resizeImageFile(file, 1024)
          .then(function (dataUrl) {
            dataUrlForPreview = dataUrl;
            photoPreview.src = dataUrl;
            photoPreview.style.display = 'block';
            photoRemoveBtn.style.display = 'inline-block';
            photoStatus.textContent = 'Анализирую вещь на фото…';
            return fetch('api/analyze-item', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (currentSession ? currentSession.access_token : '')
              },
              body: JSON.stringify({ image: dataUrl })
            });
          })
          .then(function (res) {
            if (!res.ok) {
              return res.json().catch(function () { return {}; }).then(function (data) {
                throw new Error(data.error || 'Сервис разбора фото сейчас недоступен.');
              });
            }
            return res.json();
          })
          .then(function (data) {
            answers.item = data.description || answers.item;
            itemInput.value = answers.item;
            setNextEnabled(!!answers.item.trim());
            photoStatus.textContent = 'Готово — можно поправить текст вручную, если нужно.';
            photoStatus.className = 'wizard-photo-status wizard-photo-status--ok';
          })
          .catch(function (err) {
            photoStatus.textContent = (err && err.message) || 'Не получилось разобрать фото — опишите вещь текстом.';
            photoStatus.className = 'wizard-photo-status wizard-photo-status--error';
          })
          .then(function () { photoBtn.disabled = !photoConsentCheckbox.checked; });
      });

      photoField.appendChild(photoRow);
      photoField.appendChild(photoStatus);
      photoField.appendChild(photoInput);
      root.appendChild(photoField);

      var linkField = el('div', 'wizard-field');
      var linkLabel = el('label', null, 'Ссылка на заказ (необязательно)');
      linkLabel.setAttribute('for', 'wizardLink');
      var linkInput = el('input', 'wizard-input');
      linkInput.id = 'wizardLink';
      linkInput.type = 'url';
      linkInput.placeholder = 'https://…';
      linkInput.value = answers.link || '';
      linkInput.addEventListener('input', function () { answers.link = linkInput.value; });
      linkField.appendChild(linkLabel);
      linkField.appendChild(linkInput);
      root.appendChild(linkField);

      canAdvance = !!(answers.item && answers.item.trim());
    } else if (step.type === 'select') {
      root.appendChild(el('span', 'wizard-step__eyebrow', step.eyebrow));
      root.appendChild(el('h2', null, step.question));
      if (step.hint) root.appendChild(el('p', 'wizard-step__hint', step.hint));

      var optWrap = el('div', 'wizard-options');
      step.options.forEach(function (opt) {
        var selected = answers[step.id] === opt.value;
        var btn = el('button', 'wizard-option' + (selected ? ' is-selected' : ''), opt.label);
        btn.type = 'button';
        btn.addEventListener('click', function () {
          answers[step.id] = opt.value;
          render();
        });
        optWrap.appendChild(btn);
      });
      root.appendChild(optWrap);

      canAdvance = !!answers[step.id];
    } else if (step.type === 'text') {
      root.appendChild(el('span', 'wizard-step__eyebrow', step.eyebrow));
      root.appendChild(el('h2', null, step.question));
      if (step.hint) root.appendChild(el('p', 'wizard-step__hint', step.hint));

      var field = el('div', 'wizard-field');
      var input = el('textarea', 'wizard-textarea');
      input.placeholder = step.placeholder || '';
      input.value = answers[step.id] || '';
      field.appendChild(input);
      root.appendChild(field);

      var fitConsentCheckbox = null;
      if (step.sensitive) {
        var fitConsentWrap = el('label', 'wizard-consent');
        fitConsentCheckbox = document.createElement('input');
        fitConsentCheckbox.type = 'checkbox';
        fitConsentCheckbox.checked = !!answers[step.id + 'Consent'];
        fitConsentWrap.appendChild(fitConsentCheckbox);
        fitConsentWrap.appendChild(el('span', null,
          'Согласен(на) на обработку этих данных о фигуре для подбора образа — см. ' +
          '<a href="legal-privacy.html" target="_blank" rel="noopener">Политику конфиденциальности</a>.'
        ));
        root.appendChild(fitConsentWrap);
        fitConsentCheckbox.addEventListener('change', function () {
          answers[step.id + 'Consent'] = fitConsentCheckbox.checked;
          recalcTextAdvance();
        });
      }

      function recalcTextAdvance() {
        var hasValue = !!(answers[step.id] && answers[step.id].trim());
        var ok = !(step.sensitive && hasValue) || (fitConsentCheckbox && fitConsentCheckbox.checked);
        setNextEnabled(ok);
      }

      input.addEventListener('input', function () {
        answers[step.id] = input.value;
        recalcTextAdvance();
      });

      var fitHasValue = !!(answers[step.id] && answers[step.id].trim());
      canAdvance = !(step.sensitive && fitHasValue) || (fitConsentCheckbox && fitConsentCheckbox.checked);
    }

    var actions = el('div', 'wizard-actions');
    var backBtn = el('button', 'wizard-back', '← Назад');
    backBtn.type = 'button';
    backBtn.disabled = stepIndex === 0;
    backBtn.addEventListener('click', goBack);

    var nextBtn = el('a', 'btn-3d btn-3d--rect', stepIndex === steps.length - 1 ? 'Получить образ' : 'Далее');
    nextBtn.href = '#';
    nextBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (nextBtn.hasAttribute('disabled')) return;
      goNext();
    });

    function setNextEnabled(enabled) {
      if (enabled) {
        nextBtn.removeAttribute('disabled');
        nextBtn.removeAttribute('aria-disabled');
        nextBtn.removeAttribute('tabindex');
      } else {
        nextBtn.setAttribute('disabled', '');
        nextBtn.setAttribute('aria-disabled', 'true');
        nextBtn.setAttribute('tabindex', '-1');
      }
    }
    setNextEnabled(canAdvance);

    actions.appendChild(backBtn);
    actions.appendChild(nextBtn);
    root.appendChild(actions);
  }

  function bumpStyleCount() {
    try {
      var n = parseInt(localStorage.getItem('stil.styleCount') || '0', 10) || 0;
      localStorage.setItem('stil.styleCount', String(n + 1));
    } catch (e) {}
  }

  function renderResult(built, image) {
    bumpStyleCount();

    progressLabel.textContent = 'Готово';
    progressFill.style.width = '100%';

    root.innerHTML = '';

    var tpl = built.tpl;
    var layers = built.layers;
    root.appendChild(el('span', 'wizard-result__badge', 'Пример формата, не персональная генерация'));
    root.appendChild(el('h2', null, 'Ваш образ по слоям'));

    var itemNote = answers.item ? 'Вещь: «' + escapeHtml(answers.item) + '». ' : '';
    root.appendChild(el('p', 'wizard-result__note',
      itemNote + 'Так выглядит формат результата для повода «' + tpl.title.toLowerCase() + '». ' +
      'Настоящий ИИ-стилист, который будет собирать образ именно под вашу вещь и ответы, — следующий этап: ' +
      'сайту нужен бэкенд с подключением к языковой модели, сейчас это чистая статика.'
    ));

    if (image) {
      root.appendChild(el('p', 'wizard-result__note',
        'Картинка ниже — иллюстрация по описанию выше, нарисованная ИИ с нуля, а не фотография реальной вещи или человека.'
      ));
      var img = document.createElement('img');
      img.className = 'wizard-result-image';
      img.src = image;
      img.alt = 'Иллюстрация образа';
      root.appendChild(img);
    }

    var layersBlock = el('div', 'wizard-result__block');
    layersBlock.appendChild(el('div', 'wizard-result__block-title', '👕 Образ по слоям'));
    var dl = el('dl', 'wizard-layers');
    Object.keys(layers).forEach(function (key) {
      dl.appendChild(el('dt', null, key));
      dl.appendChild(el('dd', null, layers[key]));
    });
    layersBlock.appendChild(dl);
    root.appendChild(layersBlock);

    var whyBlock = el('div', 'wizard-result__block');
    whyBlock.appendChild(el('div', 'wizard-result__block-title', '💡 Почему именно так'));
    whyBlock.appendChild(el('p', 'wizard-why', tpl.why));
    root.appendChild(whyBlock);

    var productsBlock = el('div', 'wizard-result__block');
    productsBlock.appendChild(el('div', 'wizard-result__block-title', '🛍 Что докупить · бюджет ' + (BUDGET_LABELS[answers.budget] || 'не указан')));
    productsBlock.appendChild(el('p', 'wizard-result__note',
      'Это не рекомендация к покупке и не ссылки на конкретные магазины — просто список того, чего не ' +
      'хватает для образа. Покупать ли, что и где — решаете только вы, сайт в этом не участвует.'
    ));
    var grid = el('div', 'wizard-products');
    tpl.products.forEach(function (p) {
      var card = el('div', 'wizard-product');
      card.appendChild(el('h4', null, p.name));
      card.appendChild(el('p', null, p.note));
      grid.appendChild(card);
    });
    productsBlock.appendChild(grid);
    root.appendChild(productsBlock);

    renderRestartLinks();
  }

  function renderRestartLinks() {
    var restartWrap = el('div', 'wizard-restart');
    var restartBtn = el('button', 'wizard-back', 'Начать заново');
    restartBtn.type = 'button';
    restartBtn.addEventListener('click', restart);
    restartWrap.appendChild(restartBtn);
    restartWrap.appendChild(el('span', null, ' · '));
    var cabinetLink = el('a', 'wizard-back', 'Личный кабинет');
    cabinetLink.href = 'cabinet.html';
    restartWrap.appendChild(cabinetLink);
    root.appendChild(restartWrap);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* сжимает фото до maxDim по большей стороне перед отправкой на сервер —
     без этого даже обычное фото с телефона легко превышает лимит тела запроса */
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
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  if (authGate && window.stilAuthGate) {
    window.stilAuthGate.renderGate(authGate, function (session) {
      currentSession = session;
      var progressWrap = document.getElementById('wizardProgressWrap');
      if (progressWrap) progressWrap.style.display = '';
      render();
    });
  } else {
    render();
  }
})();
