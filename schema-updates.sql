-- Schema updates for political-forums-app.
-- Run this after the original schema.sql on an existing database.

alter table users
  add column if not exists status text not null default 'active';

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
