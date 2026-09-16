'use strict';

function channelFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    nameLocal: row.name_local || '',
    nameEn: row.name_en || '',
    slug: row.slug,
    countryId: row.country_id,
    languageId: row.language_id,
    youtubeChannelId: row.youtube_channel_id || '',
    youtubeUrl: row.youtube_url || '',
    websiteUrl: row.website_url || '',
    logoUrl: row.logo_url || '',
    category: row.category || 'news',
    isOfficial: row.is_official !== false,
    isVerified: row.is_verified === true,
    isActive: row.is_active !== false,
    priority: Number(row.priority || 0),
    manualVideoId: row.manual_video_id || '',
    country: row.country_iso2 ? {
      id: row.country_id,
      iso2: row.country_iso2,
      iso3: row.country_iso3,
      nameAr: row.country_name_ar,
      nameEn: row.country_name_en,
      nameNative: row.country_name_native,
      region: row.country_region,
      flag: row.country_flag
    } : null,
    language: row.language_code ? {
      id: row.language_id,
      code: row.language_code,
      nameNative: row.language_name_native,
      nameAr: row.language_name_ar,
      nameEn: row.language_name_en,
      direction: row.language_direction
    } : null,
    live: row.youtube_video_id || row.cache_checked_at ? {
      youtubeVideoId: row.youtube_video_id || '',
      title: row.live_title || '',
      thumbnail: row.live_thumbnail || '',
      isLive: row.is_live === true,
      isEmbeddable: row.is_embeddable !== false,
      viewerCount: row.viewer_count === null || row.viewer_count === undefined ? null : Number(row.viewer_count),
      checkedAt: row.cache_checked_at,
      expiresAt: row.expires_at,
      startedAt: row.started_at
    } : null,
    followed: row.followed === true
  };
}

