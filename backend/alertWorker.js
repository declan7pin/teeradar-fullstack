// backend/alertWorker.js
// Simple no-op alert worker so the import in server.js doesn't break on Render.
// You can replace this later with the real implementation.

export function startAlertWorker() {
  console.log("🔔 Alert worker started (stub). No background jobs are running yet.");
}
