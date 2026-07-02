const express = require('express');
const { getDb } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendReadyNotification } = require('../services/sms_service');
const { notifyPickup, notifyDelivery, notifyWorkerAssigned, notifyWorkerPickedUp } = require('../services/fcm_service');
const { broadcast } = require('../websocket');

const router = express.Router();

function getPricePerSqm(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'price_per_sqm'").get();
  return row ? Number(row.value) : 15000;
}

function recalcOrderTotal(db, orderId) {
  const carpets = db.prepare('SELECT price FROM carpets WHERE order_id = ?').all(orderId);
  const total = carpets.reduce((sum, c) => sum + c.price, 0);
  // order_items mavjud bo'lsa ular skidkali narxni saqlagan — carpet narxi bilan qayta yozmaymiz
  const hasItems = db.prepare('SELECT COUNT(*) as c FROM order_items WHERE order_id = ?').get(orderId).c > 0;
  if (!hasItems) {
    db.prepare('UPDATE orders SET total_price = ? WHERE id = ?').run(total, orderId);
  }
  return total;
}

const { latinToCyrillic, cyrillicToLatin } = require('../services/transliterate');

// GET /api/orders
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const { user } = req;

  const q = (req.query.q || '').trim();
  const status = req.query.status || null; // 'yetkazildi', 'yangi', etc.
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  // search: har ikki alifboda ham qidirish (latin ↔ kirill)
  // SQLite LIKE kirill uchun katta/kichik harfni farqlamaydi deb ishlamaydi,
  // shuning uchun asl registrda ham, kichik harfda ham qidiramiz.
  const like = q ? `%${q}%` : null;
  const idQ = q ? q.replace(/^#+/, '').replace(/^0+/, '') : null;

  const title = s => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;

  const qLower    = q.toLowerCase();
  const qCyrLower = latinToCyrillic(qLower);
  const qCyrTitle = title(qCyrLower);
  const qLatLower = cyrillicToLatin(qLower);
  const qLatTitle = title(qLatLower);

  // Barcha variantlar: asl + kichik + title case (kirill/latin)
  const alts = [...new Set([qLower, qCyrLower, qCyrTitle, qLatLower, qLatTitle])]
    .filter(v => v && v !== q);

  function buildWhere(extraCond) {
    const conds = [];
    const params = [];
    if (extraCond) { conds.push(extraCond.cond); params.push(...extraCond.params); }
    if (status) {
      conds.push('o.status = ?');
      params.push(status);
    }
    if (like) {
      const orParts = [
        'o.customer_name LIKE ?', 'o.phone LIKE ?', 'o.address LIKE ?', 'CAST(o.id AS TEXT) = ?',
      ];
      params.push(like, like, like, idQ);
      for (const alt of alts) {
        orParts.push('o.customer_name LIKE ?', 'o.address LIKE ?');
        params.push(`%${alt}%`, `%${alt}%`);
      }
      conds.push(`(${orParts.join(' OR ')})`);
    }
    return {
      where: conds.length ? 'WHERE ' + conds.join(' AND ') : '',
      params,
    };
  }

  let roleExtra = null;
  if (user.role === 'driver') {
    roleExtra = {
      cond: `(o.assigned_driver_id = ?
        OR (o.assigned_driver_id IS NULL AND o.status IN ('yangi', 'tayyor')))`,
      params: [user.id],
    };
  }

  const { where, params } = buildWhere(roleExtra);

  // LIMIT+1 trick — COUNT queryni o'tkazib yuboramiz (tezroq)
  const orders = db.prepare(`
    SELECT o.*, uw.name as worker_name, ud.name as driver_name
    FROM orders o
    LEFT JOIN users uw ON uw.id = o.assigned_worker_id
    LEFT JOIN users ud ON ud.id = o.assigned_driver_id
    ${where}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit + 1, offset);

  const hasMore = orders.length > limit;
  if (hasMore) orders.pop(); // ortiqcha elementni olib tashlaymiz

  // Total faqat birinchi sahifa va qidiruv bo'lmaganda aniq hisoblanadi
  let total;
  if (!q && page === 1) {
    const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM orders o ${where}`).get(...params);
    total = countRow.cnt;
  } else {
    // Taxminiy total: agar ko'proq bor bo'lsa, offset + limit + 1
    total = hasMore ? offset + limit + 1 : offset + orders.length;
  }

  // Har bir order uchun items_summary qo'shamiz
  const placeholder = orders.map(() => '?').join(',') || '0';

  const itemsQuery = db.prepare(`
    SELECT oi.order_id,
      SUM(CASE WHEN s.unit_type='sqm'   THEN oi.area     ELSE 0 END) as total_sqm,
      SUM(CASE WHEN s.unit_type='meter' THEN oi.quantity  ELSE 0 END) as total_meter,
      SUM(CASE WHEN s.unit_type='piece' THEN oi.quantity  ELSE 0 END) as total_piece,
      COUNT(*) as items_count,
      SUM(oi.total_price) as items_total
    FROM order_items oi
    JOIN services s ON s.id = oi.service_id
    WHERE oi.order_id IN (${placeholder})
    GROUP BY oi.order_id
  `);
  const summaries = orders.length > 0
    ? itemsQuery.all(...orders.map(o => o.id))
    : [];
  const summaryMap = {};
  for (const s of summaries) summaryMap[s.order_id] = s;

  // Global discount settings
  const discEnabledRow = db.prepare("SELECT value FROM settings WHERE key='discount_enabled'").get();
  const discMinRow     = db.prepare("SELECT value FROM settings WHERE key='discount_min_sqm'").get();
  const discPctRow     = db.prepare("SELECT value FROM settings WHERE key='discount_percentage'").get();
  const discEnabled    = discEnabledRow?.value === '1';
  const discMinSqm     = discMinRow ? Number(discMinRow.value) : 0;
  const discPct        = discPctRow ? Number(discPctRow.value) : 0;

  const result = orders.map(o => {
    const summary = summaryMap[o.id] || null;
    let calcTotal = o.total_price;
    let calcDiscount = o.discount_amount || 0;
    if (summary && summary.items_total > 0) {
      // items_total = per-service discounted sum; apply global discount on top
      const itemsTotal = summary.items_total;
      const totalSqm = summary.total_sqm || 0;
      let globalDisc = 0;
      if (discEnabled && discMinSqm > 0 && discPct > 0 && totalSqm >= discMinSqm) {
        globalDisc = itemsTotal * discPct / 100;
      }
      calcTotal = Math.max(0, itemsTotal - globalDisc);
      calcDiscount = globalDisc + (o.discount_amount || 0);
      // Sync DB if stale (background, best-effort)
      if (Math.abs(calcTotal - o.total_price) > 0.5) {
        db.prepare('UPDATE orders SET total_price = ?, discount_amount = ? WHERE id = ?')
          .run(calcTotal, globalDisc, o.id);
      }
    }
    return {
      ...o,
      total_price: calcTotal,
      discount_amount: calcDiscount,
      items_summary: summary,
    };
  });
  res.json({ items: result, total, page, limit });
});

