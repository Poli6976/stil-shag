-- ---------------------------------------------------------------------------
-- 2026-10-18: профиль стиля и оценки образов (ТЗ v5, разделы 7 и 10).
-- Запустить ОДИН раз: Supabase → SQL Editor → вставить этот файл → Run.
-- Скрипт можно запускать повторно — он ничего не сломает (if not exists).
--
-- style_profiles — подсказки для полей «Рост и размер» и «Вещь» (до 5 последних),
--   прошлые ответы анкеты о внешности и стиле, согласие remember. Хранится только
--   при включённом согласии; выключение стирает данные (lib/styleProfile.js).
-- look_ratings — «Нравится / Не моё» с причинами; удаляется вместе с образом.
--
-- Как у saved_looks: RLS включён, политик для клиентов НЕТ — читать и писать
-- может только service_role (серверный код api/looks/saved.js). Из браузера
-- напрямую эти таблицы недоступны.
-- ---------------------------------------------------------------------------

create table if not exists public.style_profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  remember      boolean not null default false,
  answers       jsonb not null default '{}'::jsonb,
  fit_history   text[] not null default '{}',
  item_history  text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

alter table public.style_profiles enable row level security;

create table if not exists public.look_ratings (
  look_id     uuid primary key references public.saved_looks(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  rating      text not null check (rating in ('like', 'dislike')),
  reasons     text[] not null default '{}',
  comment     text check (comment is null or char_length(comment) <= 300),
  created_at  timestamptz not null default now()
);

create index if not exists look_ratings_user_idx on public.look_ratings (user_id);

alter table public.look_ratings enable row level security;

revoke all on public.style_profiles from anon, authenticated;
revoke all on public.look_ratings from anon, authenticated;
