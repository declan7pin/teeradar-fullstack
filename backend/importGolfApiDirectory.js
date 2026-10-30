
// backend/importGolfApiDirectory.js
//
// Run from the project root:
// node backend/importGolfApiDirectory.js ./course_names.csv
//
// Imports GolfAPI course identities into PostgreSQL.
// Preserves existing GPS, pars, tees and scorecard data.

import fs from "node:fs";
import db from "./db.js";

import {
  ensureGolfApiCacheSchema,
} from "./golfApiIo.js";


// =========================================================
// PARSE CSV FILE
// =========================================================

function parseCsv(input) {
  const rows = [];

  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const c = input[i];

    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") {
        i++;
      }

      row.push(field);
      field = "";

      if (row.some((value) => value.trim())) {
        rows.push(row);
      }

      row = [];
    } else {
      field += c;
    }
  }

  if (quoted) {
    throw new Error("Unclosed quoted CSV field");
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}


// =========================================================
// IMPORT COMPLETE GOLFAPI DIRECTORY
// =========================================================

async function main() {
  const path = process.argv[2];

  if (!path) {
    throw new Error(
      "Usage: node backend/importGolfApiDirectory.js ./course_names.csv"
    );
  }

  // -------------------------------------------------------
  // READ CSV
  // -------------------------------------------------------

  const raw = fs
    .readFileSync(path, "utf8")
    .replace(/^\uFEFF/, "");

  const [headers, ...records] = parseCsv(raw);

  const required = [
    "ClubName",
    "CourseName",
    "Country",
    "State",
    "City",
    "ClubID",
    "CourseID",
  ];

  for (const name of required) {
    if (!headers.includes(name)) {
      throw new Error(
        `Missing CSV column: ${name}`
      );
    }
  }

  const index = Object.fromEntries(
    headers.map((header, i) => [header, i])
  );

  // -------------------------------------------------------
  // BUILD UNIQUE COURSE DIRECTORY
  //
  // Keep IDs as strings to preserve leading zeros.
  // -------------------------------------------------------

  const entries = new Map();

  for (const record of records) {
    const get = (name) =>
      (record[index[name]] ?? "").trim();

    const id = get("CourseID");

    if (!id) {
      continue;
    }

    entries.set(id, [
      id,
      get("ClubID"),
      get("ClubName"),
      get("CourseName"),
      get("City"),
      get("State"),
      get("Country"),
    ]);
  }

  console.log(
    `Read ${records.length} rows; ${entries.size} distinct course IDs.`
  );

  // -------------------------------------------------------
  // ENSURE EXISTING DATABASE TABLE EXISTS
  // -------------------------------------------------------

  await ensureGolfApiCacheSchema();

  const values = [...entries.values()];

  let imported = 0;

  // -------------------------------------------------------
  // IMPORT IN BATCHES
  //
  // Existing detailed course data is preserved.
  // -------------------------------------------------------

  for (
    let start = 0;
    start < values.length;
    start += 250
  ) {
    const batch = values.slice(
      start,
      start + 250
    );

    const params = batch.flatMap(
      (row) => row.map((value) => value || null)
    );

    const placeholders = batch
      .map(
        (_, i) =>
          `(${Array.from(
            { length: 7 },
            (_, j) => `$${i * 7 + j + 1}`
          ).join(",")})`
      )
      .join(",");

    await db.query(
      `
      INSERT INTO golf_api_courses (
        golfapi_course_id,
        golfapi_club_id,
        club_name,
        course_name,
        city,
        state,
        country
      )

      VALUES ${placeholders}

      ON CONFLICT (
        golfapi_course_id
      )

      DO UPDATE SET

        golfapi_club_id =
          COALESCE(
            NULLIF(EXCLUDED.golfapi_club_id, ''),
            golf_api_courses.golfapi_club_id
          ),

        club_name =
          COALESCE(
            NULLIF(EXCLUDED.club_name, ''),
            golf_api_courses.club_name
          ),

        course_name =
          COALESCE(
            NULLIF(EXCLUDED.course_name, ''),
            golf_api_courses.course_name
          ),

        city =
          COALESCE(
            NULLIF(EXCLUDED.city, ''),
            golf_api_courses.city
          ),

        state =
          COALESCE(
            NULLIF(EXCLUDED.state, ''),
            golf_api_courses.state
          ),

        country =
          COALESCE(
            NULLIF(EXCLUDED.country, ''),
            golf_api_courses.country
          )
      `,
      params
    );

    imported += batch.length;

    if (
      imported % 5000 < 250 ||
      imported === values.length
    ) {
      console.log(
        `Imported ${imported}/${values.length}`
      );
    }
  }

  console.log(
    "Directory import complete. Existing full course, GPS and scorecard data untouched."
  );
}


// =========================================================
// RUN IMPORT
// =========================================================

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
