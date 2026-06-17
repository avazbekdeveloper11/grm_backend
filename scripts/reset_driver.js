const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../gilam.db');
const db = new DatabaseSync(DB_PATH);

const driverId = process.argv[2];

if (!driverId) {
  console.log("Iltimos, haydovchi ID sini kiriting. Masalan: node --experimental-sqlite scripts/reset_driver.js 5");
  console.log("\nMavjud haydovchilar ro'yxati:");
  try {
    const drivers = db.prepare("SELECT id, name, login FROM users WHERE role = 'driver'").all();
    console.table(drivers);
  } catch (err) {
    console.error("Xatolik: users jadvalini o'qib bo'lmadi:", err.message);
  }
  process.exit(1);
}

const targetId = Number(driverId);
let driver;
try {
  driver = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'driver'").get(targetId);
} catch (err) {
  console.error("Xatolik: foydalanuvchini izlashda xato:", err.message);
  process.exit(1);
}

if (!driver) {
  console.error(`Xatolik: ID si ${driverId} bo'lgan haydovchi topilmadi.`);
  process.exit(1);
}

console.log(`Haydovchi '${driver.name}' (ID: ${driver.id}) hisobi nollashtirilmoqda...`);

db.exec("BEGIN TRANSACTION");
try {
  // 1. Settlements tozalash
  const delSettlements = db.prepare("DELETE FROM driver_settlements WHERE driver_id = ?").run(driver.id);
  console.log(`- Topshirilgan pullar tarixi o'chirildi (${delSettlements.changes} ta qator)`);

  // 2. Buyurtmalardagi collected_by ni NULL qilish (buyurtmalar o'chirilmaydi, faqat haydovchidan uziladi)
  const updateCollected = db.prepare("UPDATE orders SET collected_by = NULL WHERE collected_by = ?").run(driver.id);
  console.log(`- Yig'ilgan buyurtmalar haydovchidan uzildi (${updateCollected.changes} ta buyurtma)`);

  // 3. Avans to'lovlari bor faol buyurtmalardan haydovchini uzish
  const updateAdvances = db.prepare("UPDATE orders SET assigned_driver_id = NULL WHERE assigned_driver_id = ? AND payment_status != 'tolangan'").run(driver.id);
  console.log(`- Avans to'lovi bor buyurtmalar haydovchidan uzildi (${updateAdvances.changes} ta buyurtma)`);

  db.exec("COMMIT");
  console.log("\nMuvaffaqiyatli yakunlandi! Haydovchi balansi 0 ga tushirildi.");
} catch (error) {
  db.exec("ROLLBACK");
  console.error("Xatolik yuz berdi, o'zgarishlar bekor qilindi:", error.message);
}