// GET /api/orders/by-chat/:chatId — Telegram bot: mijoz o'z zakazlarini ko'radi
router.get('/by-chat/:chatId', requireAuth, (req, res) => {
  const db = getDb();
  const chatId = req.params.chatId;
  const orders = db.prepare(`
    SELECT id, customer_name, address, status, payment_status,
           pickup_date, delivery_date, total_price, created_at
    FROM orders
    WHERE telegram_chat_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(chatId);
  res.json({ items: orders });
});

// GET /api/orders/bot-stats — admin: bot orqali tushgan zakazlar soni
router.get('/bot-stats', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) as today
    FROM orders WHERE telegram_chat_id IS NOT NULL
  `).get();
  res.json({ total: row.total || 0, today: row.today || 0 });
});

// GET /api/orders/:id
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const order = db.prepare(`
    SELECT o.*, uw.name as worker_name, ud.name as driver_name
    FROM orders o
    LEFT JOIN users uw ON uw.id = o.assigned_worker_id
    LEFT JOIN users ud ON ud.id = o.assigned_driver_id
    WHERE o.id = ?
  `).get(Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  // order_items mavjud bo'lsa skidkali narxni qayta hisoblash
  const itemsRow = db.prepare(
    'SELECT SUM(total_price) as items_total, SUM(area) as total_sqm FROM order_items oi JOIN services s ON s.id=oi.service_id WHERE oi.order_id=? AND s.unit_type="sqm"'
  ).get(order.id);
  const itemsTotalRow = db.prepare(
    'SELECT SUM(total_price) as items_total FROM order_items WHERE order_id=?'
  ).get(order.id);

  if (itemsTotalRow && itemsTotalRow.items_total > 0) {
    const discEnabledRow = db.prepare("SELECT value FROM settings WHERE key='discount_enabled'").get();
    const discMinRow     = db.prepare("SELECT value FROM settings WHERE key='discount_min_sqm'").get();
    const discPctRow     = db.prepare("SELECT value FROM settings WHERE key='discount_percentage'").get();
    const discEnabled    = discEnabledRow?.value === '1';
    const discMinSqm     = discMinRow ? Number(discMinRow.value) : 0;
    const discPct        = discPctRow ? Number(discPctRow.value) : 0;
    const itemsTotal     = itemsTotalRow.items_total;
    const totalSqm       = itemsRow?.total_sqm || 0;
    let globalDisc = 0;
    if (discEnabled && discMinSqm > 0 && discPct > 0 && totalSqm >= discMinSqm) {
      globalDisc = itemsTotal * discPct / 100;
    }
    const calcTotal = Math.max(0, itemsTotal - globalDisc);
    if (Math.abs(calcTotal - order.total_price) > 0.5) {
      db.prepare('UPDATE orders SET total_price=?, discount_amount=? WHERE id=?').run(calcTotal, globalDisc, order.id);
    }
    return res.json({ ...order, total_price: calcTotal, discount_amount: globalDisc });
  }
  res.json(order);
});

