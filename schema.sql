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

create index if not exists message_requests_to_status_idx
  on message_requests (to_user_id, status, created_at desc);

create table if not exists direct_messages (
  id text primary key,
  from_user_id text not null references users(id) on delete cascade,
  to_user_id text not null references users(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now(),
  constraint direct_messages_text_not_empty check (char_length(text) > 0),
  constraint direct_messages_no_self check (from_user_id <> to_user_id)
);

create index if not exists direct_messages_pair_created_idx
  on direct_messages (least(from_user_id, to_user_id), greatest(from_user_id, to_user_id), created_at desc);

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

create index if not exists notifications_user_created_idx
  on notifications (user_id, created_at desc);

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
values ('schema', '{"version": 10}'::jsonb)
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

insert into rooms (id, name, description) values
  ('local', 'الساحة العامة', 'نقاشات يومية ومواضيع مفتوحة للمجتمع.'),
  ('gulf', 'مجلس الخليج', 'حوارات عامة حول شؤون الخليج والمجتمع.'),
  ('arab', 'العالم العربي', 'نقاشات عامة حول اهتمامات المنطقة العربية.'),
  ('world', 'العالم', 'حوارات عالمية وموضوعات من مختلف الدول.'),
  ('elections', 'الفعاليات', 'متابعة الفعاليات والمناسبات والبرامج العامة.'),
  ('economy', 'الأعمال والاقتصاد', 'نقاشات الأعمال والأسواق والحياة الاقتصادية.'),
  ('debates', 'المناظرات والحوار', 'حوارات مباشرة وآراء متعددة حول مختلف المواضيع.')
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

-- v11: global official news channel directory and YouTube live cache.
create table if not exists countries (
  id text primary key,
  iso2 text not null unique,
  iso3 text not null unique,
  name_ar text not null,
  name_en text not null,
  name_native text not null default '',
  region text not null,
  flag text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists countries_region_idx on countries(region, name_en);

create table if not exists languages (
  id text primary key,
  code text not null unique,
  name_native text not null,
  name_ar text not null,
  name_en text not null,
  direction text not null default 'ltr',
  is_active boolean not null default true,
  constraint languages_direction_check check (direction in ('rtl','ltr'))
);

create table if not exists news_channels (
  id text primary key,
  name text not null,
  name_local text not null default '',
  name_en text not null default '',
  slug text not null unique,
  country_id text references countries(id) on delete set null,
  language_id text references languages(id) on delete set null,
  youtube_channel_id text not null default '',
  youtube_url text not null default '',
  website_url text not null default '',
  logo_url text not null default '',
  category text not null default 'news',
  is_official boolean not null default true,
  is_verified boolean not null default false,
  is_active boolean not null default true,
  priority int not null default 0,
  manual_video_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists news_channels_country_idx on news_channels(country_id, priority desc);
create index if not exists news_channels_language_idx on news_channels(language_id, priority desc);
create index if not exists news_channels_active_priority_idx on news_channels(is_active, priority desc);

create table if not exists channel_live_cache (
  channel_id text primary key references news_channels(id) on delete cascade,
  youtube_video_id text not null default '',
  title text not null default '',
  thumbnail text not null default '',
  is_live boolean not null default false,
  is_embeddable boolean not null default true,
  viewer_count bigint,
  checked_at timestamptz not null default now(),
  expires_at timestamptz not null default now(),
  started_at timestamptz
);
create index if not exists channel_live_cache_live_idx on channel_live_cache(is_live, viewer_count desc, checked_at desc);
create index if not exists channel_live_cache_expires_idx on channel_live_cache(expires_at);

create table if not exists channel_follows (
  user_id text not null references users(id) on delete cascade,
  channel_id text not null references news_channels(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id, channel_id)
);
create index if not exists channel_follows_channel_idx on channel_follows(channel_id, created_at desc);

alter table rooms add column if not exists source_channel_id text references news_channels(id) on delete set null;
alter table rooms add column if not exists source_youtube_video_id text not null default '';
create index if not exists rooms_source_channel_idx on rooms(source_channel_id, created_at desc);

insert into countries (id, iso2, iso3, name_ar, name_en, name_native, region, flag) values
  ('world', 'WW', 'WWW', 'عالمي', 'World', 'World', 'دولي', '🌐'),
  ('qa', 'QA', 'QAT', 'قطر', 'Qatar', 'قطر', 'الشرق الأوسط', '🇶🇦'),
  ('sa', 'SA', 'SAU', 'السعودية', 'Saudi Arabia', 'السعودية', 'الشرق الأوسط', '🇸🇦'),
  ('ae', 'AE', 'ARE', 'الإمارات', 'United Arab Emirates', 'الإمارات', 'الشرق الأوسط', '🇦🇪'),
  ('gb', 'GB', 'GBR', 'المملكة المتحدة', 'United Kingdom', 'United Kingdom', 'أوروبا', '🇬🇧'),
  ('fr', 'FR', 'FRA', 'فرنسا', 'France', 'France', 'أوروبا', '🇫🇷'),
  ('de', 'DE', 'DEU', 'ألمانيا', 'Germany', 'Deutschland', 'أوروبا', '🇩🇪'),
  ('tr', 'TR', 'TUR', 'تركيا', 'Turkey', 'Türkiye', 'آسيا', '🇹🇷'),
  ('us', 'US', 'USA', 'الولايات المتحدة', 'United States', 'United States', 'أمريكا الشمالية', '🇺🇸'),
  ('jp', 'JP', 'JPN', 'اليابان', 'Japan', '日本', 'آسيا', '🇯🇵'),
  ('in', 'IN', 'IND', 'الهند', 'India', 'भारत', 'آسيا', '🇮🇳'),
  ('cn', 'CN', 'CHN', 'الصين', 'China', '中国', 'آسيا', '🇨🇳'),
  ('kr', 'KR', 'KOR', 'كوريا الجنوبية', 'South Korea', '대한민국', 'آسيا', '🇰🇷'),
  ('au', 'AU', 'AUS', 'أستراليا', 'Australia', 'Australia', 'أوقيانوسيا', '🇦🇺')
on conflict (id) do update set
  iso2=excluded.iso2, iso3=excluded.iso3, name_ar=excluded.name_ar, name_en=excluded.name_en,
  name_native=excluded.name_native, region=excluded.region, flag=excluded.flag, updated_at=now();

insert into languages (id, code, name_native, name_ar, name_en, direction) values
  ('ar', 'ar', 'العربية', 'العربية', 'Arabic', 'rtl'),
  ('en', 'en', 'English', 'الإنجليزية', 'English', 'ltr'),
  ('fr', 'fr', 'Français', 'الفرنسية', 'French', 'ltr'),
  ('de', 'de', 'Deutsch', 'الألمانية', 'German', 'ltr'),
  ('tr', 'tr', 'Türkçe', 'التركية', 'Turkish', 'ltr'),
  ('ja', 'ja', '日本語', 'اليابانية', 'Japanese', 'ltr'),
  ('hi', 'hi', 'हिन्दी', 'الهندية', 'Hindi', 'ltr'),
  ('zh', 'zh', '中文', 'الصينية', 'Chinese', 'ltr'),
  ('ko', 'ko', '한국어', 'الكورية', 'Korean', 'ltr')
on conflict (id) do update set
  code=excluded.code, name_native=excluded.name_native, name_ar=excluded.name_ar,
  name_en=excluded.name_en, direction=excluded.direction;

insert into news_channels (id, name, name_local, name_en, slug, country_id, language_id, youtube_url, website_url, category, is_official, is_verified, priority) values
  ('aljazeera-ar', 'الجزيرة', 'الجزيرة', 'Al Jazeera Arabic', 'aljazeera-ar', 'qa', 'ar', 'https://www.youtube.com/@aljazeera', 'https://www.aljazeera.net', 'news', true, false, 95),
  ('aljazeera-mubasher', 'الجزيرة مباشر', 'الجزيرة مباشر', 'Al Jazeera Mubasher', 'aljazeera-mubasher', 'qa', 'ar', 'https://www.youtube.com/@ajmubasher', 'https://mubasher.aljazeera.net', 'news', true, false, 94),
  ('alarabiya', 'العربية', 'العربية', 'Al Arabiya', 'alarabiya', 'ae', 'ar', 'https://www.youtube.com/@AlArabiya', 'https://www.alarabiya.net', 'news', true, false, 93),
  ('alhadath', 'الحدث', 'الحدث', 'Al Hadath', 'alhadath', 'ae', 'ar', 'https://www.youtube.com/@AlHadath', 'https://www.alhadath.net', 'news', true, false, 92),
  ('saudi-ekhbariya', 'الإخبارية السعودية', 'الإخبارية', 'Saudi Al Ekhbariya', 'saudi-ekhbariya', 'sa', 'ar', '', 'https://www.alekhbariya.net', 'news', true, false, 88),
  ('skynewsarabia', 'سكاي نيوز عربية', 'سكاي نيوز عربية', 'Sky News Arabia', 'skynewsarabia', 'ae', 'ar', 'https://www.youtube.com/@skynewsarabia', 'https://www.skynewsarabia.com', 'news', true, false, 87),
  ('bbc-arabic', 'BBC News عربي', 'BBC News عربي', 'BBC Arabic', 'bbc-arabic', 'gb', 'ar', 'https://www.youtube.com/@BBCArabic', 'https://www.bbc.com/arabic', 'news', true, false, 86),
  ('france24-ar', 'France 24 عربي', 'فرانس 24 عربي', 'France 24 Arabic', 'france24-ar', 'fr', 'ar', 'https://www.youtube.com/@France24_ar', 'https://www.france24.com/ar', 'news', true, false, 85),
  ('dw-ar', 'DW عربية', 'DW عربية', 'DW Arabic', 'dw-ar', 'de', 'ar', 'https://www.youtube.com/@dw_arabic', 'https://www.dw.com/ar', 'news', true, false, 84),
  ('trt-arabi', 'TRT عربي', 'TRT عربي', 'TRT Arabic', 'trt-arabi', 'tr', 'ar', 'https://www.youtube.com/@TRTArabi', 'https://www.trtarabi.com', 'news', true, false, 83),
  ('bbc-news', 'BBC News', 'BBC News', 'BBC News', 'bbc-news', 'gb', 'en', 'https://www.youtube.com/@BBCNews', 'https://www.bbc.com/news', 'news', true, false, 92),
  ('cnn', 'CNN', 'CNN', 'CNN', 'cnn', 'us', 'en', 'https://www.youtube.com/@CNN', 'https://www.cnn.com', 'news', true, false, 90),
  ('reuters', 'Reuters', 'Reuters', 'Reuters', 'reuters', 'gb', 'en', 'https://www.youtube.com/@Reuters', 'https://www.reuters.com', 'news', true, false, 89),
  ('france24-en', 'France 24 English', 'France 24 English', 'France 24 English', 'france24-en', 'fr', 'en', 'https://www.youtube.com/@France24_en', 'https://www.france24.com/en', 'news', true, false, 86),
  ('dw-news', 'DW News', 'DW News', 'DW News', 'dw-news', 'de', 'en', 'https://www.youtube.com/@dwnews', 'https://www.dw.com', 'news', true, false, 85),
  ('trt-world', 'TRT World', 'TRT World', 'TRT World', 'trt-world', 'tr', 'en', 'https://www.youtube.com/@TRTWorld', 'https://www.trtworld.com', 'news', true, false, 84),
  ('nhk-world', 'NHK World', 'NHK World', 'NHK World', 'nhk-world', 'jp', 'en', 'https://www.youtube.com/@NHKWORLDJAPAN', 'https://www3.nhk.or.jp/nhkworld', 'news', true, false, 83),
  ('abc-australia', 'ABC Australia', 'ABC Australia', 'ABC Australia', 'abc-australia', 'au', 'en', 'https://www.youtube.com/@abcnewsaustralia', 'https://www.abc.net.au/news', 'news', true, false, 82)
on conflict (id) do update set
  name=excluded.name, name_local=excluded.name_local, name_en=excluded.name_en,
  country_id=excluded.country_id, language_id=excluded.language_id, youtube_url=excluded.youtube_url,
  website_url=excluded.website_url, category=excluded.category, is_official=excluded.is_official,
  priority=excluded.priority, updated_at=now();

insert into news_channels (id, name, name_local, name_en, slug, country_id, language_id, youtube_channel_id, youtube_url, website_url, logo_url, category, is_official, is_verified, priority, manual_video_id) values
  ('aljazeera-en', 'Al Jazeera English', 'Al Jazeera English', 'Al Jazeera English', 'aljazeera-en', 'qa', 'en', 'UCNye-wNBqNL5ZzHSJj3l8Bg', 'https://www.youtube.com/@aljazeeraenglish', 'https://www.aljazeera.com', 'https://www.google.com/s2/favicons?domain=aljazeera.com&sz=128', 'news', true, true, 91, ''),
  ('france24-ar', 'France 24 عربي', 'فرانس 24 عربي', 'France 24 Arabic', 'france24-ar', 'fr', 'ar', 'UCdTyuXgmJkG_O8_75eqej-w', 'https://www.youtube.com/@FRANCE24Arabic', 'https://www.france24.com/ar', 'https://www.google.com/s2/favicons?domain=france24.com&sz=128', 'news', true, true, 85, '5FgLgl0MmGA')
on conflict (id) do update set
  youtube_channel_id=excluded.youtube_channel_id, youtube_url=excluded.youtube_url,
  website_url=excluded.website_url, logo_url=excluded.logo_url, is_verified=excluded.is_verified,
  priority=excluded.priority, manual_video_id=excluded.manual_video_id, updated_at=now();

update news_channels set youtube_channel_id='UCfiwzLy-8yKzIbsmZTzxDgw', logo_url='https://www.google.com/s2/favicons?domain=aljazeera.net&sz=128', is_verified=true, manual_video_id='N8xxOD0nT1Y' where id='aljazeera-ar';
update news_channels set youtube_channel_id='UCCv1Pd24oPErw5S7zJWltnQ', logo_url='https://www.google.com/s2/favicons?domain=aljazeeramubasher.net&sz=128', is_verified=true where id='aljazeera-mubasher';
update news_channels set youtube_channel_id='UCahpxixMCwoANAftn6IxkTg', logo_url='https://www.google.com/s2/favicons?domain=alarabiya.net&sz=128', is_verified=true, manual_video_id='n7eQejkXbnM' where id='alarabiya';
update news_channels set youtube_channel_id='UCrj5BGAhtWxDfqbza9T9hqA', logo_url='https://www.google.com/s2/favicons?domain=alhadath.net&sz=128', is_verified=true, manual_video_id='2YkEX2Z8Vds' where id='alhadath';
update news_channels set youtube_channel_id='UCV01ajGl6nt09h40iDoHDNg', logo_url='https://www.google.com/s2/favicons?domain=alekhbariya.net&sz=128', is_verified=true where id='saudi-ekhbariya';
update news_channels set youtube_channel_id='UCIJXOvggjKtCagMfxvcCzAA', logo_url='https://www.google.com/s2/favicons?domain=skynewsarabia.com&sz=128', is_verified=true where id='skynewsarabia';
update news_channels set logo_url='https://www.google.com/s2/favicons?domain=bbc.com&sz=128' where id='bbc-arabic';
update news_channels set youtube_channel_id='UC30ditU5JI16o5NbFsHde_Q', logo_url='https://www.google.com/s2/favicons?domain=dw.com&sz=128', is_verified=true where id='dw-ar';
update news_channels set youtube_channel_id='UC5GvVahlgulCyo4cshSmbcg', logo_url='https://www.google.com/s2/favicons?domain=trtarabi.com&sz=128', is_verified=true where id='trt-arabi';
update news_channels set youtube_channel_id='UC16niRr50-MSBwiO3YDb3RA', logo_url='https://www.google.com/s2/favicons?domain=bbc.com&sz=128', is_verified=true where id='bbc-news';
update news_channels set youtube_channel_id='UCupvZG-5ko_eiXAupbDfxWw', logo_url='https://www.google.com/s2/favicons?domain=cnn.com&sz=128', is_verified=true where id='cnn';
update news_channels set youtube_channel_id='UChqUTb7kYRX8-EiaN3XFrSQ', logo_url='https://www.google.com/s2/favicons?domain=reuters.com&sz=128', is_verified=true where id='reuters';
update news_channels set youtube_channel_id='UCQfwfsi5VrQ8yKZ-UWmAEFg', logo_url='https://www.google.com/s2/favicons?domain=france24.com&sz=128', is_verified=true, manual_video_id='9c_Bac-17Rk' where id='france24-en';
update news_channels set youtube_channel_id='UCknLrEdhRCp1aegoMqRaCZg', logo_url='https://www.google.com/s2/favicons?domain=dw.com&sz=128', is_verified=true where id='dw-news';
update news_channels set youtube_channel_id='UC7fWeaHhqgM4Ry-RMpM2YYw', logo_url='https://www.google.com/s2/favicons?domain=trtworld.com&sz=128', is_verified=true where id='trt-world';
update news_channels set youtube_channel_id='UCSPEjw8F2nQDtmUKPFNF7_A', logo_url='https://www.google.com/s2/favicons?domain=www3.nhk.or.jp&sz=128', is_verified=true, manual_video_id='IimtbuqYIE8' where id='nhk-world';
update news_channels set youtube_channel_id='UCVgO39Bk5sMo66-6o6Spn6Q', logo_url='https://www.google.com/s2/favicons?domain=abc.net.au&sz=128', is_verified=true, manual_video_id='vOTiJkg1voo' where id='abc-australia';

insert into app_meta (key,value) values ('schema','{"version":11}'::jsonb)
on conflict(key) do update set value=excluded.value,updated_at=now();
