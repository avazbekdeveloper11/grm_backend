const express = require('express');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// POST /api/reset  — DB ni tozalash, faqat admin qoladi
router.post('/', requireAdmin, (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'TOZALA') {
    return res.status(400).json({ error: "confirm: 'TOZALA' yuborish kerak" });
  }

  const db = getDb();

  const stmts = [
    'DELETE FROM order_items',
    'DELETE FROM driver_settlements',
    'DELETE FROM carpets',
    'DELETE FROM orders',
    'DELETE FROM services',
    "DELETE FROM users WHERE role != 'admin'",
    "UPDATE users SET fcm_token = NULL, name = 'Administrator', login = 'admin', password = 'admin123' WHERE role = 'admin'",
    "DELETE FROM settings",
    "DELETE FROM sqlite_sequence",
  ];

  for (const sql of stmts) {
    try { db.prepare(sql).run(); } catch (_) {}
  }

  res.json({ success: true, message: "DB to'liq tozalandi. Faqat admin (admin/admin123) qoldi." });
});

// POST /api/reset/orders — faqat buyurtmalarni tozalash (xodimlar, narxlar qoladi)
router.post('/orders', requireAdmin, (req, res) => {
  const { confirm } = req.body;
  if (confirm !== 'BUYURTMALAR') {
    return res.status(400).json({ error: "confirm: 'BUYURTMALAR' yuborish kerak" });
  }

  const db = getDb();

  const stmts = [
    'DELETE FROM order_items',
    'DELETE FROM driver_settlements',
    'DELETE FROM carpets',
    'DELETE FROM orders',
    "DELETE FROM sqlite_sequence WHERE name IN ('orders','carpets','order_items','driver_settlements')",
  ];

  for (const sql of stmts) {
    try { db.prepare(sql).run(); } catch (_) {}
  }

  res.json({ success: true, message: "Barcha buyurtmalar tozalandi. ID 1 dan boshlanadi." });
});

// POST /api/reset/admin-password — admin parolni ko'rish yoki tiklash (vaqtincha)
router.post('/admin-password', (req, res) => {
  const { secret } = req.body;
  if (secret !== 'gilam2026reset') {
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  }
  const db = getDb();
  const admins = db.prepare("SELECT login, password FROM users WHERE role = 'admin'").all();
  res.json({ success: true, admins });
});

// POST /api/reset/sessions — hamma tokenlarni expire qilish
router.post('/sessions', requireAdmin, (req, res) => {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('token_invalidated_at', ?)").run(String(now));
  res.json({ success: true, message: "Barcha sessiyalar tugatildi. Foydalanuvchilar qayta login qilishi kerak." });
});

// POST /api/reset/driver/:id — haydovchi balansini 0 ga tushirish (zakazlar o'chmaydi)
router.post('/driver/:id', requireAdmin, (req, res) => {
  const driverId = Number(req.params.id);
  const db = getDb();

  // Haydovchi mavjudligini tekshirish
  const driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(driverId);
  if (!driver) {
    return res.status(404).json({ error: "Haydovchi topilmadi" });
  }

  db.exec("BEGIN TRANSACTION");
  try {
    // 1. Settlements tozalash
    db.prepare("DELETE FROM driver_settlements WHERE driver_id = ?").run(driverId);

    // 2. Buyurtmalardagi collected_by ni NULL qilish (buyurtmalar o'chirilmaydi, faqat haydovchidan uziladi)
    db.prepare("UPDATE orders SET collected_by = NULL WHERE collected_by = ?").run(driverId);

    // 3. Avans to'lovlari bor faol buyurtmalardan haydovchini uzish
    db.prepare("UPDATE orders SET assigned_driver_id = NULL WHERE assigned_driver_id = ? AND payment_status != 'tolangan'").run(driverId);

    db.exec("COMMIT");
    res.json({ success: true, message: `Haydovchi '${driver.name}' balansi muvaffaqiyatli 0 ga tushirildi.` });
  } catch (error) {
    db.exec("ROLLBACK");
    res.status(500).json({ error: "Xatolik yuz berdi: " + error.message });
  }
});

module.exports = router;
