-- ============================================================================
-- Схема базы сайта на собственном PostgreSQL (сервер в России, 152-ФЗ ч. 5 ст. 18)
-- — замена Supabase (2026-10-23). Применяется один раз на пустую базу:
--   psql "$DATABASE_URL" -f db/postgres/schema.sql
-- Повторный запуск ничего не ломает (if not exists / create or replace).
--
-- Отличия от db/schema.sql (Supabase):
--   - пользователи — своя таблица users (вместо auth.users), вход по коду из
--     письма — login_codes, сессии — sessions (lib/auth.js);
--   - картинки (образы, аватарки, примеры образов) — таблица files (bytea)
--     вместо Supabase Storage, пути объектов те же (lib/storage.js);
--   - RLS и роли anon/authenticated не нужны: браузер к базе не подключается
--     вообще, все запросы идут только из api/*.js под одной серверной ролью;
--   - старые функции депозита (finalize_topup, debit_wallet_*) не переносятся —
--     код их не вызывает с 20.10.2026; их данные (wallet_transactions, баланс)
--     остаются для истории.
--
-- Всё, что двигает деньги и образы, — по-прежнему функции Postgres: каждая
-- операция одной транзакцией, гонки двух параллельных запросов исключены.
-- ============================================================================

-- gen_random_uuid() встроена в PostgreSQL 13+, расширение pgcrypto не нужно.

-- ---------------------------------------------------------------------------
-- Пользователи, вход по коду, сессии
-- ---------------------------------------------------------------------------

create table if not exists users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique check (email = lower(email)),
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- Код из письма хранится только хэшем (HMAC с AUTH_SECRET) — утечка базы не
-- даёт войти по ещё не истёкшему коду. attempts — неверные попытки ввода.
create table if not exists login_codes (
  id          bigserial primary key,
  email       text not null,
  code_hash   text not null,
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists login_codes_email_created_idx on login_codes (email, created_at desc);

-- Токен сессии отдаётся браузеру один раз, в базе — только sha256 от него.
create table if not exists sessions (
  token_hash    text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now()
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_expires_idx on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Файлы (вместо Supabase Storage). bucket/path — как были в Storage:
--   looks/{user_id}/{look_id}.jpg   — картинки «Моих образов» (приватные,
--                                     выдаются по подписанной ссылке на минуты);
--   avatars/{user_id}/avatar.jpg    — аватарки (публичные, как раньше);
--   site-looks/{uuid}.jpg           — примеры образов на сайте (публичные).
-- ---------------------------------------------------------------------------

create table if not exists files (
  bucket        text not null,
  path          text not null,
  content_type  text not null default 'image/jpeg',
  data          bytea not null,
  size_bytes    integer not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (bucket, path)
);

-- ---------------------------------------------------------------------------
-- Кошелёк — общая запись состояния пользователя (запас образов, аватарка).
-- balance_kopecks / looks_count / free_credits_remaining — от прежних моделей
-- цен, оставлены для истории.
-- ---------------------------------------------------------------------------

create table if not exists wallets (
  user_id                 uuid primary key references users(id) on delete cascade,
  balance_kopecks         bigint not null default 0 check (balance_kopecks >= 0),
  currency                text not null default 'RUB',
  looks_count             integer not null default 0,
  free_credits_remaining  integer not null default 0,
  looks_in_stock          integer not null default 0 check (looks_in_stock >= 0),
  avatar_path             text,
  updated_at              timestamptz not null default now()
);

create table if not exists wallet_transactions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references users(id) on delete cascade,
  type                   text not null check (type in ('topup', 'debit', 'refund')),
  amount_kopecks         bigint not null check (amount_kopecks > 0),
  balance_after_kopecks  bigint not null check (balance_after_kopecks >= 0),
  provider_payment_id    text,
  order_id               uuid,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

create index if not exists wallet_transactions_user_created_idx on wallet_transactions (user_id, created_at desc);

create table if not exists payments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  provider              text not null default 'robokassa',
  provider_payment_id   text not null,
  amount_kopecks        bigint not null check (amount_kopecks > 0),
  status                text not null default 'pending'
                          check (status in ('pending', 'succeeded', 'failed', 'canceled', 'refunded')),
  raw_payload           jsonb,
  order_id              uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

create index if not exists payments_user_created_idx on payments (user_id, created_at desc);

create table if not exists orders (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  package_code            text not null,
  price_kopecks           bigint not null check (price_kopecks >= 0),
  wallet_transaction_id   uuid references wallet_transactions(id),
  status                  text not null default 'created'
                            check (status in ('created', 'paid', 'done', 'returned', 'canceled')),
  answers                 jsonb,
  payment_id              uuid references payments(id),
  look_id                 uuid,
  rebuild_used            boolean not null default false,
  done_at                 timestamptz,
  created_at              timestamptz not null default now()
);

create index if not exists orders_user_created_idx on orders (user_id, created_at desc);

do $$ begin
  alter table payments add constraint payments_order_id_fkey foreign key (order_id) references orders(id);
exception when duplicate_object then null; end $$;

-- Один код партнёра — одна скидка (UNIQUE code), см. api/redeem-code.js.
create table if not exists discount_credits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  code        text not null unique,
  status      text not null default 'available' check (status in ('available', 'used')),
  order_id    uuid references orders(id),
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

create index if not exists discount_credits_user_status_idx on discount_credits (user_id, status);

-- ---------------------------------------------------------------------------
-- Rate-limit (lib/rateLimit.js): bucket уже содержит хэш IP или email.
-- ---------------------------------------------------------------------------

create table if not exists rate_limit_hits (
  id          bigserial primary key,
  bucket      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists rate_limit_hits_bucket_created_idx on rate_limit_hits (bucket, created_at);

create or replace function check_rate_limit(p_bucket text, p_window_seconds int, p_max_hits int)
returns boolean
language plpgsql
as $$
declare
  v_count int;
begin
  -- Блокировка по ключу: два параллельных запроса с одного адреса не проскочат лимит вместе.
  perform pg_advisory_xact_lock(hashtext(p_bucket));
  delete from rate_limit_hits
    where bucket = p_bucket and created_at < now() - (p_window_seconds || ' seconds')::interval;
  select count(*) into v_count from rate_limit_hits where bucket = p_bucket;
  if v_count >= p_max_hits then
    return false;
  end if;
  insert into rate_limit_hits (bucket) values (p_bucket);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- «Мои образы», профиль стиля, оценки
-- ---------------------------------------------------------------------------

create table if not exists saved_looks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  layers      jsonb not null default '{}'::jsonb,
  why         text,
  fit         text,
  image_path  text,
  created_at  timestamptz not null default now()
);

create index if not exists saved_looks_user_created_idx on saved_looks (user_id, created_at desc);

create table if not exists style_profiles (
  user_id       uuid primary key references users(id) on delete cascade,
  remember      boolean not null default false,
  answers       jsonb not null default '{}'::jsonb,
  fit_history   text[] not null default '{}',
  item_history  text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

create table if not exists look_ratings (
  look_id     uuid primary key references saved_looks(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  rating      text not null check (rating in ('like', 'dislike')),
  reasons     text[] not null default '{}',
  comment     text check (comment is null or char_length(comment) <= 300),
  created_at  timestamptz not null default now()
);

create index if not exists look_ratings_user_idx on look_ratings (user_id);

-- ---------------------------------------------------------------------------
-- Партнёры «Примерки», отзывы, примеры образов
-- ---------------------------------------------------------------------------

create table if not exists partners (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  contact     text,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists partner_codes (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references partners(id) on delete cascade,
  code        text not null unique,
  ref         text not null,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists partner_codes_partner_idx on partner_codes (partner_id);

create or replace view partner_stats as
select
  p.id as partner_id,
  p.name,
  p.slug,
  p.contact,
  p.status,
  p.notes,
  p.created_at,
  count(pc.id) as codes_issued,
  count(dc.id) as codes_redeemed,
  count(o.id) as orders_completed,
  coalesce(sum(o.price_kopecks), 0) as revenue_kopecks
from partners p
left join partner_codes pc on pc.partner_id = p.id
left join discount_credits dc on dc.code = pc.code
left join orders o on o.id = dc.order_id
group by p.id, p.name, p.slug, p.contact, p.status, p.notes, p.created_at;

create table if not exists reviews (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  text        text not null,
  age         integer,
  status      text not null default 'pending' check (status in ('pending', 'approved')),
  created_at  timestamptz not null default now()
);

create index if not exists reviews_status_created_idx on reviews (status, created_at desc);

create table if not exists site_looks (
  id          uuid primary key default gen_random_uuid(),
  image_path  text not null,
  caption     text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists site_looks_sort_idx on site_looks (sort_order, created_at desc);

-- ---------------------------------------------------------------------------
-- Заказ + ожидающий платёж одной транзакцией (api/payments/create.js).
-- ---------------------------------------------------------------------------
create or replace function create_order_with_payment(
  p_user_id uuid,
  p_package_code text,
  p_price_kopecks bigint,
  p_answers jsonb,
  p_provider_payment_id text
)
returns uuid
language plpgsql
as $$
declare
  v_order_id uuid;
  v_payment_id uuid;
begin
  insert into orders (user_id, package_code, price_kopecks, status, answers)
    values (p_user_id, p_package_code, p_price_kopecks, 'created', p_answers)
    returning id into v_order_id;

  insert into payments (user_id, provider, provider_payment_id, amount_kopecks, status, order_id)
    values (p_user_id, 'robokassa', p_provider_payment_id, p_price_kopecks, 'pending', v_order_id)
    returning id into v_payment_id;

  update orders set payment_id = v_payment_id where id = v_order_id;
  return v_order_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Подтверждённая оплата (api/payments/webhook.js и запасной опрос Robokassa).
-- Идемпотентно: повторное уведомление возвращает 'already'.
-- ---------------------------------------------------------------------------
create or replace function finalize_order_payment(p_provider_payment_id text, p_out_sum_kopecks bigint)
returns text
language plpgsql
as $$
declare
  v_payment record;
  v_order record;
  v_looks integer;
  v_credit_id uuid;
begin
  select id, user_id, amount_kopecks, order_id, status into v_payment
    from payments
    where provider = 'robokassa' and provider_payment_id = p_provider_payment_id
    for update;

  if not found then
    return 'not_found';
  end if;
  if v_payment.status <> 'pending' then
    return 'already';
  end if;
  if v_payment.amount_kopecks <> p_out_sum_kopecks then
    raise exception 'amount_mismatch' using errcode = 'P0001';
  end if;

  update payments set status = 'succeeded', updated_at = now() where id = v_payment.id;

  select id, package_code into v_order from orders where id = v_payment.order_id for update;
  if not found then
    return 'no_order';
  end if;

  if v_order.package_code in ('PACK_3', 'PACK_5') then
    v_looks := case v_order.package_code when 'PACK_3' then 3 else 5 end;
    insert into wallets (user_id) values (v_payment.user_id) on conflict (user_id) do nothing;
    update wallets set looks_in_stock = looks_in_stock + v_looks, updated_at = now()
      where user_id = v_payment.user_id;
    update orders set status = 'done', done_at = now() where id = v_order.id;
  else
    update orders set status = 'paid' where id = v_order.id and status = 'created';
    if v_order.package_code = 'OBRAZ_PARTNER' then
      select id into v_credit_id from discount_credits
        where user_id = v_payment.user_id and status = 'available'
        order by created_at limit 1 for update;
      if found then
        update discount_credits set status = 'used', used_at = now(), order_id = v_order.id
          where id = v_credit_id;
      end if;
    end if;
  end if;

  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------------
-- Занять право на сборку одного образа (api/looks/charge.js):
--   p_order_id задан → этот оплаченный и ещё не использованный заказ;
--   p_order_id пуст  → один образ из запаса (заказ STOCK_LOOK за 0 ₽).
-- ---------------------------------------------------------------------------
create or replace function claim_look(p_user_id uuid, p_order_id uuid)
returns uuid
language plpgsql
as $$
declare
  v_order_id uuid;
begin
  if p_order_id is not null then
    update orders set status = 'done', done_at = now()
      where id = p_order_id and user_id = p_user_id and status = 'paid'
        and package_code in ('OBRAZ_PO_FOTO', 'OBRAZ_PARTNER')
      returning id into v_order_id;
    if not found then
      raise exception 'not_paid' using errcode = 'P0001';
    end if;
    return v_order_id;
  end if;

  update wallets set looks_in_stock = looks_in_stock - 1, updated_at = now()
    where user_id = p_user_id and looks_in_stock > 0;
  if not found then
    raise exception 'no_stock' using errcode = 'P0001';
  end if;
  insert into orders (user_id, package_code, price_kopecks, status, done_at)
    values (p_user_id, 'STOCK_LOOK', 0, 'done', now())
    returning id into v_order_id;
  return v_order_id;
end;
$$;

-- Образ не собрался после оплаты — оплаченный образ возвращается в запас.
create or replace function return_look_to_stock(p_user_id uuid, p_order_id uuid)
returns boolean
language plpgsql
as $$
begin
  update orders set status = 'returned'
    where id = p_order_id and user_id = p_user_id and status = 'done' and look_id is null
      and done_at > now() - interval '15 minutes';
  if not found then
    return false;
  end if;
  insert into wallets (user_id) values (p_user_id) on conflict (user_id) do nothing;
  update wallets set looks_in_stock = looks_in_stock + 1, updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;

-- Бесплатная пересборка: одна на оплаченный образ, 30 минут после сборки.
create or replace function use_rebuild(p_user_id uuid, p_order_id uuid, p_undo boolean)
returns boolean
language plpgsql
as $$
begin
  if p_undo then
    update orders set rebuild_used = false
      where id = p_order_id and user_id = p_user_id and rebuild_used;
    return found;
  end if;
  update orders set rebuild_used = true
    where id = p_order_id and user_id = p_user_id and status = 'done' and not rebuild_used
      and look_id is not null
      and done_at > now() - interval '30 minutes'
      and package_code in ('OBRAZ_PO_FOTO', 'OBRAZ_PARTNER', 'STOCK_LOOK');
  return found;
end;
$$;
