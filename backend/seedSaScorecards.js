// backend/seedSaScorecards.js

import db from "./db.js";

function makeStandardCourse({
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

      // Do not fabricate 9-hole ratings
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

// =========================================================
// VERIFIED SA SCORECARDS
// =========================================================

const STANDARD_COURSES = [

  // -------------------------------------------------------
  // Royal Adelaide Golf Club
  // White Men: 72 / 130
  // -------------------------------------------------------
  {
    name: "royal adelaide golf club",
    pars: [
      4,5,4,4,4,4,3,4,4,
      4,4,3,4,4,5,3,5,4
    ],
    rating: 72.0,
    slope: 130,
    tee: "White",
  },

  // -------------------------------------------------------
  // Glenelg Golf Club
  // White Men: 72 / 135
  // -------------------------------------------------------
  {
    name: "glenelg golf club",
    pars: [
      4,4,4,3,5,4,3,4,4,
      4,3,4,4,4,3,5,4,5
    ],
    rating: 72.0,
    slope: 135,
    tee: "White",
  },

  // -------------------------------------------------------
  // Mount Osmond Golf Club
  // White Men: 69 / 127
  // -------------------------------------------------------
  {
    name: "mount osmond golf club",
    pars: [
      4,3,4,4,4,5,3,4,4,
      4,3,4,4,5,4,3,4,5
    ],
    rating: 69.0,
    slope: 127,
    tee: "White",
  },

  // -------------------------------------------------------
  // Tea Tree Gully Golf Club
  // White: 71 / 131
  // -------------------------------------------------------
  {
    name: "tea tree gully golf club",
    pars: [
      4,3,3,4,4,4,4,3,5,
      4,5,5,3,4,4,4,4,4
    ],
    rating: 71.0,
    slope: 131,
    tee: "White",
  },

  // -------------------------------------------------------
  // Blackwood Golf Club
  // Men's course: 72 / 128
  // -------------------------------------------------------
  {
    name: "blackwood golf club",
    pars: [
      4,5,3,4,4,4,5,3,4,
      4,3,4,4,3,5,4,4,5
    ],
    rating: 72.0,
    slope: 128,
    tee: "Mens",
  },

];

// =========================================================
// Build import list
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
];

export async function seedSaScorecards() {
  console.log(
    `🏌️ SA scorecard seed starting (${COURSE_ROWS.length} templates)`
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
        'SA',
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
    `✅ SA scorecard seed complete (${insertedOrUpdated} templates)`
  );

  return {
    ok: true,
    templates: insertedOrUpdated,
  };
}
