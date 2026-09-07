// backend/testGolfApiIo.js

import {
  ensureGolfApiCacheSchema,
  findGolfApiCourses,
  loadGolfApiCourse,
  getGolfApiGreensByHole,
} from "./golfApiIo.js";


// =========================================================
// DISTANCE HELPER
// =========================================================

function distanceMetres(
  lat1,
  lng1,
  lat2,
  lng2
) {
  const R = 6371000;

  const toRad =
    (value) =>
      value * Math.PI / 180;

  const φ1 =
    toRad(lat1);

  const φ2 =
    toRad(lat2);

  const Δφ =
    toRad(lat2 - lat1);

  const Δλ =
    toRad(lng2 - lng1);

  const a =
    Math.sin(
      Δφ / 2
    ) ** 2 +
    Math.cos(φ1) *
      Math.cos(φ2) *
      Math.sin(
        Δλ / 2
      ) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}


// =========================================================
// PICK BEST GREEN POINT
// =========================================================

function getBestGreenPoint(hole) {
  if (!hole) {
    return null;
  }

  return (
    hole.middle ||
    hole.front ||
    hole.back ||
    null
  );
}


// =========================================================
// MAIN
// =========================================================

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

  console.log(
    "✅ Cache table ready"
  );

  console.log("");


  // -------------------------------------------------------
  // 2. COURSE NAME FROM TERMINAL
  //
  // Examples:
  //
  // node backend/testGolfApiIo.js "Araluen"
  //
  // node backend/testGolfApiIo.js "Gosnells"
  //
  // node backend/testGolfApiIo.js "The Springs Club"
  // -------------------------------------------------------

  const searchName =
  process.argv[2]?.trim() ||
  "The Springs Club";

const layoutName =
  process.argv[3]?.trim() ||
  null;

  console.log(
    `🔎 Searching for ${searchName}...`
  );

  const search =
    await findGolfApiCourses({
      name:
        searchName,

      state:
        "WA",

      country:
        "Australia",
    });

  console.log("");

  console.log(
    `Search source: ${search.source}`
  );

  console.log(
    `Matches found: ${search.courses.length}`
  );

  console.log("");

  if (
    !search.courses.length
  ) {
    console.log(
      `❌ GolfAPI.io did not find ${searchName}`
    );

    process.exit(0);
  }


  // -------------------------------------------------------
  // 3. SHOW MATCHES
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
  // 4. PICK RESULT WITH GPS
  //
  // Prefer a result that actually has GPS.
  // If none have GPS, use the first match.
  // -------------------------------------------------------

  let selected = null;

if (layoutName) {
  selected =
    search.courses.find(
      (course) => {
        const courseName =
          course.courseName ||
          course.course_name ||
          "";

        return (
          courseName
            .trim()
            .toLowerCase() ===
          layoutName
            .trim()
            .toLowerCase()
        );
      }
    );

  if (!selected) {
    console.log(
      `❌ Could not find layout "${layoutName}"`
    );

    console.log("");

    console.log(
      "Available layouts:"
    );

    console.table(
      search.courses.map(
        (course) => ({
          course:
            course.courseName ||
            course.course_name,

          GPS:
            course.hasGPS ??
            course.has_gps,
        })
      )
    );

    process.exit(0);
  }
} else {
  selected =
    search.courses.find(
      (course) => {
        const hasGps =
          course.hasGPS ??
          course.has_gps;

        return (
          hasGps === 1 ||
          hasGps === "1" ||
          hasGps === true
        );
      }
    ) ||
    search.courses[0];
}

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
  // 5. FIRST FULL LOAD
  //
  // If already cached:
  // 0 API calls.
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
  // 6. CHECK GREEN GPS
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


// REPEATED 9-HOLE COURSES:
// COMPARE HOLES 1–9 AGAINST 10–18

  const selectedNumHoles =
  Number(
    selected.numHoles ??
    selected.num_holes ??
    first.course?.num_holes
  ) || null;

const repeatedNineOverrides = [
  "the springs",
];

const normalisedSearchName =
  searchName
    .toLowerCase()
    .trim();

const isRepeatedNine =
  selectedNumHoles === 9 ||
  repeatedNineOverrides.some(
    (name) =>
      normalisedSearchName.includes(name)
  );

