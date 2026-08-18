// backend/seedTasScorecards.js

import db from "./db.js";


// =========================================================
// STANDARD 18-HOLE COURSE BUILDER
//
// Every normal 18-hole course automatically creates:
//
// Course 18
// Course - front 9
// Course - back 9
//
// We DO NOT copy an 18-hole rating/slope onto the 9-hole
// templates because that would be inaccurate.
// =========================================================

function makeStandardCourse({
  name,
  pars,
  rating = null,
  slope = null,
  tee = "White",
}) {
  if (!Array.isArray(pars) || pars.length !== 18) {
    throw new Error(
      `${name}: expected exactly 18 pars`
    );
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


// =========================================================
// TASMANIA SCORECARDS
// BATCH 1
// =========================================================

const STANDARD_COURSES = [


  // -------------------------------------------------------
  // TASMANIA GOLF CLUB
  //
  // White
  // Par 72
  //
  // Rating: 71
  // Slope: 126
  // -------------------------------------------------------
  {
    name: "tasmania golf club",

    pars: [
      4,3,5,4,5,4,4,5,3,
      4,4,5,4,3,4,4,3,4
    ],

    rating: 71.0,
    slope: 126,
    tee: "White",
  },


  // -------------------------------------------------------
  // LAUNCESTON GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Rating/slope intentionally left null until we have
  // a reliable tee-specific current pair.
  // -------------------------------------------------------
  {
    name: "launceston golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // DEVONPORT COUNTRY CLUB
  //
  // Men
  // Par 70
  //
  // Rating/slope intentionally left null until a reliable
  // current tee-specific pair is confirmed.
  // -------------------------------------------------------
  {
    name: "devonport country club",

    pars: [
      4,4,4,3,4,4,3,5,4,
      4,3,4,4,4,3,5,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // ULVERSTONE GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Rating/slope intentionally left null until verified.
  // -------------------------------------------------------
  {
    name: "ulverstone golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // RIVERSIDE GOLF CLUB
  //
  // Men's White
  // Par 72
  //
  // Hole-by-hole pars taken from Riverside's published
  // course tour.
  // -------------------------------------------------------
  {
    name: "riverside golf club",

    pars: [
      4,4,4,3,4,5,4,3,4,
      3,5,5,4,3,5,4,3,5
    ],

    rating: null,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // TAS BATCH 2
  // Hobart / North-West / North-East
  // =======================================================


  // -------------------------------------------------------
  // ROYAL HOBART GOLF CLUB
  //
  // Men
  // Par 72
  //
  // Rating/slope left null until a current tee-specific
  // pair can be confidently matched to this scorecard.
  // -------------------------------------------------------
  {
    name: "royal hobart golf club",

    pars: [
      4,4,3,5,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // KINGSTON BEACH GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "kingston beach golf club",

    pars: [
      4,5,4,3,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // BURNIE GOLF CLUB
  //
  // Men
  // Par 72
  // -------------------------------------------------------
  {
    name: "burnie golf club",

    pars: [
      4,5,3,4,4,4,3,5,4,
      4,5,3,4,4,4,3,5,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // WYNYARD GOLF CLUB
  //
  // Men
  // Par 70
  // -------------------------------------------------------
  {
    name: "wynyard golf club",

    pars: [
      4,4,3,4,5,4,3,4,4,
      4,3,4,5,4,3,4,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },


  // -------------------------------------------------------
  // SCOTTSDALE GOLF CLUB
  //
  // Men
  // Par 70
  // -------------------------------------------------------
  {
    name: "scottsdale golf club",

    pars: [
      4,4,3,5,4,3,4,4,4,
      4,3,4,5,4,3,4,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // =======================================================
  // TAS BATCH 3
  // Hobart / East Coast / North
  // =======================================================


  // -------------------------------------------------------
  // CLAREMONT GOLF CLUB
  //
  // Blue / Men
  // Par 69
  // 5,362 metres
  //
  // Official Claremont scorecard.
  // -------------------------------------------------------
  {
    name: "claremont golf club",

    pars: [
      5,3,5,3,4,3,4,4,4,
      4,3,4,4,4,3,4,5,3
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // GEORGE TOWN GOLF CLUB
  //
  // Men
  // Par 70
  //
  // Rating: 68
  // Slope: 117
  // -------------------------------------------------------
  {
    name: "george town golf club",

    pars: [
      4,4,3,5,3,4,3,5,4,
      4,4,4,4,3,4,3,5,4
    ],

    rating: 68.0,
    slope: 117,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BICHENO GOLF CLUB
  //
  // IMPORTANT:
  // Physical course has 9 greens / 18 tee positions.
  //
  // Blue Men
  // Full 18-hole playing layout = Par 71
  // Scratch: 72
  // Slope: 111
  //
  // Official club data.
  // -------------------------------------------------------
  {
    name: "bicheno golf club",

    pars: [
      4,4,4,3,4,3,5,4,5,
      4,4,4,3,4,3,4,4,5
    ],

    rating: 72.0,
    slope: 111,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // NEW NORFOLK GOLF CLUB
  //
  // 9-hole physical course played from alternate tees.
  //
  // First White nine = Par 35
  // Second White nine = Par 34
  //
  // Combined playing layout = Par 69
  //
  // Rating/slope left null.
  // -------------------------------------------------------
  {
    name: "new norfolk golf club",

    pars: [
      5,4,3,4,4,3,4,3,5,
      4,3,4,4,4,3,5,3,4
    ],

    rating: null,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // TAS BATCH 4
  // North-West / North / Southern Tasmania
  // =======================================================


  // -------------------------------------------------------
  // SMITHTON COUNTRY CLUB
  //
  // Yellow
  // Par 71
  // Rating: 70
  // Slope: 118
  // -------------------------------------------------------
  {
    name: "smithton country club",

    pars: [
      4,4,3,4,4,5,4,3,4,
      4,4,3,5,4,5,4,3,4
    ],

    rating: 70.0,
    slope: 118,
    tee: "Yellow",
  },


  // -------------------------------------------------------
  // DELORAINE GOLF CLUB
  //
  // Men
  // Par 70
  // Rating: 69
  // Slope: 114
  // -------------------------------------------------------
  {
    name: "deloraine golf club",

    pars: [
      4,4,5,3,3,5,4,3,4,
      4,4,4,3,3,5,4,4,4
    ],

    rating: 69.0,
    slope: 114,
    tee: "Men",
  },


  // -------------------------------------------------------
  // HUON VALLEY GOLF CLUB
  //
  // Men
  // Par 72
  // Rating: 70
  // Slope: 116
  //
  // NOTE:
  // The club describes the physical property as a
  // 12-hole course, but its competition scorecard has
  // a complete 18-hole playing sequence.
  // -------------------------------------------------------
  {
    name: "huon valley golf club",

    pars: [
      3,5,4,4,4,3,4,4,5,
      3,4,4,5,4,3,4,4,5
    ],

    rating: 70.0,
    slope: 116,
    tee: "Men",
  },


  // -------------------------------------------------------
  // LLANHERNE GOLF CLUB
  //
  // Yellow
  // Par 72
  // Rating: 70
  // Slope: 128
  //
  // The physical course is a compact/repeating layout,
  // but the published scorecard provides a complete
  // 18-hole competition sequence.
  // -------------------------------------------------------
  {
    name: "llanherne golf club",

    pars: [
      4,3,4,3,5,4,4,4,5,
      4,3,4,3,5,4,4,4,5
    ],

    rating: 70.0,
    slope: 128,
    tee: "Yellow",
  },


  // -------------------------------------------------------
  // SHEFFIELD GOLF CLUB
  //
  // Member
  //
  // Sheffield has separate Front and Back member cards.
  // Front: Par 34 / Rating 33.0 / Slope 101
  // Back:  Par 34 / Rating 33.5 / Slope 117
  //
  // Combined TeeRadar playing layout = Par 68.
  //
  // We leave the combined rating/slope null because the
  // source rates the two nine-hole configurations
  // separately.
  // -------------------------------------------------------
  {
    name: "sheffield golf club",

    pars: [
      // FRONT
      4,3,4,3,4,3,4,4,5,

      // BACK
      4,3,4,3,4,3,4,4,5
    ],

    rating: null,
    slope: null,
    tee: "Member",
  },
    // =======================================================
  // TAS BATCH 5 — STANDARD 18-HOLE COURSES
  // =======================================================


  // -------------------------------------------------------
  // SEABROOK GOLF CLUB
  //
  // Men's
  // Par 72
  // Rating: 71
  // Slope: 117
  // -------------------------------------------------------
  {
    name: "seabrook golf club",

    pars: [
      3,5,4,4,5,3,4,4,4,
      5,4,4,3,4,3,4,4,5
    ],

    rating: 71.0,
    slope: 117,
    tee: "Men's",
  },


  // -------------------------------------------------------
  // ST HELENS GOLF CLUB
  //
  // Blue / Men
  // Par 72
  // Scratch: 69
  // Slope: 115
  //
  // Golf Australia currently lists:
  // 18 Holes Blue Men — Par 72 / Scratch 69 / Slope 115
  // -------------------------------------------------------
  {
    name: "st helens golf club",

    pars: [
      3,3,4,4,4,5,4,4,5,
      3,3,4,4,4,5,4,4,5
    ],

    rating: 69.0,
    slope: 115,
    tee: "Blue",
  },
    // =======================================================
  // TAS BATCH 6 — 18-HOLE PLAYING LAYOUTS
  // =======================================================


  // -------------------------------------------------------
  // COLEBROOK GOLF CLUB
  //
  // Physical course: 9 holes with alternate tees
  // Members competition layout: 18 holes
  // Par 70
  //
  // Front: Par 35
  // Back:  Par 35
  //
  // Club lists Men's Australian Course Rating: 69.
  // Slope left null because a sufficiently reliable
  // current slope could not be matched.
  // -------------------------------------------------------
  {
    name: "colebrook golf club",

    pars: [
      4,3,4,4,5,4,4,3,4,
      4,3,4,4,5,4,4,3,4
    ],

    rating: 69.0,
    slope: null,
    tee: "Members",
  },


  // -------------------------------------------------------
  // CAMPBELL TOWN GOLF CLUB
  //
  // Physical 9-hole course with separate front/back tees.
  //
  // Men's Front: Par 35
  // Men's Back:  Par 35
  // Combined competition layout: Par 70
  //
  // Rating/slope left null.
  // -------------------------------------------------------
  {
    name: "campbell town golf club",

    pars: [
      // FRONT
      4,4,4,4,4,3,4,5,3,

      // BACK
      5,4,4,4,4,3,4,4,3
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },

];

const NINE_HOLE_COURSES = [

  // -------------------------------------------------------
  // ORFORD GOLF CLUB
  //
  // White
  // 9 holes
  // Par 35
  // Rating: 33.8
  // -------------------------------------------------------
  {
    name: "orford golf club",
    holes: 9,

    pars: [
      4,3,4,4,4,5,3,4,4
    ],

    rating: 33.8,
    slope: null,
    tee: "White",
  },
    // =======================================================
  // TAS BATCH 5 — TRUE 9-HOLE COURSES
  // =======================================================


  // -------------------------------------------------------
  // PENGUIN GOLF CLUB
  //
  // Men
  // 9 holes
  // Par 36
  // Rating: 35
  // Slope: 113
  // -------------------------------------------------------
  {
    name: "penguin golf club",
    holes: 9,

    pars: [
      4,4,4,3,5,4,3,5,4
    ],

    rating: 35.0,
    slope: 113,
    tee: "Men",
  },


  // -------------------------------------------------------
  // OATLANDS GOLF CLUB
  //
  // Members
  // 9 holes
  // Par 35
  // Rating: 34
  // Slope: 109
  // -------------------------------------------------------
  {
    name: "oatlands golf club",
    holes: 9,

    pars: [
      4,4,3,5,4,3,4,4,4
    ],

    rating: 34.0,
    slope: 109,
    tee: "Members",
  },


  // -------------------------------------------------------
  // SCAMANDER RIVER GOLF CLUB
  //
  // Blue
  // 9 holes
  // Par 36
  // Rating: 35
  // Slope: 110
  // -------------------------------------------------------
  {
    name: "scamander river golf club",
    holes: 9,

    pars: [
      4,4,4,5,5,3,4,3,4
    ],

    rating: 35.0,
    slope: 110,
    tee: "Blue",
  },
    // =======================================================
  // TAS BATCH 6 — TRUE 9-HOLE TEMPLATES
  // =======================================================


  // -------------------------------------------------------
  // BRIDPORT GOLF CLUB
  //
  // Blue
  // 9 holes
  // Par 36
  //
  // Rating: 34.5
  // Slope: 117
  // -------------------------------------------------------
  {
    name: "bridport golf club",
    holes: 9,

    pars: [
      3,4,4,5,4,3,4,5,4
    ],

    rating: 34.5,
    slope: 117,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // ROSEBERY GOLF CLUB
  //
  // White
  // 9 holes
  // Par 36
  //
  // Rating: 34.5
  // Slope: 119
  // -------------------------------------------------------
  {
    name: "rosebery golf club",
    holes: 9,

    pars: [
      3,4,4,3,4,4,4,5,5
    ],

    rating: 34.5,
    slope: 119,
    tee: "White",
  },


  // -------------------------------------------------------
  // BOTHWELL GOLF CLUB / RATHO FARM
  //
  // 9-hole historic course.
  //
  // IMPORTANT:
  // I am NOT adding guessed pars here.
  // Keep this one out of COURSE_ROWS until we have a
  // reliable current hole-by-hole scorecard.
  // -------------------------------------------------------

];


// =========================================================
// BUILD TAS IMPORT LIST
//
// 5 physical courses currently = 15 scorecard templates.
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(
    makeStandardCourse
  ),

  ...NINE_HOLE_COURSES,
];


// =========================================================
// TAS SEED FUNCTION
// =========================================================

export async function seedTasScorecards() {

  console.log(
    `🏌️ TAS scorecard seed starting (${COURSE_ROWS.length} templates)`
  );

  let insertedOrUpdated = 0;


  for (const course of COURSE_ROWS) {

    const holes =
      Number(course.holes);


    // -----------------------------------------------------
    // Validate hole count
    // -----------------------------------------------------

    if (![9, 18].includes(holes)) {

      throw new Error(
        `${course.name}: invalid hole count`
      );

    }


    // -----------------------------------------------------
    // Validate par array length
    // -----------------------------------------------------

    if (
      !Array.isArray(course.pars) ||
      course.pars.length !== holes
    ) {

      throw new Error(
        `${course.name}: par count does not equal ${holes}`
      );

    }


    // -----------------------------------------------------
    // Validate every individual par
    // -----------------------------------------------------

    for (const par of course.pars) {

      const p =
        Number(par);

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


    // -----------------------------------------------------
    // Validate rating
    // -----------------------------------------------------

    const rating =
      course.rating === null ||
      typeof course.rating === "undefined"
        ? null
        : Number(course.rating);

    if (
      rating !== null &&
      !Number.isFinite(rating)
    ) {

      throw new Error(
        `${course.name}: invalid course rating`
      );

    }


    // -----------------------------------------------------
    // Validate slope
    // -----------------------------------------------------

    const slope =
      course.slope === null ||
      typeof course.slope === "undefined"
        ? null
        : Number(course.slope);

    if (
      slope !== null &&
      (
        !Number.isFinite(slope) ||
        slope < 55 ||
        slope > 155
      )
    ) {

      throw new Error(
        `${course.name}: invalid slope rating`
      );

    }


    // -----------------------------------------------------
    // INSERT / UPDATE
    // -----------------------------------------------------

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
        'TAS',
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
        JSON.stringify(
          course.pars
        ),
        rating,
        slope,
        course.tee,
      ]
    );


    insertedOrUpdated++;

  }


  console.log(
    `✅ TAS scorecard seed complete (${insertedOrUpdated} templates)`
  );


  return {
    ok: true,

    courses:
      STANDARD_COURSES.length,

    templates:
      insertedOrUpdated,
  };
}
