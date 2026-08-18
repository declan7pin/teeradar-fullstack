// backend/seedActScorecards.js

import db from "./db.js";


// =========================================================
// STANDARD 18-HOLE COURSE BUILDER
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
// VERIFIED ACT SCORECARDS
// =========================================================

const STANDARD_COURSES = [


  // -------------------------------------------------------
  // FEDERAL GOLF CLUB
  //
  // Blue Men
  // Par 72
  // Scratch: 73
  // Slope: 131
  //
  // Federal's own Golf Australia chart confirms 73 / 131.
  // -------------------------------------------------------
  {
    name: "federal golf club",

    pars: [
      5,4,3,4,4,4,5,3,4,
      4,4,3,5,4,4,3,5,4
    ],

    rating: 73.0,
    slope: 131,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MURRUMBIDGEE COUNTRY CLUB
  //
  // Blue
  // Par 72
  // Rating: 73.9
  // Slope: 126
  // -------------------------------------------------------
  {
    name: "murrumbidgee country club",

    pars: [
      4,4,5,3,4,5,4,4,3,
      4,5,4,3,5,4,4,3,4
    ],

    rating: 73.9,
    slope: 126,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // GUNGAHLIN LAKES GOLF CLUB
  //
  // Blue
  // Par 72
  //
  // Golf NSW currently lists Blue slope 136.
  // Current published Blue scorecard is Par 72.
  //
  // Scratch left null because current sources differ
  // slightly on the exact rating.
  // -------------------------------------------------------
  {
    name: "gungahlin lakes golf club",

    pars: [
      4,4,3,4,3,5,4,5,4,
      4,3,4,5,4,4,5,3,4
    ],

    rating: null,
    slope: 136,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // GOLD CREEK COUNTRY CLUB
  //
  // Black
  // Par 72
  // Rating: 74.8
  // Slope: 132
  // -------------------------------------------------------
  {
    name: "gold creek country club",

    pars: [
      4,4,5,4,3,4,3,4,5,
      4,4,3,4,5,3,5,4,4
    ],

    rating: 74.8,
    slope: 132,
    tee: "Black",
  },


  // -------------------------------------------------------
  // FAIRBAIRN GOLF CLUB
  //
  // Par 70
  //
  // Official club currently confirms:
  // 18 holes / Par 70.
  //
  // Rating/slope left null until we have a clean current
  // men's tee-specific rating pair.
  // -------------------------------------------------------
  {
    name: "fairbairn golf club",

    pars: [
      4,4,4,4,5,3,4,3,5,
      3,4,3,5,3,4,4,4,4
    ],

    rating: null,
    slope: null,
    tee: "Men",
  },
    // -------------------------------------------------------
  // CAPITAL PUBLIC GOLF COURSE
  //
  // Blue / Men
  // Par 69
  // Rating: 68
  // Slope: 121
  // -------------------------------------------------------
  {
    name: "capital public golf course",

    pars: [
      5,4,3,5,4,4,3,4,3,
      5,3,4,4,3,4,4,4,3
    ],

    rating: 68.0,
    slope: 121,
    tee: "Blue",
  },
    // =======================================================
  // ACT BATCH 3
  // =======================================================


  // -------------------------------------------------------
  // BURNS GOLF CLUB BELCONNEN
  // Formerly / also known as Magpies Belconnen Golf Club
  //
  // Blue / Men
  // Par 72
  //
  // Rating: 72
  // Slope: 129
  //
  // Front 9: 37
  // Back 9:  35
  // -------------------------------------------------------
  {
    name: "burns golf club belconnen",

    pars: [
      // FRONT 9 — PAR 37
      5,4,3,4,3,4,4,5,5,

      // BACK 9 — PAR 35
      4,4,4,4,3,4,4,5,3
    ],

    rating: 72.0,
    slope: 129,
    tee: "Blue",
  },
    // =======================================================
  // ACT BATCH 4
  // =======================================================


  // -------------------------------------------------------
  // ROYAL MILITARY COLLEGE GOLF CLUB
  // RMC / DUNTROON
  //
  // Physical course: 9 holes with alternate back-nine tees
  //
  // Men's Blue
  // 18-hole playing layout
  //
  // Par: 68
  // AMCR: 68
  // Length: 5,364m
  //
  // Front 9: Par 34
  // Back 9:  Par 34
  // -------------------------------------------------------
  {
    name: "royal military college golf club",

    pars: [
      // FRONT 9 — PAR 34
      4,3,4,5,3,4,3,4,4,

      // BACK 9 — PAR 34
      4,3,4,5,3,4,3,4,4
    ],

    rating: 68.0,
    slope: null,
    tee: "Blue",
  },
  
];


  
  // =========================================================
// ACT BATCH 2
// SPECIAL / MULTI-NINE COURSES
// =========================================================


// =========================================================
// ROYAL CANBERRA GOLF CLUB
//
// 27-hole facility:
//
// Holes 1-9
// Holes 10-18
// Holes 19-27
//
// Official Blue combinations:
//
// Westbourne   = holes 1-18
// Par 72 / Scratch 73 / Slope 140
//
// Yarralumla   = holes 10-27
// Par 72 / Scratch 72 / Slope 128
//
// Brindabella  = holes 19-27 + 1-9
// Par 72 / Scratch 74 / Slope 129
// =========================================================

const ROYAL_CANBERRA_1_9 = [
  5,4,3,4,4,5,4,3,4
];

const ROYAL_CANBERRA_10_18 = [
  4,4,4,3,4,5,4,3,5
];

const ROYAL_CANBERRA_19_27 = [
  4,3,4,4,4,5,4,3,5
];


const SPECIAL_COURSES = [

  // -------------------------------------------------------
  // ROYAL CANBERRA — WESTBOURNE
  // Holes 1-18
  // -------------------------------------------------------
  {
    name: "royal canberra - westbourne 18",
    holes: 18,

    pars: [
      ...ROYAL_CANBERRA_1_9,
      ...ROYAL_CANBERRA_10_18
    ],

    rating: 73.0,
    slope: 140,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // ROYAL CANBERRA — YARRALUMLA
  // Holes 10-27
  // -------------------------------------------------------
  {
    name: "royal canberra - yarralumla 18",
    holes: 18,

    pars: [
      ...ROYAL_CANBERRA_10_18,
      ...ROYAL_CANBERRA_19_27
    ],

    rating: 72.0,
    slope: 128,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // ROYAL CANBERRA — BRINDABELLA
  // Holes 19-27 followed by 1-9
  // -------------------------------------------------------
  {
    name: "royal canberra - brindabella 18",
    holes: 18,

    pars: [
      ...ROYAL_CANBERRA_19_27,
      ...ROYAL_CANBERRA_1_9
    ],

    rating: 74.0,
    slope: 129,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // ROYAL CANBERRA — 1-9
  // -------------------------------------------------------
  {
    name: "royal canberra - holes 1-9",
    holes: 9,

    pars: [
      ...ROYAL_CANBERRA_1_9
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // ROYAL CANBERRA — 10-18
  // -------------------------------------------------------
  { 
    name: "royal canberra - holes 10-18",
    holes: 9,

    pars: [
      ...ROYAL_CANBERRA_10_18
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // ROYAL CANBERRA — 19-27
  // -------------------------------------------------------
  {
    name: "royal canberra - holes 19-27",
    holes: 9,

    pars: [
      ...ROYAL_CANBERRA_19_27
    ],

    rating: null,
    slope: null,
    tee: "Blue",
  },
  



// =========================================================
// BUILD IMPORT LIST
// =========================================================
const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(
    makeStandardCourse
  ),

  ...SPECIAL_COURSES,
];


// =========================================================
// ACT SEED FUNCTION
// =========================================================

export async function seedActScorecards() {

  console.log(
    `🏌️ ACT scorecard seed starting (${COURSE_ROWS.length} templates)`
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
    // Validate par array
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
    // Validate pars
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
        'ACT',
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
    `✅ ACT scorecard seed complete (${insertedOrUpdated} templates)`
  );


  return {
    ok: true,

    courses:
      STANDARD_COURSES.length,

    templates:
      insertedOrUpdated,
  };
}
