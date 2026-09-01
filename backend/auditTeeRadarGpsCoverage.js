// backend/auditTeeRadarGpsCoverage.js

import db from "./db.js";

import {
  searchGolfCourses,
  getGolfCourseGreenCenters,
} from "./golfCoursesApi.js";


// =========================================================
// SETTINGS
// =========================================================

const DELAY_BETWEEN_REQUESTS_MS = 600;

const STATES = [
  "WA",
  "NSW",
  "VIC",
  "QLD",
  "SA",
  "TAS",
  "ACT",
  "NT",
];


// =========================================================
// STATE NAMES
// =========================================================

function normaliseState(state) {
  const value =
    String(state || "")
      .trim()
      .toUpperCase();

  const map = {
    "WESTERN AUSTRALIA": "WA",
    "NEW SOUTH WALES": "NSW",
    "VICTORIA": "VIC",
    "QUEENSLAND": "QLD",
    "SOUTH AUSTRALIA": "SA",
    "TASMANIA": "TAS",
    "AUSTRALIAN CAPITAL TERRITORY": "ACT",
    "NORTHERN TERRITORY": "NT",
  };

  return map[value] || value;
}


// =========================================================
// COURSE NAME CLEANING
// =========================================================

function cleanCourseName(name) {
  let value =
    String(name || "").trim();

  /*
   * Collapse TeeRadar scorecard variants:
   *
   * The Cut 18
   * The Cut - 18
   * The Cut - Front 9
   * The Cut Front 9
   * The Cut - Back 9
   * The Cut Back 9
   *
   * all become:
   *
   * The Cut
   */

  value = value
    .replace(
      /\s*[-–—]?\s*front\s*9(?:\s*holes?)?\s*$/i,
      ""
    )
    .replace(
      /\s*[-–—]?\s*back\s*9(?:\s*holes?)?\s*$/i,
      ""
    )
    .replace(
      /\s*[-–—]?\s*front\s*nine\s*$/i,
      ""
    )
    .replace(
      /\s*[-–—]?\s*back\s*nine\s*$/i,
      ""
    )
    .replace(
      /\s*[-–—]?\s*18\s*holes?\s*$/i,
      ""
    )
    .replace(
      /\s*[-–—]?\s*9\s*holes?\s*$/i,
      ""
    )
    .replace(
      /\s*[-–—]?\s*18\s*$/i,
      ""
    )
    .trim();

  return value;
}


// =========================================================
// NAME MATCHING
// =========================================================

function normaliseName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bgolf\b/g, "")
    .replace(/\bcourse\b/g, "")
    .replace(/\bclub\b/g, "")
    .replace(/\bresort\b/g, "")
    .replace(/\bestate\b/g, "")
    .replace(/\bthe\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}


function namesAreSimilar(
  teeRadarName,
  providerName
) {
  const a =
    normaliseName(teeRadarName);

  const b =
    normaliseName(providerName);

  if (!a || !b) {
    return false;
  }

  if (a === b) {
    return true;
  }

  if (
    a.includes(b) ||
    b.includes(a)
  ) {
    return true;
  }

  return false;
}


// =========================================================
// HELPERS
// =========================================================

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(resolve, ms)
  );
}


function extractCourses(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (
    data &&
    Array.isArray(data.courses)
  ) {
    return data.courses;
  }

  if (
    data &&
    Array.isArray(data.data)
  ) {
    return data.data;
  }

  if (
    data?.data &&
    Array.isArray(data.data.courses)
  ) {
    return data.data.courses;
  }

  return [];
}


