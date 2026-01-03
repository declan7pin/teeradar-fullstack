// backend/analyticsRoutes.js
import express from "express";

/**
 * ✅ FIX:
 * analyticsDb.js in your repo does NOT export `deleteRegisteredUser`.
 * Named ESM imports must exist or Node will crash on boot.
 *
 * So we import the module as a namespace and safely access functions.
 */
import * as analyticsDb from "./db/analyticsDb.js";

/* ✅ ALSO write + read Postgres analytics (backend/analytics.js) */
import {
  recordEvent as recordPgEvent,
  getAnalyticsSummary as getPgAnalyticsSummary,
} from "./analytics.js";
/* ✅ END ONLY ADDITIONS */

// ✅ ADD (needed): direct DB queries to compute "user searches only"
import db from "./db.js";

const router = express.Router();

// pull the functions that DO exist (no hard failure)
const logAnalyticsEvent = analyticsDb.logAnalyticsEvent;
const getAnalyticsSummary = analyticsDb.getAnalyticsSummary;
const getAllEvents = analyticsDb.getAllEvents;
const getRegisteredUsers = analyticsDb.getRegisteredUsers;
const recordRegisteredUser = analyticsDb.recordRegisteredUser;

// ✅ Try common delete export names (so it works across versions)
const deleteRegisteredUser =
  analyticsDb.deleteRegisteredUser ||
  analyticsDb.deleteRegisteredUserById ||
  analyticsDb.deleteUser ||
  analyticsDb.deleteUserById ||
  analyticsDb.removeRegisteredUser ||
  null;

/**
 * IMPORTANT:
 * Some pages send analytics fields at the top level:
 * { type, at, userId, courseName, roundId }
 * Others send:
 * { type, at, payload: { userId, courseName, roundId } }
 *
 * We merge both into a single payload so NOTHING breaks.
 */

/**
 * POST /api/analytics/event
 * Body: { type, at?, payload? } OR { type, at?, userId?, courseName?, roundId?, ... }
 */
router.post("/event", async (req, res) => {
  try {
    const body = req.body || {};
    const { type } = body;

    if (!type) {
      return res.status(400).json({ error: "Missing event type" });
    }

    const at = body.at || new Date().toISOString();

    // ✅ Merge top-level fields into payload (keep backwards compatibility)
    const incomingPayload =
      body.payload && typeof body.payload === "object" ? body.payload : {};

    const mergedPayload = {
      ...incomingPayload,
      ...body, // allows userId/courseName/roundId sent top-level
    };

    // remove non-payload keys so payload stays clean
    delete mergedPayload.type;
    delete mergedPayload.at;
    delete mergedPayload.payload;

    // ✅ Put the Render log back (so you can see events arriving)
    console.log("\nIncoming analytics event:", {
      type,
      at,
      ...mergedPayload,
    });

    // existing (SQLite) analytics (your old cards / views depend on this)
    if (typeof logAnalyticsEvent === "function") {
      logAnalyticsEvent({ type, at, payload: mergedPayload });
    }

    // ✅ ALSO store to Postgres analytics (so rounds + everything are in one place)
    try {
      const userId =
        merged