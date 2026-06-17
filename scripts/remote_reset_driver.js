const readline = require('readline');

const BASE_URL = 'http://xnc9fjs58xbbiimup042ie3w.178.104.171.171.sslip.io';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function main() {
  console.log("=== Masofaviy Haydovchi Balansini Nollashtirish Tool ===");
  console.log(`Server: ${BASE_URL}\n`);

  const login = await ask("Admin loginini kiriting: ");
  const password = await ask("Admin parolini kiriting: ");

  console.log("\nTizimga kirilmoqda...");
  try {
    const loginRes = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password })
    });

    if (!loginRes.ok) {
      const err = await loginRes.json();
      throw new Error(err.error || "Login yoki parol xato");
    }

    const { token } = await loginRes.json();
    console.log("✓ Login muvaffaqiyatli amalga oshirildi.");

    console.log("\nHaydovchilar ro'yxati yuklanmoqda...");
    const usersRes = await fetch(`${BASE_URL}/api/users?role=driver`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!usersRes.ok) {
      throw new Error("Haydovchilar ro'yxatini olib bo'lmadi");
    }

    const drivers = await usersRes.json();
    if (drivers.length === 0) {
      console.log("Hech qanday haydovchi topilmadi.");
      rl.close();
      return;
    }

    console.log("\nMavjud haydovchilar:");
    drivers.forEach(d => {
      console.log(`[ID: ${d.id}] - ${d.name} (${d.login})`);
    });

    const driverId = await ask("\nNollashtirmoqchi bo'lgan haydovchingiz ID sini kiriting: ");
    const selected = drivers.find(d => d.id == driverId);

    if (!selected) {
      console.log("Xatolik: Bunday ID dagi haydovchi ro'yxatda yo'q.");
      rl.close();
      return;
    }

    const confirm = await ask(`\nDiqqat! '${selected.name}' hisobini 0 ga tushirishni tasdiqlaysizmi? (ha/yo'q): `);
    if (confirm.toLowerCase() !== 'ha') {
      console.log("Bekor qilindi.");
      rl.close();
      return;
    }

    console.log("\nHisob nollashtirilmoqda...");
    const resetRes = await fetch(`${BASE_URL}/api/reset/driver/${driverId}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      }
    });

    const result = await resetRes.json();
    if (!resetRes.ok) {
      throw new Error(result.error || "Nollashtirishda xatolik yuz berdi");
    }

    console.log(`\n✓ ${result.message}`);
  } catch (error) {
    console.error(`\nXatolik yuz berdi: ${error.message}`);
  } finally {
    rl.close();
  }
}

main();
