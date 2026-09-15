'use strict';

function createAuthMiddleware({ jwt, jwtSecret, getUserById }) {
  function auth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    try { req.user = jwt.verify(token, jwtSecret); next(); }
    catch { res.status(401).json({ error: 'يجب تسجيل الدخول أو تجديد الجلسة' }); }
  }

  async function requireAdmin(req, res, next) {
    try {
      const user = await getUserById(req.user.id);
      if (!user || user.role !== 'admin') return res.status(403).json({ error: 'هذه الميزة متاحة للمدير فقط' });
      req.fullUser = user;
      next();
    } catch (e) { next(e); }
  }

  async function requireActiveUser(req, res, next) {
    try {
      const user = await getUserById(req.user.id);
      if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
      if (user.status !== 'active') return res.status(403).json({ error: 'حسابك موقوف مؤقتًا ولا يملك صلاحية تنفيذ هذا الإجراء' });
      req.fullUser = user;
      next();
    } catch (e) { next(e); }
  }

  function decodeSocketToken(token) {
    try { return jwt.verify(String(token || ''), jwtSecret); } catch { return null; }
  }

  return { auth, requireAdmin, requireActiveUser, decodeSocketToken };
}

module.exports = { createAuthMiddleware };
