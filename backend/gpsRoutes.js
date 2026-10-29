// backend/gpsRoutes.js

import express from "express";

import {
  findGolfApiCourses,
  loadGolfApiCourse,
  getGolfApiGreensByHole,
} from "./golfApiIo.js";

import {
  requireAuth,
} from "./auth.js";

import db from "./db.js";

const router =
  express.Router();

router.use(
  express.json()
);


// =========================================================
// HELPERS
// =========================================================

function normaliseState(value) {
  const state =
    String(value || "")
      .trim()
      .toUpperCase();

  const allowed =
    new Set([
      "WA",
      "NT",
      "QLD",
      "NSW",
      "VIC",
      "SA",
      "TAS",
      "ACT",
    ]);

  return allowed.has(state)
    ? state
    : "";
}


function golfApiCountryName(
  countryCode
) {
  const code =
    String(
      countryCode || "AU"
    )
      .trim()
      .toUpperCase();

  /*
   * TeeRadar is currently focused on Australia.
   *
   * Keep this helper so international countries
   * can be added later without changing the route.
   */

  if (code === "AU") {
    return "Australia";
  }

  return null;
}


function getCourseId(course) {
  return (
    course?.courseID ||
    course?.golfapi_course_id ||
    null
  );
}


function getClubName(course) {
  return (
    course?.clubName ||
    course?.club_name ||
    null
  );
}


function getCourseName(course) {
  return (
    course?.courseName ||
    course?.course_name ||
    null
  );
}


