// backend/auditTopGpsDemand.js

import db from "./db.js";

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
// HELPERS
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


function cleanCourseName(name) {
  return String(name || "")
    .trim()

    // Front 9
    .replace(
      /\s*[-–—]?\s*front\s*9(?:\s*holes?)?\s*$/i,
      ""
    )

    // Back 9
    .replace(
      /\s*[-–—]?\s*back\s*9(?:\s*holes?)?\s*$/i,
      ""
    )

    // Front Nine
    .replace(
      /\s*[-–—]?\s*front\s*nine\s*$/i,
      ""
    )

    // Back Nine
    .replace(
      /\s*[-–—]?\s*back\s*nine\s*$/i,
      ""
    )

    // 18 holes
    .replace(
      /\s*[-–—]?\s*18\s*holes?\s*$/i,
      ""
    )

    // 9 holes
    .replace(
      /\s*[-–—]?\s*9\s*holes?\s*$/i,
      ""
    )

    // trailing 18
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
    .replace(/[^a-z0-9]/g, "");
}


// =========================================================
// LOAD SCORECARD COURSES
// =========================================================

async function loadScorecardCourses() {

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

  const courses = new Map();

  for (const row of rows) {

    const state =
      normaliseState(row.state);

    if (!STATES.includes(state)) {
      continue;
    }

    const name =
      cleanCourseName(row.name);

    const key =
      `${state}|${normaliseName(name)}`;

    if (!courses.has(key)) {

      courses.set(key, {
        state,
        name,
        names: [],
        templateIds: [],
        holes: [],
      });
    }

    const course =
      courses.get(key);

    course.names.push(
      String(row.name)
    );

    course.templateIds.push(
      row.id
    );

    course.holes.push(
      Number(row.holes) || null
    );
  }

  return Array.from(
    courses.values()
  );
}


// =========================================================
// LOAD ANALYTICS
// =========================================================

async function loadAnalytics() {

  const { rows } =
    await db.query(`
      SELECT
        course_name,
        type,
        round_id,
        round_key
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
    `);

  return rows;
}


// =========================================================
// BUILD DEMAND
// =========================================================

function buildDemand(
  courses,
  analyticsRows
) {

  /*
   * Build lookup by normalised course name.
   *
   * Analytics doesn't necessarily contain state,
   * so we match against scorecard course names.
   */

  const lookup =
    new Map();

  for (const course of courses) {

    const possibleNames = [
      course.name,
      ...course.names,
    ];

    for (const name of possibleNames) {

      const key =
        normaliseName(name);

      if (!key) continue;

      if (!lookup.has(key)) {
        lookup.set(key, []);
      }

      lookup
        .get(key)
        .push(course);
    }
  }


  // Initialise counts

  for (const course of courses) {

    course.searches = 0;
    course.clicks = 0;
    course.roundKeys =
      new Set();

    course.unmatchedAnalytics =
      0;
  }


  for (const row of analyticsRows) {

    const analyticsName =
      normaliseName(
        row.course_name
      );

    if (!analyticsName) {
      continue;
    }

    let matches =
      lookup.get(
        analyticsName
      ) || [];


    /*
     * Fallback matching.
     *
     * Useful where analytics uses:
     *
     * "Wembley Golf Complex"
     *
     * but the scorecard template is:
     *
     * "Wembley Golf Complex - Old Course"
     */

    if (!matches.length) {

      matches =
        courses.filter(
          (course) => {

            const a =
              normaliseName(
                course.name
              );

            const b =
              analyticsName;

            if (
              !a ||
              !b
            ) {
              return false;
            }

            return (
              a === b ||
              a.includes(b) ||
              b.includes(a)
            );
          }
        );
    }


    /*
     * Don't guess if an analytics name
     * could belong to multiple courses.
     */

    if (matches.length !== 1) {
      continue;
    }


    const course =
      matches[0];

    const type =
      String(row.type || "")
        .trim()
        .toLowerCase();


    // SEARCH

    if (
      [
        "search_course",
        "course_search",
        "searched_course",
      ].includes(type)
    ) {

      course.searches += 1;
    }


    // BOOKING CLICK

    if (
      [
        "booking_click",
        "course_booking_click",
        "booking",
        "book_click",
        "course_booking",
      ].includes(type)
    ) {

      course.clicks += 1;
    }


    // ROUND

    if (
      [
        "round_played",
        "round_saved",
        "scorecard_saved",
      ].includes(type)
    ) {

      const roundKey =
        row.round_key ||
        (
          row.round_id != null
            ? String(row.round_id)
            : null
        );

      /*
       * If there is no round identifier,
       * still count the event uniquely.
       */

      if (roundKey) {

        course.roundKeys.add(
          String(roundKey)
        );

      } else {

        course.roundKeys.add(
          `event-${Math.random()}`
        );
      }
    }
  }


  for (const course of courses) {

    course.rounds =
      course.roundKeys.size;

    /*
     * TeeRadar GPS priority score:
     *
     * search = 2 points
     * booking click = 1 point
     * completed/played round = 3 points
     */

    course.score =
      (
        course.searches * 2
      ) +
      (
        course.clicks
      ) +
      (
        course.rounds * 3
      );

    delete course.roundKeys;
  }


  return courses;
}


// =========================================================
// PRINT RESULTS
// =========================================================

function printState(
  state,
  courses
) {

  const stateCourses =
    courses
      .filter(
        (course) =>
          course.state === state
      )
      .sort(
        (a, b) => {

          if (
            b.score !== a.score
          ) {
            return (
              b.score -
              a.score
            );
          }

          if (
            b.rounds !== a.rounds
          ) {
            return (
              b.rounds -
              a.rounds
            );
          }

          if (
            b.searches !==
            a.searches
          ) {
            return (
              b.searches -
              a.searches
            );
          }

          return (
            b.clicks -
            a.clicks
          );
        }
      )
      .slice(0, 20);


  console.log("");
  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    `${state} — TOP ${stateCourses.length} TEERADAR COURSES`
  );

  console.log(
    "=================================================="
  );


  if (!stateCourses.length) {

    console.log(
      "No scorecard courses found."
    );

    return;
  }


  stateCourses.forEach(
    (course, index) => {

      console.log("");

      console.log(
        `${index + 1}. ${course.name}`
      );

      console.log(
        `   Searches: ${course.searches}` +
        ` | Booking clicks: ${course.clicks}` +
        ` | Rounds: ${course.rounds}` +
        ` | Score: ${course.score}`
      );
    }
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
    "TEERADAR GPS PRIORITY — COURSE DEMAND"
  );

  console.log(
    "=================================================="
  );


  console.log("");
  console.log(
    "Loading scorecard courses..."
  );

  const courses =
    await loadScorecardCourses();

  console.log(
    `${courses.length} physical courses found.`
  );


  console.log("");
  console.log(
    "Loading TeeRadar analytics..."
  );

  const analytics =
    await loadAnalytics();

  console.log(
    `${analytics.length} relevant analytics events found.`
  );


  const demand =
    buildDemand(
      courses,
      analytics
    );


  for (const state of STATES) {

    printState(
      state,
      demand
    );
  }


  console.log("");
  console.log("");
  console.log(
    "=================================================="
  );

  console.log(
    "DONE"
  );

  console.log(
    "=================================================="
  );

  console.log("");
}


main()
  .catch(
    (err) => {

      console.error("");
      console.error(
        "❌ Demand audit failed:"
      );

      console.error(err);

      process.exitCode = 1;
    }
  )
  .finally(
    async () => {

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
    }
  );
