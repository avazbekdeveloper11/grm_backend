const express = require('express');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/settlements/balances — barcha haydovchilar balansi
router.get('/balances', requireAuth, (req, res) => {
  const db = getDb();

  const drivers = db.prepare(`
    SELECT u.id, u.name, u.login
    FROM users u
    WHERE u.role = 'driver' AND u.is_active = 1
    ORDER BY u.name
  `).all();

  const result = drivers.map(driver => {
    // To'liq to'langan buyurtmalardan yig'im (order_items mavjud bo'lsa ulardan)
    const collected = db.prepare(`
      SELECT
        COALESCE(SUM(
          COALESCE(o.manual_price, COALESCE((SELECT SUM(oi.total_price) FROM order_items oi WHERE oi.order_id = o.id), o.total_price))
        ), 0) as total,
        COUNT(*) as count
      FROM orders o
      WHERE o.collected_by = ? AND o.payment_status = 'tolangan'
    `).get(driver.id);

    // Avans to'lovlar - hali to'lanmagan YOKI to'langan lekin boshqa haydovchi yig'gan
    const advances = db.prepare(`
      SELECT COALESCE(SUM(o.advance_payment), 0) as total, COUNT(*) as count
      FROM orders o
      WHERE o.assigned_driver_id = ? AND o.advance_payment > 0
        AND (o.payment_status != 'tolangan' OR (o.payment_status = 'tolangan' AND o.collected_by != o.assigned_driver_id))
    `).get(driver.id);

    // Jami topshirilgan (adminga)
    const settled = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
      FROM driver_settlements
      WHERE driver_id = ?
    `).get(driver.id);

    // So'nggi topshirish sanasi
    const lastSettlement = db.prepare(`
      SELECT created_at FROM driver_settlements
      WHERE driver_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(driver.id);

    const totalCollected = collected.total + advances.total;

    return {
      id: driver.id,
      name: driver.name,
      login: driver.login,
      total_collected: totalCollected,
      collected_count: collected.count,
      advance_count: advances.count,
      advance_total: advances.total,
      total_settled: settled.total,
      settled_count: settled.count,
      balance: totalCollected - settled.total,
      last_settlement: lastSettlement?.created_at || null,
    };
  });

  res.json(result);
});

// GET /api/settlements/driver/:id — haydovchi tarixi
router.get('/driver/:id', requireAuth, (req, res) => {
  const db = getDb();
  const driverId = Number(req.params.id);

  // To'liq to'langan buyurtmalar — har bir zakaz alohida
  const collectedOrders = db.prepare(`
    SELECT
      o.id,
      o.customer_name,
      o.collected_at,
      o.advance_payment,
      COALESCE(o.manual_price, COALESCE(
        (SELECT SUM(oi.total_price) FROM order_items oi WHERE oi.order_id = o.id),
        o.total_price
      )) as collected_amount
    FROM orders o
    WHERE o.collected_by = ? AND o.payment_status = 'tolangan'
    ORDER BY o.collected_at DESC
    LIMIT 50
  `).all(driverId);

  // Avans to'lovlar — har bir zakaz alohida
  const advanceOrders = db.prepare(`
    SELECT
      o.id,
      o.customer_name,
      o.advance_payment_at,
      o.advance_payment
    FROM orders o
    WHERE o.assigned_driver_id = ? AND o.advance_payment > 0
      AND (o.payment_status != 'tolangan' OR (o.payment_status = 'tolangan' AND o.collected_by != o.assigned_driver_id))
      AND o.advance_payment_at IS NOT NULL
    ORDER BY o.advance_payment_at DESC
    LIMIT 50
  `).all(driverId);

  // Topshirish tarixi
  const settlements = db.prepare(`
    SELECT ds.*, u.name as admin_name
    FROM driver_settlements ds
    LEFT JOIN users u ON u.id = ds.admin_id
    WHERE ds.driver_id = ?
    ORDER BY ds.created_at DESC
    LIMIT 30
  `).all(driverId);

  // Balans: to'langan + avanslar - topshirilgan
  const collectedTotal = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(o.manual_price, COALESCE(
      (SELECT SUM(oi.total_price) FROM order_items oi WHERE oi.order_id = o.id),
      o.total_price
    ))), 0) as total
    FROM orders o WHERE o.collected_by = ? AND o.payment_status = 'tolangan'
  `).get(driverId).total;

  const advanceTotal = db.prepare(`
    SELECT COALESCE(SUM(o.advance_payment), 0) as total
    FROM orders o
    WHERE o.assigned_driver_id = ? AND o.advance_payment > 0
      AND (o.payment_status != 'tolangan' OR (o.payment_status = 'tolangan' AND o.collected_by != o.assigned_driver_id))
  `).get(driverId).total;

  const settledTotal = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM driver_settlements WHERE driver_id = ?
  `).get(driverId).total;

  res.json({
    collectedOrders,
    advanceOrders,
    settlements,
    balance: collectedTotal + advanceTotal - settledTotal,
    collected_total: collectedTotal,
    advance_total: advanceTotal,
  });
});

// POST /api/settlements — admin haydovchidan pul oldi
router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { driver_id, amount, note } = req.body;

  if (!driver_id || !amount || amount <= 0) {
    return res.status(400).json({ error: "driver_id va amount talab qilinadi" });
  }

  // Haydovchi balansini tekshirish
  const collected = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(o.manual_price, COALESCE(
      (SELECT SUM(oi.total_price) FROM order_items oi WHERE oi.order_id = o.id),
      o.total_price
    ))), 0) as total
    FROM orders o
    WHERE o.collected_by = ? AND o.payment_status = 'tolangan'
  `).get(Number(driver_id));

  const advanceHeld = db.prepare(`
    SELECT COALESCE(SUM(o.advance_payment), 0) as total
    FROM orders o
    WHERE o.assigned_driver_id = ? AND o.advance_payment > 0
      AND (o.payment_status != 'tolangan' OR (o.payment_status = 'tolangan' AND o.collected_by != o.assigned_driver_id))
  `).get(Number(driver_id));

  const settled = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM driver_settlements
    WHERE driver_id = ?
  `).get(Number(driver_id));

  const balance = collected.total + advanceHeld.total - settled.total;
  if (amount > balance + 0.01) {
    return res.status(400).json({
      error: `Haydovchida faqat ${balance} so'm bor`,
      balance
    });
  }

  const result = db.prepare(`
    INSERT INTO driver_settlements (driver_id, amount, note, admin_id)
    VALUES (?, ?, ?, ?)
  `).run(Number(driver_id), Number(amount), note || null, req.user.id);

  const row = db.prepare('SELECT * FROM driver_settlements WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(row);
});

// DELETE /api/settlements/:id — xato kiritilganda o'chirish (admin)
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM driver_settlements WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

module.exports = router;
