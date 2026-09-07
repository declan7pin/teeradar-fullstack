// backend/golfApiIo.js

import db from "./db.js";

const BASE_URL =
  "https://golfapi.io/api/v2.3";

const API_KEY =
  (process.env.GOLF_API_IO_KEY || "").trim();


// =========================================================
// HELPERS
// =========================================================

function requireKey() {
  if (!API_KEY) {
    throw new Error(
      "GOLF_API_IO_KEY is not configured"
    );
  }
}


async function golfApiGet(path) {
  requireKey();

  const response = await fetch(
    `${BASE_URL}${path}`,
    {
      headers: {
        Authorization:
          `Bearer ${API_KEY}`,

        Accept:
          "application/json",
      },
    }
  );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `GolfAPI.io ${response.status}: ${text}`
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      "GolfAPI.io returned invalid JSON"
    );
  }

  if (
    json?.apiRequestsLeft !== undefined
  ) {
    console.log(
      "GolfAPI.io calls remaining:",
      json.apiRequestsLeft
    );
  }

  return json;
}


function toNullableNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function toBooleanGps(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1"
  );
}

// =========================================================
// NORMALISE TEERADAR COURSE SEARCH NAMES
//
// TeeRadar names may contain display text that GolfAPI
// does not use, for example:
//
// "Araluen Golf Course - 18 holes"
// becomes:
// "araluen"
//
// This lets those display-name variations reuse the same
// permanent GolfAPI cache entry.
// =========================================================

function normaliseGolfApiSearchName(value) {
  let name =
    String(value || "")
      .toLowerCase()
      .trim();

  if (!name) {
    return "";
  }

  // -------------------------------------------------------
  // Remove TeeRadar round/template suffixes.
  // -------------------------------------------------------

  name = name
    .replace(/\(\s*18\s*holes?[^)]*\)/gi, " ")
    .replace(/\(\s*9\s*holes?[^)]*\)/gi, " ")
    .replace(/\b18\s*holes?\b/gi, " ")
    .replace(/\b9\s*holes?\b/gi, " ")
    .replace(/\bfront\s*9\b/gi, " ")
    .replace(/\bback\s*9\b/gi, " ")
    .replace(/\bwalking\b/gi, " ");

  // -------------------------------------------------------
  // Remove common generic golf-course wording.
  //
  // Do NOT remove words such as "links", "country",
  // "estate", "lakes", "island", etc. because those may
  // genuinely identify a different course/layout.
  // -------------------------------------------------------

  name = name
    .replace(/\bgolf\s+course\b/gi, " ")
    .replace(/\bgolf\s+club\b/gi, " ");

  // -------------------------------------------------------
  // Clean separators / duplicate whitespace.
  // -------------------------------------------------------

  name = name
    .replace(/\s*[-–—]\s*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return name;
}

// =========================================================
// DATABASE SCHEMA
// =========================================================

