// backend/db.js
import pkg from "pg";

const { Pool } = pkg;

// Render injects DATABASE_URL as an env var.
const connectionString =
  process.env.DATABASE_URL ||
  "YOUR_EXISTING_FALLBACK_CONNECTION_STRING";

const pool = new Pool({
  connectionString,

  ssl: {
    rejectUnauthorized: false,
  },

  // -------------------------------------------------
  // Pool protection
  // -------------------------------------------------
  max: Number(process.env.PG_POOL_MAX) || 10,

  // Don't allow requests to wait forever for a connection.
  connectionTimeoutMillis: 5000,

  // Release unused connections after 30 seconds.
  idleTimeoutMillis: 30000,

  // Don't allow a single DB query to run forever.
  statement_timeout: 15000,
  query_timeout: 20000,
});

// -------------------------------------------------
// Pool error logging
// -------------------------------------------------
pool.on("error", (err) => {
  console.error("❌ Unexpected Postgres pool error:", err);
});

// -------------------------------------------------
// Initial connection test
// -------------------------------------------------
pool
  .connect()
  .then((client) => {
    console.log("✅ Connected to Postgres");

    console.log("📊 Initial Postgres pool:", {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });

    client.release();
  })
  .catch((err) => {
    console.error("❌ Postgres connection error:", err.message);
  });

// -------------------------------------------------
// Database interface
// -------------------------------------------------
const db = {
  query: (text, params) => pool.query(text, params),

  // Transaction-safe usage
  connect: () => pool.connect(),

  // Diagnostic information
  getPoolStats: () => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }),
};

export default db;
