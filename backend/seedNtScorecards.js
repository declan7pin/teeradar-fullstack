// backend/seedNtScorecards.js

import db from "./db.js";

// =========================================================
// Helpers
// =========================================================

function makeStandard18Course({
  name,
  pars,
  rating = null,
  slope = null,
  tee = "White",
}) {
  if (!Array.isArray(pars) || pars.length !== 18) {
    throw new Error(`${name}: expected exactly 18 pars`);
  }

  return [
    {
      name: `${name} 18`,
      holes: 18,
      pars,
      rating,
      slope,
      tee,
    },

    {
      name: `${name} - front 9`,
      holes: 9,
      pars: pars.slice(0, 9),
      rating: null,
      slope: null,
      tee,
    },

    {
      name: `${name} - back 9`,
      holes: 9,
      pars: pars.slice(9, 18),
      rating: null,
      slope: null,
      tee,
    },
  ];
}

function makeRepeatedNineCourse({
  name,
  pars,
  rating9 = null,
  slope9 = null,
  rating18 = null,
  slope18 = null,
  tee = "White",
}) {
  if (!Array.isArray(pars) || pars.length !== 9) {
    throw new Error(`${name}: expected exactly 9 pars`);
  }

  return [
    {
      name: `${name} - 9 holes`,
      holes: 9,
      pars,
      rating: rating9,
      slope: slope9,
      tee,
    },

    {
      name: `${name} - 18 holes`,
      holes: 18,
      pars: [...pars, ...pars],
      rating: rating18,
      slope: slope18,
      tee,
    },
  ];
}

// =========================================================
// TRUE 18-HOLE COURSES
// =========================================================