function getNumHoles(course) {
  const value =
    course?.numHoles ??
    course?.num_holes;

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function getHasGps(course) {
  const value =
    course?.hasGPS ??
    course?.has_gps;

  return (
    value === true ||
    value === 1 ||
    value === "1"
  );
}


// =========================================================
// SEARCH COURSES
//
// NEW FLOW:
//
// TeeRadar Postgres first
//       ↓
// GolfAPI.io only when not already cached
//       ↓
// Search result saved automatically
//
// Examples:
//
// /api/gps/search?q=Araluen&state=WA
// /api/gps/search?q=Whaleback&state=WA
// /api/gps/search?q=St%20Lucia&state=QLD
// =========================================================

router.get(
  "/search",
  requireAuth,
  async (req, res) => {
    try {
      const query =
        String(
          req.query.q || ""
        ).trim();

      if (!query) {
        return res.status(400).json({
          ok: false,

          error:
            "Search query is required",
        });
      }


      // -------------------------------------------------
      // STATE
      //
      // State is strongly recommended because Australian
      // courses can have similar names.
      // -------------------------------------------------

      const state =
        normaliseState(
          req.query.state
        );


      // -------------------------------------------------
      // COUNTRY
      //
      // TeeRadar currently uses Australia.
      // -------------------------------------------------

      const countryCode =
        String(
          req.query.country ||
          "AU"
        )
          .trim()
          .toUpperCase();

      const country =
        golfApiCountryName(
          countryCode
        );

      if (!country) {
        return res.status(400).json({
          ok: false,

          error:
            "Only Australian GolfAPI searches are currently enabled",

          country:
            countryCode,
        });
      }


      // -------------------------------------------------
      // CACHE-FIRST SEARCH
      // -------------------------------------------------

      const search =
        await findGolfApiCourses({
          name:
            query,

          state:
            state || undefined,

          country:
            country,
        });


      const rawCourses =
        Array.isArray(
          search?.courses
        )
          ? search.courses
          : [];


      // -------------------------------------------------
      // NORMALISE RESPONSE
      //
      // Keep useful provider fields but also return a
      // predictable TeeRadar shape.
      // -------------------------------------------------

      const courses =
        rawCourses
          .map(
            (course) => {
              const id =
                getCourseId(
                  course
                );

              if (!id) {
                return null;
              }

              return {
                id:
                  String(id),

                courseID:
                  String(id),

                provider_course_id:
                  String(id),

                club:
                  getClubName(
                    course
                  ),

                clubName:
                  getClubName(
                    course
                  ),

                course:
                  getCourseName(
                    course
                  ),

                courseName:
                  getCourseName(
                    course
                  ),

                city:
                  course?.city ||
                  null,

                state:
                  course?.state ||
                  state ||
                  null,

                country:
                  course?.country ||
                  country,

                address:
                  course?.address ||
                  null,

                holes:
                  getNumHoles(
                    course
                  ),

                numHoles:
                  getNumHoles(
                    course
                  ),

                hasGPS:
                  getHasGps(
                    course
                  ),

                source:
                  search?.source ||
                  null,
              };
            }
          )
          .filter(Boolean);


      return res.json({
        ok: true,

        source:
          search?.source ||
          null,

        country:
          countryCode,

        state:
          state || null,

        courses,
      });

    } catch (err) {
      console.error(
        "GolfAPI GPS course search failed:",
        err
      );

      return res.status(500).json({
        ok: false,

        error:
          "Could not search golf courses",

        detail:
          err?.message ||
          String(err),
      });
    }
  }
);


// =========================================================
// COURSE DETAIL
//
// NEW FLOW:
//
// TeeRadar cache first
//       ↓
// GolfAPI.io only if full course data is missing
//       ↓
// Full course saved permanently
// =========================================================

router.get(
  "/course/:providerCourseId",
  requireAuth,
  async (req, res) => {
    try {
      const providerCourseId =
        String(
          req.params.providerCourseId
        ).trim();

      if (!providerCourseId) {
        return res.status(400).json({
          ok: false,

          error:
            "Course ID is required",
        });
      }


      const loaded =
        await loadGolfApiCourse(
          providerCourseId
        );

      const course =
        loaded?.course ||
        null;


      if (!course) {
        return res.status(404).json({
          ok: false,

          error:
            "Golf course not found",
        });
      }


      return res.json({
        ok: true,

        source:
          loaded?.source ||
          null,

        course: {
          id:
            course.golfapi_course_id,

          courseID:
            course.golfapi_course_id,

          provider_course_id:
            course.golfapi_course_id,

          clubID:
            course.golfapi_club_id,

          clubName:
            course.club_name,

          courseName:
            course.course_name,

          city:
            course.city,

          state:
            course.state,

          country:
            course.country,

          address:
            course.address,

          numHoles:
            course.num_holes,

          hasGPS:
            course.has_gps,

          latitude:
            course.latitude,

          longitude:
            course.longitude,

          measure:
            course.measure,

          parsMen:
            Array.isArray(
              course.pars_men
            )
              ? course.pars_men
              : [],

          indexesMen:
            Array.isArray(
              course.indexes_men
            )
              ? course.indexes_men
              : [],

          parsWomen:
            Array.isArray(
              course.pars_women
            )
              ? course.pars_women
              : [],

          indexesWomen:
            Array.isArray(
              course.indexes_women
            )
              ? course.indexes_women
              : [],

          tees:
            Array.isArray(
              course.tees
            )
              ? course.tees
              : [],
        },
      });

    } catch (err) {
      console.error(
        "GolfAPI GPS course lookup failed:",
        err
      );

      return res.status(500).json({
        ok: false,

        error:
          "Could not load golf course",

        detail:
          err?.message ||
          String(err),
      });
    }
  }
);


// =========================================================
// GREEN GPS
//
// NEW FLOW:
//
// TeeRadar database first
//       ↓
// GolfAPI.io only if coordinates were never loaded
//       ↓
// Save coordinates permanently
//
// GolfAPI gives:
//
// front
// middle
// back
//
// For backwards compatibility:
//
// lat/lng = middle
//
// If middle is missing:
//
// front -> back fallback
// =========================================================

router.get(
  "/course/:providerCourseId/greens",
  requireAuth,
  async (req, res) => {
    try {
      const providerCourseId =
        String(
          req.params.providerCourseId
        ).trim();

      if (!providerCourseId) {
        return res.status(400).json({
          ok: false,

          error:
            "Course ID is required",
        });
      }


      const greens =
        await getGolfApiGreensByHole(
          providerCourseId
        );


      
      // -------------------------------------------------
      // NORMALISE ALL GOLFAPI GPS POINTS
      //
      // Existing GPS fields remain unchanged.
      // Additional POIs are exposed for future features.
      // -------------------------------------------------

      function toLatLng(point) {
        if (!point) return null;

        const lat = Number(point.latitude);
        const lng = Number(point.longitude);

        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          Math.abs(lat) > 90 ||
          Math.abs(lng) > 180
        ) {
          return null;
        }

        return { lat, lng };
      }

      function toPointArray(points) {
        if (!Array.isArray(points)) return [];

        return points
          .map(toLatLng)
          .filter(Boolean);
      }

      const cleanHoles = greens
        .map((hole) => {
          const centre =
            hole?.middle ||
            hole?.front ||
            hole?.back ||
            null;

          if (!centre) {
            return null;
          }

          const centrePoint = toLatLng(centre);

          if (!centrePoint) {
            return null;
          }

          // Complete list of provider POIs.
          // Preserve POI code, location and sideFW.
          const pois = Array.isArray(hole.pois)
            ? hole.pois
                .map((point) => {
                  const position = toLatLng(point);

                  if (!position) return null;

                  return {
                    poi: Number(point.poi),
                    type: point.type,
                    location: point.location,
                    sideFW: point.sideFW,
                    ...position
                  };
                })
                .filter(Boolean)
            : [];

          return {
            hole: Number(hole.hole),

            // Existing GPS compatibility.
            lat: centrePoint.lat,
            lng: centrePoint.lng,

            front: toLatLng(hole.front),
            middle: toLatLng(hole.middle),
            back: toLatLng(hole.back),

            teeFront: toLatLng(hole.teeFront),
            teeBack: toLatLng(hole.teeBack),

            marker100: toLatLng(hole.marker100),

            // Additional reference points.
            marker150: toLatLng(hole.marker150),
            marker200: toLatLng(hole.marker200),
            dogleg: toLatLng(hole.dogleg),

            // Complete provider data.
            pois,

            // Categorised hazards and landmarks.
            greenBunkers: toPointArray(
              hole.greenBunkers
            ),

            fairwayBunkers: toPointArray(
              hole.fairwayBunkers
            ),

            waterHazards: toPointArray(
              hole.waterHazards
            ),

            trees: toPointArray(hole.trees),
            roads: toPointArray(hole.roads),

            doglegs: toPointArray(hole.doglegs),

            markers100: toPointArray(
              hole.markers100
            ),

            markers150: toPointArray(
              hole.markers150
            ),

            markers200: toPointArray(
              hole.markers200
            ),

            frontTees: toPointArray(
              hole.frontTees
            ),

            backTees: toPointArray(
              hole.backTees
            )
          };
        })
        .filter(
          (hole) =>
            hole &&
            Number.isInteger(hole.hole) &&
            hole.hole > 0 &&
            Number.isFinite(hole.lat) &&
            Number.isFinite(hole.lng)
        );



      return res.json({
        ok: true,

        provider_course_id:
          providerCourseId,

        holes:
          cleanHoles,
      });

    } catch (err) {
      console.error(
        "GolfAPI green lookup failed:",
        err
      );

      return res.status(500).json({
        ok: false,

        error:
          "Could not load green GPS data",

        detail:
          err?.message ||
          String(err),
      });
    }
  }
);


