const postgres = require('postgres');

// One-time migration: copies every row of site_data from the old Neon database
// into the new Supabase database. Admin-authed. Delete this file once migration is confirmed.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { adminEmail, adminPass } = req.body || {};
  if (
    !adminEmail || !adminPass ||
    adminEmail !== process.env.ADMIN_EMAIL ||
    adminPass  !== process.env.ADMIN_PASS
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.DATABASE_URL) {
    return res.status(503).json({ error: 'Source (Neon DATABASE_URL) not configured' });
  }
  if (!process.env.SUPABASE_DATABASE_URL) {
    return res.status(503).json({ error: 'Target (SUPABASE_DATABASE_URL) not configured' });
  }

  const neonSql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false });
  const supaSql = postgres(process.env.SUPABASE_DATABASE_URL, { ssl: 'require', prepare: false });

  try {
    const rows = await neonSql`SELECT key, value, updated_at FROM site_data`;

    await supaSql`
      CREATE TABLE IF NOT EXISTS site_data (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    const migrated = [];
    for (const row of rows) {
      const jsonValue = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
      await supaSql`
        INSERT INTO site_data (key, value, updated_at)
        VALUES (${row.key}, ${jsonValue}::jsonb, ${row.updated_at})
        ON CONFLICT (key) DO UPDATE
          SET value      = ${jsonValue}::jsonb,
              updated_at = ${row.updated_at}
      `;
      migrated.push(row.key);
    }

    const supaCount = await supaSql`SELECT COUNT(*)::int AS n FROM site_data`;

    return res.json({
      success: true,
      neonRowCount: rows.length,
      migratedKeys: migrated,
      supabaseRowCountAfter: supaCount[0].n,
    });
  } catch (err) {
    console.error('[migrate-to-supabase]', err.message);
    return res.status(500).json({ error: err.message });
  } finally {
    await neonSql.end({ timeout: 1 });
    await supaSql.end({ timeout: 1 });
  }
};