const STANDARD_18 = [

  // -------------------------------------------------------
  // Alice Springs Golf Club
  // Blue: 72 / 121
  // -------------------------------------------------------
  {
    name: "alice springs golf club",
    pars: [
      4,4,3,5,3,5,4,4,4,
      5,4,3,4,5,3,4,4,4
    ],
    rating: 72.0,
    slope: 121,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Darwin Golf Club
  // Official club rating:
  // Blue men: 71 / 120
  // -------------------------------------------------------
  {
    name: "darwin golf club",
    pars: [
      5,4,4,4,3,4,5,3,4,
      4,3,4,4,5,4,3,4,5
    ],
    rating: 71.0,
    slope: 120,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Palmerston Golf Course
  // Blue: 70.9 / 123
  // -------------------------------------------------------
  {
    name: "palmerston golf course",
    pars: [
      4,5,4,3,4,4,3,4,5,
      4,4,4,5,3,4,3,4,4
    ],
    rating: 70.9,
    slope: 123,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // RAAF Darwin
  // White: 67.5 / 105
  // -------------------------------------------------------
  {
    name: "raaf darwin golf club",
    pars: [
      4,3,4,4,3,5,4,3,4,
      4,3,4,5,3,5,4,4,3
    ],
    rating: 67.5,
    slope: 105,
    tee: "White",
  },

  // -------------------------------------------------------
  // Humpty Doo & Rural Area
  // Blue: 70.6 / 121
  //
  // This database lists a full 18-hole scorecard.
  // -------------------------------------------------------
  {
    name: "humpty doo & rural area golf club",
    pars: [
      5,3,4,4,4,3,4,4,5,
      5,3,4,5,4,3,4,4,4
    ],
    rating: 70.6,
    slope: 121,
    tee: "Blue",
  },
];

// =========================================================
// TRUE 9-HOLE COURSES
//
// For these, TeeRadar creates:
// Course - 9 holes
// Course - 18 holes (same physical nine played twice)
// =========================================================

const NINE_HOLE = [

  // -------------------------------------------------------
  // Gardens Park Golf Links
  // Men: 31.5 / 103
  // -------------------------------------------------------
  {
    name: "gardens park golf links",
    pars: [
      3,4,4,5,4,4,4,3,3
    ],
    rating9: 31.5,
    slope9: 103,

    // Don't fabricate an official 18-hole rating
    rating18: null,
    slope18: null,

    tee: "Men",
  },

  // -------------------------------------------------------
  // Gove Country Golf Club
  // White: 36.6 / 120
  // -------------------------------------------------------
  {
    name: "gove country golf club",
    pars: [
      5,4,4,3,4,4,4,3,5
    ],
    rating9: 36.6,
    slope9: 120,
    rating18: null,
    slope18: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // Jabiru Golf Club
  // White: 37.4 / 123
  // -------------------------------------------------------
  {
    name: "jabiru golf club",
    pars: [
      4,4,3,5,4,5,4,4,3
    ],
    rating9: 37.4,
    slope9: 123,
    rating18: null,
    slope18: null,
    tee: "White",
  },
];

// =========================================================
// ALYANGULA
//
// Current scorecard source shows 18 separate hole entries,
// so keep as 18 rather than repeating a nine.
// =========================================================

const ALYANGULA = [
  {
    name: "alyangula golf club 18",
    holes: 18,
    pars: [
      3,4,3,3,4,4,4,4,3,
      3,4,3,3,4,4,5,4,3
    ],
    rating: 62.0,
    slope: 105,
    tee: "Blue",
  },

  {
    name: "alyangula golf club - front 9",
    holes: 9,
    pars: [
      3,4,3,3,4,4,4,4,3
    ],
    rating: null,
    slope: null,
    tee: "Blue",
  },

  {
    name: "alyangula golf club - back 9",
    holes: 9,
    pars: [
      3,4,3,3,4,4,5,4,3
    ],
    rating: null,
    slope: null,
    tee: "Blue",
  },
];

// =========================================================
// Build rows
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_18.flatMap(makeStandard18Course),
  ...NINE_HOLE.flatMap(makeRepeatedNineCourse),
  ...ALYANGULA,
];

// =========================================================
// Seed
// =========================================================

export async function seedNtScorecards() {
  console.log(
    `🏌️ NT scorecard seed starting (${COURSE_ROWS.length} templates)`
  );

  let insertedOrUpdated = 0;

  for (const course of COURSE_ROWS) {
    const holes = Number(course.holes);

    if (![9, 18].includes(holes)) {
      throw new Error(
        `${course.name}: invalid hole count`
      );
    }

    if (
      !Array.isArray(course.pars) ||
      course.pars.length !== holes
    ) {
      throw new Error(
        `${course.name}: par count does not equal ${holes}`
      );
    }

    for (const par of course.pars) {
      const p = Number(par);

      if (
        !Number.isFinite(p) ||
        p < 3 ||
        p > 6
      ) {
        throw new Error(
          `${course.name}: invalid par ${par}`
        );
      }
    }

    await db.query(
      `
      INSERT INTO scorecard_courses (
        name,
        state,
        holes,
        pars_json,
        dists_json,
        course_rating,
        slope_rating,
        tee_colour,
        updated_at
      )
      VALUES (
        $1,
        'NT',
        $2,
        $3::jsonb,
        '[]'::jsonb,
        $4,
        $5,
        $6,
        now()
      )

      ON CONFLICT (name, state, holes)

      DO UPDATE SET
        pars_json = EXCLUDED.pars_json,

        course_rating =
          COALESCE(
            EXCLUDED.course_rating,
            scorecard_courses.course_rating
          ),

        slope_rating =
          COALESCE(
            EXCLUDED.slope_rating,
            scorecard_courses.slope_rating
          ),

        tee_colour =
          COALESCE(
            EXCLUDED.tee_colour,
            scorecard_courses.tee_colour
          ),

        updated_at = now();
      `,
      [
        course.name,
        holes,
        JSON.stringify(course.pars),
        course.rating,
        course.slope,
        course.tee,
      ]
    );

    insertedOrUpdated++;
  }

  console.log(
    `✅ NT scorecard seed complete (${insertedOrUpdated} templates)`
  );

  return {
    ok: true,
    templates: insertedOrUpdated,
  };
}