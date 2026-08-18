// backend/seedQldScorecards.js

import db from "./db.js";

/*
  TeeRadar — Queensland scorecard seed

  IMPORTANT:
  - Only courses we are sufficiently confident in are included.
  - Rating/slope are NULL unless we have confidence in the exact tee.
  - Standard 18-hole courses automatically create:
      Course 18
      Course - Front 9
      Course - Back 9
  - We do NOT derive a 9-hole rating from an 18-hole rating.
*/

// ============================================================
// HELPERS
// ============================================================

function makeStandardCourse({
  name,
  pars,
  rating = null,
  slope = null,
  tee = null,
}) {
  if (!Array.isArray(pars) || pars.length !== 18) {
    throw new Error(
      `${name}: standard course must contain exactly 18 pars`
    );
  }

  return [
    {
      name: `${name} 18`,
      holes: 18,
      pars: [...pars],
      rating,
      slope,
      tee,
    },

    {
      name: `${name} - Front 9`,
      holes: 9,
      pars: pars.slice(0, 9),
      rating: null,
      slope: null,
      tee,
    },

    {
      name: `${name} - Back 9`,
      holes: 9,
      pars: pars.slice(9, 18),
      rating: null,
      slope: null,
      tee,
    },
  ];
}

// ============================================================
// QLD COURSES
// ============================================================

