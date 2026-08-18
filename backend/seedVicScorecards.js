// backend/seedVicScorecards.js

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

const STANDARD_COURSES = [

  // VIC courses go here

];

const COURSE_ROWS = [
  ...STANDARD_COURSES.flatMap(makeStandardCourse),
];

export async function seedVicScorecards() {

  console.log(
    `🏌️ VIC scorecard seed starting (${COURSE_ROWS.length} templates)`
  );

  let insertedOrUpdated = 0;

  for (const course of COURSE_ROWS) {

    const holes = Number(course.holes);

    if (![9, 18].includes(holes)) {
      throw new Error(`${course.name}: invalid hole count`);
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
        'VIC',
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
        course.tee,
      ]
    );

    insertedOrUpdated++;
  }

  console.log(
    `✅ VIC scorecard seed complete (${insertedOrUpdated} templates)`
  );

  return {
    ok: true,
    courses: STANDARD_COURSES.length,
    templates: insertedOrUpdated,
  };
}
