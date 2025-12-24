// backend/scorecardsRouter.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- helpers ---
function safeJsonParseLoose(text) {
  // remove BOM
  let s = String(text || "").replace(/^\uFEFF/, "");

  // 1) try strict JSON first
  try {
    return JSON.parse(s);
  } catch (e1) {
    // 2) remove trailing commas before } or ]
    //    Example: [1,2,] -> [1,2]  and  { "a":1, } -> { "a":1 }
    const fixed = s.replace(/,\s*([}\]])/g, "$1");

    return JSON.parse(fixed);
  }
}

function normalizeStateParam(st) {
  return String(st || "").trim().toUpperCase();
}

function scorecardsFileCandidates(state) {
  const st = normalizeStateParam(state);
  const stLower = st.toLowerCase();

  // Try the common names/paths you already log + a few sensible ones
  return [
    // backend/data/scorecards/scorecards-wa.json (your working dir shows this exists)
    path.join(__dirname, "data", "scorecards", `scorecards-${stLower}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards-${st}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards_${stLower}.json`),
    path.join(__dirname, "data", "scorecards", `scorecards_${st}.json`),

    // backend/data/scorecards-wa.json etc
    path.join(__dirname, "data", `scorecards-${stLower}.json`),
    path.join(__dirname, "data", `scorecards-${st}.json`),
    path.join(__dirname, "data", `scorecards_${stLower}.json`),
    path.join(__dirname, "data", `scorecards_${st}.json`),

    // backend/scorecards-wa.json etc
    path.join(__dirname, `scorecards-${stLower}.json`),
    path.join(__dirname, `scorecards-${st}.json`),
    path.join(__dirname, `scorecards_${stLower}.json`),
    path.join(__dirname, `scorecards_${st}.json`),

    // public/data/scorecards/... (in case you move them later)
    path.join(__dirname, "..", "public", "data", "scorecards", `scorecards-${stLower}.json`),
    path.join(__dirname, "..", "public", "data", "scorecards", `scorecards-${st}.json`),
    path.join(__dirname, "..", "public", "data", `scorecards-${stLower}.json`),
    path.join(__dirname, "..", "public", "data", `scorecards-${st}.json`),
  ];
}

function pickExistingFile(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

// GET /api/scorecards/:state
router.get("/:state", (req, res) => {
  const state = normalizeStateParam(req.params.state);

  const tried = scorecardsFileCandidates(state);
  const found = pickExistingFile(tried);

  if (!found) {
    return res.status(404).json({
      error: "scorecards file not found",
      state,
      expectedExamples: [
        "backend/data/scorecards/scorecards-wa.json",
        "public/data/scorecards/scorecards-wa.json",
      ],
      tried,
      debug: {
        __dirname,
        cwd: process.cwd(),
      },
    });
  }

  try {
    const raw = fs.readFileSync(found, "utf8");
    const parsed = safeJsonParseLoose(raw);

    // allow either:
    // - [ ...scorecards ]
    // - { "scorecards": [ ... ] }
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.scorecards) ? parsed.scorecards : null);

    if (!arr) {
      return res.status(400).json({
        error: "scorecards file parsed but had unexpected shape",
        state,
        file: found,
        expected: "Array or { scorecards: Array }",
      });
    }

    return res.json(arr);
  } catch (err) {
    return res.status(400).json({
      error: "scorecards file found but could not be parsed",
      state,
      file: found,
      message: String(err?.message || err),
      hint: "If you want strict JSON, remove trailing commas inside arrays/objects.",
    });
  }
});

export default router;