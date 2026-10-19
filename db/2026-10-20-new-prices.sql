-- ---------------------------------------------------------------------------
-- 2026-10-20: новые цены (ТЗ «Новые цены» v8). Баланса (депозита) больше нет:
-- клиентка платит картой за конкретный заказ — образ (590 ₽, по коду партнёра
-- 370 ₽) или пакет (3 образа — 1 200 ₽, 5 образов — 1 850 ₽). Купленные пакетом
-- образы лежат «в запасе» (wallets.looks_in_stock).
--
-- Запустить ОДИН раз: Supabase → SQL Editor → вставить этот файл → Run.
-- Повторный запуск ничего не сломает (if not exists / create or replace).
--
-- Как и раньше, всё, что двигает деньги и образы, — только через функции ниже
-- (SECURITY DEFINER, EXECUTE только у service_role): каждая операция — одна
-- транзакция БД, user_id сервер берёт из проверенного JWT, а не из запроса.
-- Старые функции депозита (finalize_topup, debit_wallet_*) в базе остаются,
-- но код их больше не вызывает.
-- ---------------------------------------------------------------------------

-- Образы в запасе (купленные пакетом или вернувшиеся после сбоя сборки).
alter table public.wallets add column if not exists looks_in_stock integer not null default 0;
do $$ begin
  alter table public.wallets add constraint wallets_looks_in_stock_nonneg check (looks_in_stock >= 0);
exception when duplicate_object then null; end $$;

-- Заказ: статус, ответы анкеты (без фото), связь с оплатой и образом, пересборка.
-- Старые заказы (списания с депозита) считаются выполненными.
alter table public.orders add column if not exists status text not null default 'done';
alter table public.orders alter column status set default 'created';
do $$ begin
  alter table public.orders add constraint orders_status_check
    check (status in ('created', 'paid', 'done', 'returned', 'canceled'));
exception when duplicate_object then null; end $$;
alter table public.orders add column if not exists answers jsonb;
alter table public.orders add column if not exists payment_id uuid references public.payments(id);
alter table public.orders add column if not exists look_id uuid;
alter table public.orders add column if not exists rebuild_used boolean not null default false;
alter table public.orders add column if not exists done_at timestamptz;
-- Образ из запаса — заказ с ценой 0 (деньги прошли при покупке пакета).
alter table public.orders drop constraint if exists orders_price_kopecks_check;
do $$ begin
  alter table public.orders add constraint orders_price_kopecks_nonneg check (price_kopecks >= 0);
exception when duplicate_object then null; end $$;

alter table public.payments add column if not exists order_id uuid references public.orders(id);