function extractGreens(data) {

  // Golf Courses API actual response:
  //
  // {
  //   data: {
  //     course_id: 3819,
  //     holes: [
  //       { hole: 1, lat: ..., lng: ... },
  //       ...
  //     ]
  //   }
  // }

  if (
    data?.data &&
    Array.isArray(data.data.holes)
  ) {
    return data.data.holes;
  }

  // Other possible response formats,
  // kept here as fallbacks.

  if (Array.isArray(data)) {
    return data;
  }

  if (
    data &&
    Array.isArray(data.holes)
  ) {
    return data.holes;
  }

  if (
    data &&
    Array.isArray(data.greens)
  ) {
    return data.greens;
  }

  if (
    data &&
    Array.isArray(data.green_centers)
  ) {
    return data.green_centers;
  }

  if (
    data &&
    Array.isArray(data.greenCenters)
  ) {
    return data.greenCenters;
  }

  if (
    data &&
    Array.isArray(data.data)
  ) {
    return data.data;
  }

  if (
    data?.data &&
    Array.isArray(
      data.data.green_centers
    )
  ) {
    return data.data.green_centers;
  }

  if (
    data?.data &&
    Array.isArray(
      data.data.greens
    )
  ) {
    return data.data.greens;
  }

  return [];
}

// =========================================================
// PROVIDER STATE MATCH
// =========================================================

function providerStateMatches(
  providerCourse,
  teeRadarState
) {
  const wanted =
    normaliseState(teeRadarState);

  const candidates = [
    providerCourse?.state,
    providerCourse?.state_code,
    providerCourse?.region,
    providerCourse?.province,
    providerCourse?.location?.state,
    providerCourse?.location?.state_code,
    providerCourse?.address?.state,
  ]
    .filter(Boolean)
    .map(normaliseState);

  /*
   * If the API result doesn't provide a state,
   * don't reject it solely for that reason.
   */
  if (!candidates.length) {
    return true;
  }

  return candidates.includes(wanted);
}


// =========================================================
// FIND BEST PROVIDER MATCH
// =========================================================

function findBestMatch(
  teeRadarName,
  teeRadarState,
  providerCourses
) {

  if (!providerCourses.length) {
    return null;
  }

  const stateMatches =
    providerCourses.filter(
      (course) =>
        providerStateMatches(
          course,
          teeRadarState
        )
    );

  const candidates =
    stateMatches.length
      ? stateMatches
      : providerCourses;

  /*
   * First preference:
   * normalised name match.
   */
  const nameMatch =
    candidates.find(
      (course) =>
        namesAreSimilar(
          teeRadarName,
          course?.name
        )
    );

  if (nameMatch) {
    return nameMatch;
  }

  /*
   * We deliberately DO NOT blindly accept
   * the first search result.
   *
   * A wrong GPS course is much worse than
   * reporting NO MATCH.
   */
  return null;
}


// =========================================================
// LOAD TEERADAR COURSES
// =========================================================

async function loadTeeRadarCourses() {

  const result =
    await db.query(`
      SELECT
        id,
        name,
        state,
        holes
      FROM scorecard_courses
      WHERE
        name IS NOT NULL
        AND TRIM(name) <> ''
        AND state IS NOT NULL
        AND TRIM(state) <> ''
      ORDER BY
        state,
        name
    `);

  const rows =
    result.rows || [];

  /*
   * Collapse:
   *
   * Course 18
   * Course Front 9
   * Course Back 9
   *
   * into ONE physical golf course.
   */

  const unique =
    new Map();

  for (const row of rows) {

    const state =
      normaliseState(row.state);

    if (!STATES.includes(state)) {
      continue;
    }

    const cleanedName =
      cleanCourseName(row.name);

    if (!cleanedName) {
      continue;
    }

    const key =
      `${state}|${normaliseName(
        cleanedName
      )}`;

    if (!unique.has(key)) {
      unique.set(
        key,
        {
          state,
          name: cleanedName,
          templates: [],
        }
      );
    }

    unique
      .get(key)
      .templates
      .push({
        id: row.id,
        name: row.name,
        holes: row.holes,
      });
  }

  return Array.from(
    unique.values()
  );
}


// =========================================================
// AUDIT ONE COURSE
// =========================================================

