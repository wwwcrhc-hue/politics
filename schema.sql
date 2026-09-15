-- Supabase/PostgreSQL schema for political-forums-app v5.

create table if not exists app_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  username text not null,
  display_name text not null,
  bio text not null default '',
  avatar_url text not null default '',
  password_hash text not null,
  role text not null default 'user',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint users_username_length check (char_length(username) between 3 and 24),
  constraint users_role_check check (role in ('user', 'admin', 'moderator')),
  constraint users_status_check check (status in ('active', 'suspended'))
);

alter table users
  add column if not exists status text not null default 'active';

alter table users
  add column if not exists avatar_url text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_status_check'
  ) then
    alter table users
      add constraint users_status_check check (status in ('active', 'suspended'));
  end if;
end $$;

create unique index if not exists users_username_lower_idx
  on users (lower(username));

create table if not exists rooms (
  id text primary key,
  name text not null,
  description text not null default '',
  owner_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table rooms
  add column if not exists owner_user_id text references users(id) on delete set null;

create index if not exists rooms_owner_created_idx
  on rooms (owner_user_id, created_at desc);

create table if not exists posts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  room_id text not null references rooms(id) on delete restrict,
  text text not null default '',
  media jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  constraint posts_text_or_media check (char_length(text) > 0 or jsonb_array_length(media) > 0)
);

create index if not exists posts_room_created_idx
  on posts (room_id, created_at desc);

create index if not exists posts_user_created_idx
  on posts (user_id, created_at desc);

create table if not exists comments (
  id text primary key,
  post_id text not null references posts(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  constraint comments_text_not_empty check (char_length(text) > 0)
);

create index if not exists comments_post_created_idx
  on comments (post_id, created_at asc);

create table if not exists likes (
  id text primary key,
  post_id text not null references posts(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint likes_post_user_unique unique (post_id, user_id)
);

create index if not exists likes_user_idx
  on likes (user_id);

create table if not exists follows (
  id text primary key,
  follower_id text not null references users(id) on delete cascade,
  following_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint follows_no_self_follow check (follower_id <> following_id),
  constraint follows_pair_unique unique (follower_id, following_id)
);

create index if not exists follows_following_idx
  on follows (following_id);

create table if not exists room_messages (
  id text primary key,
  room_id text not null references rooms(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  constraint room_messages_text_not_empty check (char_length(text) > 0)
);

create index if not exists room_messages_room_created_idx
  on room_messages (room_id, created_at desc);


create table if not exists reports (
  id text primary key,
  reporter_id text not null references users(id) on delete cascade,
  target_type text not null,
  target_id text not null,
  reason text not null default '',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  constraint reports_status_check check (status in ('open', 'reviewing', 'resolved', 'dismissed'))
);

create index if not exists reports_status_created_idx
  on reports (status, created_at desc);

insert into app_meta (key, value)
values ('schema', '{"version": 7}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

insert into rooms (id, name, description) values
  ('local', 'السياسة المحلية', 'نقاش الأخبار والقرارات والسياسات المحلية.'),
  ('gulf', 'سياسة الخليج', 'القضايا السياسية في دول مجلس التعاون الخليجي.'),
  ('arab', 'العالم العربي', 'حوارات سياسية حول الدول العربية.'),
  ('world', 'السياسة الدولية', 'العلاقات الدولية والتحولات العالمية.'),
  ('elections', 'الانتخابات', 'الانتخابات والبرامج والحملات والتحليلات.'),
  ('economy', 'الاقتصاد السياسي', 'السياسات الاقتصادية وأثرها على المجتمع.'),
  ('debates', 'المناظرات', 'مناظرات مباشرة وحجج مؤيدة ومعارضة.')
on conflict (id) do update
set name = excluded.name,
    description = excluded.description;

-- v9: room permissions and moderation (no audio/video recording)
alter table rooms add column if not exists status text not null default 'active';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='rooms_status_check') then
    alter table rooms add constraint rooms_status_check check (status in ('active','closed'));
  end if;
end $$;

create table if not exists room_members (
  id text primary key,
  room_id text not null references rooms(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint room_members_pair_unique unique(room_id,user_id),
  constraint room_members_role_check check (role in ('member','moderator')),
  constraint room_members_status_check check (status in ('active','banned'))
);
create index if not exists room_members_room_idx on room_members(room_id,created_at asc);
create index if not exists room_members_user_idx on room_members(user_id,created_at desc);


create table if not exists moderation_logs (
  id text primary key,
  actor_user_id text references users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text not null default '',
  room_id text references rooms(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists moderation_logs_created_idx on moderation_logs(created_at desc);
create index if not exists moderation_logs_room_idx on moderation_logs(room_id,created_at desc);

insert into app_meta (key,value) values ('schema','{"version":9}'::jsonb)
on conflict(key) do update set value=excluded.value,updated_at=now();