-- ---------------------------------------------------------------------------
-- Заказ + ожидающий платёж одной транзакцией (api/payments/create.js).
-- Сумму и товар определяет сервер по прайсу lib/packages.js.
-- ---------------------------------------------------------------------------
create or replace function public.create_order_with_payment(
  p_user_id uuid,
  p_package_code text,
  p_price_kopecks bigint,
  p_answers jsonb,
  p_provider_payment_id text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_payment_id uuid;
begin
  insert into public.orders (user_id, package_code, price_kopecks, status, answers)
    values (p_user_id, p_package_code, p_price_kopecks, 'created', p_answers)
    returning id into v_order_id;

  insert into public.payments (user_id, provider, provider_payment_id, amount_kopecks, status, order_id)
    values (p_user_id, 'robokassa', p_provider_payment_id, p_price_kopecks, 'pending', v_order_id)
    returning id into v_payment_id;

  update public.orders set payment_id = v_payment_id where id = v_order_id;
  return v_order_id;
end;
$$;
revoke execute on function public.create_order_with_payment(uuid, text, bigint, jsonb, text) from public;
grant execute on function public.create_order_with_payment(uuid, text, bigint, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Подтверждённая оплата (api/payments/webhook.js, после проверки подписи).
-- Идемпотентно: повторное уведомление об уже обработанной оплате ничего не
-- меняет и возвращает 'already' — пакет не начислится дважды.
-- Образ → заказ «оплачен» (собирается в api/looks/charge.js); по коду партнёра
-- код погашается. Пакет → +3 / +5 образов в запас, заказ выполнен.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_order_payment(
  p_provider_payment_id text,
  p_out_sum_kopecks bigint
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment record;
  v_order record;
  v_looks integer;
  v_credit_id uuid;
begin
  select id, user_id, amount_kopecks, order_id, status into v_payment
    from public.payments
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

  update public.payments set status = 'succeeded', updated_at = now() where id = v_payment.id;

  select id, package_code into v_order from public.orders where id = v_payment.order_id for update;
  if not found then
    return 'no_order';
  end if;

  if v_order.package_code in ('PACK_3', 'PACK_5') then
    v_looks := case v_order.package_code when 'PACK_3' then 3 else 5 end;
    update public.wallets set looks_in_stock = looks_in_stock + v_looks, updated_at = now()
      where user_id = v_payment.user_id;
    update public.orders set status = 'done', done_at = now() where id = v_order.id;
  else
    update public.orders set status = 'paid' where id = v_order.id and status = 'created';
    if v_order.package_code = 'OBRAZ_PARTNER' then
      select id into v_credit_id from public.discount_credits
        where user_id = v_payment.user_id and status = 'available'
        order by created_at limit 1 for update;
      if found then
        update public.discount_credits set status = 'used', used_at = now(), order_id = v_order.id
          where id = v_credit_id;
      end if;
    end if;
  end if;

  return 'ok';
end;
$$;
revoke execute on function public.finalize_order_payment(text, bigint) from public;
grant execute on function public.finalize_order_payment(text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Занять право на сборку одного образа (api/looks/charge.js) — атомарно:
--   p_order_id задан → этот оплаченный и ещё не использованный заказ клиентки;
--   p_order_id пуст  → один образ из запаса (создаётся заказ STOCK_LOOK за 0 ₽).
-- Возвращает id заказа, к которому привязан образ (по нему — пересборка).
-- ---------------------------------------------------------------------------
create or replace function public.claim_look(p_user_id uuid, p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
begin
  if p_order_id is not null then
    update public.orders set status = 'done', done_at = now()
      where id = p_order_id and user_id = p_user_id and status = 'paid'
        and package_code in ('OBRAZ_PO_FOTO', 'OBRAZ_PARTNER')
      returning id into v_order_id;
    if not found then
      raise exception 'not_paid' using errcode = 'P0001';
    end if;
    return v_order_id;
  end if;

  update public.wallets set looks_in_stock = looks_in_stock - 1, updated_at = now()
    where user_id = p_user_id and looks_in_stock > 0;
  if not found then
    raise exception 'no_stock' using errcode = 'P0001';
  end if;
  insert into public.orders (user_id, package_code, price_kopecks, status, done_at)
    values (p_user_id, 'STOCK_LOOK', 0, 'done', now())
    returning id into v_order_id;
  return v_order_id;
end;
$$;
revoke execute on function public.claim_look(uuid, uuid) from public;
grant execute on function public.claim_look(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Образ не собрался после оплаты (сбой и повтор не помогли) — оплаченный образ
-- возвращается в запас, следующая попытка без оплаты. Только для только что
-- занятого заказа без сохранённого образа; повторный вызов ничего не делает.
-- ---------------------------------------------------------------------------
create or replace function public.return_look_to_stock(p_user_id uuid, p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders set status = 'returned'
    where id = p_order_id and user_id = p_user_id and status = 'done' and look_id is null
      and done_at > now() - interval '15 minutes';
  if not found then
    return false;
  end if;
  update public.wallets set looks_in_stock = looks_in_stock + 1, updated_at = now()
    where user_id = p_user_id;
  return true;
end;
$$;
revoke execute on function public.return_look_to_stock(uuid, uuid) from public;
grant execute on function public.return_look_to_stock(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Бесплатная пересборка (ТЗ, раздел 3): одна на оплаченный образ, только в
-- течение 30 минут после сборки. p_undo = true — вернуть право, если сама
-- пересборка не собралась.
-- ---------------------------------------------------------------------------
create or replace function public.use_rebuild(p_user_id uuid, p_order_id uuid, p_undo boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_undo then
    update public.orders set rebuild_used = false
      where id = p_order_id and user_id = p_user_id and rebuild_used;
    return found;
  end if;
  update public.orders set rebuild_used = true
    where id = p_order_id and user_id = p_user_id and status = 'done' and not rebuild_used
      and look_id is not null
      and done_at > now() - interval '30 minutes'
      and package_code in ('OBRAZ_PO_FOTO', 'OBRAZ_PARTNER', 'STOCK_LOOK');
  return found;
end;
$$;
revoke execute on function public.use_rebuild(uuid, uuid, boolean) from public;
grant execute on function public.use_rebuild(uuid, uuid, boolean) to service_role;