export async function ensureGolfApiCacheSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS golf_api_courses (
      id BIGSERIAL PRIMARY KEY,

      golfapi_course_id TEXT UNIQUE NOT NULL,
      golfapi_club_id TEXT,

      club_name TEXT,
      course_name TEXT,

      city TEXT,
      state TEXT,
      country TEXT,
      address TEXT,

      num_holes INTEGER,
      has_gps BOOLEAN DEFAULT FALSE,

      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,

      measure TEXT,

      pars_men JSONB,
      indexes_men JSONB,

      pars_women JSONB,
      indexes_women JSONB,

      tees JSONB,

      coordinates JSONB,

      source_updated_at BIGINT,

      course_data_loaded BOOLEAN
        DEFAULT FALSE,

      coordinates_loaded BOOLEAN
        DEFAULT FALSE,

      created_at TIMESTAMPTZ
        DEFAULT NOW(),

      updated_at TIMESTAMPTZ
        DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      golf_api_courses_name_idx
    ON golf_api_courses (
      LOWER(course_name)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      golf_api_courses_club_name_idx
    ON golf_api_courses (
      LOWER(club_name)
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      golf_api_courses_state_idx
    ON golf_api_courses (
      state
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      golf_api_courses_country_idx
    ON golf_api_courses (
      country
    );
  `);
}


// =========================================================
// GET ONE CACHED COURSE
// =========================================================

export async function getCachedGolfApiCourse(
  courseId
) {
  await ensureGolfApiCacheSchema();

  const result =
    await db.query(
      `
      SELECT *
      FROM golf_api_courses
      WHERE golfapi_course_id = $1
      LIMIT 1
      `,
      [
        String(courseId),
      ]
    );

  return result.rows[0] || null;
}


// =========================================================
// SEARCH LOCAL CACHE FIRST
// =========================================================

export async function searchCachedGolfApiCourses({
  name,
  state,
  country = "Australia",
}) {
  await ensureGolfApiCacheSchema();

  const values = [];
  const conditions = [];

 if (name) {
  const rawName =
    String(name)
      .trim()
      .toLowerCase();

  const normalisedName =
    normaliseGolfApiSearchName(
      name
    );

  // First allow the exact/original search.
  values.push(
    `%${rawName}%`
  );

  const rawParam =
    values.length;

  // Then also search using TeeRadar's cleaned course name.
  values.push(
    `%${normalisedName}%`
  );

  const normalisedParam =
    values.length;

  conditions.push(`
    (
      LOWER(course_name)
        LIKE $${rawParam}

      OR

      LOWER(club_name)
        LIKE $${rawParam}

      OR

      LOWER(course_name)
        LIKE $${normalisedParam}

      OR

      LOWER(club_name)
        LIKE $${normalisedParam}
    )
  `);
}

  if (state) {
    values.push(
      String(state).trim()
    );

    conditions.push(`
      state = $${values.length}
    `);
  }

  if (country) {
    values.push(
      String(country).trim()
    );

    conditions.push(`
      country = $${values.length}
    `);
  }

  const where =
    conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

  const result =
    await db.query(
      `
      SELECT *
      FROM golf_api_courses
      ${where}
      ORDER BY
        club_name ASC,
        course_name ASC
      LIMIT 200
      `,
      values
    );

  return result.rows;
}


// =========================================================
// SAVE LIGHTWEIGHT SEARCH RESULT
// =========================================================

async function saveSearchResult(course) {
  const courseId =
    course?.courseID;

  if (!courseId) {
    return;
  }

  await db.query(
    `
    INSERT INTO golf_api_courses (
      golfapi_course_id,
      golfapi_club_id,

      club_name,
      course_name,

      city,
      state,
      country,
      address,

      num_holes,
      has_gps,

      source_updated_at,

      updated_at
    )

    VALUES (
      $1,$2,
      $3,$4,
      $5,$6,$7,$8,
      $9,$10,
      $11,
      NOW()
    )

    ON CONFLICT (
      golfapi_course_id
    )

    DO UPDATE SET
      golfapi_club_id =
        EXCLUDED.golfapi_club_id,

      club_name =
        EXCLUDED.club_name,

      course_name =
        EXCLUDED.course_name,

      city =
        EXCLUDED.city,

      state =
        EXCLUDED.state,

      country =
        EXCLUDED.country,

      address =
        EXCLUDED.address,

      num_holes =
        EXCLUDED.num_holes,

      has_gps =
        EXCLUDED.has_gps,

      source_updated_at =
        EXCLUDED.source_updated_at,

      updated_at =
        NOW()
    `,
    [
      String(courseId),

      course?.clubID
        ? String(course.clubID)
        : null,

      course?.clubName || null,
      course?.courseName || null,

      course?.city || null,
      course?.state || null,
      course?.country || null,
      course?.address || null,

      toNullableNumber(
        course?.numHoles
      ),

      toBooleanGps(
        course?.hasGPS
      ),

      toNullableNumber(
        course?.timestampUpdated
      ),
    ]
  );
}


// =========================================================
// SEARCH GOLFAPI.IO
// =========================================================

export async function searchGolfApiCourses({
  name,
  state,
  country = "Australia",
}) {
  await ensureGolfApiCacheSchema();

  const params =
    new URLSearchParams();

  if (name) {
    params.set(
      "name",
      name
    );
  }

  if (state) {
    params.set(
      "state",
      state
    );
  }

  if (country) {
    params.set(
      "country",
      country
    );
  }

  const json =
    await golfApiGet(
      `/courses?${params.toString()}`
    );

  const courses =
    Array.isArray(json?.courses)
      ? json.courses
      : [];

  for (const course of courses) {
    try {
      await saveSearchResult(
        course
      );
    } catch (err) {
      console.warn(
        "Could not cache GolfAPI search result:",
        course?.courseID,
        err?.message || err
      );
    }
  }

  return {
    apiRequestsLeft:
      json?.apiRequestsLeft ?? null,

    numCourses:
      Number(json?.numCourses) || 0,

    numAllCourses:
      Number(json?.numAllCourses) || 0,

    courses,
  };
}


// =========================================================
// SEARCH CACHE FIRST, API SECOND
// =========================================================

export async function findGolfApiCourses({
  name,
  state,
  country = "Australia",
}) {
  await ensureGolfApiCacheSchema();

  /*
   * First look in our own database.
   */
  const cached =
    await searchCachedGolfApiCourses({
      name,
      state,
      country,
    });

  if (cached.length > 0) {
    console.log(
      `✅ GolfAPI cache search hit: ${cached.length} result(s)`
    );

    return {
      source: "cache",
      courses: cached,
    };
  }

  /*
   * Nothing cached.
   *
   * Search GolfAPI.io.
   * Search requests cost only 0.1 calls.
   */
  console.log(
    "🌐 GolfAPI.io search required"
  );

  const remote =
    await searchGolfApiCourses({
      name,
      state,
      country,
    });

  return {
    source: "api",

    apiRequestsLeft:
      remote.apiRequestsLeft,

    courses:
      remote.courses,
  };
}


// =========================================================
// SAVE FULL COURSE DATA
// =========================================================

async function saveFullCourse({
  course,
  coordinates,
}) {
  const courseId =
    course?.courseID;

  if (!courseId) {
    throw new Error(
      "GolfAPI.io course response has no courseID"
    );
  }

  const hasGps =
    toBooleanGps(
      course?.hasGPS
    );

  await db.query(
    `
    INSERT INTO golf_api_courses (
      golfapi_course_id,
      golfapi_club_id,

      club_name,
      course_name,

      city,
      state,
      country,
      address,

      num_holes,
      has_gps,

      latitude,
      longitude,

      measure,

      pars_men,
      indexes_men,

      pars_women,
      indexes_women,

      tees,

      coordinates,

      source_updated_at,

      course_data_loaded,
      coordinates_loaded,

      updated_at
    )

    VALUES (
      $1,$2,
      $3,$4,
      $5,$6,$7,$8,
      $9,$10,
      $11,$12,
      $13,
      $14,$15,
      $16,$17,
      $18,
      $19,
      $20,
      TRUE,$21,
      NOW()
    )

    ON CONFLICT (
      golfapi_course_id
    )

    DO UPDATE SET
      golfapi_club_id =
        EXCLUDED.golfapi_club_id,

      club_name =
        COALESCE(
          EXCLUDED.club_name,
          golf_api_courses.club_name
        ),

      course_name =
        COALESCE(
          EXCLUDED.course_name,
          golf_api_courses.course_name
        ),

      city =
        EXCLUDED.city,

      state =
        EXCLUDED.state,

      country =
        EXCLUDED.country,

      address =
        EXCLUDED.address,

      num_holes =
        EXCLUDED.num_holes,

      has_gps =
        EXCLUDED.has_gps,

      latitude =
        EXCLUDED.latitude,

      longitude =
        EXCLUDED.longitude,

      measure =
        EXCLUDED.measure,

      pars_men =
        EXCLUDED.pars_men,

      indexes_men =
        EXCLUDED.indexes_men,

      pars_women =
        EXCLUDED.pars_women,

      indexes_women =
        EXCLUDED.indexes_women,

      tees =
        EXCLUDED.tees,

      coordinates =
        EXCLUDED.coordinates,

      source_updated_at =
        EXCLUDED.source_updated_at,

      course_data_loaded =
        TRUE,

      coordinates_loaded =
        EXCLUDED.coordinates_loaded,

      updated_at =
        NOW()
    `,
    [
      String(courseId),

      course?.clubID
        ? String(course.clubID)
        : null,

      course?.clubName || null,
      course?.courseName || null,

      course?.city || null,
      course?.state || null,
      course?.country || null,
      course?.address || null,

      toNullableNumber(
        course?.numHoles
      ),

      hasGps,

      toNullableNumber(
        course?.latitude
      ),

      toNullableNumber(
        course?.longitude
      ),

      course?.measure || null,

      JSON.stringify(
        Array.isArray(
          course?.parsMen
        )
          ? course.parsMen
          : []
      ),

      JSON.stringify(
        Array.isArray(
          course?.indexesMen
        )
          ? course.indexesMen
          : []
      ),

      JSON.stringify(
        Array.isArray(
          course?.parsWomen
        )
          ? course.parsWomen
          : []
      ),

      JSON.stringify(
        Array.isArray(
          course?.indexesWomen
        )
          ? course.indexesWomen
          : []
      ),

      JSON.stringify(
        Array.isArray(
          course?.tees
        )
          ? course.tees
          : []
      ),

      JSON.stringify(
        Array.isArray(
          coordinates
        )
          ? coordinates
          : []
      ),

      toNullableNumber(
        course?.timestampUpdated
      ),

      hasGps,
    ]
  );
}


// =========================================================
// LOAD FULL COURSE + GPS
// =========================================================

export async function loadGolfApiCourse(
  courseId
) {
  await ensureGolfApiCacheSchema();

  const id =
    String(courseId);

  /*
   * -----------------------------------------
   * 1. CHECK TEERADAR DATABASE FIRST
   * -----------------------------------------
   */

  const cached =
    await getCachedGolfApiCourse(
      id
    );

  if (
    cached?.course_data_loaded &&
    (
      !cached.has_gps ||
      cached.coordinates_loaded
    )
  ) {
    console.log(
      `✅ GolfAPI full cache hit: ${cached.course_name}`
    );

    return {
      source: "cache",
      course: cached,
    };
  }

  /*
   * -----------------------------------------
   * 2. FETCH FULL COURSE DATA
   *
   * Costs 1 API call.
   * -----------------------------------------
   */

  console.log(
    `🌐 GolfAPI.io course fetch: ${id}`
  );

  const course =
    await golfApiGet(
      `/courses/${encodeURIComponent(id)}?measureUnit=m`
    );

  const hasGps =
    toBooleanGps(
      course?.hasGPS
    );

  /*
   * -----------------------------------------
   * 3. FETCH GPS COORDINATES
   *
   * Only if the course has GPS.
   *
   * Costs 1 API call.
   * -----------------------------------------
   */

  let coordinates = [];

  let coordinatesLoaded =
    false;

  if (hasGps) {
    console.log(
      `🌐 GolfAPI.io coordinate fetch: ${id}`
    );

    const coordinateJson =
      await golfApiGet(
        `/coordinates/${encodeURIComponent(id)}`
      );

    coordinates =
      Array.isArray(
        coordinateJson?.coordinates
      )
        ? coordinateJson.coordinates
        : [];

    coordinatesLoaded = true;
  }

  /*
   * -----------------------------------------
   * 4. SAVE EVERYTHING PERMANENTLY
   * -----------------------------------------
   */

  await saveFullCourse({
    course,
    coordinates,
  });

  /*
   * If GPS didn't exist, saveFullCourse marks
   * coordinates_loaded false automatically
   * via hasGPS.
   */

  if (
    !hasGps &&
    cached?.golfapi_course_id
  ) {
    await db.query(
      `
      UPDATE golf_api_courses
      SET
        coordinates_loaded = FALSE,
        updated_at = NOW()
      WHERE golfapi_course_id = $1
      `,
      [id]
    );
  }

  /*
   * -----------------------------------------
   * 5. RETURN SAVED VERSION
   * -----------------------------------------
   */

  const saved =
    await getCachedGolfApiCourse(
      id
    );

  return {
    source: "api",
    coordinatesLoaded,
    course: saved,
  };
}


// =========================================================
// GET GREEN COORDINATES FOR A COURSE
// =========================================================

export async function getGolfApiGreenCoordinates(
  courseId
) {
  const loaded =
    await loadGolfApiCourse(
      courseId
    );

  const course =
    loaded?.course;

  if (!course) {
    return [];
  }

  const coordinates =
    Array.isArray(
      course.coordinates
    )
      ? course.coordinates
      : [];

  /*
   * GolfAPI.io:
   *
   * poi = 1 -> green
   *
   * location:
   * 1 -> front
   * 2 -> middle
   * 3 -> back
   */

  return coordinates
    .filter(
      (row) =>
        Number(row?.poi) === 1
    )
    .map(
      (row) => ({
        hole:
          toNullableNumber(
            row?.hole
          ),

        location:
          toNullableNumber(
            row?.location
          ),

        latitude:
          toNullableNumber(
            row?.latitude
          ),

        longitude:
          toNullableNumber(
            row?.longitude
          ),
      })
    )
    .filter(
      (row) =>
        row.hole !== null &&
        row.latitude !== null &&
        row.longitude !== null
    );
}


// =========================================================
// GET GREENS GROUPED BY HOLE
// =========================================================

export async function getGolfApiGreensByHole(
  courseId
) {
  const greens =
    await getGolfApiGreenCoordinates(
      courseId
    );

  const holes = {};

  for (const green of greens) {
    const hole =
      green.hole;

    if (!holes[hole]) {
      holes[hole] = {
        hole,
        front: null,
        middle: null,
        back: null,
      };
    }

    const point = {
      latitude:
        green.latitude,

      longitude:
        green.longitude,
    };

    if (
      green.location === 1
    ) {
      holes[hole].front =
        point;
    }

    if (
      green.location === 2
    ) {
      holes[hole].middle =
        point;
    }

    if (
      green.location === 3
    ) {
      holes[hole].back =
        point;
    }
  }

  return Object.values(
    holes
  ).sort(
    (a, b) =>
      a.hole - b.hole
  );
}
