// backend/analytics.js
//
// Simple in-memory analytics store.
// Resets on each restart/redeploy, but needs no DB/sql.js.
//
// Tracks:
//  - homeViews (type = "home_view")
//  - searches  (type = "search")
//  - bookingClicks (type = "booking_click")
//  - unique users (all time, today, last 7 days, new users last 7 days)
//  - most-clicked courses

// Array of all events:
// { type, userId, courseName, createdAt: Date }
const events = [];

/**
 * Record a single analytics event.
 * @param {Object} param0
 *   type: "home_view" | "search" | "booking_click" | ...
 *   userId: string | null
 *   courseName: string | null
 *   at: ISO timestamp (optional)
 */
export async function recordEvent({ type, userId, courseName, at }) {
  if (!type) return;

  const createdAt = at ? new Date(at) : new Date();

  events.push({
    type,
    userId: userId || null,
    courseName: courseName || null,
    createdAt
  });

  // Safety cap so memory doesn't grow forever
  if (events.length > 50000) {
    events.splice(0, events.length - 50000);
  }

  // Debug:
  console.log("[analytics] recorded", { type, userId, courseName, createdAt });
}

/**
 * Summary numbers for the admin dashboard.
 */
export async function getAnalyticsSummary() {
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  let homeViews = 0;
  let searches = 0;
  let bookingClicks = 0;

  const allUserIds = new Set();
  const todayUserIds = new Set();
  const weekUserIds = new Set();

  // For "new users" in last 7 days
  const firstSeen = new Map(); // userId -> Date

  for (const ev of events) {
    const { type, userId, createdAt } = ev;

    if (type === "home_view") homeViews++;
    if (type === "search") searches++;
    if (type === "booking_click") bookingClicks++;

    if (!userId) continue;

    allUserIds.add(userId);

    if (createdAt >= startOfToday) {
      todayUserIds.add(userId);
    }
    if (createdAt >= sevenDaysAgo) {
      weekUserIds.add(userId);
    }

    const existing = firstSeen.get(userId);
    if (!existing || createdAt < existing) {
      firstSeen.set(userId, createdAt);
    }
  }

  let newUsers7d = 0;
  for (const [, first] of firstSeen.entries()) {
    if (first >= sevenDaysAgo) newUsers7d++;
  }

  const summary = {
    homeViews,
    searches,
    bookingClicks,
    usersAllTime: allUserIds.size,
    usersToday: todayUserIds.size,
    usersWeek: weekUserIds.size,
    newUsers7d
  };

  console.log("[analytics] summary", summary);
  return summary;
}

/**
 * Most-clicked courses based on booking_click events.
 * Returns [{ courseName, clicks }, ...]
 */
export async function getTopCourses(limit = 5) {
  const counts = new Map(); // courseName -> clicks

  for (const ev of events) {
    if (ev.type !== "booking_click") continue;
    if (!ev.courseName) continue;

    const current = counts.get(ev.courseName) || 0;
    counts.set(ev.courseName, current + 1);
  }

  const arr = [...counts.entries()]
    .map(([courseName, clicks]) => ({ courseName, clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, limit);

  console.log("[analytics] top courses", arr);
  return arr;
}