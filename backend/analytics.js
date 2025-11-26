// backend/analytics.js
// Simple in-memory analytics store for TeeRadar

// Each event: { type, at: ISO string, userId, courseName }
const events = [];

/**
 * Record a single analytics event.
 * Called from /api/analytics/event
 */
export function recordEvent({ type, at, userId, courseName }) {
  try {
    const timestamp = at ? new Date(at).toISOString() : new Date().toISOString();

    events.push({
      type,
      at: timestamp,
      userId: userId || null,
      courseName: courseName || null,
    });

    // Optional debug log
    console.log("📈 stored analytics event:", {
      type,
      at: timestamp,
      userId,
      courseName,
    });
  } catch (err) {
    console.error("analytics recordEvent error:", err);
  }
}

/**
 * Build a summary object for the dashboard.
 * Called from GET /api/analytics
 */
export async function getAnalyticsSummary() {
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const ONE_WEEK = 7 * ONE_DAY;

  let homePageViews = 0;
  let courseBookingClicks = 0;
  let searches = 0;
  let newUsers = 0;

  const userIdsAllTime = new Set();
  const userIdsToday = new Set();
  const userIdsWeek = new Set();

  // courseName -> click count
  const courseClickCounts = new Map();

  for (const ev of events) {
    const t = new Date(ev.at).getTime();
    const age = now - t;

    const userId = ev.userId || null;
    const isToday = age < ONE_DAY;
    const isWeek = age < ONE_WEEK;

    switch (ev.type) {
      case "home_view":
        homePageViews++;
        break;
      case "course_booking_click":
        courseBookingClicks++;
        if (ev.courseName) {
          const key = ev.courseName;
          courseClickCounts.set(key, (courseClickCounts.get(key) || 0) + 1);
        }
        break;
      case "search":
        searches++;
        break;
      case "new_user":
        newUsers++;
        break;
      default:
        // ignore other event types for now
        break;
    }

    if (userId) {
      userIdsAllTime.add(userId);
      if (isToday) userIdsToday.add(userId);
      if (isWeek) userIdsWeek.add(userId);
    }
  }

  // Build top courses list
  const topCourses = Array.from(courseClickCounts.entries())
    .map(([courseName, clicks]) => ({ courseName, clicks }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10);

  return {
    // key metrics
    homePageViews,
    courseBookingClicks,
    searches,
    newUsers,

    // user overview
    usersAllTime: userIdsAllTime.size,
    usersToday: userIdsToday.size,
    usersWeek: userIdsWeek.size,

    // per-course stats
    topCourses,
  };
}