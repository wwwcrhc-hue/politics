'use strict';

const express = require('express');
const { createChannelsRepository } = require('../repositories/channelsRepository');

const officialLivePages = {
  skynewsarabia: 'https://www.skynewsarabia.com/livestream-%D8%A7%D9%84%D8%A8%D8%AB-%D8%A7%D9%84%D9%85%D8%A8%D8%A7%D8%B4%D8%B1'
};

function optionalUser(jwt, jwtSecret) {
  return (req, _res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token) {
      try { req.optionalUser = jwt.verify(token, jwtSecret); } catch {}
    }
    next();
  };
}

function createChannelsRouter(dependencies) {
  const { auth, requireActiveUser, cleanText, jwt, jwtSecret } = dependencies;
  const channelsRepository = createChannelsRepository(dependencies);
  const router = express.Router();
  const optionalAuth = optionalUser(jwt, jwtSecret);

  router.get('/channels/meta', async (_req, res, next) => {
    try { res.json(await channelsRepository.listMeta()); }
    catch (e) { next(e); }
  });

  router.get('/channels/live', async (req, res, next) => {
    try { res.json({ channels: await channelsRepository.liveChannels(req.query.limit) }); }
    catch (e) { next(e); }
  });

  router.get('/channels', optionalAuth, async (req, res, next) => {
    try {
      res.json(await channelsRepository.listChannels({
        page: req.query.page,
        limit: req.query.limit,
        region: cleanText(req.query.region, 80),
        country: cleanText(req.query.country, 40),
        language: cleanText(req.query.language, 40),
        live: cleanText(req.query.live, 8),
        search: cleanText(req.query.search, 80),
        userId: req.optionalUser?.id || ''
      }));
    } catch (e) { next(e); }
  });

  router.get('/channels/:id/player', async (req, res, next) => {
    try {
      const channel = await channelsRepository.getChannel(cleanText(req.params.id, 80));
      if (!channel || !channel.isActive) return res.status(404).json({ error: 'القناة غير موجودة' });
      const videoId = channel.live?.isLive && channel.live?.isEmbeddable ? channel.live.youtubeVideoId : channel.manualVideoId;
      const officialLivePage = officialLivePages[channel.id] || '';
      const channelLiveUrl = !videoId && channel.youtubeChannelId
        ? `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channel.youtubeChannelId)}&autoplay=1&playsinline=1`
        : '';
      const embedUrl = videoId
        ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&playsinline=1&enablejsapi=1`
        : officialLivePage || channelLiveUrl;
      res.json({
        channel,
        playable: !!embedUrl,
        playerType: videoId ? 'video' : officialLivePage ? 'official-page' : channelLiveUrl ? 'channel-live' : 'external',
        videoId: videoId || '',
        embedUrl,
        youtubeUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : channel.youtubeUrl,
        fallbackUrl: channel.youtubeUrl || channel.websiteUrl,
        reason: embedUrl ? '' : 'هذا البث غير متاح للمشاهدة داخل الموقع'
      });
    } catch (e) { next(e); }
  });

  router.post('/channels/:id/follow', auth, requireActiveUser, async (req, res, next) => {
    try {
      const id = cleanText(req.params.id, 80);
      if (!await channelsRepository.getChannel(id)) return res.status(404).json({ error: 'القناة غير موجودة' });
      await channelsRepository.followChannel(req.user.id, id);
      res.json({ ok:true, followed:true });
    } catch (e) { next(e); }
  });

  router.delete('/channels/:id/follow', auth, requireActiveUser, async (req, res, next) => {
    try {
      await channelsRepository.unfollowChannel(req.user.id, cleanText(req.params.id, 80));
      res.json({ ok:true, followed:false });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createChannelsRouter };
