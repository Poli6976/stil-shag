-- ============================================================================
-- Схема платёжной подсистемы (депозит + списание за пакетные услуги).
-- Применяется вручную в Supabase → SQL Editor (см. DEPLOY-payments.md).
--
-- Принцип: все деньги двигаются ТОЛЬКО через функции ниже (SECURITY DEFINER,
-- EXECUTE только для service_role), никогда прямым UPDATE баланса из кода.
-- Это даёт настоящую атомарность (вся операция — одна транзакция БД) и не
-- даёт даже ошибке в нашем JS-коде оставить баланс в неконсистентном
-- состоянии. EXECUTE отозван у обычных ролей специально: если бы его мог
-- вызвать залогиненный пользователь напрямую (RPC из браузера), он мог бы
-- передать чужой p_user_id и списать/начислить деньги на чужой кошелёк —
-- сервер обязан сам определять user_id из проверенного JWT, а не из тела
-- запроса, и вызывать эти функции только со своим service-role ключом.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------

create table if not exists public.wallets (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  balance_kopecks  bigint not null default 0 check (balance_kopecks >= 0),
  currency         text not null default 'RUB',
  updated_at       timestamptz not null default now()
);

create table if not exists public.wallet_transactions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  type                   text not null check (type in ('topup', 'debit', 'refund')),
  amount_kopecks         bigint not null check (amount_kopecks > 0),
  balance_after_kopecks  bigint not null check (balance_after_kopecks >= 0),
  provider_payment_id    text,
  order_id               uuid,
  metadata               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now()
);

create index if not exists wallet_transactions_user_created_idx
  on public.wallet_transactions (user_id, created_at desc);

create table if not exists public.payments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  provider              text not null default 'robokassa',
  provider_payment_id   text not null,
  amount_kopecks        bigint not null check (amount_kopecks > 0),
  status                text not null default 'pending'
                          check (status in ('pending', 'succeeded', 'failed', 'canceled', 'refunded')),
  raw_payload           jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);

create table if not exists public.orders (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users(id) on delete cascade,
  package_code            text not null,
  price_kopecks           bigint not null check (price_kopecks > 0),
  wallet_transaction_id   uuid references public.wallet_transactions(id),
  created_at              timestamptz not null default now()
);

create index if not exists orders_user_created_idx
  on public.orders (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Скидочные кредиты программы «Примерка» — один код от партнёра даёт ровно
-- одну Примерку со скидкой. UNIQUE(code) не даёт погасить один и тот же код
-- дважды (в том числе в разных браузерах/аккаунтах) — это и есть правило
-- «одна скидка — одна примерка». Запись создаётся в api/redeem-code.js сразу
-- после того, как подпись кода прошла проверку (см. lib/partnerCode.js), и
-- расходуется атомарно в debit_wallet_for_discounted_primerka ниже.
-- ---------------------------------------------------------------------------

create table if not exists public.discount_credits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code        text not null unique,
  status      text not null default 'available' check (status in ('available', 'used')),
  order_id    uuid references public.orders(id),
  created_at  timestamptz not null default now(),
  used_at     timestamptz
);

create index if not exists discount_credits_user_status_idx
  on public.discount_credits (user_id, status);

