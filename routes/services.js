const express = require('express');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/services
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM services ORDER BY sort_order, id'
  ).all();
  res.json(rows);
});

// POST /api/services
router.post('/', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, unit_type, price_per_unit,
          discount_enabled, discount_min_qty, discount_amount, salary_percent } = req.body;
  if (!name || !unit_type || price_per_unit == null) {
    return res.status(400).json({ error: "name, unit_type, price_per_unit talab qilinadi" });
  }
  if (!['sqm', 'piece', 'meter'].includes(unit_type)) {
    return res.status(400).json({ error: "unit_type: 'sqm', 'meter' yoki 'piece' bo'lishi kerak" });
  }
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM services').get().m || 0;
  const result = db.prepare(
    `INSERT INTO services (name, unit_type, price_per_unit, sort_order,
       discount_enabled, discount_min_qty, discount_amount, salary_percent)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    name.trim(), unit_type, Number(price_per_unit), maxOrder + 1,
    discount_enabled ? 1 : 0,
    discount_min_qty != null ? Number(discount_min_qty) : 0,
    discount_amount != null ? Number(discount_amount) : 0,
    salary_percent != null ? Number(salary_percent) : 20,
  );
  res.status(201).json(db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid));
});

// PUT /api/services/:id
router.put('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!svc) return res.status(404).json({ error: 'Xizmat topilmadi' });
  const { name, unit_type, price_per_unit, is_active,
          discount_enabled, discount_min_qty, discount_amount, salary_percent } = req.body;
  db.prepare(`
    UPDATE services
    SET name=?, unit_type=?, price_per_unit=?, is_active=?,
        discount_enabled=?, discount_min_qty=?, discount_amount=?, salary_percent=?
    WHERE id=?
  `).run(
    name ?? svc.name,
    unit_type ?? svc.unit_type,
    price_per_unit != null ? Number(price_per_unit) : svc.price_per_unit,
    is_active != null ? (is_active ? 1 : 0) : svc.is_active,
    discount_enabled != null ? (discount_enabled ? 1 : 0) : svc.discount_enabled,
    discount_min_qty != null ? Number(discount_min_qty) : svc.discount_min_qty,
    discount_amount != null ? Number(discount_amount) : svc.discount_amount,
    salary_percent != null ? Number(salary_percent) : svc.salary_percent,
    id
  );
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(id));
});

// DELETE /api/services/:id
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE services SET is_active = 0 WHERE id = ?').run(Number(req.params.id));
  res.json({ success: true });
});

// ─── Order items ───────────────────────────────────────────────────────────────

// GET /api/services/order/:orderId/items
router.get('/order/:orderId/items', requireAuth, (req, res) => {
  const db = getDb();
  const items = db.prepare(`
    SELECT oi.*,
           s.name as service_name, s.unit_type,
           s.discount_enabled, s.discount_min_qty, s.discount_amount as service_discount_pct
    FROM order_items oi
    JOIN services s ON s.id = oi.service_id
    WHERE oi.order_id = ?
    ORDER BY oi.id
  `).all(Number(req.params.orderId));
  res.json(items);
});

// POST /api/services/order/:orderId/items — dastavchi kiritadi
router.post('/order/:orderId/items', requireAuth, (req, res) => {
  const db = getDb();
  const orderId = Number(req.params.orderId);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const { items } = req.body; // [{service_id, quantity?, width?, height?, notes?}]
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items massivi talab qilinadi' });
  }

  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);

  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, service_id, quantity, width, height, area, unit_price, total_price, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // 1-bosqich: barcha itemlarni skidkasiz saqlash va xizmat bo'yicha jami qty hisoblash
  const rowsToInsert = [];
  const serviceQtyMap = {}; // service_id -> jami qty

  for (const item of items) {
    const svc = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(item.service_id));
    if (!svc) continue;

    let area = null, qty = 0, rawTotal = 0;

    if (svc.unit_type === 'sqm') {
      const w = Number(item.width) || 0;
      const h = Number(item.height) || 0;
      area = w * h;
      qty = area;
      rawTotal = area * svc.price_per_unit;
    } else if (svc.unit_type === 'meter') {
      qty = Number(item.quantity) || 0;
      rawTotal = qty * svc.price_per_unit;
    } else {
      qty = Number(item.quantity) || 0;
      rawTotal = qty * svc.price_per_unit;
    }

    if (qty <= 0) continue;

    serviceQtyMap[svc.id] = (serviceQtyMap[svc.id] || 0) + qty;
    rowsToInsert.push({ svc, qty, area, rawTotal, item });
  }

  // 2-bosqich: xizmat bo'yicha JAMI qty asosida discount qo'llab saqlash
  let totalPrice = 0;
  for (const { svc, qty, area, rawTotal, item } of rowsToInsert) {
    const totalQtyForService = serviceQtyMap[svc.id] || qty;
    let itemTotal = rawTotal;

    // Per-service discount: jami qty threshold dan oshsa — bu itemga ham discount
    if (svc.discount_enabled && svc.discount_min_qty > 0 && totalQtyForService >= svc.discount_min_qty) {
      const pct = svc.discount_amount || 0;
      itemTotal = Math.max(0, rawTotal * (1 - pct / 100));
    }

    insertItem.run(
      orderId, svc.id, qty,
      item.width ? Number(item.width) : null,
      item.height ? Number(item.height) : null,
      area,
      svc.price_per_unit,
      itemTotal,
      item.notes || null
    );
    totalPrice += itemTotal;
  }

  // Global discount hisoblash
  const discEnabledRow = db.prepare("SELECT value FROM settings WHERE key='discount_enabled'").get();
  const discMinRow    = db.prepare("SELECT value FROM settings WHERE key='discount_min_sqm'").get();
  const discPctRow    = db.prepare("SELECT value FROM settings WHERE key='discount_percentage'").get();
  const discEnabled   = discEnabledRow?.value === '1';
  const discMinSqm    = discMinRow ? Number(discMinRow.value) : 0;
  const discPct       = discPctRow ? Number(discPctRow.value) : 0; // foiz (masalan 5 = 5%)

  // Jami sqm maydonni hisoblash (faqat sqm turidagilar)
  const totalSqm = db.prepare(`
    SELECT COALESCE(SUM(oi.area), 0) as total FROM order_items oi
    JOIN services s ON s.id = oi.service_id
    WHERE oi.order_id = ? AND s.unit_type = 'sqm'
  `).get(orderId).total;

  let discountAmount = 0;
  if (discEnabled && discMinSqm > 0 && discPct > 0 && totalSqm >= discMinSqm) {
    discountAmount = totalPrice * discPct / 100;
  }
  const finalPrice = Math.max(0, totalPrice - discountAmount);

  // Update order total_price
  db.prepare('UPDATE orders SET total_price = ?, discount_amount = ? WHERE id = ?').run(finalPrice, discountAmount, orderId);

  // Agar status "yangi" bo'lsa va items qo'shilsa → "qabulQilindi" ga o'tkazamiz
  if (order.status === 'yangi') {
    db.prepare("UPDATE orders SET status = 'qabulQilindi' WHERE id = ?").run(orderId);
  }

  const savedItems = db.prepare(`
    SELECT oi.*, s.name as service_name, s.unit_type
    FROM order_items oi JOIN services s ON s.id = oi.service_id
    WHERE oi.order_id = ?
  `).all(orderId);

  const updatedOrder = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  res.status(201).json({ items: savedItems, total_price: finalPrice, discount_amount: discountAmount, status: updatedOrder.status });
});

// GET /api/services/worker/:workerId/items — worker'ning barcha order items
router.get('/worker/:workerId/items', requireAuth, (req, res) => {
  const db = getDb();
  const workerId = req.params.workerId;

  const items = db.prepare(`
    SELECT oi.*, o.id as order_id, s.name as service_name, s.unit_type,
           s.discount_enabled, s.discount_min_qty, s.discount_amount as service_discount_pct
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN services s ON s.id = oi.service_id
    WHERE o.assigned_worker_id = ?
    ORDER BY oi.order_id, oi.id
  `).all(workerId);

  // order_id bo'yicha guruhlash
  const result = {};
  for (const item of items) {
    const oid = item.order_id;
    if (!result[oid]) result[oid] = [];
    result[oid].push(item);
  }
  res.json(result);
});

module.exports = router;
