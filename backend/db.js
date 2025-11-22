// backend/db.js
import pkg from "pg";

const { Pool } = pkg;

// Render exposes DATABASE_URL for your Postgres instance.
// We also allow a local fallback for dev if you ever need it.
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://teeradar_user_user:ANWbR8pIDv1yjiRJ5MXBvWpamjuRq3FN@dpg-d4fed4a4d50c73a12t9g-a/teeradar_user";

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false, // required for Render's managed Postgres
  },
});

// Simple helper so we can log connection issues early
pool
  .connect()
  .then((client) => {
    console.log("✅ Connected to Postgres");
    client.release();
  })
  .catch((err) => {
    console.error("❌ Postgres connection error:", err.message);
  });

export default {
  query: (text, params) => pool.query(text, params),
};