// =========================================================
// TEERADAR ADMIN TEE POINTS
// =========================================================

const TEE_ADMIN_EMAIL = "declan7pin@gmail.com";

let teeTablePromise = null;

async function ensureTeePointsTable() {
  if (!teeTablePromise) {
    teeTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS teeradar_tee_points (
        id BIGSERIAL PRIMARY KEY,
        provider_course_id TEXT NOT NULL,
        hole_number INTEGER NOT NULL
          CHECK (hole_number BETWEEN 1 AND 36),
        tee_type TEXT NOT NULL
          CHECK (tee_type IN ('front', 'back')),
        latitude DOUBLE PRECISION NOT NULL
          CHECK (latitude BETWEEN -90 AND 90),
        longitude DOUBLE PRECISION NOT NULL
          CHECK (longitude BETWEEN -180 AND 180),
        source TEXT NOT NULL DEFAULT 'admin_manual',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (
          provider_course_id,
          hole_number,
          tee_type
        )
      )
    `).catch((error) => {
      teeTablePromise = null;
      throw error;
    });
  }

  await teeTablePromise;
}

async function isTeeAdmin(req) {
  const userId = Number(req.user?.id);

  if (!Number.isInteger(userId) || userId <= 0) {
    return false;
  }

  const result = await db.query(
    `
    SELECT id
    FROM users
    WHERE id = $1
      AND LOWER(email) = $2
    LIMIT 1
    `,
    [userId, TEE_ADMIN_EMAIL]
  );

  return result.rowCount === 1;
}

function validTeeType(value) {
  return value === "front" || value === "back";
}

function validCoordinates(lat, lng) {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

// ---------------------------------------------------------
// GET SAVED TEE POINTS
// ---------------------------------------------------------

router.get(
  "/course/:providerCourseId/tees",
  requireAuth,
  async (req, res) => {
    try {
      await ensureTeePointsTable();

      const courseId = String(
        req.params.providerCourseId || ""
      ).trim();

      if (!courseId) {
        return res.status(400).json({
          ok: false,
          error: "Course ID required",
        });
      }

      const result = await db.query(
        `
        SELECT
          hole_number,
          tee_type,
          latitude,
          longitude,
          source
        FROM teeradar_tee_points
        WHERE provider_course_id = $1
        ORDER BY hole_number, tee_type
        `,
        [courseId]
      );

      return res.json({
        ok: true,
        provider_course_id: courseId,
        tees: result.rows,
      });

    } catch (error) {
      console.error("Load tee points failed:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not load tee points",
      });
    }
  }
);

// ---------------------------------------------------------
// SAVE OR UPDATE ADMIN TEE POINT
// ---------------------------------------------------------

router.put(
  "/course/:providerCourseId/tees/:hole/:teeType",
  requireAuth,
  async (req, res) => {
    try {
      if (!(await isTeeAdmin(req))) {
        return res.status(403).json({
          ok: false,
          error: "Admin access required",
        });
      }

      const courseId = String(
        req.params.providerCourseId || ""
      ).trim();

      const hole = Number(req.params.hole);
      const teeType = req.params.teeType;

      const lat = req.body?.lat;
      const lng = req.body?.lng;

      if (
        !courseId ||
        courseId.length > 200 ||
        !Number.isInteger(hole) ||
        hole < 1 ||
        hole > 36 ||
        !validTeeType(teeType) ||
        !validCoordinates(lat, lng)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid tee point data",
        });
      }

      await ensureTeePointsTable();

      const result = await db.query(
        `
        INSERT INTO teeradar_tee_points (
          provider_course_id,
          hole_number,
          tee_type,
          latitude,
          longitude,
          source,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, 'admin_manual', $6)

        ON CONFLICT (
          provider_course_id,
          hole_number,
          tee_type
        )
        DO UPDATE SET
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          source = 'admin_manual',
          created_by = EXCLUDED.created_by,
          updated_at = NOW()

        RETURNING *
        `,
        [
          courseId,
          hole,
          teeType,
          lat,
          lng,
          TEE_ADMIN_EMAIL,
        ]
      );

      return res.json({
        ok: true,
        tee: result.rows[0],
      });

    } catch (error) {
      console.error("Save tee point failed:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not save tee point",
      });
    }
  }
);

// ---------------------------------------------------------
// DELETE ADMIN TEE POINT
// ---------------------------------------------------------

router.delete(
  "/course/:providerCourseId/tees/:hole/:teeType",
  requireAuth,
  async (req, res) => {
    try {
      if (!(await isTeeAdmin(req))) {
        return res.status(403).json({
          ok: false,
          error: "Admin access required",
        });
      }

      const courseId = String(
        req.params.providerCourseId || ""
      ).trim();

      const hole = Number(req.params.hole);
      const teeType = req.params.teeType;

      if (
        !courseId ||
        !Number.isInteger(hole) ||
        hole < 1 ||
        hole > 36 ||
        !validTeeType(teeType)
      ) {
        return res.status(400).json({
          ok: false,
          error: "Invalid tee point",
        });
      }

      await ensureTeePointsTable();

      const result = await db.query(
        `
        DELETE FROM teeradar_tee_points
        WHERE provider_course_id = $1
          AND hole_number = $2
          AND tee_type = $3
        RETURNING id
        `,
        [courseId, hole, teeType]
      );

      return res.json({
        ok: true,
        deleted: result.rowCount > 0,
      });

    } catch (error) {
      console.error("Delete tee point failed:", error);

      return res.status(500).json({
        ok: false,
        error: "Could not delete tee point",
      });
    }
  }
);


export default router;
