import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error(
    "FATAL: DATABASE_URL is not set. Copy .env.example to .env and paste your Supabase Postgres connection string."
  );
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires TLS; its cert chain isn't always in Node's default
  // trust store, so we verify encryption without pinning the CA.
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle Postgres client", err);
});

export function query(text, params) {
  return pool.query(text, params);
}

// Runs fn(client) inside a real Postgres transaction. Unlike the previous
// SQLite version, statements here are async and DO interleave with other
// connections — correctness against concurrent spins comes from row locks
// (`SELECT ... FOR UPDATE`) and atomic `UPDATE ... RETURNING`, not from
// Node's single-threadedness. See spin.js.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS offers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    offer_type TEXT NOT NULL DEFAULT 'percentage' CHECK (offer_type IN ('percentage', 'custom')),
    discount_percentage INTEGER,
    weight INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    max_claims INTEGER,
    claims_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (offer_type = 'percentage' AND discount_percentage IS NOT NULL)
      OR (offer_type = 'custom' AND discount_percentage IS NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS participants (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    normalized_phone TEXT NOT NULL UNIQUE,
    department TEXT NOT NULL,
    department_other TEXT,
    year TEXT,
    college_name TEXT,
    has_spun BOOLEAN NOT NULL DEFAULT FALSE,
    offer_id INTEGER REFERENCES offers(id),
    offer_name TEXT,
    offer_type TEXT,
    discount_percentage INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_participants_created_at ON participants(created_at);
  CREATE INDEX IF NOT EXISTS idx_participants_department ON participants(department);
`;

const SEED_OFFERS = [
  { name: "50% Discount", discount_percentage: 50, weight: 5 },
  { name: "40% Discount", discount_percentage: 40, weight: 10 },
  { name: "30% Discount", discount_percentage: 30, weight: 15 },
  { name: "20% Discount", discount_percentage: 20, weight: 25 },
  { name: "15% Discount", discount_percentage: 15, weight: 20 },
  { name: "10% Discount", discount_percentage: 10, weight: 15 },
  { name: "5% Discount", discount_percentage: 5, weight: 10 },
];

async function seedOffers() {
  const { rows } = await query("SELECT COUNT(*)::int AS c FROM offers");
  if (rows[0].c > 0) return;

  await withTransaction(async (client) => {
    for (const offer of SEED_OFFERS) {
      await client.query(
        `INSERT INTO offers (name, discount_percentage, weight, is_active) VALUES ($1, $2, $3, TRUE)`,
        [offer.name, offer.discount_percentage, offer.weight]
      );
    }
  });
}

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";

  if (!email || !password) {
    console.warn("[seed] ADMIN_EMAIL / ADMIN_PASSWORD not set — skipping admin seed.");
    return;
  }

  const { rows } = await query("SELECT id FROM admins WHERE email = $1", [email]);
  if (rows.length > 0) return;

  const passwordHash = bcrypt.hashSync(password, 12);
  await query("INSERT INTO admins (email, password_hash, role) VALUES ($1, $2, 'admin')", [
    email,
    passwordHash,
  ]);
  console.log(`[seed] Created initial admin account for ${email}`);
}

export async function initDb() {
  await query(SCHEMA_SQL);
  await seedOffers();
  await seedAdmin();
}
