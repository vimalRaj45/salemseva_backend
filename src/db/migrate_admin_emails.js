const db = require('./db');

async function updateEmails() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Attempt ${attempt}: updating admin_team emails...`);
      const res = await db.query(
        "UPDATE admin_team SET email = REPLACE(email, '@Shazu One.in', '@shazuone.in') WHERE email LIKE '%@Shazu One.in'"
      );
      console.log(`Updated rows: ${res.rowCount}`);
      const check = await db.query('SELECT name, role, email FROM admin_team');
      console.log('Current admin team:', check.rows);
      break;
    } catch (e) {
      console.error(`Attempt ${attempt} error:`, e.message);
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  await db.pool.end();
}

updateEmails();
