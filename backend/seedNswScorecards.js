// backend/seedNswScorecards.js

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
// NSW SCORECARDS
// BATCH 1
// =========================================================

const STANDARD_COURSES = [

  // -------------------------------------------------------
  // NEW SOUTH WALES GOLF CLUB
  //
  // Championship
  // Par 72
  // Rating: 74
  // Slope: 138
  // -------------------------------------------------------
  {
    name: "new south wales golf club",

    pars: [
      4,3,4,4,5,3,4,5,4,
      4,3,5,4,4,4,4,3,5
    ],

    rating: 74.0,
    slope: 138,
    tee: "Championship",
  },


  // -------------------------------------------------------
  // ST MICHAEL'S GOLF CLUB
  //
  // White
  // Par 72
  // Rating: 72
  // Slope: 133
  // -------------------------------------------------------
  {
    name: "st michael's golf club",

    pars: [
      4,4,3,4,3,5,5,4,4,
      4,4,3,5,4,3,4,5,4
    ],

    rating: 72.0,
    slope: 133,
    tee: "White",
  },


  // -------------------------------------------------------
  // LONG REEF GOLF CLUB
  //
  // Black
  // Par 71
  // Rating: 72
  // Slope: 128
  // -------------------------------------------------------
  {
    name: "long reef golf club",

    pars: [
      5,3,4,4,4,4,3,4,5,
      3,4,4,3,4,5,4,4,4
    ],

    rating: 72.0,
    slope: 128,
    tee: "Black",
  },


  // -------------------------------------------------------
  // WAKEHURST GOLF CLUB
  //
  // Black
  // Par 72
  // Rating: 73
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "wakehurst golf club",

    pars: [
      4,4,4,5,3,4,4,5,4,
      4,4,4,3,4,5,3,4,4
    ],

    rating: 73.0,
    slope: 136,
    tee: "Black",
  },


  // -------------------------------------------------------
  // MONA VALE GOLF CLUB
  //
  // Blue
  // Par 72
  // Rating: 71
  // Slope: 131
  // -------------------------------------------------------
  {
    name: "mona vale golf club",

    pars: [
      5,3,5,4,5,3,4,3,4,
      4,5,4,5,3,4,3,4,4
    ],

    rating: 71.0,
    slope: 131,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // BAYVIEW GOLF CLUB
  //
  // Black
  // Par 72
  // Rating: 69.3
  // Slope: 134
  // -------------------------------------------------------
  {
    name: "bayview golf club",

    pars: [
      4,5,4,3,4,4,4,3,4,
      3,4,3,4,5,5,4,5,4
    ],

    rating: 69.3,
    slope: 134,
    tee: "Black",
  },


  // -------------------------------------------------------
  // WARRINGAH GOLF CLUB
  //
  // Blue
  // Par 70
  // Rating: 70.2
  // Slope: 124
  //
  // IMPORTANT:
  // Par is 70. Previous confusion came from course rating
  // being mistaken for course par.
  // -------------------------------------------------------
  {
    name: "warringah golf club",

    pars: [
      4,4,5,4,3,4,4,3,4,
      5,4,3,4,3,5,4,3,4
    ],

    rating: 70.2,
    slope: 124,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // MANLY GOLF CLUB
  //
  // Blue
  // Par 71
  // -------------------------------------------------------
  {
    name: "manly golf club",

    pars: [
      4,5,5,3,4,4,3,4,4,
      4,3,4,4,4,3,4,5,4
    ],

    rating: 72.0,
    slope: 134,
    tee: "Blue",
  },


  // -------------------------------------------------------
  // CROMER GOLF CLUB
  //
  // Black
  // Par 70
  // Rating: 73
  // Slope: 136
  // -------------------------------------------------------
  {
    name: "cromer golf club",

    pars: [
      4,3,5,3,4,4,4,4,3,
      5,4,4,4,4,3,5,4,3
    ],

    rating: 73.0,
    slope: 136,
    tee: "Black",
  },


  // -------------------------------------------------------
  // AVONDALE GOLF CLUB
  //
  // Championship
  // Par 71
  // Rating: 71.5
  // Slope: 132
  // -------------------------------------------------------
  {
    name: "avondale golf club",

    pars: [
      4,3,5,3,4,4,5,3,5,
      4,3,4,4,5,3,4,4,4
    ],

    rating: 71.5,
    slope: 132,
    tee: "Championship",
  },


  // -------------------------------------------------------
  // PYMBLE GOLF CLUB
  //
  // Men's
  // Par 72
  // Rating: 70
  // Slope: 123
  // -------------------------------------------------------
  {
    name: "pymble golf club",

    pars: [
      5,5,3,4,4,4,5,3,4,
      4,3,5,4,5,3,4,4,3
    ],

    rating: 70.0,
    slope: 123,
    tee: "Mens",
  },


  // -------------------------------------------------------
  // ROSEVILLE GOLF CLUB
  //
  // Blue
  // Par 66
  // Rating: 66.9
  // Slope: 118
  // -------------------------------------------------------
  {
    name: "roseville golf club",

    pars: [
      4,3,3,3,3,4,4,3,3,
      4,4,3,4,4,3,5,4,5
    ],

    rating: 66.9,
    slope: 118,
    tee: "Blue",
  },

];


// =========================================================
// BUILD NSW IMPORT LIST
// =========================================================

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(
    makeStandardCourse
  ),
];


// =========================================================
// NSW SEED FUNCTION
// =========================================================

export async function seedNswScorecards() {

  console.log(
    `🏌️ NSW scorecard seed starting (${COURSE_ROWS.length} templates)`
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
        'NSW',
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
    `✅ NSW scorecard seed complete (${insertedOrUpdated} templates)`
  );


  return {
    ok: true,

    courses:
      STANDARD_COURSES.length,

    templates:
      insertedOrUpdated,
  };
}
