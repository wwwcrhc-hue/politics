-- Schema updates for political-forums-app.
-- Run this after the original schema.sql on an existing database.

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


alter table rooms
  add column if not exists owner_user_id text references users(id) on delete set null;

create index if not exists rooms_owner_created_idx
  on rooms (owner_user_id, created_at desc);

insert into app_meta (key, value)
values ('schema', '{"version": 9}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

-- v9 permissions/moderation; recording system removed
alter table rooms add column if not exists status text not null default 'active';
create table if not exists room_members (
  id text primary key, room_id text not null references rooms(id) on delete cascade,
  user_id text not null references users(id) on delete cascade, role text not null default 'member',
  status text not null default 'active', created_at timestamptz not null default now(),
  unique(room_id,user_id)
);
create table if not exists moderation_logs (
  id text primary key, actor_user_id text references users(id) on delete set null,
  action text not null, target_type text not null, target_id text not null default '',
  room_id text references rooms(id) on delete set null, details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- v10 social graph, private message requests, direct messages, and notifications
create table if not exists message_requests (
  id text primary key,
  from_user_id text not null references users(id) on delete cascade,
  to_user_id text not null references users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_requests_no_self check (from_user_id <> to_user_id),
  constraint message_requests_status_check check (status in ('pending', 'accepted', 'rejected')),
  constraint message_requests_pair_unique unique (from_user_id, to_user_id)
);
create index if not exists message_requests_to_status_idx on message_requests(to_user_id,status,created_at desc);

create table if not exists direct_messages (
  id text primary key,
  from_user_id text not null references users(id) on delete cascade,
  to_user_id text not null references users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  constraint direct_messages_text_not_empty check (char_length(text) > 0),
  constraint direct_messages_no_self check (from_user_id <> to_user_id)
);
create index if not exists direct_messages_pair_created_idx on direct_messages(least(from_user_id,to_user_id),greatest(from_user_id,to_user_id),created_at desc);

create table if not exists notifications (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  actor_user_id text references users(id) on delete set null,
  type text not null,
  text text not null,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_created_idx on notifications(user_id,created_at desc);

insert into app_meta (key, value)
values ('schema', '{"version": 10}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
