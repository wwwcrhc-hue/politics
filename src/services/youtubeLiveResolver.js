'use strict';

function numberEnv(value, fallback, min = 1) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function createYouTubeLiveResolver({ channelsRepository, env, logError }) {
  const apiKey = env.YOUTUBE_API_KEY || '';
  const ttlMs = numberEnv(env.YOUTUBE_LIVE_CACHE_TTL, 10 * 60 * 1000, 1000);
  const intervalMs = numberEnv(env.YOUTUBE_RESOLVER_INTERVAL, 5 * 60 * 1000, 5000);
  const batchSize = numberEnv(env.YOUTUBE_RESOLVER_BATCH_SIZE, 8, 1);
  const quotaBudget = numberEnv(env.YOUTUBE_QUOTA_BUDGET, 800, 1);
  let quotaUsed = 0;
  let timer = null;
  let running = false;

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`YouTube API failed: ${res.status}`);
    return res.json();
  }

  function manualResult(channel) {
    if (!channel.manual_video_id) return null;
    return {
      youtubeVideoId: channel.manual_video_id,
      title: channel.name || '',
      thumbnail: '',
      isLive: true,
      isEmbeddable: true,
      viewerCount: null,
      expiresAt: isoAfter(ttlMs),
      startedAt: null
    };
  }

  async function resolveChannel(channel) {
    const fallback = manualResult(channel);
    if (!apiKey || !channel.youtube_channel_id) {
      return fallback || {
        youtubeVideoId: '',
        title: '',
        thumbnail: '',
        isLive: false,
        isEmbeddable: true,
        viewerCount: null,
        expiresAt: isoAfter(ttlMs),
        startedAt: null
      };
    }
    if (quotaUsed >= quotaBudget) return fallback;
    quotaUsed += 100;
    const params = new URLSearchParams({
      part: 'id',
      channelId: channel.youtube_channel_id,
      eventType: 'live',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '1',
      key: apiKey
    });
    const search = await getJson(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const videoId = search.items?.[0]?.id?.videoId || '';
    if (!videoId) {
      return {
        youtubeVideoId: '',
        title: '',
        thumbnail: '',
        isLive: false,
        isEmbeddable: true,
        viewerCount: null,
        expiresAt: isoAfter(ttlMs * 2),
        startedAt: null
      };
    }
    quotaUsed += 1;
    const detailsParams = new URLSearchParams({
      part: 'snippet,liveStreamingDetails,status',
      id: videoId,
      key: apiKey
    });
    const details = await getJson(`https://www.googleapis.com/youtube/v3/videos?${detailsParams}`);
    const video = details.items?.[0] || {};
    const snippet = video.snippet || {};
    const live = video.liveStreamingDetails || {};
    const status = video.status || {};
    return {
      youtubeVideoId: videoId,
      title: snippet.title || '',
      thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || '',
      isLive: !!live.actualStartTime && !live.actualEndTime,
      isEmbeddable: status.embeddable !== false,
      viewerCount: live.concurrentViewers ? Number(live.concurrentViewers) : null,
      expiresAt: isoAfter(ttlMs),
      startedAt: live.actualStartTime || null
    };
  }

  async function resolveDueChannels() {
    if (running) return;
    running = true;
    try {
      const due = await channelsRepository.getChannelsDueForResolve(batchSize);
      for (const channel of due) {
        try {
          const result = await resolveChannel(channel);
          if (result) await channelsRepository.upsertLiveCache(channel.id, result);
        } catch (e) {
          logError(e, `youtube-live-resolve:${channel.id}`);
          await channelsRepository.upsertLiveCache(channel.id, {
            youtubeVideoId: '',
            title: '',
            thumbnail: '',
            isLive: false,
            isEmbeddable: true,
            viewerCount: null,
            expiresAt: isoAfter(ttlMs),
            startedAt: null
          });
        }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    resolveDueChannels().catch(e => logError(e, 'youtube-live-resolver-start'));
    timer = setInterval(() => resolveDueChannels().catch(e => logError(e, 'youtube-live-resolver')), intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, resolveDueChannels };
}

module.exports = { createYouTubeLiveResolver };
