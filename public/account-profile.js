'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const requestedUserId = params.get('user');
  let token = localStorage.getItem('token') || '';
  let me = null;
  let profile = null;
  let isOwner = false;
  let isFollowing = false;
  let currentPosts = [];
  let totalPosts = null;

  const formatDate = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ar-AE', { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const text = (element, value) => { element.textContent = String(value ?? ''); };
  const safeMediaUrl = value => {
    const input = String(value || '');
    if (input.startsWith('/') && !input.startsWith('//') && !input.includes('\\')) return input;
    try {
      const url = new URL(input);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch { return ''; }
  };

  function showStatus(message, error = false) {
    const box = $('profileStatus');
    box.textContent = message;
    box.dataset.error = error ? 'true' : 'false';
    box.hidden = !message;
  }

  function showMessage(id, message, kind = 'error') {
    const box = $(id);
    box.textContent = message;
    box.dataset.kind = kind;
    box.hidden = !message;
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `تعذر إتمام الطلب (${response.status})`);
    return data;
  }

  function create(tag, className = '', content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) text(element, content);
    return element;
  }

  function fillAvatar(user) {
    const container = $('heroAvatar');
    container.replaceChildren();
    const url = safeMediaUrl(user.avatarUrl);
    if (url) {
      const image = create('img');
      image.src = url;
      image.alt = `صورة ${user.displayName || user.username || 'الشاعر'}`;
      image.addEventListener('error', () => { container.replaceChildren(create('span', '', (user.displayName || user.username || 'ش').slice(0, 1))); }, { once: true });
      container.appendChild(image);
    } else {
      container.appendChild(create('span', '', (user.displayName || user.username || 'ش').slice(0, 1)));
    }
  }

  function renderProfile(user) {
    profile = user;
    isOwner = !!me && me.id === user.id;
    text($('breadcrumbName'), user.displayName || user.username);
    text($('heroName'), user.displayName || user.username);
    text($('heroUsername'), `@${user.username}`);
    text($('heroBio'), user.bio || 'لم يكتب الشاعر نبذة عن نفسه بعد.');
    text($('ownerTag'), isOwner ? 'ملفي الشخصي' : 'صفحة الشاعر');
    text($('joinedValue'), formatDate(user.createdAt));
    document.title = `${user.displayName || user.username} | ديوان الشعراء`;
    fillAvatar(user);

    const meta = $('heroMeta');
    meta.replaceChildren();
    if (user.city) meta.appendChild(create('span', 'meta-pill', `⌖ ${user.city}`));
    if (user.website) {
      const href = safeMediaUrl(user.website);
      if (href) {
        const link = create('a', 'meta-pill profile-web-link', '↗ رابط الشاعر');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer nofollow';
        meta.appendChild(link);
      }
    }
    $('avatarEditLabel').hidden = !isOwner;
    document.querySelectorAll('.owner-only').forEach(element => { element.hidden = !isOwner; });
    $('followButton').hidden = isOwner;
    if (isOwner) populateEditForm();
    $('profileHero').hidden = false;
    $('profileContent').hidden = false;
    showStatus('');
  }

  function populateEditForm() {
    if (!profile || !isOwner) return;
    $('editDisplayName').value = profile.displayName || '';
    $('editUsername').value = profile.username || '';
    $('editCity').value = profile.city || '';
    $('editWebsite').value = profile.website || '';
    $('editBio').value = profile.bio || '';
    $('usernameCurrentPassword').value = '';
    $('bioLength').textContent = String($('editBio').value.length);
    updateUsernamePasswordField();
  }

  function updateUsernamePasswordField() {
    const changed = isOwner && profile && $('editUsername').value.trim() !== profile.username;
    $('usernamePasswordField').hidden = !changed;
    $('usernameCurrentPassword').required = !!changed;
  }

  function makePoemCard(post) {
    const card = create('article', 'poem-card');
    const header = create('div', 'poem-card-header');
    const room = create('a', 'poem-room', '✒ قصيدة من المجالس');
    room.href = `/?room=${encodeURIComponent(post.roomId || '')}`;
    header.appendChild(room);
    header.appendChild(create('time', 'poem-date', formatDate(post.createdAt)));
    card.appendChild(header);
    if (post.text) {
      const poemText = create('p', 'poem-text', post.text);
      poemText.dir = 'auto';
      card.appendChild(poemText);
    }
    const mediaList = Array.isArray(post.media) ? post.media.slice(0, 4) : [];
    if (mediaList.length) {
      const mediaWrap = create('div', 'poem-media');
      for (const media of mediaList) {
        const url = safeMediaUrl(typeof media === 'string' ? media : media?.url);
        if (!url) continue;
        const mediaType = String(media?.type || media?.mime || '');
        const isVideo = mediaType.includes('video') || /\.(mp4|webm|mov)(?:$|\?)/i.test(url);
        if (isVideo) {
          const video = create('video');
          video.src = url;
          video.controls = true;
          video.preload = 'none';
          video.playsInline = true;
          mediaWrap.appendChild(video);
        } else {
          const image = create('img');
          image.src = url;
          image.alt = 'صورة مرفقة بالقصيدة';
          image.loading = 'lazy';
          mediaWrap.appendChild(image);
        }
      }
      if (mediaWrap.childElementCount) card.appendChild(mediaWrap);
    }
    const footer = create('div', 'poem-card-footer');
    footer.appendChild(create('span', '', `♡ ${Number(post.likes || 0)} إعجاب`));
    footer.appendChild(create('span', '', `◌ ${Number(post.comments || 0)} تعليق`));
    card.appendChild(footer);
    return card;
  }

  function renderPosts(posts) {
    const list = $('poemsList');
    list.replaceChildren();
    text($('postsCount'), Number(totalPosts === null ? posts.length : totalPosts).toLocaleString('ar-AE'));
    if (!posts.length) {
      const empty = create('div', 'profile-empty');
      empty.appendChild(create('span', 'empty-ornament', '✒'));
      empty.appendChild(create('h3', '', 'ما زال الديوان ينتظر أول قصيدة'));
      empty.appendChild(create('p', '', 'لم تُنشر مشاركات شعرية في هذا الحساب بعد.'));
      if (isOwner) {
        const link = create('a', 'account-primary', 'اذهب لكتابة قصيدتك');
        link.href = '/';
        empty.appendChild(link);
      }
      list.appendChild(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    posts.forEach(post => fragment.appendChild(makePoemCard(post)));
    list.appendChild(fragment);
  }

  async function refreshStats() {
    if (!profile) return;
    try {
      const stats = await api(`/api/users/${encodeURIComponent(profile.id)}/stats`);
      text($('followersCount'), Number(stats.followers || 0).toLocaleString('ar-AE'));
      text($('followingCount'), Number(stats.following || 0).toLocaleString('ar-AE'));
      totalPosts = Number(stats.posts || 0);
      text($('postsCount'), totalPosts.toLocaleString('ar-AE'));
    } catch {
      text($('followersCount'), '—');
      text($('followingCount'), '—');
    }
    if (!isOwner && token) {
      try {
        const social = await api(`/api/users/${encodeURIComponent(profile.id)}/social`);
        isFollowing = !!social.following;
        text($('followButton'), isFollowing ? '✓ إلغاء المتابعة' : '+ متابعة الشاعر');
      } catch {
        text($('followButton'), '+ متابعة الشاعر');
      }
    } else if (!isOwner) {
      text($('followButton'), '+ متابعة الشاعر');
    }
  }

  async function init() {
    try {
      if (token) {
        try { me = await api('/api/me'); }
        catch { me = null; token = ''; localStorage.removeItem('token'); }
      }
      $('profileLoginLink').hidden = !!me;
      $('myProfileLink').hidden = !me;
      $('logoutButton').hidden = !me;
      $('adminLink').hidden = me?.role !== 'admin';
      const userId = requestedUserId || me?.id;
      if (!userId) {
        location.replace(`/login?next=${encodeURIComponent('/profile')}`);
        return;
      }
      const user = requestedUserId ? await api(`/api/users/${encodeURIComponent(userId)}/profile`) : me;
      renderProfile(user);
      const [postsResult] = await Promise.allSettled([
        api(`/api/users/${encodeURIComponent(userId)}/posts`),
        refreshStats()
      ]);
      if (postsResult.status === 'fulfilled' && Array.isArray(postsResult.value)) {
        currentPosts = postsResult.value;
        renderPosts(currentPosts);
      } else {
        $('poemsList').replaceChildren(create('div', 'profile-empty', 'تعذر تحميل القصائد الآن. حدّث الصفحة للمحاولة مجددًا.'));
      }
    } catch (error) {
      showStatus(error.message || 'تعذر تحميل الملف الشخصي.', true);
    }
  }

  $('editBio').addEventListener('input', () => { $('bioLength').textContent = String($('editBio').value.length); });
  $('editUsername').addEventListener('input', updateUsernamePasswordField);
  $('resetProfileButton').addEventListener('click', () => { populateEditForm(); showMessage('editMessage', ''); });

  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!isOwner || !profile) return;
    showMessage('editMessage', '');
    const username = $('editUsername').value.trim();
    const displayName = $('editDisplayName').value.trim();
    if (!/^[A-Za-z0-9_\u0600-\u06FF]{3,24}$/.test(username)) return showMessage('editMessage', 'اسم المستخدم بين 3 و24 حرفًا وبلا مسافات أو رموز خاصة.');
    if (!displayName) return showMessage('editMessage', 'الاسم الظاهر لا يمكن أن يكون فارغًا.');
    if (username !== profile.username && !$('usernameCurrentPassword').value) return showMessage('editMessage', 'أدخل كلمة المرور الحالية لتغيير اسم المستخدم.');
    const button = $('saveProfileButton');
    button.disabled = true;
    button.textContent = 'جارٍ الحفظ...';
    try {
      const body = { username, displayName, bio: $('editBio').value, city: $('editCity').value, website: $('editWebsite').value };
      if (username !== profile.username) body.currentPassword = $('usernameCurrentPassword').value;
      me = await api('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
      renderProfile(me);
      showMessage('editMessage', 'تم تحديث ملفك الشخصي بنجاح.', 'success');
    } catch (error) { showMessage('editMessage', error.message); }
    finally { button.disabled = false; button.textContent = 'حفظ التغييرات'; }
  });

  $('passwordForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!isOwner) return;
    showMessage('passwordMessage', '');
    const currentPassword = $('currentPasswordInput').value;
    const newPassword = $('newPasswordInput').value;
    const confirmation = $('confirmNewPasswordInput').value;
    if (!currentPassword) return showMessage('passwordMessage', 'أدخل كلمة المرور الحالية.');
    if (newPassword.length < 8 || newPassword.length > 128) return showMessage('passwordMessage', 'كلمة المرور الجديدة يجب أن تكون بين 8 و128 حرفًا.');
    if (newPassword !== confirmation) return showMessage('passwordMessage', 'كلمتا المرور الجديدتان غير متطابقتين.');
    if (currentPassword === newPassword) return showMessage('passwordMessage', 'اختر كلمة مرور جديدة تختلف عن الحالية.');
    const button = $('savePasswordButton');
    button.disabled = true;
    button.textContent = 'جارٍ التحديث...';
    try {
      await api('/api/me', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) });
      $('passwordForm').reset();
      showMessage('passwordMessage', 'تم تغيير كلمة المرور بنجاح. استخدم الكلمة الجديدة عند تسجيل الدخول مجددًا.', 'success');
    } catch (error) { showMessage('passwordMessage', error.message); }
    finally { button.disabled = false; button.textContent = 'تحديث كلمة المرور'; }
  });

  $('avatarFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file || !isOwner) return;
    if (!file.type.startsWith('image/')) { showStatus('اختر ملف صورة فقط.', true); event.target.value = ''; return; }
    if (file.size > 5 * 1024 * 1024) { showStatus('حجم الصورة يجب ألا يتجاوز 5 ميغابايت.', true); event.target.value = ''; return; }
    showStatus('جارٍ تحديث صورة البروفايل...');
    try {
      const body = new FormData();
      body.append('avatar', file);
      me = await api('/api/me/avatar', { method: 'POST', body });
      renderProfile(me);
      showStatus('تم تحديث صورة البروفايل.', false);
      setTimeout(() => { if ($('profileStatus').textContent === 'تم تحديث صورة البروفايل.') showStatus(''); }, 3000);
    } catch (error) { showStatus(error.message, true); }
    finally { event.target.value = ''; }
  });

  $('followButton').addEventListener('click', async () => {
    if (!profile || isOwner) return;
    if (!token) { location.href = `/login?next=${encodeURIComponent(`/profile?user=${profile.id}`)}`; return; }
    const button = $('followButton');
    button.disabled = true;
    try {
      const result = await api(`/api/users/${encodeURIComponent(profile.id)}/follow`, { method: 'POST' });
      isFollowing = !!result.following;
      text(button, isFollowing ? '✓ إلغاء المتابعة' : '+ متابعة الشاعر');
      await refreshStats();
    } catch (error) { showStatus(error.message, true); }
    finally { button.disabled = false; }
  });

  $('shareButton').addEventListener('click', async () => {
    if (!profile) return;
    const link = `${location.origin}/profile?user=${encodeURIComponent(profile.id)}`;
    try {
      await navigator.clipboard.writeText(link);
      const button = $('shareButton');
      text(button, '✓ تم نسخ رابط الملف');
      setTimeout(() => text(button, 'مشاركة الملف ↗'), 2500);
    } catch { window.prompt('انسخ رابط ملف الشاعر:', link); }
  });

  $('logoutButton').addEventListener('click', () => { localStorage.removeItem('token'); location.href = '/'; });
  init();
})();