async function auditCourse(course) {

  console.log("");
  console.log(
    `🔎 ${course.state} | ${course.name}`
  );

  let searchData;

  try {

    searchData =
      await searchGolfCourses({
        query: course.name,
        country: "AU",
        perPage: 25,
      });

  } catch (err) {

    console.log(
      `   ❌ SEARCH ERROR: ${err.message}`
    );

    return {
      ...course,
      status: "SEARCH_ERROR",
      providerId: null,
      providerName: null,
      greenCount: 0,
      error: err.message,
    };
  }

  const providerCourses =
    extractCourses(searchData);

  const match =
    findBestMatch(
      course.name,
      course.state,
      providerCourses
    );

  if (!match) {

    console.log(
      "   ❌ NO API MATCH"
    );

    return {
      ...course,
      status: "NO_MATCH",
      providerId: null,
      providerName: null,
      greenCount: 0,
      error: null,
    };
  }

  const providerId =
    match.id ??
    match.course_id ??
    null;

  const providerName =
    match.name ||
    "(unknown provider name)";

  if (!providerId) {

    console.log(
      `   ⚠️ MATCHED "${providerName}" but no provider ID`
    );

    return {
      ...course,
      status: "MATCH_NO_ID",
      providerId: null,
      providerName,
      greenCount: 0,
      error: null,
    };
  }

  console.log(
    `   ↳ ${providerName} | API ID ${providerId}`
  );

  await sleep(
    DELAY_BETWEEN_REQUESTS_MS
  );

  let greenData;

  try {

    greenData =
      await getGolfCourseGreenCenters(
        providerId
      );

  } catch (err) {

    /*
     * The provider may return an error when
     * green centres are unavailable.
     *
     * For this audit that means:
     * matched course, but no usable GPS.
     */

    console.log(
      `   ⚠️ MATCHED / NO GREEN CENTRES`
    );

    console.log(
      `      ${err.message}`
    );

    return {
      ...course,
      status: "MATCHED_NO_GREENS",
      providerId,
      providerName,
      greenCount: 0,
      error: err.message,
    };
  }

  const greens =
    extractGreens(greenData);

  const validGreens =
    greens.filter(
      (green) => {

        const lat =
          Number(
            green?.lat ??
            green?.latitude
          );

        const lng =
          Number(
            green?.lng ??
            green?.lon ??
            green?.longitude
          );

        return (
          Number.isFinite(lat) &&
          Number.isFinite(lng)
        );
      }
    );

  const greenCount =
    validGreens.length;

  if (!greenCount) {

    console.log(
      "   ⚠️ MATCHED / NO GREEN CENTRES"
    );

    return {
      ...course,
      status: "MATCHED_NO_GREENS",
      providerId,
      providerName,
      greenCount: 0,
      error: null,
    };
  }

  console.log(
    `   ✅ API GPS | ${greenCount} green centres`
  );

  return {
    ...course,
    status: "API_GPS",
    providerId,
    providerName,
    greenCount,
    error: null,
  };
}


// =========================================================
// PRINT STATE RESULTS
// =========================================================

function printStateResults(
  state,
  results
) {

  console.log("");
  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    `${state} GPS COVERAGE`
  );

  console.log(
    "=================================================="
  );

  const stateResults =
    results.filter(
      (row) =>
        row.state === state
    );

  if (!stateResults.length) {

    console.log(
      "No TeeRadar courses found."
    );

    return;
  }

  stateResults.forEach(
    (row, index) => {

      let icon = "❌";

      if (
        row.status === "API_GPS"
      ) {
        icon = "✅";
      }

      if (
        row.status ===
        "MATCHED_NO_GREENS"
      ) {
        icon = "⚠️";
      }

      console.log(
        `${String(index + 1).padStart(
          2,
          " "
        )}. ${icon} ${row.name}`
      );

      if (row.providerName) {

        console.log(
          `    API: ${row.providerName}` +
          ` | ID ${row.providerId}` +
          ` | Greens ${row.greenCount}`
        );
      } else {

        console.log(
          `    ${row.status}`
        );
      }
    }
  );

  const gps =
    stateResults.filter(
      (row) =>
        row.status === "API_GPS"
    ).length;

  const noGreens =
    stateResults.filter(
      (row) =>
        row.status ===
        "MATCHED_NO_GREENS"
    ).length;

  const noMatch =
    stateResults.filter(
      (row) =>
        row.status === "NO_MATCH"
    ).length;

  console.log("");
  console.log(
    `${state}: ${stateResults.length} checked` +
    ` | ${gps} with GPS` +
    ` | ${noGreens} matched/no greens` +
    ` | ${noMatch} no match`
  );
}


