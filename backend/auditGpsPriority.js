// backend/auditGpsPriority.js

import db from "./db.js";

import {
  searchGolfCourses,
  getGolfCourseGreenCenters,
} from "./golfCoursesApi.js";

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

const STATE_NAMES = {
  WA: "Western Australia",
  NSW: "New South Wales",
  VIC: "Victoria",
  QLD: "Queensland",
  SA: "South Australia",
  TAS: "Tasmania",
  ACT: "Australian Capital Territory",
  NT: "Northern Territory",
};

const WAIT_MS = 600;


// =========================================================
// HELPERS
// =========================================================

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}


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


function cleanCourseName(name) {

  return String(name || "")
    .trim()

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
}


function normaliseName(name) {

  return cleanCourseName(name)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bgolf\b/g, "")
    .replace(/\bcourse\b/g, "")
    .replace(/\bclub\b/g, "")
    .replace(/\bgc\b/g, "")
    .replace(/\binc\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}


// =========================================================
// PROVIDER RESPONSE HELPERS
// =========================================================

function extractSearchResults(data) {

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.courses)) {
    return data.courses;
  }

  if (Array.isArray(data?.data?.courses)) {
    return data.data.courses;
  }

  return [];
}


function extractGreens(data) {

  // Confirmed Golf Courses API format:
  //
  // {
  //   data: {
  //     course_id: 3819,
  //     holes: [...]
  //   }
  // }

  if (Array.isArray(data?.data?.holes)) {
    return data.data.holes;
  }

  if (Array.isArray(data?.holes)) {
    return data.holes;
  }

  if (Array.isArray(data?.greens)) {
    return data.greens;
  }

  if (Array.isArray(data?.green_centers)) {
    return data.green_centers;
  }

  if (Array.isArray(data?.data?.greens)) {
    return data.data.greens;
  }

  if (
    Array.isArray(
      data?.data?.green_centers
    )
  ) {
    return data.data.green_centers;
  }

  return [];
}


function validGreens(data) {

  const greens =
    extractGreens(data);

  return greens.filter((green) => {

    const hole =
      Number(green?.hole);

    const lat =
      Number(green?.lat);

    const lng =
      Number(green?.lng);

    return (
      Number.isFinite(hole) &&
      hole >= 1 &&
      hole <= 18 &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    );
  });
}


// =========================================================
// PROVIDER COURSE HELPERS
// =========================================================

function providerId(course) {

  return (
    course?.id ??
    course?.course_id ??
    course?.courseId ??
    null
  );
}


function providerName(course) {

  return String(
    course?.name ??
    course?.course_name ??
    course?.courseName ??
    ""
  ).trim();
}


function providerStateText(course) {

  const candidates = [
    course?.state,
    course?.state_name,
    course?.region,
    course?.province,
    course?.location?.state,
    course?.location?.state_name,
    course?.address?.state,
  ];

  return candidates
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}


function providerStateMatches(
  course,
  state
) {

  const text =
    providerStateText(course);

  // Provider result has no usable state.
  // Don't reject solely for that.
  if (!text) {
    return true;
  }

  const code =
    state.toLowerCase();

  const full =
    STATE_NAMES[state]
      .toLowerCase();

  return (
    text === code ||
    text.includes(full)
  );
}


function chooseProviderCourse(
  teeRadarCourse,
  results
) {

  const target =
    normaliseName(
      teeRadarCourse.name
    );

  if (!target) {
    return null;
  }

  const stateMatches =
    results.filter(
      (course) =>
        providerStateMatches(
          course,
          teeRadarCourse.state
        )
    );


  // -----------------------------------------
  // Exact normalised match
  // -----------------------------------------

  let matches =
    stateMatches.filter(
      (course) =>
        normaliseName(
          providerName(course)
        ) === target
    );

  if (matches.length === 1) {
    return matches[0];
  }


  // -----------------------------------------
  // Conservative contains match
  // -----------------------------------------

  matches =
    stateMatches.filter(
      (course) => {

        const candidate =
          normaliseName(
            providerName(course)
          );

        if (
          target.length < 6 ||
          candidate.length < 6
        ) {
          return false;
        }

        return (
          candidate.includes(target) ||
          target.includes(candidate)
        );
      }
    );

  if (matches.length === 1) {
    return matches[0];
  }


  // -----------------------------------------
  // Don't guess
  // -----------------------------------------

  return null;
}