-- ---------------------------------------------------------------------------
-- Автосоздание пустого кошелька при регистрации пользователя
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wallets (user_id, balance_kopecks) values (new.id, 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Зачисление депозита — вызывается из api/payments/webhook.js после того,
-- как подпись уведомления Robokassa прошла проверку (см.
-- lib/payments/robokassa.js). Идемпотентно: если платёж уже не в статусе
-- 'pending', функция просто ничего не делает и возвращает NULL — повторный
-- вебхук не задвоит зачисление.
-- ---------------------------------------------------------------------------

create or replace function public.finalize_topup(
  p_payment_id uuid,
  p_provider_payment_id text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_amount bigint;
  v_new_balance bigint;
begin
  update public.payments
    set status = 'succeeded', updated_at = now()
    where id = p_payment_id
      and provider_payment_id = p_provider_payment_id
      and status = 'pending'
    returning user_id, amount_kopecks into v_user_id, v_amount;

  if not found then
    return null; -- уже обработан либо не найден — идемпотентный выход
  end if;

  update public.wallets
    set balance_kopecks = balance_kopecks + v_amount, updated_at = now()
    where user_id = v_user_id
    returning balance_kopecks into v_new_balance;

  insert into public.wallet_transactions
    (user_id, type, amount_kopecks, balance_after_kopecks, provider_payment_id)
    values (v_user_id, 'topup', v_amount, v_new_balance, p_provider_payment_id);

  return v_new_balance;
end;
$$;

revoke execute on function public.finalize_topup(uuid, text) from public;
grant execute on function public.finalize_topup(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Списание с депозита за пакетную услугу. Атомарный UPDATE ... WHERE balance
-- >= price гарантирует, что баланс никогда не уйдёт в минус даже при двух
-- параллельных запросах на списание одновременно.
-- ---------------------------------------------------------------------------

create or replace function public.debit_wallet_for_package(
  p_user_id uuid,
  p_package_code text,
  p_price_kopecks bigint
)
returns table (order_id uuid, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_balance bigint;
  v_tx_id uuid;
  v_order_id uuid;
begin
  update public.wallets
    set balance_kopecks = balance_kopecks - p_price_kopecks, updated_at = now()
    where user_id = p_user_id and balance_kopecks >= p_price_kopecks
    returning balance_kopecks into v_new_balance;

  if not found then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions
    (user_id, type, amount_kopecks, balance_after_kopecks, metadata)
    values (p_user_id, 'debit', p_price_kopecks, v_new_balance, jsonb_build_object('package_code', p_package_code))
    returning id into v_tx_id;

  insert into public.orders (user_id, package_code, price_kopecks, wallet_transaction_id)
    values (p_user_id, p_package_code, p_price_kopecks, v_tx_id)
    returning id into v_order_id;

  update public.wallet_transactions set order_id = v_order_id where id = v_tx_id;

  return query select v_order_id, v_new_balance;
end;
$$;

revoke execute on function public.debit_wallet_for_package(uuid, text, bigint) from public;
grant execute on function public.debit_wallet_for_package(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Списание с депозита за Примерку со скидкой. В отличие от
-- debit_wallet_for_package, сначала атомарно захватывает один непотраченный
-- скидочный кредит пользователя (FOR UPDATE SKIP LOCKED — чтобы два
-- параллельных запроса не забрали один и тот же кредит дважды) и только
-- потом списывает деньги — если кредита нет, до списания баланса дело не
-- доходит вообще.
-- ---------------------------------------------------------------------------

create or replace function public.debit_wallet_for_discounted_primerka(
  p_user_id uuid,
  p_package_code text,
  p_price_kopecks bigint
)
returns table (order_id uuid, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit_id uuid;
  v_new_balance bigint;
  v_tx_id uuid;
  v_order_id uuid;
begin
  select id into v_credit_id
    from public.discount_credits
    where user_id = p_user_id and status = 'available'
    order by created_at
    limit 1
    for update skip locked;

  if v_credit_id is null then
    raise exception 'no_discount_available' using errcode = 'P0001';
  end if;

  update public.wallets
    set balance_kopecks = balance_kopecks - p_price_kopecks, updated_at = now()
    where user_id = p_user_id and balance_kopecks >= p_price_kopecks
    returning balance_kopecks into v_new_balance;

  if not found then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;

  insert into public.wallet_transactions
    (user_id, type, amount_kopecks, balance_after_kopecks, metadata)
    values (p_user_id, 'debit', p_price_kopecks, v_new_balance,
      jsonb_build_object('package_code', p_package_code, 'discount_credit_id', v_credit_id))
    returning id into v_tx_id;

  insert into public.orders (user_id, package_code, price_kopecks, wallet_transaction_id)
    values (p_user_id, p_package_code, p_price_kopecks, v_tx_id)
    returning id into v_order_id;

  update public.wallet_transactions set order_id = v_order_id where id = v_tx_id;

  update public.discount_credits
    set status = 'used', used_at = now(), order_id = v_order_id
    where id = v_credit_id;

  return query select v_order_id, v_new_balance;
end;
$$;

revoke execute on function public.debit_wallet_for_discounted_primerka(uuid, text, bigint) from public;
grant execute on function public.debit_wallet_for_discounted_primerka(uuid, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security — пользователь читает только свои строки. Запись
-- (INSERT/UPDATE/DELETE) не разрешена никому, кроме service_role, у которого
-- RLS отключена по умолчанию в Supabase — то есть писать деньги может
-- только серверный код с сервисным ключом, никогда браузер напрямую.
-- ---------------------------------------------------------------------------

alter table public.wallets enable row level security;
alter table public.wallet_transactions enable row level security;
alter table public.payments enable row level security;
alter table public.orders enable row level security;
alter table public.discount_credits enable row level security;

create policy "wallets_select_own" on public.wallets
  for select using (auth.uid() = user_id);

create policy "wallet_transactions_select_own" on public.wallet_transactions
  for select using (auth.uid() = user_id);

create policy "payments_select_own" on public.payments
  for select using (auth.uid() = user_id);

create policy "orders_select_own" on public.orders
  for select using (auth.uid() = user_id);

create policy "discount_credits_select_own" on public.discount_credits
  for select using (auth.uid() = user_id);

grant select on public.wallets, public.wallet_transactions, public.payments, public.orders, public.discount_credits to authenticated;

-- ---------------------------------------------------------------------------
-- Rate-limit для платных анонимных эндпоинтов (см. lib/rateLimit.js) —
-- сейчас только api/analyze-item.js: он вызывает платный GigaChat и доступен
-- без входа в личный кабинет, поэтому без счётчика кто угодно мог бы дёргать
-- его напрямую и накручивать чужой счёт за внешний API. Ключ bucket уже
-- содержит хэш IP, здесь просто окно/счётчик по этому ключу.
-- ---------------------------------------------------------------------------

create table if not exists public.rate_limit_hits (
  id          bigserial primary key,
  bucket      text not null,
  created_at  timestamptz not null default now()
);

create index if not exists rate_limit_hits_bucket_created_idx
  on public.rate_limit_hits (bucket, created_at);

create or replace function public.check_rate_limit(
  p_bucket text,
  p_window_seconds int,
  p_max_hits int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from public.rate_limit_hits
    where bucket = p_bucket and created_at < now() - (p_window_seconds || ' seconds')::interval;

  select count(*) into v_count from public.rate_limit_hits where bucket = p_bucket;

  if v_count >= p_max_hits then
    return false;
  end if;

  insert into public.rate_limit_hits (bucket) values (p_bucket);
  return true;
end;
$$;

revoke execute on function public.check_rate_limit(text, int, int) from public;
grant execute on function public.check_rate_limit(text, int, int) to service_role;

alter table public.rate_limit_hits enable row level security;
-- Специально без select-политик: эту таблицу не должен читать никто, кроме
-- service_role через функцию выше — ни один пользователь не имеет к ней
-- прямого доступа, даже на чтение своих строк (тут таких и нет — bucket
-- обезличен и не привязан к конкретному аккаунту).

-- ---------------------------------------------------------------------------
-- Бесплатный первый образ — раньше учитывался только в браузере
-- (localStorage 'stil.styleCount' в js/wizard.js), что не даёт реального
-- учёта и легко обходится очисткой localStorage. Теперь один флаг на
-- кошельке + атомарная функция: UPDATE ... WHERE free_look_used = false
-- гарантирует, что даже два параллельных запроса от одного пользователя не
-- смогут оба получить бесплатный образ. См. lib/lookAccess.js.
-- ---------------------------------------------------------------------------

alter table public.wallets add column if not exists free_look_used boolean not null default false;

create or replace function public.consume_free_look(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_consumed boolean;
begin
  update public.wallets
    set free_look_used = true, updated_at = now()
    where user_id = p_user_id and free_look_used = false
    returning true into v_consumed;

  return coalesce(v_consumed, false);
end;
$$;

revoke execute on function public.consume_free_look(uuid) from public;
grant execute on function public.consume_free_look(uuid) to service_role;