// POST /api/orders
router.post('/', requireAuth, (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'driver') {
    return res.status(403).json({ error: 'Ruxsat yo\'q' });
  }
  const db = getDb();
  const {
    customer_name, phone, address,
    pickup_date, delivery_date,
    assigned_worker_id, assigned_driver_id,
    notes, carpet_count, carpet_types,
    telegram_chat_id,
  } = req.body;

  // Driver o'zini avtomatik tayinlaydi
  const effectiveDriverId = req.user.role === 'driver'
    ? req.user.id
    : (assigned_driver_id || null);

  if (!customer_name || !phone || !address || !pickup_date || !delivery_date) {
    return res.status(400).json({ error: "Majburiy maydonlar to'ldirilmagan" });
  }

  const result = db.prepare(`
    INSERT INTO orders
      (customer_name, phone, address, pickup_date, delivery_date,
       assigned_worker_id, assigned_driver_id, notes, carpet_count, carpet_types,
       telegram_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    customer_name, phone, address, pickup_date, delivery_date,
    assigned_worker_id || null, effectiveDriverId,
    notes || null,
    carpet_count || 0,
    carpet_types ?? '',
    telegram_chat_id || null,
  );

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
  broadcast('order_created', { order_id: order.id });

  // Yangi zakaz yaratilganda haydovchi tayinlangan bo'lsa — xabar yuborish
  if (order.assigned_driver_id) {
    notifyPickup(db, order.assigned_driver_id, order.id, order.customer_name, order.address)
      .catch((e) => console.error('Push xatolik:', e));
  }
  // Ishchi tayinlangan bo'lsa — xabar yuborish
  if (order.assigned_worker_id) {
    notifyWorkerAssigned(db, order.assigned_worker_id, order.id, order.customer_name)
      .catch((e) => console.error('Push xatolik:', e));
  }

  res.status(201).json(order);
});

// POST /api/orders/:id/claim — haydovchi o'zini tayinlaydi (birinchi bo'lib qabul qilgan oladi)
router.post('/:id/claim', requireAuth, (req, res) => {
  if (req.user.role !== 'driver') {
    return res.status(403).json({ error: 'Faqat haydovchilar uchun' });
  }
  const db = getDb();
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  if (!['yangi', 'tayyor'].includes(order.status)) {
    return res.status(409).json({ error: 'Bu buyurtmani qabul qilib bo\'lmaydi' });
  }

  const result = db.prepare(`
    UPDATE orders SET assigned_driver_id = ?
    WHERE id = ? AND assigned_driver_id IS NULL
  `).run(req.user.id, id);

  if (result.changes === 0) {
    return res.status(409).json({ error: 'Bu buyurtmani boshqa haydovchi qabul qilib bo\'lgan' });
  }

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  broadcast('order_updated', { order_id: id, status: updated.status });
  res.json(updated);
});

// PUT /api/orders/:id
router.put('/:id', requireAuth, async (req, res) => {
  try {
  const db = getDb();
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const {
    customer_name, phone, address,
    pickup_date, delivery_date,
    status, payment_status,
    assigned_worker_id, assigned_driver_id,
    notes, carpet_count, carpet_types,
    manual_price,
  } = req.body;

  const previousStatus = order.status;
  const newStatus = status ?? order.status;

  // Yuvish tugagan sanani belgilash (yuvilyapti -> upakovka o'tishida)
  const newWashedAt = (previousStatus === 'yuvilyapti' && newStatus === 'upakovka')
    ? new Date().toISOString()
    : order.washed_at;

  // Yuvish boshlangan sanani belgilash ("yuvilyapti" birinchi marta bosilganda)
  const newWashingStartedAt = (previousStatus !== 'yuvilyapti' && newStatus === 'yuvilyapti')
    ? new Date().toISOString()
    : order.washing_started_at;

  // Worker tayinlangan sanani belgilash (birinchi marta worker tayinlanganda)
  const newAssignedWorkerAt = (assigned_worker_id && !order.assigned_worker_id)
    ? new Date().toISOString()
    : (assigned_worker_id !== undefined && assigned_worker_id !== order.assigned_worker_id && assigned_worker_id)
      ? new Date().toISOString()
      : order.assigned_worker_at;

  // manual_price faqat admin o'zgartira oladi
  const newManualPrice = (req.user.role === 'admin' && manual_price !== undefined)
    ? (manual_price === null || manual_price === '' ? null : Number(manual_price))
    : order.manual_price;

  db.prepare(`
    UPDATE orders SET
      customer_name = ?, phone = ?, address = ?,
      pickup_date = ?, delivery_date = ?,
      status = ?, payment_status = ?,
      assigned_worker_id = ?, assigned_driver_id = ?,
      notes = ?, carpet_count = ?, carpet_types = ?,
      manual_price = ?, washed_at = ?, washing_started_at = ?,
      assigned_worker_at = ?
    WHERE id = ?
  `).run(
    customer_name ?? order.customer_name,
    phone ?? order.phone,
    address ?? order.address,
    pickup_date ?? order.pickup_date,
    delivery_date ?? order.delivery_date,
    newStatus,
    payment_status ?? order.payment_status,
    assigned_worker_id !== undefined ? (assigned_worker_id || null) : order.assigned_worker_id,
    assigned_driver_id !== undefined ? (assigned_driver_id || null) : order.assigned_driver_id,
    notes !== undefined ? (notes || null) : order.notes,
    carpet_count ?? order.carpet_count,
    carpet_types !== undefined ? (carpet_types ?? '') : (order.carpet_types ?? ''),
    newManualPrice,
    newWashedAt,
    newWashingStartedAt,
    newAssignedWorkerAt,
    id
  );

  const result = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);

  // 1. SMS — tayyor holatida mijozga (sms_enabled=1 bo'lsagina)
  if (previousStatus !== 'tayyor' && newStatus === 'tayyor') {
    const smsEnabledRow = db.prepare("SELECT value FROM settings WHERE key='sms_enabled'").get();
    const smsEnabled = !smsEnabledRow || smsEnabledRow.value !== '0'; // default: yoqiq
    if (smsEnabled) {
      sendReadyNotification(result.phone, result.customer_name, db)
        .then((r) => console.log('SMS natija:', r))
        .catch((e) => console.error('SMS xatolik:', e));
    } else {
      console.log('SMS o\'chirilgan, yuborilmadi');
    }

    // Push — yetkazish uchun tayinlangan haydovchiga
    if (result.assigned_driver_id) {
      notifyDelivery(db, result.assigned_driver_id, id,
        result.customer_name, result.address)
        .catch((e) => console.error('Push xatolik:', e));
    }
  }

  // 2. Push — yangi haydovchi tayinlanganda (pickup uchun)
  const prevDriverId = order.assigned_driver_id;
  const newDriverId = assigned_driver_id !== undefined
    ? (assigned_driver_id || null) : order.assigned_driver_id;

  if (newDriverId && newDriverId !== prevDriverId &&
      newStatus !== 'tayyor' && newStatus !== 'yetkazildi') {
    notifyPickup(db, newDriverId, id, result.customer_name, result.address)
      .catch((e) => console.error('Push xatolik:', e));
  }

  // 3. Push — yangi ishchi tayinlanganda
  const prevWorkerId = order.assigned_worker_id;
  const newWorkerId = assigned_worker_id !== undefined
    ? (assigned_worker_id || null) : order.assigned_worker_id;

  if (newWorkerId && newWorkerId !== prevWorkerId) {
    notifyWorkerAssigned(db, newWorkerId, id, result.customer_name)
      .catch((e) => console.error('Push xatolik:', e));
  }

  // 4. Push — gilam olib kelindi (yuvilyapti), ishchiga xabar
  if (previousStatus !== 'yuvilyapti' && newStatus === 'yuvilyapti') {
    if (result.assigned_worker_id) {
      notifyWorkerPickedUp(db, result.assigned_worker_id, id, result.customer_name)
        .catch((e) => console.error('Push xatolik:', e));
    }
  }

  broadcast('order_updated', { order_id: id, status: result.status });
  res.json(result);
  } catch (err) {
    console.error('PUT /orders/:id xatolik:', err);
    res.status(500).json({ error: err.message || 'Server xatoligi' });
  }
});

// DELETE /api/orders/:id
router.delete('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });
  db.prepare('DELETE FROM carpets WHERE order_id = ?').run(id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
  broadcast('order_deleted', { order_id: id });
  res.json({ success: true });
});

// POST /api/orders/:id/advance-payment
router.post('/:id/advance-payment', requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const advance = Number(req.body.advance_payment);
  if (isNaN(advance) || advance < 0) {
    return res.status(400).json({ error: 'Noto\'g\'ri summa' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE orders SET advance_payment = ?, advance_payment_at = ? WHERE id = ?').run(advance, now, id);
  const result = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  broadcast('order_updated', { order_id: id, status: result.status });
  res.json(result);
});

// POST /api/orders/:id/carpets
router.post('/:id/carpets', requireAuth, (req, res) => {
  const db = getDb();
  const orderId = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const { carpets, pickup_lat, pickup_lng } = req.body;
  if (!Array.isArray(carpets)) {
    return res.status(400).json({ error: 'carpets massivi talab qilinadi' });
  }

  // Save pickup location if provided
  if (pickup_lat != null && pickup_lng != null) {
    db.prepare('UPDATE orders SET pickup_lat = ?, pickup_lng = ? WHERE id = ?')
      .run(Number(pickup_lat), Number(pickup_lng), orderId);
  }

  const pricePerSqm = getPricePerSqm(db);
  db.prepare('DELETE FROM carpets WHERE order_id = ?').run(orderId);

  const insertCarpet = db.prepare(
    'INSERT INTO carpets (order_id, width, height, area, price) VALUES (?, ?, ?, ?, ?)'
  );
  for (const { width, height } of carpets) {
    const w = Number(width);
    const h = Number(height);
    if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) continue;
    const area = w * h;
    const price = area * pricePerSqm;
    insertCarpet.run(orderId, w, h, area, price);
  }

  const total = recalcOrderTotal(db, orderId);
  const savedCarpets = db.prepare('SELECT * FROM carpets WHERE order_id = ?').all(orderId);

  // Update carpet_count to actual count from driver input
  db.prepare('UPDATE orders SET carpet_count = ? WHERE id = ?').run(savedCarpets.length, orderId);

  res.status(201).json({ carpets: savedCarpets, total_price: total, carpet_count: savedCarpets.length });
});

// GET /api/orders/:id/carpets
router.get('/:id/carpets', requireAuth, (req, res) => {
  const db = getDb();
  const carpets = db
    .prepare('SELECT * FROM carpets WHERE order_id = ?')
    .all(Number(req.params.id));
  res.json(carpets);
});

// POST /api/orders/:id/collect  — haydovchi to'lovni oldi
router.post('/:id/collect', requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const collectorId = req.user.id;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE orders
    SET payment_status = 'tolangan', collected_by = ?, collected_at = ?
    WHERE id = ?
  `).run(collectorId, now, id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  res.json(updated);
});

