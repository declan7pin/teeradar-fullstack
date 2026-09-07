// backend/testGolfApiIo.js

import {
  ensureGolfApiCacheSchema,
  findGolfApiCourses,
  loadGolfApiCourse,
  getGolfApiGreensByHole,
} from "./golfApiIo.js";


async function main() {
  console.log("");
  console.log("========================================");
  console.log("🏌️ GolfAPI.io TeeRadar Test");
  console.log("========================================");
  console.log("");

  // -------------------------------------------------------
  // 1. ENSURE CACHE TABLE EXISTS
  // -------------------------------------------------------

  await ensureGolfApiCacheSchema();

  console.log("✅ Cache table ready");
  console.log("");


  // -------------------------------------------------------
  // 2. SEARCH FOR A COURSE
  //
  // GolfAPI search costs 0.1 calls if not already cached.
  // -------------------------------------------------------

  console.log(
    "🔎 Searching for The Springs Public Golf Course..."
  );

  const search =
    await findGolfApiCourses({
      name: "The Springs Club",
      state: "WA",
      country: "Australia",
    });

  console.log("");
  console.log(
    `Search source: ${search.source}`
  );

  console.log(
    `Matches found: ${search.courses.length}`
  );

  console.log("");

  if (!search.courses.length) {
    console.log(
      "❌ GolfAPI.io did not find The Springs Club"
    );

    process.exit(0);
  }


  // -------------------------------------------------------
  // SHOW MATCHES
  // -------------------------------------------------------

  console.table(
    search.courses.map(
      (course) => ({
        courseID:
          course.courseID ||
          course.golfapi_course_id,

        club:
          course.clubName ||
          course.club_name,

        course:
          course.courseName ||
          course.course_name,

        city:
          course.city,

        state:
          course.state,

        holes:
          course.numHoles ||
          course.num_holes,

        GPS:
          course.hasGPS ??
          course.has_gps,
      })
    )
  );


  // -------------------------------------------------------
  // 3. PICK FIRST RESULT
  // -------------------------------------------------------

  const selected =
    search.courses[0];

  const courseId =
    selected.courseID ||
    selected.golfapi_course_id;

  if (!courseId) {
    throw new Error(
      "Selected result does not contain a GolfAPI course ID."
    );
  }

  console.log("");
  console.log(
    `➡️ Testing course ID: ${courseId}`
  );


  // -------------------------------------------------------
  // 4. FIRST FULL LOAD
  //
  // If not cached:
  // course details = 1 call
  // coordinates    = 1 call if hasGPS
  // -------------------------------------------------------

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "FIRST LOAD"
  );
  console.log(
    "========================================"
  );

  const first =
    await loadGolfApiCourse(
      courseId
    );

  console.log("");
  console.log(
    `First load source: ${first.source}`
  );

  console.log(
    `Course: ${first.course?.club_name} / ${first.course?.course_name}`
  );

  console.log(
    `Has GPS: ${first.course?.has_gps}`
  );

  console.log(
    `Course data saved: ${first.course?.course_data_loaded}`
  );

  console.log(
    `Coordinates saved: ${first.course?.coordinates_loaded}`
  );


  // -------------------------------------------------------
  // 5. CHECK GREEN GPS
  // -------------------------------------------------------

  const greens =
    await getGolfApiGreensByHole(
      courseId
    );

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "GREEN GPS"
  );
  console.log(
    "========================================"
  );

  console.log(
    `Holes with green GPS: ${greens.length}`
  );

  console.table(
    greens.map(
      (hole) => ({
        hole:
          hole.hole,

        front:
          hole.front
            ? `${hole.front.latitude}, ${hole.front.longitude}`
            : "—",

        middle:
          hole.middle
            ? `${hole.middle.latitude}, ${hole.middle.longitude}`
            : "—",

        back:
          hole.back
            ? `${hole.back.latitude}, ${hole.back.longitude}`
            : "—",
      })
    )
  );


  // -------------------------------------------------------
  // 6. LOAD SAME COURSE AGAIN
  //
  // This MUST come from TeeRadar's database.
  //
  // No GolfAPI.io calls should occur.
  // -------------------------------------------------------

  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "SECOND LOAD - CACHE TEST"
  );
  console.log(
    "========================================"
  );

  const second =
    await loadGolfApiCourse(
      courseId
    );

  console.log("");
  console.log(
    `Second load source: ${second.source}`
  );


  if (second.source === "cache") {
    console.log("");
    console.log(
      "✅ SUCCESS"
    );

    console.log(
      "Second request came entirely from TeeRadar Postgres."
    );

    console.log(
      "No additional GolfAPI.io course/GPS call was required."
    );
  } else {
    console.log("");
    console.log(
      "⚠️ Cache test failed."
    );

    console.log(
      "The second request contacted GolfAPI.io again."
    );
  }


  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "TEST COMPLETE"
  );
  console.log(
    "========================================"
  );
  console.log("");
}


main().catch(
  (err) => {
    console.error("");
    console.error(
      "❌ GolfAPI.io test failed:"
    );

    console.error(
      err
    );

    process.exit(1);
  }
);
