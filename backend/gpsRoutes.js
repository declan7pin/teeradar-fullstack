// backend/gpsRoutes.js

import express from "express";

import {
  searchGolfCourses,
  getGolfCourse,
  getGolfCourseGreenCenters,
} from "./golfCoursesApi.js";

import {
  requireAuth,
} from "./auth.js";

const router =
  express.Router();

router.use(
  express.json()
);


// =========================================================
// SEARCH PROVIDER COURSES
//
// Temporary/admin/testing endpoint.
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

      const data =
        await searchGolfCourses({
          query,
          country: "AU",
          perPage: 25,
        });

      return res.json({
        ok: true,
        courses:
          Array.isArray(data?.data)
            ? data.data
            : [],
      });
    } catch (err) {
      console.error(
        "GPS course search failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not search golf courses",
      });
    }
  }
);


// =========================================================
// COURSE DETAIL
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

      const data =
        await getGolfCourse(
          providerCourseId
        );

      return res.json({
        ok: true,
        course:
          data?.data || null,
      });
    } catch (err) {
      console.error(
        "GPS course lookup failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not load golf course",
      });
    }
  }
);


// =========================================================
// GREEN CENTRES
//
// IMPORTANT:
// This currently fetches LIVE from the provider.
// We are deliberately NOT persisting their GPS data yet.
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

      const data =
        await getGolfCourseGreenCenters(
          providerCourseId
        );

      const holes =
        Array.isArray(
          data?.data?.holes
        )
          ? data.data.holes
          : [];

      const cleanHoles =
        holes
          .map((hole) => ({
            hole:
              Number(hole.hole),

            lat:
              Number(hole.lat),

            lng:
              Number(hole.lng),
          }))
          .filter((hole) =>
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
        "GPS green lookup failed:",
        err
      );

      return res.status(500).json({
        ok: false,
        error:
          "Could not load green GPS data",
      });
    }
  }
);


export default router;