// POST /api/orders/:id/debt  — haydovchi qarzga yetkazib berdi
router.post('/:id/debt', requireAuth, (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Buyurtma topilmadi' });

  const collectorId = req.user.id;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE orders
    SET payment_status = 'qarz', collected_by = ?, collected_at = ?
    WHERE id = ?
  `).run(collectorId, now, id);

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  res.json(updated);
});

// GET /api/drivers/collections?date=2026-05-17  — admin: haydovchilar yig'imi
router.get('/drivers/collections', requireAuth, (req, res) => {
  const db = getDb();
  const { date } = req.query;

  // To'liq to'langan buyurtmalar
  let collectedWhere = "o.payment_status = 'tolangan' AND o.collected_by IS NOT NULL";
  const collectedParams = [];
  if (date) {
    collectedWhere += " AND date(o.collected_at) = ?";
    collectedParams.push(date);
  }

  // Avans to'lovlar (to'lanmagan buyurtmalardan)
  let advanceWhere = "o.advance_payment > 0 AND o.payment_status != 'tolangan' AND o.advance_payment_at IS NOT NULL AND o.assigned_driver_id IS NOT NULL";
  const advanceParams = [];
  if (date) {
    advanceWhere += " AND date(o.advance_payment_at) = ?";
    advanceParams.push(date);
  }

  const drivers = db.prepare(`SELECT id, name FROM users WHERE role = 'driver' AND is_active = 1 ORDER BY name`).all();

  const rows = drivers.map(u => {
    // To'liq to'langan buyurtmalardan yig'im
    const collected = db.prepare(`
      SELECT
        COUNT(o.id) as order_count,
        COALESCE(SUM(COALESCE(
          (SELECT SUM(oi.total_price) FROM order_items oi WHERE oi.order_id = o.id),
          o.total_price
        ) - o.advance_payment), 0) as collected_sum
      FROM orders o
      WHERE o.collected_by = ? AND ${collectedWhere}
    `).get(u.id, ...collectedParams);

    // Avans to'lovlar (hali to'lanmagan buyurtmalardan)
    const advances = db.prepare(`
      SELECT
        COUNT(o.id) as advance_count,
        COALESCE(SUM(o.advance_payment), 0) as advance_sum
      FROM orders o
      WHERE o.assigned_driver_id = ? AND ${advanceWhere}
    `).get(u.id, ...advanceParams);

    return {
      id: u.id,
      name: u.name,
      order_count: (collected.order_count || 0) + (advances.advance_count || 0),
      collected_count: collected.order_count || 0,
      advance_count: advances.advance_count || 0,
      total_collected: (collected.collected_sum || 0) + (advances.advance_sum || 0),
      collected_sum: collected.collected_sum || 0,
      advance_sum: advances.advance_sum || 0,
    };
  });

  // Uncollected (assigned to driver but not paid, no advance)
  const uncollected = db.prepare(`
    SELECT
      u.id as driver_id, u.name as driver_name,
      o.id, o.customer_name, o.total_price, o.advance_payment, o.status
    FROM orders o
    JOIN users u ON u.id = o.assigned_driver_id
    WHERE o.payment_status = 'tolanmagan'
      AND o.advance_payment = 0
      AND o.assigned_driver_id IS NOT NULL
    ORDER BY o.created_at DESC
  `).all();

  res.json({ drivers: rows, uncollected });
});

module.exports = router;