function createChannelsRepository({ pool }) {
  const channelSelect = `
    select ch.*,
      c.iso2 as country_iso2, c.iso3 as country_iso3, c.name_ar as country_name_ar,
      c.name_en as country_name_en, c.name_native as country_name_native, c.region as country_region, c.flag as country_flag,
      l.code as language_code, l.name_native as language_name_native, l.name_ar as language_name_ar,
      l.name_en as language_name_en, l.direction as language_direction,
      cache.youtube_video_id, cache.title as live_title, cache.thumbnail as live_thumbnail,
      cache.is_live, cache.is_embeddable, cache.viewer_count, cache.checked_at as cache_checked_at,
      cache.expires_at, cache.started_at
  `;

  const channelJoins = `
    from news_channels ch
    left join countries c on c.id = ch.country_id
    left join languages l on l.id = ch.language_id
    left join channel_live_cache cache on cache.channel_id = ch.id
  `;

  async function listMeta() {
    const [countries, languages, regions] = await Promise.all([
      pool.query('select * from countries where is_active = true order by region, name_en'),
      pool.query('select * from languages where is_active = true order by name_en'),
      pool.query('select distinct region from countries where is_active = true order by region')
    ]);
    return {
      regions: regions.rows.map(r => r.region).filter(Boolean),
      countries: countries.rows.map(r => ({
        id:r.id, iso2:r.iso2, iso3:r.iso3, nameAr:r.name_ar, nameEn:r.name_en,
        nameNative:r.name_native, region:r.region, flag:r.flag
      })),
      languages: languages.rows.map(r => ({
        id:r.id, code:r.code, nameNative:r.name_native, nameAr:r.name_ar,
        nameEn:r.name_en, direction:r.direction
      }))
    };
  }

  async function listChannels({ page = 1, limit = 30, region = '', country = '', language = '', live = '', search = '', userId = '' }) {
    const where = ['ch.is_active = true'];
    const values = [];
    function add(value) {
      values.push(value);
      return `$${values.length}`;
    }
    if (region) where.push(`c.region = ${add(region)}`);
    if (country) where.push(`(c.id = ${add(country)} or lower(c.iso2) = lower(${add(country)}))`);
    if (language) where.push(`(l.id = ${add(language)} or lower(l.code) = lower(${add(language)}))`);
    if (live === 'true' || live === '1') where.push('cache.is_live = true');
    if (search) {
      const p = add(`%${search}%`);
      where.push(`(
        ch.name ilike ${p} or ch.name_local ilike ${p} or ch.name_en ilike ${p}
        or c.name_ar ilike ${p} or c.name_en ilike ${p} or c.name_native ilike ${p}
        or l.name_ar ilike ${p} or l.name_en ilike ${p} or l.name_native ilike ${p}
      )`);
    }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 60));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;
    const countValues = values.slice();
    const followedJoin = userId ? `left join channel_follows cf on cf.channel_id = ch.id and cf.user_id = ${add(userId)}` : '';
    const followedSelect = userId ? ', (cf.user_id is not null) as followed' : ', false as followed';
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const count = await pool.query(`select count(*)::int as total ${channelJoins} ${whereSql}`, countValues);
    const { rows } = await pool.query(`
      ${channelSelect}${followedSelect}
      ${channelJoins}
      ${followedJoin}
      ${whereSql}
      order by coalesce(cache.is_live,false) desc, ch.priority desc, ch.name asc
      limit ${safeLimit} offset ${offset}
    `, values);
    return { page:safePage, limit:safeLimit, total:count.rows[0]?.total || 0, channels:rows.map(channelFromRow) };
  }

  async function liveChannels(limit = 12) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 30));
    const { rows } = await pool.query(`
      ${channelSelect}, false as followed
      ${channelJoins}
      where ch.is_active = true
        and (cache.is_live = true or ch.youtube_channel_id <> '' or ch.manual_video_id <> '')
      order by coalesce(cache.is_live,false) desc, coalesce(cache.viewer_count,0) desc, ch.priority desc, cache.checked_at desc nulls last
      limit $1
    `, [safeLimit]);
    return rows.map(channelFromRow);
  }

  async function getChannel(id) {
    const { rows } = await pool.query(`${channelSelect}, false as followed ${channelJoins} where ch.id = $1`, [id]);
    return channelFromRow(rows[0]);
  }

  async function getChannelsDueForResolve(limit = 10) {
    const { rows } = await pool.query(`
      select ch.*, cache.expires_at, cache.is_live
      from news_channels ch
      left join channel_live_cache cache on cache.channel_id = ch.id
      where ch.is_active = true
        and (ch.youtube_channel_id <> '' or ch.manual_video_id <> '')
        and (cache.expires_at is null or cache.expires_at <= now())
      order by ch.priority desc, coalesce(cache.is_live,false) desc, coalesce(cache.expires_at, timestamp 'epoch') asc
      limit $1
    `, [limit]);
    return rows;
  }

  async function upsertLiveCache(channelId, live) {
    await pool.query(`
      insert into channel_live_cache
        (channel_id, youtube_video_id, title, thumbnail, is_live, is_embeddable, viewer_count, checked_at, expires_at, started_at)
      values ($1,$2,$3,$4,$5,$6,$7,now(),$8,$9)
      on conflict (channel_id) do update set
        youtube_video_id = excluded.youtube_video_id,
        title = excluded.title,
        thumbnail = excluded.thumbnail,
        is_live = excluded.is_live,
        is_embeddable = excluded.is_embeddable,
        viewer_count = excluded.viewer_count,
        checked_at = excluded.checked_at,
        expires_at = excluded.expires_at,
        started_at = excluded.started_at
    `, [
      channelId, live.youtubeVideoId || '', live.title || '', live.thumbnail || '',
      live.isLive === true, live.isEmbeddable !== false, live.viewerCount ?? null,
      live.expiresAt, live.startedAt || null
    ]);
  }

  async function followChannel(userId, channelId) {
    await pool.query(
      'insert into channel_follows (user_id, channel_id, created_at) values ($1,$2,now()) on conflict (user_id, channel_id) do nothing',
      [userId, channelId]
    );
  }

  async function unfollowChannel(userId, channelId) {
    await pool.query('delete from channel_follows where user_id = $1 and channel_id = $2', [userId, channelId]);
  }

  return { listMeta, listChannels, liveChannels, getChannel, getChannelsDueForResolve, upsertLiveCache, followChannel, unfollowChannel };
}

module.exports = { createChannelsRepository };
