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


      const cleanHoles =
        greens
          .map(
            (hole) => {
              const centre =
                hole?.middle ||
                hole?.front ||
                hole?.back ||
                null;

              if (!centre) {
                return null;
              }


              return {
                hole:
                  Number(
                    hole.hole
                  ),


                // -----------------------------------------
                // BACKWARDS COMPATIBILITY
                //
                // Existing TeeRadar GPS expects:
                //
                // hole.lat
                // hole.lng
                //
                // Use middle green coordinate.
                // -----------------------------------------

                lat:
                  Number(
                    centre.latitude
                  ),

                lng:
                  Number(
                    centre.longitude
                  ),


                // -----------------------------------------
                // NEW FRONT / MIDDLE / BACK DATA
                // -----------------------------------------

                front:
                  hole.front
                    ? {
                        lat:
                          Number(
                            hole.front.latitude
                          ),

                        lng:
                          Number(
                            hole.front.longitude
                          ),
                      }
                    : null,

                middle:
                  hole.middle
                    ? {
                        lat:
                          Number(
                            hole.middle.latitude
                          ),

                        lng:
                          Number(
                            hole.middle.longitude
                          ),
                      }
                    : null,

                back:
                  hole.back
                    ? {
                        lat:
                          Number(
                            hole.back.latitude
                          ),

                        lng:
                          Number(
                            hole.back.longitude
                          ),
                      }
                    : null,
              };
            }
          )
          .filter(
            (hole) =>
              hole &&
              Number.isInteger(
                hole.hole
              ) &&
              hole.hole > 0 &&
              Number.isFinite(
                hole.lat
              ) &&
              Number.isFinite(
                hole.lng
              )
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


export default router;