const STANDARD_COURSES = [

  // ==========================================================
  // ROYAL QUEENSLAND GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Royal Queensland Golf Club",
    pars: [
      4, 4, 4, 3, 4, 4, 5, 3, 5,
      5, 3, 4, 4, 4, 5, 4, 3, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // NUDGEE GOLF CLUB — KURRAI
  // Total par: 72
  // ==========================================================
  {
    name: "Nudgee Golf Club - Kurrai",
    pars: [
      4, 4, 3, 5, 5, 4, 4, 3, 4,
      4, 3, 4, 4, 4, 5, 4, 5, 3,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // GAILES GOLF CLUB
  // Total par: 73
  // ==========================================================
  {
    name: "Gailes Golf Club",
    pars: [
      5, 5, 3, 4, 4, 3, 4, 4, 5,
      4, 4, 3, 4, 4, 4, 4, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // MCLEOD COUNTRY GOLF CLUB
  // Total par: 71
  // ==========================================================
  {
    name: "McLeod Country Golf Club",
    pars: [
      4, 3, 5, 4, 4, 3, 5, 4, 5,
      5, 4, 3, 4, 4, 4, 3, 4, 3,
    ],
    rating: 71.2,
    slope: 132,
    tee: "Blue",
  },

  // ==========================================================
  // IPSWICH GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Ipswich Golf Club",
    pars: [
      4, 5, 3, 4, 3, 4, 4, 5, 4,
      3, 4, 4, 5, 3, 4, 5, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // ST LUCIA GOLF LINKS
  // Total par: 69
  // ==========================================================
  {
    name: "St Lucia Golf Links",
    pars: [
      4, 3, 4, 4, 4, 5, 4, 3, 4,
      4, 3, 4, 4, 4, 4, 3, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // OXLEY GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Oxley Golf Club",
    pars: [
      4, 5, 3, 4, 3, 4, 3, 4, 4,
      4, 5, 5, 3, 4, 4, 4, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // VIRGINIA GOLF CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Virginia Golf Club",
    pars: [
      5, 4, 3, 4, 4, 4, 4, 4, 3,
      4, 4, 3, 5, 3, 4, 5, 4, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // SURFERS PARADISE GOLF CLUB
  // Total par: 71
  // ==========================================================
  {
    name: "Surfers Paradise Golf Club",
    pars: [
      4, 3, 5, 4, 3, 4, 3, 4, 5,
      4, 4, 4, 4, 4, 4, 3, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // LINKS HOPE ISLAND
  // Total par: 72
  // ==========================================================
  {
    name: "Links Hope Island",
    pars: [
      4, 5, 4, 4, 3, 4, 4, 5, 3,
      4, 5, 4, 4, 3, 4, 4, 3, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // NOOSA SPRINGS GOLF & SPA RESORT
  // Total par: 72
  // ==========================================================
  {
    name: "Noosa Springs Golf & Spa Resort",
    pars: [
      4, 4, 5, 3, 4, 4, 4, 3, 5,
      4, 4, 4, 3, 4, 5, 3, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // PEREGIAN SPRINGS GOLF CLUB
  // Total par: 71
  // ==========================================================
  {
    name: "Peregian Springs Golf Club",
    pars: [
      4, 4, 3, 4, 3, 4, 5, 3, 5,
      4, 5, 3, 4, 3, 4, 4, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // PALMER COOLUM RESORT
  // Total par: 72
  // ==========================================================
  {
    name: "Palmer Coolum Resort",
    pars: [
      4, 3, 5, 4, 3, 5, 4, 4, 4,
      5, 3, 5, 4, 5, 3, 4, 3, 4,
    ],
    rating: null,
    slope: null,
    tee: null,
  },

  // ==========================================================
  // TIN CAN BAY COUNTRY CLUB
  // Total par: 72
  // ==========================================================
  {
    name: "Tin Can Bay Country Club",
    pars: [
      4, 4, 5, 4, 3, 4, 3, 5, 3,
      5, 3, 4, 3, 4, 5, 4, 4, 5,
    ],
    rating: null,
    slope: null,
    tee: null,
  },
    // ==========================================================
  // PACIFIC GOLF CLUB
  // Brisbane
  // Blue
  // Par 72
  // Rating 73.3 / Slope 130
  // ==========================================================
  {
    name: "Pacific Golf Club",
    pars: [
      5, 4, 3, 4, 4, 4, 3, 4, 5,
      4, 5, 4, 3, 4, 4, 4, 3, 5,
    ],
    rating: 73.3,
    slope: 130,
    tee: "Blue",
  },

  // ==========================================================
  // CARBROOK GOLF CLUB
  // Brisbane / Logan
  // Blue
  // Par 71
  // Rating 71.7 / Slope 125
  // ==========================================================
  {
    name: "Carbrook Golf Club",
    pars: [
      4, 3, 4, 5, 4, 4, 3, 5, 4,
      4, 3, 4, 4, 3, 4, 5, 4, 4,
    ],
    rating: 71.7,
    slope: 125,
    tee: "Blue",
  },

  // ==========================================================
  // REDCLIFFE GOLF CLUB
  // Moreton Bay
  // Blue
  // Par 71
  // Rating 72 / Slope 123
  // ==========================================================
  {
    name: "Redcliffe Golf Club",
    pars: [
      4, 3, 4, 5, 4, 4, 3, 4, 4,
      5, 3, 4, 3, 4, 4, 5, 4, 4,
    ],
    rating: 72,
    slope: 123,
    tee: "Blue",
  },

  // ==========================================================
  // WYNNUM GOLF CLUB
  // Brisbane
  // White
  // Par 70
  // Rating 66.7 / Slope 119
  // ==========================================================
  {
    name: "Wynnum Golf Club",
    pars: [
      4, 5, 4, 4, 3, 3, 4, 4, 3,
      4, 4, 5, 5, 4, 3, 3, 4, 4,
    ],
    rating: 66.7,
    slope: 119,
    tee: "White",
  },

  // ==========================================================
  // EMERALD LAKES GOLF CLUB
  // Gold Coast
  // Blue
  // Par 72
  // Rating 69.2 / Slope 117
  // ==========================================================
  {
    name: "Emerald Lakes Golf Club",
    pars: [
      4, 5, 3, 5, 3, 5, 4, 3, 4,
      4, 4, 5, 3, 5, 4, 4, 3, 4,
    ],
    rating: 69.2,
    slope: 117,
    tee: "Blue",
  },

  // ==========================================================
  // THE GLADES GOLF CLUB
  // Gold Coast
  // Par 72
  //
  // Official Glades course-tour par sequence.
  // White slope = 125.
  // Leaving rating NULL because we haven't tied a verified
  // course rating to the same tee.
  // ==========================================================
  {
    name: "The Glades Golf Club",
    pars: [
      4, 4, 3, 4, 3, 5, 5, 4, 4,
      4, 5, 5, 3, 4, 4, 4, 3, 4,
    ],
    rating: null,
    slope: 125,
    tee: "White",
  },

  // ==========================================================
  // LAKELANDS GOLF CLUB
  // Gold Coast
  // Official scorecard
  // Par 72
  //
  // Rating/slope intentionally left NULL here.
  // ==========================================================
  {
    name: "Lakelands Golf Club",
    pars: [
      4, 5, 3, 4, 5, 3, 4, 4, 4,
      4, 5, 4, 4, 3, 4, 5, 3, 4,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // SOUTHPORT GOLF CLUB
  // Gold Coast
  // Blue
  // Par 71
  // Rating 70.5 / Slope 123
  // ==========================================================
  {
    name: "Southport Golf Club",
    pars: [
      5, 3, 4, 4, 5, 4, 3, 5, 4,
      4, 4, 3, 5, 3, 4, 3, 4, 4,
    ],
    rating: 70.5,
    slope: 123,
    tee: "Blue",
  },

  // ==========================================================
  // BURLEIGH GOLF CLUB
  // Gold Coast
  // Back tee
  // Par 71
  // Rating 72 / Slope 140
  // ==========================================================
  {
    name: "Burleigh Golf Club",
    pars: [
      5, 4, 4, 3, 4, 3, 4, 3, 5,
      4, 3, 4, 5, 5, 4, 4, 3, 4,
    ],
    rating: 72,
    slope: 140,
    tee: "Back",
  },

  // ==========================================================
  // TWIN WATERS GOLF CLUB
  // Sunshine Coast
  // Championship
  // Par 72
  // Rating 72 / Slope 126
  // ==========================================================
  {
    name: "Twin Waters Golf Club",
    pars: [
      5, 3, 4, 5, 4, 4, 3, 4, 4,
      4, 3, 4, 4, 5, 4, 4, 3, 5,
    ],
    rating: 72,
    slope: 126,
    tee: "Championship",
  },

  // ==========================================================
  // HEADLAND GOLF CLUB
  // Sunshine Coast
  // White
  // Par 72
  //
  // Two source records currently disagree on the exact
  // rating/slope pair, so we keep these NULL rather than
  // inserting uncertain handicap data.
  // ==========================================================
  {
    name: "Headland Golf Club",
    pars: [
      4, 5, 4, 4, 3, 4, 5, 3, 4,
      5, 4, 4, 5, 3, 4, 4, 4, 3,
    ],
    rating: null,
    slope: null,
    tee: "White",
  },

  // ==========================================================
  // PELICAN WATERS GOLF CLUB
  // Sunshine Coast
  // Championship
  // Par 72
  // Rating 73
  //
  // Source supplies rating but not slope, so slope remains
  // NULL.
  // ==========================================================
  {
    name: "Pelican Waters Golf Club",
    pars: [
      4, 4, 5, 3, 4, 3, 4, 5, 4,
      5, 3, 4, 4, 3, 4, 5, 4, 4,
    ],
    rating: 73,
    slope: null,
    tee: "Championship",
  },

  // ==========================================================
  // CITY GOLF CLUB TOOWOOMBA
  // Darling Downs
  // Blue
  // Par 70
  // Rating 68.7 / Slope 117
  // ==========================================================
  {
    name: "City Golf Club Toowoomba",
    pars: [
      4, 3, 4, 3, 4, 4, 4, 3, 4,
      5, 4, 4, 4, 4, 3, 4, 5, 4,
    ],
    rating: 68.7,
    slope: 117,
    tee: "Blue",
  },
];

// ============================================================
// SPECIAL COURSES
//
// Do NOT put facilities with multiple interchangeable nines
// through makeStandardCourse().
//
// Indooroopilly
// Keperra
// Royal Pines
// Sanctuary Cove
// etc.
//
// We can add those separately once each routing is mapped.
// ============================================================

const SPECIAL_COURSES = [];

// ============================================================
// BUILD DATABASE ROWS
// ============================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
  ...SPECIAL_COURSES,
];

// ============================================================
// VALIDATION
// ============================================================

function validateCourse(course) {
  const holes = Number(course.holes);

  if (holes !== 9 && holes !== 18) {
    throw new Error(
      `${course.name}: holes must be either 9 or 18`
    );
  }

  if (!Array.isArray(course.pars)) {
    throw new Error(
      `${course.name}: pars must be an array`
    );
  }

  if (course.pars.length !== holes) {
    throw new Error(
      `${course.name}: expected ${holes} pars but found ${course.pars.length}`
    );
  }

  course.pars.forEach((par, index) => {
    const value = Number(par);

    if (
      !Number.isInteger(value) ||
      value < 3 ||
      value > 6
    ) {
      throw new Error(
        `${course.name}: invalid par on hole ${index + 1}: ${par}`
      );
    }
  });

  if (
    course.rating !== null &&
    course.rating !== undefined
  ) {
    const rating = Number(course.rating);

    if (
      !Number.isFinite(rating) ||
      rating < 25 ||
      rating > 90
    ) {
      throw new Error(
        `${course.name}: invalid course rating ${course.rating}`
      );
    }
  }

  if (
    course.slope !== null &&
    course.slope !== undefined
  ) {
    const slope = Number(course.slope);

    if (
      !Number.isInteger(slope) ||
      slope < 55 ||
      slope > 155
    ) {
      throw new Error(
        `${course.name}: invalid slope rating ${course.slope}`
      );
    }
  }

  return true;
}

// ============================================================
// SEED FUNCTION
// ============================================================

export async function seedQldScorecards() {
  console.log("");
  console.log("==========================================");
  console.log("🏌️ TeeRadar QLD scorecard seed");
  console.log("==========================================");
  console.log(
    `Courses: ${STANDARD_COURSES.length}`
  );
  console.log(
    `Templates: ${COURSE_ROWS.length}`
  );
  console.log("");

  let processed = 0;
  let failed = 0;

  for (const course of COURSE_ROWS) {
    try {
      validateCourse(course);

      const holes = Number(course.holes);

      const rating =
        course.rating === null ||
        course.rating === undefined
          ? null
          : Number(course.rating);

      const slope =
        course.slope === null ||
        course.slope === undefined
          ? null
          : Number(course.slope);

      const tee =
        course.tee &&
        String(course.tee).trim()
          ? String(course.tee).trim()
          : null;

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
            'QLD',
            $2,
            $3::jsonb,
            '[]'::jsonb,
            $4,
            $5,
            $6,
            now()
          )

          ON CONFLICT (
            name,
            state,
            holes
          )

          DO UPDATE SET

            pars_json =
              EXCLUDED.pars_json,

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

            updated_at =
              now();
        `,
        [
          course.name,
          holes,
          JSON.stringify(course.pars),
          rating,
          slope,
          tee,
        ]
      );

      processed++;

      console.log(
        `✅ ${course.name} (${holes})`
      );
    } catch (error) {
      failed++;

      console.error(
        `❌ ${course.name}:`,
        error?.message || error
      );
    }
  }

  console.log("");
  console.log("==========================================");
  console.log("QLD SCORECARD SEED COMPLETE");
  console.log("==========================================");
  console.log(`✅ Processed: ${processed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📋 Total: ${COURSE_ROWS.length}`);
  console.log("");

  return {
    ok: failed === 0,
    state: "QLD",
    courses: STANDARD_COURSES.length,
    templates: COURSE_ROWS.length,
    processed,
    failed,
  };
}

export default seedQldScorecards;
