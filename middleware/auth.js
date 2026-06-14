const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../routes/auth');
const { getDb } = require('../database');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token talab qilinadi' });
  }
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const db = getDb();

    // token_invalidated_at dan oldin chiqarilgan tokenlarni rad etish
    const row = db.prepare("SELECT value FROM settings WHERE key='token_invalidated_at'").get();
    if (row?.value) {
      const invalidatedAt = Number(row.value);
      if (decoded.iat < invalidatedAt) {
        return res.status(401).json({ error: 'Sessiya muddati tugadi. Qayta login qiling.' });
      }
    }

    // User bloklangan yoki o'chirilganligini tekshirish
    const user = db.prepare("SELECT is_active FROM users WHERE id = ?").get(decoded.id);
    if (!user || user.is_active !== 1) {
      return res.status(403).json({ error: 'Akkount bloklangan. Admin bilan bog\'laning.' });
    }

    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token yaroqsiz yoki muddati tugagan' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Faqat admin uchun' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
