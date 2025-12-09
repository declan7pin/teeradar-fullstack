// backend/alertsRoutes.js
import express from "express";
import {
  createWatch,
  getWatchesForUser,
  deactivateWatch,
  countActiveWatchesForUser,
} from "./db/alertsDb.js";

const router = express.Router();

// 0 = free, 1 = Tier1, 2 = Tier2, 3 = Tier3
const MAX_WATCHES_BY_LEVEL = {
  0: 0,
  1: 3,
  2: 5,
  3: 10,
};

// TEMP auth stub:
// Replace this with your real auth logic when you're ready.
function requireAuth(req, res, next) {
  // For now, hard-code a test user so you can try the feature:
  // Later this should come from your session / JWT / etc.
  if (!req.user) {
    req.user = {
      id: 1,
      email: "test@example.com",
      subscriptionLevel: 3, // Tier 3 for testing
    };
  }
  next();
}

// Get all alerts for current user
router.get("/", requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const watches = getWatchesForUser(userId);
    res.json({ watches });
  } catch (err) {
    console.error("Error fetching alerts", err);
    res.status(500).json({ error: "Failed to fetch alerts" });
  }
});

// Create a new alert
router.post("/", requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const subscriptionLevel = req.user.subscriptionLevel ?? 1;

    const maxWatches = MAX_WATCHES_BY_LEVEL[subscriptionLevel] ?? 0;
    const currentCount = countActiveWatchesForUser(userId);

    if (currentCount >= maxWatches) {
      return res.status(400).json({
        error: `You have reached the limit of ${maxWatches} active alerts for your plan.`,
      });
    }

    const { courseId, date, timeFrom, timeTo, groupSize } = req.body || {};

    if (!courseId || !date || !timeFrom || !timeTo || !groupSize) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const watchId = createWatch({
      userId,
      userEmail,
      courseId,
      date,
      timeFrom,
      timeTo,
      groupSize: Number(groupSize),
      subscriptionLevel,
    });

    res.json({ ok: true, watchId });
  } catch (err) {
    console.error("Error creating alert", err);
    res.status(500).json({ error: "Failed to create alert" });
  }
});

// Deactivate an alert
router.delete("/:id", requireAuth, (req, res) => {
  try {
    const userId = req.user.id;
    const watchId = Number(req.params.id);
    if (!watchId) {
      return res.status(400).json({ error: "Invalid alert id" });
    }

    deactivateWatch({ watchId, userId });
    res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting alert", err);
    res.status(500).json({ error: "Failed to delete alert" });
  }
});

export default router;