if (isRepeatedNine) {
    console.log("");

    console.log(
      "========================================"
    );

    console.log(
      "FRONT 9 vs BACK 9 GREEN COMPARISON"
    );

    console.log(
      "========================================"
    );

    const comparisons = [];

    for (
      let frontHole = 1;
      frontHole <= 9;
      frontHole += 1
    ) {
      const backHole =
        frontHole + 9;

      const front =
        greens.find(
          (hole) =>
            Number(hole.hole) ===
            frontHole
        );

      const back =
        greens.find(
          (hole) =>
            Number(hole.hole) ===
            backHole
        );

      const frontPoint =
        getBestGreenPoint(
          front
        );

      const backPoint =
        getBestGreenPoint(
          back
        );

      if (
        !frontPoint ||
        !backPoint
      ) {
        comparisons.push({
          holes:
            `${frontHole} vs ${backHole}`,

          frontPoint:
            frontPoint
              ? `${frontPoint.latitude}, ${frontPoint.longitude}`
              : "missing",

          backPoint:
            backPoint
              ? `${backPoint.latitude}, ${backPoint.longitude}`
              : "missing",

          distanceMetres:
            "—",

          result:
            "⚠️ missing GPS",
        });

        continue;
      }

      const metres =
        distanceMetres(
          Number(
            frontPoint.latitude
          ),

          Number(
            frontPoint.longitude
          ),

          Number(
            backPoint.latitude
          ),

          Number(
            backPoint.longitude
          )
        );

      let result;

      if (
        metres <= 20
      ) {
        result =
          "✅ same green";
      } else if (
        metres <= 40
      ) {
        result =
          "⚠️ probably same";
      } else {
        result =
          "❌ different green";
      }

      comparisons.push({
        holes:
          `${frontHole} vs ${backHole}`,

        frontPoint:
          `${frontPoint.latitude}, ${frontPoint.longitude}`,

        backPoint:
          `${backPoint.latitude}, ${backPoint.longitude}`,

        distanceMetres:
          metres.toFixed(1),

        result,
      });
    }

    console.table(
      comparisons
    );


    // -----------------------------------------------------
    // SPRINGS PAIR SUMMARY
    // -----------------------------------------------------

    const validComparisons =
      comparisons.filter(
        (row) =>
          row.distanceMetres !== "—"
      );

    const sameGreen =
      validComparisons.filter(
        (row) =>
          Number(
            row.distanceMetres
          ) <= 20
      ).length;

    const probablySame =
      validComparisons.filter(
        (row) => {
          const distance =
            Number(
              row.distanceMetres
            );

          return (
            distance > 20 &&
            distance <= 40
          );
        }
      ).length;

    const different =
      validComparisons.filter(
        (row) =>
          Number(
            row.distanceMetres
          ) > 40
      ).length;

    console.log("");

    console.log(
      "PAIR SUMMARY"
    );

    console.log(
      "------------"
    );

    console.log(
      `✅ Same green <=20m: ${sameGreen}`
    );

    console.log(
      `⚠️ Probably same 20–40m: ${probablySame}`
    );

    console.log(
      `❌ Different >40m: ${different}`
    );
  }


  // -------------------------------------------------------
  // 8. COURSE GPS SUMMARY
  // -------------------------------------------------------

  const completeMiddle =
    greens.filter(
      (hole) =>
        hole.middle
    ).length;

  const completeFront =
    greens.filter(
      (hole) =>
        hole.front
    ).length;

  const completeBack =
    greens.filter(
      (hole) =>
        hole.back
    ).length;

  console.log("");

  console.log(
    "GPS SUMMARY"
  );

  console.log(
    "-----------"
  );

  console.log(
    `Holes with any green GPS: ${greens.length}`
  );

  console.log(
    `Front points: ${completeFront}`
  );

  console.log(
    `Middle points: ${completeMiddle}`
  );

  console.log(
    `Back points: ${completeBack}`
  );


  // -------------------------------------------------------
  // 9. LOAD SAME COURSE AGAIN
  //
  // This MUST come from TeeRadar's database.
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


  if (
    second.source === "cache"
  ) {
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
