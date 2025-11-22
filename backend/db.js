// backend/db.js
import pkg from "pg";

const { Pool } = pkg;

// Render will inject DATABASE_URL as an env var.
// We also keep your hard-coded fallback for safety.
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://teeradar_user_user:ANWbR8pIDv1yjiRJ5MXBvWpamjuRq3FN@dpg-d4fed4a4d50c73a12t9g-a/teeradar_user";

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false, // required for Render managed Postgres
  },
});

// Just to log whether we can connect
pool
  .connect()
  .then((client) => {
    console.log("✅ Connected to Postgres");
    client.release();
  })
  .catch((err) => {
    console.error("❌ Postgres connection error:", err.message);
  });

const db = {
  query: (text, params) => pool.query(text, params),
};

export default db;