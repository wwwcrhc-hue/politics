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

create table if not exists live_recordings (
  id text primary key,
  room_id text not null references rooms(id) on delete cascade,
  host_user_id text not null references users(id) on delete cascade,
  url text not null,
  mime text not null,
  size_bytes bigint not null default 0,
  duration_ms integer not null default 0,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists live_recordings_created_idx
  on live_recordings (created_at desc);

create index if not exists live_recordings_room_created_idx
  on live_recordings (room_id, created_at desc);

alter table rooms
  add column if not exists owner_user_id text references users(id) on delete set null;

create index if not exists rooms_owner_created_idx
  on rooms (owner_user_id, created_at desc);

insert into app_meta (key, value)
values ('schema', '{"version": 7}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();
