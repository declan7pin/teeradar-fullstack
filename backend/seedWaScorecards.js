// backend/seedWaScorecards.js

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
// VERIFIED WA SCORECARDS
// =========================================================

const STANDARD_COURSES = [

  // -------------------------------------------------------
  // The Cut
  // White: 71 / 125
  // -------------------------------------------------------
  {
    name: "the cut",
    pars: [
      4,4,4,3,5,4,4,4,4,
      4,4,4,3,4,5,3,4,5
    ],
    rating: 71.0,
    slope: 125,
    tee: "White",
  },

  // -------------------------------------------------------
  // Kalgoorlie
  // Rating/slope source currently represents rated course.
  // -------------------------------------------------------
  {
    name: "kalgoorlie golf course",
    pars: [
      4,5,4,3,4,4,4,3,5,
      4,5,4,3,4,5,4,3,4
    ],
    rating: 75.0,
    slope: 129,
    tee: "Championship",
  },

  // -------------------------------------------------------
  // Meadow Springs
  // White: 72.1 / 126
  // -------------------------------------------------------
  {
    name: "meadow springs golf course",
    pars: [
      4,5,4,3,4,4,5,3,4,
      4,3,4,4,4,5,3,4,5
    ],
    rating: 72.1,
    slope: 126,
    tee: "White",
  },

  // -------------------------------------------------------
  // Araluen
  // Official men's White: 71 / 124
  // -------------------------------------------------------
  {
    name: "araluen golf course",
    pars: [
      5,4,4,3,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],
    rating: 71.0,
    slope: 124,
    tee: "White",
  },

  // -------------------------------------------------------
  // Albany
  // White rating 70. Current slope not reliably supplied.
  // -------------------------------------------------------
  {
    name: "albany golf club",
    pars: [
      4,4,4,5,4,3,4,3,5,
      3,5,4,4,3,4,5,4,4
    ],
    rating: 70.0,
    slope: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // Bunbury
  // Pars verified. Current rating/slope left unset.
  // -------------------------------------------------------
  {
    name: "bunbury golf club",
    pars: [
      3,5,4,4,4,4,5,3,4,
      3,5,4,4,4,4,3,5,4
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // -------------------------------------------------------
  // Sun City
  // White: 67.3 / 116
  // -------------------------------------------------------
  {
    name: "sun city country club",
    pars: [
      4,4,5,3,4,5,3,4,4,
      5,3,4,4,4,5,4,3,4
    ],
    rating: 67.3,
    slope: 116,
    tee: "White",
  },

  // -------------------------------------------------------
  // Mount Lawley
  // Men's tee: 72 / 72
  // -------------------------------------------------------
  {
    name: "mount lawley golf club",
    pars: [
      4,4,5,4,4,3,4,3,5,
      4,4,4,3,5,3,4,5,4
    ],
    rating: 72.0,
    slope: ,
    tee: "Mens",
  },

  // -------------------------------------------------------
  // Royal Fremantle
  // Blue: 73 / 130
  // -------------------------------------------------------
  {
    name: "royal fremantle golf club",
    pars: [
      4,5,3,4,4,5,4,3,4,
      4,5,3,4,4,4,4,3,5
    ],
    rating: 73.0,
    slope: 130,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Gosnells
  // Blue: 70 / 121
  // -------------------------------------------------------
  {
    name: "gosnells golf club",
    pars: [
      4,5,4,3,4,4,3,4,3,
      4,3,4,5,3,4,4,4,5
    ],
    rating: 70.0,
    slope: 121,
    tee: "Blue",
  },

  // -------------------------------------------------------
  // Wanneroo
  // White: 72.6 / 113
  // -------------------------------------------------------
  {
    name: "wanneroo golf club",
    pars: [
      4,5,4,3,4,4,4,3,5,
      5,3,4,4,4,3,5,4,4
    ],
    rating: 72.6,
    slope: 113,
    tee: "White",
  },

  // -------------------------------------------------------
  // Mandurah Country Club
  // Current pars verified.
  // Rating/slope currently left unset.
  // -------------------------------------------------------
  {
    name: "mandurah country club",
    pars: [
      4,4,3,5,5,3,4,4,4,
      4,5,4,4,3,4,4,3,5
    ],
    rating: null,
    slope: null,
    tee: "Men",
  },

  // -------------------------------------------------------
  // Wembley Old Course
  // -------------------------------------------------------
  {
    name: "wembley golf complex - old course",
    pars: [
      5,3,4,5,4,3,4,4,4,
      4,5,4,3,4,4,3,5,4
    ],
    rating: 69.0,
    slope: 116,
    tee: "Standard",
  },
];

// =========================================================
// JOONDALUP
//
// Three separate 9s.
// This should NOT use generic front/back generation.
// =========================================================

const JOONDALUP = [
  {
    name: "joondalup - quarry",
    holes: 9,
    pars: [4,4,3,5,4,4,3,5,4],
    rating: null,
    slope: null,
    tee: "White",
  },

  {
    name: "joondalup - dune",
    holes: 9,
    pars: [4,4,4,3,5,4,3,4,5],
    rating: null,
    slope: null,
    tee: "White",
  },

  {
    name: "joondalup - lake",
    holes: 9,
    pars: [4,4,3,5,4,4,4,3,5],
    rating: null,
    slope: null,
    tee: "White",
  },

  {
    name: "joondalup - quarry/dune",
    holes: 18,
    pars: [
      4,4,3,5,4,4,3,5,4,
      4,4,4,3,5,4,3,4,5
    ],
    rating: 71.0,
    slope: 134,
    tee: "White",
  },

  {
    name: "joondalup - lake/dune",
    holes: 18,
    pars: [
      4,4,3,5,4,4,4,3,5,
      4,4,4,3,5,4,3,4,5
    ],
    rating: 71.0,
    slope: 131,
    tee: "White",
  },

  {
    name: "joondalup - lake/quarry",
    holes: 18,
    pars: [
      4,4,3,5,4,4,4,3,5,
      4,4,3,5,4,4,3,5,4
    ],
    rating: 70.0,
    slope: 133,
    tee: "White",
  },
];

// =========================================================
// Build import list
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
  ...JOONDALUP,
];

export async function seedWaScorecards() {
  console.log(
    `🏌️ WA scorecard seed starting (${COURSE_ROWS.length} templates)`
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
        'WA',
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
    `✅ WA scorecard seed complete (${insertedOrUpdated} templates)`
  );

  return {
    ok: true,
    templates: insertedOrUpdated,
  };
}