// =========================================================
// SCORECARD COURSES
// =========================================================

async function loadCourses() {

  const { rows } =
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
      ORDER BY state, name
    `);


  const map =
    new Map();


  for (const row of rows) {

    const state =
      normaliseState(
        row.state
      );

    if (
      !STATES.includes(state)
    ) {
      continue;
    }


    const name =
      cleanCourseName(
        row.name
      );


    const key =
      `${state}|${normaliseName(name)}`;


    if (!map.has(key)) {

      map.set(key, {
        state,
        name,
        aliases: [],
        searches: 0,
        clicks: 0,
        rounds: 0,
        score: 0,
      });
    }


    const course =
      map.get(key);

    course.aliases.push(
      String(row.name)
    );
  }


  return Array.from(
    map.values()
  );
}


// =========================================================
// ANALYTICS — AGGREGATED IN POSTGRES
// =========================================================

async function loadAnalytics() {

  const { rows } =
    await db.query(`
      SELECT
        course_name,

        COUNT(*) FILTER (
          WHERE type IN (
            'search_course',
            'course_search',
            'searched_course'
          )
        )::int AS searches,

        COUNT(*) FILTER (
          WHERE type IN (
            'booking_click',
            'course_booking_click',
            'booking',
            'book_click',
            'course_booking'
          )
        )::int AS clicks,

        COUNT(
          DISTINCT COALESCE(
            round_key,
            round_id::text
          )
        ) FILTER (
          WHERE type IN (
            'round_played',
            'round_saved',
            'scorecard_saved'
          )
        )::int AS rounds

      FROM analytics

      WHERE
        course_name IS NOT NULL
        AND TRIM(course_name) <> ''

        AND type IN (
          'search_course',
          'course_search',
          'searched_course',

          'booking_click',
          'course_booking_click',
          'booking',
          'book_click',
          'course_booking',

          'round_played',
          'round_saved',
          'scorecard_saved'
        )

      GROUP BY course_name
    `);

  return rows;
}


// =========================================================
// APPLY ANALYTICS
// =========================================================

function applyDemand(
  courses,
  analytics
) {

  const lookup =
    new Map();


  for (const course of courses) {

    const names = [
      course.name,
      ...course.aliases,
    ];


    for (const name of names) {

      const key =
        normaliseName(name);

      if (!key) {
        continue;
      }


      if (!lookup.has(key)) {

        lookup.set(
          key,
          []
        );
      }


      const list =
        lookup.get(key);

      if (
        !list.includes(course)
      ) {

        list.push(course);
      }
    }
  }


  for (const row of analytics) {

    const key =
      normaliseName(
        row.course_name
      );

    if (!key) {
      continue;
    }


    let matches =
      lookup.get(key) || [];


    if (!matches.length) {

      matches =
        courses.filter(
          (course) => {

            const candidate =
              normaliseName(
                course.name
              );

            if (
              key.length < 6 ||
              candidate.length < 6
            ) {
              return false;
            }

            return (
              candidate.includes(key) ||
              key.includes(candidate)
            );
          }
        );
    }


    if (matches.length !== 1) {
      continue;
    }


    const course =
      matches[0];


    course.searches +=
      Number(row.searches) || 0;

    course.clicks +=
      Number(row.clicks) || 0;

    course.rounds +=
      Number(row.rounds) || 0;
  }


  for (const course of courses) {

    course.score =
      (
        course.searches * 2
      ) +
      course.clicks +
      (
        course.rounds * 3
      );
  }
}


// =========================================================
// CHECK PROVIDER GPS
// =========================================================

async function checkGps(course) {

  try {

    const search =
      await searchGolfCourses({
        query: course.name,
        country: "AU",
        perPage: 25,
      });


    const results =
      extractSearchResults(
        search
      );


    const providerCourse =
      chooseProviderCourse(
        course,
        results
      );


    if (!providerCourse) {

      return {
        status: "NO_MATCH",
        providerId: null,
        providerName: null,
        greens: 0,
        holes: [],
      };
    }


    const id =
      providerId(
        providerCourse
      );


    if (!id) {

      return {
        status: "NO_MATCH",
        providerId: null,
        providerName: null,
        greens: 0,
        holes: [],
      };
    }


    await sleep(WAIT_MS);


    const gps =
      await getGolfCourseGreenCenters(
        id
      );


    const greens =
      validGreens(gps);


    const holeNumbers =
      [
        ...new Set(
          greens.map(
            (green) =>
              Number(green.hole)
          )
        ),
      ].sort(
        (a, b) => a - b
      );


    let status =
      "NO_GREENS";


    if (
      holeNumbers.length >= 18
    ) {

      status =
        "COMPLETE";

    } else if (
      holeNumbers.length > 0
    ) {

      status =
        "PARTIAL";
    }


    return {
      status,

      providerId: id,

      providerName:
        providerName(
          providerCourse
        ),

      greens:
        holeNumbers.length,

      holes:
        holeNumbers,
    };

  } catch (err) {

    return {
      status: "ERROR",
      providerId: null,
      providerName: null,
      greens: 0,
      holes: [],
      error:
        err?.message ||
        String(err),
    };
  }
}


// =========================================================
// DISPLAY
// =========================================================

function gpsLabel(result) {

  if (
    result.status ===
    "COMPLETE"
  ) {

    return (
      `✅ COMPLETE API GPS — ` +
      `${result.greens}/18`
    );
  }


  if (
    result.status ===
    "PARTIAL"
  ) {

    return (
      `🟡 PARTIAL API GPS — ` +
      `${result.greens}/18`
    );
  }


  if (
    result.status ===
    "NO_GREENS"
  ) {

    return (
      "⚠️ API MATCH / NO GREENS"
    );
  }


  if (
    result.status ===
    "NO_MATCH"
  ) {

    return (
      "❌ NO API MATCH — MANUAL REQUIRED"
    );
  }


  return (
    "❗ API ERROR"
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
    "TEERADAR GPS PRIORITY AUDIT"
  );

  console.log(
    "=================================================="
  );


  const courses =
    await loadCourses();


  const analytics =
    await loadAnalytics();


  applyDemand(
    courses,
    analytics
  );


  for (const state of STATES) {

    console.log("");
    console.log("");
    console.log(
      "=================================================="
    );

    console.log(
      `${state} — GPS PRIORITY`
    );

    console.log(
      "=================================================="
    );


    /*
     * Only courses with actual TeeRadar
     * activity are prioritised.
     *
     * Maximum 20 per state.
     */

    const priority =
      courses
        .filter(
          (course) =>
            course.state === state &&
            course.score > 0
        )
        .sort(
          (a, b) =>
            b.score - a.score
        )
        .slice(0, 20);


    if (!priority.length) {

      console.log(
        "No TeeRadar demand recorded."
      );

      continue;
    }


    for (
      let i = 0;
      i < priority.length;
      i++
    ) {

      const course =
        priority[i];


      console.log("");
      console.log(
        `${i + 1}. ${course.name}`
      );

      console.log(
        `   Demand score: ${course.score}` +
        ` | Searches: ${course.searches}` +
        ` | Clicks: ${course.clicks}` +
        ` | Rounds: ${course.rounds}`
      );


      const gps =
        await checkGps(
          course
        );


      console.log(
        `   ${gpsLabel(gps)}`
      );


      if (
        gps.providerId
      ) {

        console.log(
          `   API: ${gps.providerName}` +
          ` | ID ${gps.providerId}`
        );
      }


      if (
        gps.status ===
        "PARTIAL"
      ) {

        const existing =
          new Set(
            gps.holes
          );


        const missing = [];

        for (
          let hole = 1;
          hole <= 18;
          hole++
        ) {

          if (
            !existing.has(hole)
          ) {

            missing.push(hole);
          }
        }


        console.log(
          `   Missing holes: ` +
          missing.join(", ")
        );
      }


      if (
        gps.error
      ) {

        console.log(
          `   Error: ${gps.error}`
        );
      }


      /*
       * Search request + possible greens
       * request. Keep comfortably under
       * provider burst limits.
       */

      await sleep(
        WAIT_MS
      );
    }
  }


  console.log("");
  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    "AUDIT COMPLETE"
  );

  console.log(
    "=================================================="
  );
}


main()
  .catch((err) => {

    console.error(
      "❌ GPS priority audit failed:",
      err
    );

    process.exitCode = 1;
  })
  .finally(async () => {

    try {

      if (
        db &&
        typeof db.end ===
          "function"
      ) {

        await db.end();
      }

    } catch {
      // ignore
    }
  });
