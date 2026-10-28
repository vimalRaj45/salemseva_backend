// Guard for the scripts that delete or rewrite production data.
//
// These live under src/db, next to the code that boots the server, and `npm run truncate` is
// one keystroke from `npm run start`. A wrong terminal therefore wiped the live database.
// They now require an explicit confirmation and refuse to run against production at all.

function requireDestructive(scriptName) {
  if (process.env.NODE_ENV === 'production') {
    console.error(`[${scriptName}] Refusing to run: NODE_ENV is production.`);
    process.exit(1);
  }
  if (process.env.CONFIRM_DESTRUCTIVE !== 'yes') {
    console.error(
      `[${scriptName}] Refusing to run without confirmation.\n` +
      'This script deletes or rewrites data. Re-run with CONFIRM_DESTRUCTIVE=yes and the\n' +
      'correct DATABASE_URL if that is really what you mean.'
    );
    process.exit(1);
  }
  console.log(`[${scriptName}] Confirmed. Target database: ${describeTarget()}`);
}

function describeTarget() {
  const url = process.env.DATABASE_URL || '';
  try {
    const parsed = new URL(url);
    const db = parsed.pathname.replace(/^\//, '') || '(default)';
    return `${parsed.hostname}/${db}`;
  } catch (_) {
    return url ? '(unparseable DATABASE_URL)' : '(DATABASE_URL not set)';
  }
}

module.exports = { requireDestructive, describeTarget };