// =========================================================
// MAIN
// =========================================================

async function main() {

  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    "TEERADAR GPS COVERAGE AUDIT"
  );

  console.log(
    "=================================================="
  );

  console.log("");
  console.log(
    "Loading TeeRadar scorecard courses..."
  );

  const courses =
    await loadTeeRadarCourses();

  console.log(
    `Found ${courses.length} unique physical courses.`
  );

  const results = [];

  for (
    let i = 0;
    i < courses.length;
    i += 1
  ) {

    const course =
      courses[i];

    console.log("");
    console.log(
      `[${i + 1}/${courses.length}]`
    );

    const result =
      await auditCourse(course);

    results.push(result);

    await sleep(
      DELAY_BETWEEN_REQUESTS_MS
    );
  }


  // =======================================================
  // STATE RESULTS
  // =======================================================

  for (const state of STATES) {
    printStateResults(
      state,
      results
    );
  }


  // =======================================================
  // OVERALL SUMMARY
  // =======================================================

  const apiGps =
    results.filter(
      (row) =>
        row.status === "API_GPS"
    );

  const matchedNoGreens =
    results.filter(
      (row) =>
        row.status ===
        "MATCHED_NO_GREENS"
    );

  const noMatch =
    results.filter(
      (row) =>
        row.status === "NO_MATCH"
    );

  const errors =
    results.filter(
      (row) =>
        row.status ===
          "SEARCH_ERROR" ||
        row.status ===
          "MATCH_NO_ID"
    );


  console.log("");
  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    "TEERADAR GPS COVERAGE SUMMARY"
  );

  console.log(
    "=================================================="
  );

  console.log(
    `Total courses checked: ${results.length}`
  );

  console.log(
    `✅ API GPS: ${apiGps.length}`
  );

  console.log(
    `⚠️ Matched / no greens: ${matchedNoGreens.length}`
  );

  console.log(
    `❌ No API match: ${noMatch.length}`
  );

  console.log(
    `❗ Errors: ${errors.length}`
  );


  // =======================================================
  // MANUAL GPS LIST
  // =======================================================

  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    "COURSES TO CONSIDER FOR MANUAL GPS"
  );

  console.log(
    "=================================================="
  );

  for (const state of STATES) {

    const missing =
      results.filter(
        (row) =>
          row.state === state &&
          row.status !== "API_GPS"
      );

    if (!missing.length) {
      continue;
    }

    console.log("");
    console.log(state);

    for (const row of missing) {

      let reason =
        row.status;

      if (
        row.status ===
        "MATCHED_NO_GREENS"
      ) {
        reason =
          "API match, no greens";
      }

      if (
        row.status ===
        "NO_MATCH"
      ) {
        reason =
          "No API match";
      }

      console.log(
        `  - ${row.name} (${reason})`
      );
    }
  }

  console.log("");
  console.log(
    "Audit complete."
  );
}


// =========================================================
// RUN
// =========================================================

main()
  .catch(
    (err) => {

      console.error("");
      console.error(
        "❌ GPS audit failed:"
      );

      console.error(err);

      process.exitCode = 1;
    }
  )
  .finally(
    async () => {

      /*
       * Close Postgres connection cleanly
       * if db.js exports a pg Pool.
       */

      try {

        if (
          db &&
          typeof db.end === "function"
        ) {
          await db.end();
        }

      } catch {
        // ignore shutdown errors
      }
    }
  );
