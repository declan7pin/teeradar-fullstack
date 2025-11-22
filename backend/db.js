// backend/db.js
import pkg from "pg";
const { Pool } = pkg;

// Use Render env var in Prod, fall back to literal string for local dev
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://teeradar_user_user:ANWbR8pIDv1yjiRJ5MXBvWpamjuRq3FN@dpg-d4fed4a4d50c73a12t9g-a/teeradar_user";

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
});

export default {
  query: (text, params) => pool.query(text, params),
};