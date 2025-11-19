// backend/analytics.js
//
// Simple in-memory analytics store.
// This resets on each redeploy/restart, but is very reliable
// and requires no native modules or WASM.
//
// It supports:
//  - homeViews (type = "home_view")
//  - searches  (type = "search")
//  - bookingClicks (type = "booking_click")
//  - unique users (all time, today, last 7 days)
//  - new users in last 7 days
//  - most-clicked courses

// Store every event in memory
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

  // Optional: hard cap to avoid unbounded growth
  if (events.length > 50000) {
    events.splice(0, events.length - 50000);
  }
}

/**
 * Get summary metrics for the admin dashboard.
 *  - homeViews: total home page views
 *  - searches: total searches
 *  - bookingClicks: total booking clicks
 *  - usersAllTime: distinct users (all events)
 *  - usersToday: distinct users since local midnight
 *  - usersWeek: distinct users in last 7 days
 *  - newUsers7d: users whose first-ever event was in last 7 days
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

  // Track first-seen per user for "new in last 7 days"
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
  for (const [_, first] of firstSeen.entries()) {
    if (first >= sevenDaysAgo) newUsers7d++;
  }

  return {
    homeViews,
    searches,
    bookingClicks,
    usersAllTime: allUserIds.size,
    usersToday: todayUserIds.size,
    usersWeek: weekUserIds.size,
    newUsers7d
  };
}

/**
 * Get the most-clicked courses for the "Most clicked courses" panel.
 * Returns an array of { courseName, clicks }.
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

  return arr;
}