'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const form = $('authForm');
  const modeFromPath = location.pathname === '/register' ? 'register' : 'login';
  const params = new URLSearchParams(location.search);
  const requestedNext = params.get('next') || '/profile';
  const next = requestedNext.startsWith('/') && !requestedNext.startsWith('//') && !requestedNext.includes('\\') && !/[\r\n]/.test(requestedNext) ? requestedNext : '/profile';
  let mode = modeFromPath;

  function showMessage(message, kind = 'error') {
    const box = $('authMessage');
    box.textContent = message;
    box.dataset.kind = kind;
    box.hidden = !message;
  }

  function setMode(nextMode, updatePath = true) {
    mode = nextMode;
    const registering = mode === 'register';
    $('loginTab').classList.toggle('active', !registering);
    $('registerTab').classList.toggle('active', registering);
    $('loginTab').setAttribute('aria-selected', String(!registering));
    $('registerTab').setAttribute('aria-selected', String(registering));
    $('displayNameField').hidden = !registering;
    $('confirmPasswordField').hidden = !registering;
    $('usernameHint').hidden = !registering;
    $('passwordHint').hidden = !registering;
    $('displayName').required = registering;
    $('confirmPassword').required = registering;
    $('password').autocomplete = registering ? 'new-password' : 'current-password';
    $('password').placeholder = registering ? 'ثمانية أحرف على الأقل' : 'كلمة المرور';
    $('authHeading').textContent = registering ? 'ابدأ رحلتك مع الشعر' : 'مرحبًا بعودتك';
    $('authSubtitle').textContent = registering ? 'اختر اسم مستخدم واسمًا ظاهرًا، ثم انضم إلى المجالس.' : 'أدخل اسم المستخدم وكلمة المرور لمتابعة مجالسك.';
    $('authSubmit').innerHTML = registering ? 'إنشاء حسابي <span>←</span>' : 'دخول إلى المجالس <span>←</span>';
    $('switchWrap').firstChild.textContent = registering ? 'لديك حساب بالفعل؟ ' : 'ليس لديك حساب؟ ';
    $('switchAuth').textContent = registering ? 'سجّل الدخول' : 'أنشئ حسابًا مجانًا';
    $('confirmPassword').value = '';
    showMessage('');
    if (updatePath) {
      const path = registering ? '/register' : '/login';
      const query = params.has('next') ? `?next=${encodeURIComponent(next)}` : '';
      history.replaceState(null, '', path + query);
    }
  }

  $('loginTab').addEventListener('click', () => setMode('login'));
  $('registerTab').addEventListener('click', () => setMode('register'));
  $('switchAuth').addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
  $('passwordToggle').addEventListener('click', () => {
    const visible = $('password').type === 'text';
    $('password').type = visible ? 'password' : 'text';
    $('passwordToggle').textContent = visible ? 'إظهار' : 'إخفاء';
    $('passwordToggle').setAttribute('aria-pressed', String(!visible));
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    showMessage('');
    const username = $('username').value.trim();
    const password = $('password').value;
    const registering = mode === 'register';
    const displayName = $('displayName').value.trim();
    if (!username) return showMessage('أدخل اسم المستخدم الخاص بك.');
    if (registering && !/^[A-Za-z0-9_\u0600-\u06FF]{3,24}$/.test(username)) return showMessage('اسم المستخدم يجب أن يكون 3 إلى 24 حرفًا من دون مسافات أو رموز خاصة.');
    if (!password || (registering && (password.length < 8 || password.length > 128))) return showMessage('أدخل كلمة مرور صحيحة؛ التسجيل يتطلب 8 أحرف على الأقل.');
    if (registering && (!displayName || displayName.length > 40)) return showMessage('أدخل الاسم الذي سيظهر للشعراء.');
    if (registering && password !== $('confirmPassword').value) return showMessage('تأكيد كلمة المرور غير مطابق.');

    const submit = $('authSubmit');
    submit.disabled = true;
    submit.textContent = registering ? 'جارٍ إنشاء الحساب...' : 'جارٍ تسجيل الدخول...';
    try {
      const response = await fetch(registering ? '/api/register' : '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(registering ? { username, displayName, password } : { username, password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.token) throw new Error(data.error || 'تعذر تسجيل الدخول. حاول مرة أخرى.');
      localStorage.setItem('token', data.token);
      showMessage(registering ? 'أُنشئ حسابك بنجاح. يجري فتح صفحتك...' : 'تم الدخول بنجاح. يجري تحويلك...', 'success');
      window.location.assign(next);
    } catch (error) {
      showMessage(error.message || 'تعذر الاتصال بالخادم، تحقق من اتصالك بالإنترنت.');
      submit.disabled = false;
      submit.innerHTML = registering ? 'إنشاء حسابي <span>←</span>' : 'دخول إلى المجالس <span>←</span>';
    }
  });

  setMode(mode, false);
  if (localStorage.getItem('token')) {
    showMessage('إذا كنت مسجّل الدخول بالفعل، يمكنك فتح ملفك من رابط «حسابي» في الموقع.', 'info');
  }
})();
