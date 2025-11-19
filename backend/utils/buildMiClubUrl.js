// backend/utils/buildMiClubUrl.js

import courses from "../data/courses.json" assert { type: "json" };
import feeGroups from "../data/fee_groups.json" assert { type: "json" };

// Fast lookup by course name
const courseMap = new Map(courses.map((c) => [c.name, c]));

/**
 * Build a clean, deep MiClub URL for a given course + date.
 *
 * - Uses fee_groups.json for bookingResourceId + feeGroupId
 * - Uses courses.json to get the correct host/path
 * - Does NOT include any recaptchaResponse garbage
 * - Forces selectedDate to the user's chosen date (YYYY-MM-DD)
 */
export function buildMiClubUrl(courseName, date) {
  const feeInfo = feeGroups[courseName];
  const course = courseMap.get(courseName);

  // If we don't know feeGroup or don't recognise the course, just fall back
  if (!course || !feeInfo) {
    return course?.url || null;
  }

  // Start from the URL you gave me in courses.json
  const url = new URL(course.url);

  // Wipe out any old query params completely (including stale selectedDate, recaptchaResponse, etc.)
  url.search = "";

  // Rebuild with the correct MiClub params
  url.searchParams.set("bookingResourceId", feeInfo.bookingResourceId);
  url.searchParams.set("feeGroupId", feeInfo.feeGroupId);
  url.searchParams.set("selectedDate", date); // YYYY-MM-DD from the search

  return url.toString();
}

export default buildMiClubUrl;
