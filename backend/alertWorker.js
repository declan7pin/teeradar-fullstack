// backend/alertWorker.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import db from "./db.js";
import { scrapeCourse } from "./scrapers/scrapeCourse.js";
import { Resend } from "resend"; // ✅ use Resend instead of nodemailer

// ✅ ADDED: analytics event logger (used by analytics dashboard)
import { recordEvent } from "./analytics.js";
import { sendMobilePushToEmail } from "./pushRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Resend client ---
const resendApiKey = process.env.RESEND_API_KEY || "";
const resend =
  resendApiKey && resendApiKey.trim()
    ? new Resend(resendApiKey.trim())
    : null;
    const TEERADAR_LOGO_URL =
  process.env.TEERADAR_LOGO_URL || "https://teeradar.com.au/logo.png";

// --- Load course + fee group data (same as server.js) ---
const PERTH_LAT = -31.9523;
const PERTH_LNG = 115.8613;

const coursesPath = path.join(__dirname, "data", "courses.json");
const rawCourses = JSON.parse(fs.readFileSync(coursesPath, "utf8"));

const courses = rawCourses.map((c) => {
  let provider = (c.provider || "").trim();

  // ✅ NORMALISE TeeRadar providers
  if (provider.toLowerCase() === "teeradarbooking") {
    provider = "TeeRadar";
  }

  return {
    ...c,
    provider,
    lat: typeof c.lat === "number" ? c.lat : PERTH_LAT,
    lng: typeof c.lng === "number" ? c.lng : PERTH_LNG,
  };
});

const feeGroupsPath = path.join(__dirname, "data", "fee_groups.json");
let feeGroups = {};
if (fs.existsSync(feeGroupsPath)) {
  feeGroups = JSON.parse(fs.readFileSync(feeGroupsPath, "utf8"));
}

console.log(
  `🔔 Alert worker loaded ${courses.length} courses & ${Object.keys(
    feeGroups
  ).length} fee group entries.`
);

// ---------------------------------------------------------
// DB: ensure alert hits table exists
// ---------------------------------------------------------
async function ensureUserAlertHitsTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_alert_hits (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        course_name TEXT NOT NULL,
        provider TEXT,
        date TEXT NOT NULL,              -- 'YYYY-MM-DD'
        holes INTEGER,
        party_size INTEGER,
        earliest TEXT,
        latest TEXT,
        slots JSONB,
        created_at TIMESTAMPTZ DEFAULT now(),
        read_at TIMESTAMPTZ
      );
    `);
    console.log("✅ user_alert_hits table ready");
  } catch (err) {
    console.error("❌ error ensuring user_alert_hits table:", err);
  }
}
ensureUserAlertHitsTable();

// ---------------------------------------------------------
// Subscriber entitlement helpers
// ---------------------------------------------------------
function isTruthyPlan(plan) {
  const p = String(plan || "").trim().toUpperCase();
  return p === "BASIC" || p === "PRO";
}

function isEntitledSubscriberRow(subRow) {
  if (!subRow) return false;

  const status = String(
    subRow.subscriber_status ?? subRow.status ?? ""
  ).trim().toLowerCase();

  const plan = String(
    subRow.subscriber_plan ?? subRow.plan ?? "FREE"
  ).trim().toUpperCase();

  const hasActiveStatus = status === "active" || status === "trialing";
  const hasPaidPlan = plan === "BASIC" || plan === "PRO";

  if (!hasActiveStatus || !hasPaidPlan) return false;

  // If current_period_end exists, respect it.
  // If it's missing/null, do NOT automatically fail valid active subscribers.
  const rawEnd =
    subRow.current_period_end ??
    subRow.subscriber_current_period_end ??
    null;

  if (rawEnd) {
    const endMs = new Date(rawEnd).getTime();
    if (Number.isFinite(endMs) && endMs <= Date.now()) {
      return false;
    }
  }

  return true;
}

function getEffectiveSubscriberPlan(subRow) {
  if (!isEntitledSubscriberRow(subRow)) return "FREE";

  const p = String(
    subRow.subscriber_plan ?? subRow.plan ?? ""
  ).trim().toUpperCase();

  return isTruthyPlan(p) ? p : "FREE";
}

// ---------------------------------------------------------
// ✅ ADDED: JSONB normalisers (fixes favourites/preferred_days being returned as strings)
// ---------------------------------------------------------
function normaliseJsonArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;

  // Postgres JSONB sometimes arrives as a string depending on driver/config
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Sometimes JSONB can come back as an object wrapper — we only accept arrays
  return [];
}

// ---------------------------------------------------------
// Alert email helpers
// ---------------------------------------------------------

/**
 * Map alert_frequency string → minimum time between emails (ms).
 * Handles a few possible string variants defensively.
 */
function getFrequencyWindowMs(freqRaw) {
  if (!freqRaw) return null;
  const f = freqRaw.toString().trim().toUpperCase();

  // "popups only" or explicit off → never send emails
  if (f === "POPUPS_ONLY" || f === "OFF") {
    return null;
  }

  switch (f) {
    case "6H":
    case "6HOURS":
    case "EVERY_6_HOURS":
      return 6 * 60 * 60 * 1000; // 6 hours ✅ FIXED
    case "12H":
    case "12HOURS":
    case "EVERY_12_HOURS":
      return 12 * 60 * 60 * 1000; // 12 hours
    case "DAILY":
    case "1D":
    case "EVERY_DAY":
      return 24 * 60 * 60 * 1000; // 1 day
    case "2D":
    case "EVERY_2_DAYS":
      return 2 * 24 * 60 * 60 * 1000;
    case "3D":
    case "EVERY_3_DAYS":
      return 3 * 24 * 60 * 60 * 1000;
    default:
      // Default: once per day if we don't understand the string
      return 24 * 60 * 60 * 1000;
  }
}

/**
 * ✅ Ensure the booking URL uses the alert date.
 * - Supports MiClub (YYYY-MM-DD) and common Quick18 formats (DD/MM/YYYY, YYYYMMDD).
 */
function buildBookingLinkForDate(course, date) {
  const raw =
    (course && (course.url || course.bookingUrl || course.bookUrl)) || "";
  if (!raw) return "";

  const toDMY = (iso) => {
    const [y, m, d] = String(iso).split("-");
    if (!y || !m || !d) return iso;
    return `${d}/${m}/${y}`;
  };

  const toYMDNoDash = (iso) => {
    const [y, m, d] = String(iso).split("-");
    if (!y || !m || !d) return iso;
    return `${y}${m}${d}`;
  };

  const PARAMS = [
    "selectedDate",
    "date",
    "selected_date",
    "startDate",
    "bookingDate",
    "playDate",
    "teeDate",
    "teedate",
    "dt",
  ];

  // Try URL parsing first (best)
  try {
    const u = new URL(raw);

    const setPreservingFormat = (key) => {
      const cur = u.searchParams.get(key);

      // If existing value looks like DD/MM/YYYY → keep DMY
      if (cur && /^\d{2}\/\d{2}\/\d{4}$/.test(cur)) {
        u.searchParams.set(key, toDMY(date));
        return true;
      }

      // If existing value looks like YYYYMMDD → keep that
      if (cur && /^\d{8}$/.test(cur)) {
        u.searchParams.set(key, toYMDNoDash(date));
        return true;
      }

      // Default → ISO YYYY-MM-DD
      u.searchParams.set(key, date);
      return true;
    };

    let changed = false;
    for (const key of PARAMS) {
      if (u.searchParams.has(key)) {
        changed = setPreservingFormat(key) || changed;
      }
    }

    return u.toString();
  } catch {
    // Fallback: regex replace if URL isn't parseable by URL()
    return raw
      // YYYY-MM-DD
      .replace(/([?&]selectedDate=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      .replace(/([?&]date=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      .replace(/([?&]selected_date=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      .replace(/([?&]startDate=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      .replace(/([?&]bookingDate=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      .replace(/([?&]playDate=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      .replace(/([?&]teeDate=)\d{4}-\d{2}-\d{2}/, `$1${date}`)
      // DD/MM/YYYY
      .replace(/([?&]startDate=)\d{2}\/\d{2}\/\d{4}/, `$1${toDMY(date)}`)
      .replace(/([?&]date=)\d{2}\/\d{2}\/\d{4}/, `$1${toDMY(date)}`)
      // YYYYMMDD
      .replace(/([?&]startDate=)\d{8}/, `$1${toYMDNoDash(date)}`)
      .replace(/([?&]date=)\d{8}/, `$1${toYMDNoDash(date)}`);
  }
}

function formatAlertDateLabel(isoDate) {
  const d = new Date(`${isoDate}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return isoDate;

  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function normaliseSlotTime(slot) {
  const raw =
    slot?.time ||
    slot?.tee_time ||
    slot?.teeTime ||
    slot?.start_time ||
    slot?.startTime ||
    "";

  return String(raw || "").split("|")[0].trim();
}

function buildPushHitSummary(hits) {
  const safeHits = Array.isArray(hits) ? hits : [];

  const top = safeHits.slice(0, 3).map((h) => {
    const course = String(h.courseName || "Course").trim();
    const date = formatAlertDateLabel(h.date);

    const firstTime =
      Array.isArray(h.sampleTimes) && h.sampleTimes.length
        ? h.sampleTimes[0]
        : "";

    return firstTime
      ? `${course} ${date} ${firstTime}`
      : `${course} ${date}`;
  });

  const extra = safeHits.length > 3 ? ` • +${safeHits.length - 3} more` : "";

  return top.join(" • ") + extra;
}

/**
 * Send ONE email that includes ALL favourites with availability for this tick.
 * If none found, still send a "no matches" email (digest/heartbeat).
 * Also updates user_preferences.alert_last_sent when it sends.
 *
 * ✅ WIRED: logs analytics event "alert_sent" only if email succeeds
 */
async function sendTeeTimePushSummaryForUser({
  email,
  hits,
  earliest,
  latest,
  userHoles,
  partySize,
}) {
  const safeHits = Array.isArray(hits) ? hits : [];

  if (!safeHits.length) return;

  const title =
    safeHits.length === 1
      ? `${safeHits[0].courseName} has tee times ⛳`
      : `${safeHits.length} courses have tee times ⛳`;

  const body = buildPushHitSummary(safeHits);

  await sendMobilePushToEmail(email, {
    title,
    body,
    url: "/book.html?alerts=1",
    type: "TEE_TIME_ALERT",
    meta: {
      hitsCount: safeHits.length,
      courses: safeHits.map((h) => ({
  courseName: h.courseName,
  date: h.date,
  count: h.count,
  sampleTimes: h.sampleTimes || [],
  bookingLink: h.bookingLink || ""
})),
      earliest,
      latest,
      holes: userHoles || null,
      partySize: partySize || null,
    },
  });
}
async function sendAlertEmailSummaryForUser({
  email,
  plan,
  hits,
  earliest,
  latest,
  userHoles,
  partySize,
}) {
  if (!resend) {
    console.log(
      "⚠️ Alert email skipped – RESEND_API_KEY not configured or empty."
    );
    return;
  }

  const safeHits = Array.isArray(hits) ? hits : [];
  const holesLabel = userHoles ? `${userHoles} holes` : "Any holes";
  const playersLabel = partySize ? `${partySize} player(s)` : "Any size";
  const windowLabel =
    earliest && latest ? `${earliest}–${latest}` : "Any time";

  // Group hits by date (keeps the email readable)
  const byDate = new Map();
  for (const h of safeHits) {
    const key = h.date || "Unknown date";
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(h);
  }

  const sortedDates = Array.from(byDate.keys()).sort();

  let lines = [];
  lines.push(`Hi ${email},`);
  lines.push("");

  if (safeHits.length > 0) {
    lines.push(`TeeRadar found tee times matching your alert:`);
  } else {
    lines.push(`TeeRadar update: no matching tee times were found on this check.`);
  }

  lines.push(`• Time window: ${windowLabel}`);
  lines.push(`• Holes: ${holesLabel}`);
  lines.push(`• Group size: ${playersLabel}`);
  lines.push("");

  if (safeHits.length > 0) {
    for (const d of sortedDates) {
      lines.push(`=== ${d} ===`);
      const arr = byDate.get(d) || [];
      // sort by course name for stability
      arr.sort((a, b) => (a.courseName || "").localeCompare(b.courseName || ""));
      for (const item of arr) {
        lines.push(`• ${item.courseName} — ${item.count} slot(s)`);
        lines.push(`  ${item.bookingLink}`);
      }
      lines.push("");
    }
  } else {
    lines.push(`We’ll keep checking and email you again at your selected interval.`);
    lines.push("");
  }

  lines.push(`You can adjust or turn off alerts any time from your account page:`);
  lines.push(`  https://teeradar.com.au/account.html`);
  lines.push("");
  lines.push(`Enjoy your round,`);
  lines.push(`TeeRadar`);

  const subject =
  safeHits.length > 0
    ? `TeeRadar – tee times found for your favourites`
    : `TeeRadar – update (no tee times found)`;

const textBody = lines.join("\n");

const htmlBody = `
<div style="margin:0;padding:24px 12px;background:#f4f7fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.08);">
    
    <div style="padding:18px 20px;border-bottom:1px solid #e2e8f0;background:#ffffff;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;">
            <div style="font-size:20px;font-weight:800;color:#00796b;line-height:1.2;">TeeRadar Alerts</div>
            <div style="font-size:12px;color:#64748b;margin-top:4px;">Tee times for your favourites</div>
          </td>
          <td style="text-align:right;vertical-align:middle;">
            <img
              src="${TEERADAR_LOGO_URL}"
              alt="TeeRadar"
              style="max-height:44px;max-width:140px;display:block;margin-left:auto;"
            />
          </td>
        </tr>
      </table>
    </div>

    <div style="padding:20px;">
      <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">
        Hi ${email},
      </p>

      ${
        safeHits.length > 0
          ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#0f172a;">
               We found tee times matching your alert.
             </p>`
          : `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#0f172a;">
               No matching tee times were found on this check, but we’ll keep looking for you.
             </p>`
      }

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:18px;">
        <div style="font-size:13px;color:#334155;line-height:1.7;">
          <div><strong>Time window:</strong> ${windowLabel}</div>
          <div><strong>Holes:</strong> ${holesLabel}</div>
          <div><strong>Group size:</strong> ${playersLabel}</div>
        </div>
      </div>

      ${
        safeHits.length > 0
          ? sortedDates.map((d) => {
              const arr = byDate.get(d) || [];
              arr.sort((a, b) => (a.courseName || "").localeCompare(b.courseName || ""));

              return `
                <div style="margin:0 0 18px;">
                  <div style="font-size:13px;font-weight:800;color:#0f172a;letter-spacing:.02em;margin-bottom:8px;">
                    ${d}
                  </div>

                  ${arr.map((item) => `
                    <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 14px 12px;margin-bottom:10px;background:#ffffff;">
                      <div style="font-size:15px;font-weight:700;color:#0f172a;line-height:1.4;">
                        ${item.courseName}
                      </div>
                      <div style="font-size:13px;color:#64748b;margin-top:4px;line-height:1.5;">
                        ${item.count} tee time(s) available
                      </div>
                      <div style="margin-top:10px;">
                        <a
                          href="${item.bookingLink}"
                          style="display:inline-block;background:#00796b;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;padding:10px 14px;border-radius:10px;"
                        >
                          View tee times
                        </a>
                      </div>
                    </div>
                  `).join("")}
                </div>
              `;
            }).join("")
          : `
            <div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;background:#ffffff;margin-bottom:18px;">
              <div style="font-size:14px;color:#475569;line-height:1.6;">
                We’ll check again based on your chosen alert frequency and email you when matching times are found.
              </div>
            </div>
          `
      }

      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0;">
        <div style="font-size:13px;color:#475569;line-height:1.6;">
          You can adjust or turn off alerts any time from your account page:
        </div>
        <div style="margin-top:8px;">
          <a
            href="https://teeradar.com.au/account.html"
            style="color:#00796b;text-decoration:none;font-size:13px;font-weight:600;"
          >
            teeradar.com.au/account.html
          </a>
        </div>
      </div>

      <p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#0f172a;">
        Enjoy your round,<br/>
        <strong>TeeRadar</strong>
      </p>
    </div>
  </div>
</div>
`;

const fromAddress =
  process.env.ALERT_FROM_EMAIL || "TeeRadar Alerts <alerts@teeradar.com.au>";
    

  try {
    const { error } = await resend.emails.send({
  from: fromAddress,
  to: email,
  subject,
  text: textBody,
  html: htmlBody,
});

    if (error) {
      console.error(`❌ Resend error sending summary alert to ${email}:`, error);
      return;
    }

    // Record that we sent an email now
    await db.query(
      `
      UPDATE user_preferences
      SET alert_last_sent = now()
      WHERE email = $1
      `,
      [email]
    );

    // ✅ WIRED: analytics "alert_sent" (counts emails sent)
    await recordEvent("alert_sent", {
      userId: email,
      courseName: safeHits.length > 0 ? "MULTI" : null,
      plan: plan || null,
      at: new Date().toISOString(),
      meta: {
        hitsCount: safeHits.length,
        earliest,
        latest,
        holes: userHoles || null,
        partySize: partySize || null,
      },
    });

    console.log(
      `📧 Summary alert email sent to ${email} (${safeHits.length} hit(s))`
    );
  } catch (err) {
    console.error(
      `❌ Failed to send summary alert email to ${email}:`,
      err.message
    );
  }
}

/**
 * Send a single alert email for a user / course / date.
 * Also updates user_preferences.alert_last_sent when it sends.
 *
 * ✅ WIRED: logs analytics event "alert_sent" only if email succeeds
 */
async function sendAlertEmailForHit({
  email,
  plan,
  course,
  date,
  count,
  earliest,
  latest,
  userHoles,
  partySize,
}) {
  if (!resend) {
    console.log(
      "⚠️ Alert email skipped – RESEND_API_KEY not configured or empty."
    );
    return;
  }

  const holesLabel = userHoles ? `${userHoles} holes` : "Any holes";
  const playersLabel = partySize ? `${partySize} player(s)` : "Any size";
  const windowLabel =
    earliest && latest ? `${earliest}–${latest}` : "Any time";

  // Prefer direct course booking URL if we have one (✅ but force correct date)
  const bookingLink =
    buildBookingLinkForDate(course, date) ||
    (course && (course.url || course.bookingUrl || course.bookUrl)) ||
    "https://teeradar.com.au/book.html";

  const subject = `TeeRadar – ${count} tee time(s) found at ${course.name}`;
  const textBody = `
Hi ${email},

TeeRadar just found ${count} tee time(s) that match your alert:

• Course: ${course.name}
• Date: ${date}
• Time window: ${windowLabel}
• Holes: ${holesLabel}
• Group size: ${playersLabel}

Book directly using the link below:

  ${bookingLink}

You can adjust or turn off alerts any time from your account page:

  https://teeradar.com.au/account.html

Enjoy your round,
TeeRadar
  `.trim();

  const fromAddress =
    process.env.ALERT_FROM_EMAIL || "TeeRadar Alerts <alerts@teeradar.com.au>";

  try {
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: email,
      subject,
      text: textBody,
    });

    if (error) {
      console.error(
        `❌ Resend error sending alert to ${email} for ${course.name} / ${date}:`,
        error
      );
      return;
    }

    // Record that we sent an email now
    await db.query(
      `
      UPDATE user_preferences
      SET alert_last_sent = now()
      WHERE email = $1
      `,
      [email]
    );

    // ✅ WIRED: analytics "alert_sent"
    await recordEvent("alert_sent", {
      userId: email,
      courseName: course?.name || null,
      plan: plan || null,
      at: new Date().toISOString(),
      meta: {
        date,
        count,
        earliest,
        latest,
        holes: userHoles || null,
        partySize: partySize || null,
      },
    });

    console.log(`📧 Alert email sent to ${email} for ${course.name} on ${date}`);
  } catch (err) {
    console.error(
      `❌ Failed to send alert email to ${email} for ${course.name} / ${date}:`,
      err.message
    );
  }
}

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

// ---------------------------------------------------------
// ✅ BLOCKLIST: prevent alerts for certain courses (MiClub access issues)
// ---------------------------------------------------------
const BLOCKED_ALERT_HOSTS = new Set([
  "wembleygolf.com.au",
  "meadowsprings.miclub.com.au",
]);

const BLOCKED_ALERT_NAME_MATCHES = [
  "wembley golf course",
  "meadow springs golf & country club",
  "meadow springs",
];

function getHostFromUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    return String(u.hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function isBlockedAlertCourse(course) {
  if (!course) return false;

  const host = getHostFromUrl(course.url || course.bookingUrl || course.bookUrl);
  if (host && BLOCKED_ALERT_HOSTS.has(host)) return true;

  const name = String(course.name || "").trim().toLowerCase();
  if (!name) return false;

  return BLOCKED_ALERT_NAME_MATCHES.some((needle) => name.includes(needle));
}
function normaliseDayToken(token) {
  if (!token) return null;
  const t = token.toString().trim().toLowerCase();
  if (!t) return null;

  const short = t.slice(0, 3);
  switch (short) {
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    case "sun":
      return 0;
    default:
      return null;
  }
}

// Next date (YYYY-MM-DD) matching target DOW (0=Sun..6=Sat)
function nextDateForDow(targetDow) {
  const now = new Date();
  const todayDow = now.getDay();
  let delta = (targetDow - todayDow + 7) % 7; // allow "today" if 0
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + delta
  );
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysToIso(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map((x) => parseInt(x, 10));
  const base = new Date(y, m - 1, d + days);
  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()) + "";
  const ddPadded = dd.padStart(2, "0");
  return `${yyyy}-${mm}-${ddPadded}`;
}

// Returns dates for this weekend + next weekend for chosen days
function resolveDatesFromPreferredDays(preferredDays) {
  const todayDow = new Date().getDay();

  // no days chosen → today + same day next week
  if (!Array.isArray(preferredDays) || preferredDays.length === 0) {
    const thisDate = nextDateForDow(todayDow);
    const nextDate = addDaysToIso(thisDate, 7);
    return [thisDate, nextDate];
  }

  const dows = new Set();
  for (const d of preferredDays) {
    const dow = normaliseDayToken(d);
    if (dow !== null) dows.add(dow);
  }

  if (!dows.size) {
    const thisDate = nextDateForDow(todayDow);
    const nextDate = addDaysToIso(thisDate, 7);
    return [thisDate, nextDate];
  }

  const thisWindow = Array.from(dows).map((dow) => nextDateForDow(dow));
  const nextWindow = thisWindow.map((iso) => addDaysToIso(iso, 7));
  const combined = [...thisWindow, ...nextWindow];

  // dedupe while preserving order
  const seen = new Set();
  const out = [];
  for (const d of combined) {
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function findCourseByFavourite(fav) {
  if (!fav) return null;
  const name = fav.name || fav.courseName || fav.course || null;
  if (!name) return null;

  // strict match first
  let course = courses.find((c) => c.name === name);
  if (course) return course;

  // loose contains match
  const lower = name.toLowerCase();
  course = courses.find((c) => c.name.toLowerCase().includes(lower));
  return course || null;
}
// ✅ ADD: TeeRadar/manual courses don't scrape — read available slots from DB instead
async function fetchTeeRadarSlotsFromDb(course, criteria) {
  const date = criteria.date;
  const earliest = criteria.earliest || "00:00";
  const latest = criteria.latest || "23:59";
  const holes = criteria.holes ? Number(criteria.holes) : null;
  const partySize = criteria.partySize ? Number(criteria.partySize) : null;

  // try slug first, fallback to name
  const slug = course.slug || course.course_slug || null;

  // NOTE: adjust column names here ONLY if your slots table differs.
  const { rows } = await db.query(
    `
    SELECT *
    FROM slots
    WHERE date = $1
      AND (
        ($2::text IS NOT NULL AND course_slug = $2)
        OR
        ($2::text IS NULL AND course_name = $3)
      )
      AND (time >= $4 AND time <= $5)
      AND ($6::int IS NULL OR holes = $6)
      AND ($7::int IS NULL OR players = $7 OR party_size = $7)
      AND (is_available = TRUE OR available = TRUE)
    ORDER BY time ASC
    `,
    [date, slug, course.name, earliest, latest, holes, partySize]
  );

  return rows || [];
}
async function disableAlertEmailsForUser(email) {
  try {
    await db.query(
      `
      UPDATE user_preferences
      SET alert_frequency = 'OFF'
      WHERE LOWER(email) = LOWER($1)
      `,
      [email]
    );
  } catch (err) {
    console.error(`⚠️ Failed to disable alert emails for ${email}:`, err.message);
  }
}
// ---------------------------------------------------------
// Core alert tick
// ---------------------------------------------------------

async function runAlertTick() {
  console.log("🔔 Alert tick starting…");

  try {
        // Pull users + preferences + subscriber entitlement
    const { rows } = await db.query(`
      SELECT
        u.email,
        u.home_course,

        ss.plan AS subscriber_plan,
        ss.status AS subscriber_status,
        ss.entitlement_active,
        ss.current_period_end,
        ss.cancel_at_period_end,

        p.home_state,
        p.favourites,
        p.preferred_days,
        p.preferred_earliest,
        p.preferred_latest,
        p.preferred_holes,
        p.preferred_party_size,
        p.alert_frequency,
        p.alert_last_sent
      FROM users u
      JOIN user_preferences p
        ON p.email = u.email
      LEFT JOIN subscriber_status ss
        ON LOWER(ss.email) = LOWER(u.email)
      WHERE p.favourites IS NOT NULL
    `);

    if (!rows.length) {
      console.log("🔔 Alert tick: no users with preferences yet.");
      return;
    }

    console.log(`🔔 Alert tick: found ${rows.length} user(s) with alerts.`);

    const now = new Date();

    for (const row of rows) {
            const email = (row.email || "").toLowerCase();

            const subscriberStatus = String(
        row.subscriber_status ?? row.status ?? ""
      ).trim().toLowerCase();

      const subscriberPlan = String(
        row.subscriber_plan ?? row.plan ?? "FREE"
      ).trim().toUpperCase();

      const entitled = isEntitledSubscriberRow(row);
      const plan = getEffectiveSubscriberPlan(row);

      // ✅ FIX: normalise JSONB/string values to arrays so users don't get skipped
      const favourites = normaliseJsonArray(row.favourites);
      const preferredDays = normaliseJsonArray(row.preferred_days);

      const earliest = row.preferred_earliest || "06:00";
      const latest = row.preferred_latest || "17:00";
      const holes = row.preferred_holes || "";
      const partySize = row.preferred_party_size || 1;
      const alertFrequencyRaw = row.alert_frequency || null;
      const alertLastSentRaw = row.alert_last_sent || null;

      // 🔒 Only active entitled subscribers can receive email alerts
                  if (!entitled) {
        console.log(
          `🔒 Skipping ${email} – no active subscriber entitlement (status=${subscriberStatus || "none"}, plan=${subscriberPlan || "FREE"}).`
        );

        // Optional cleanup so expired/free/cancelled users stop showing as alert-enabled
        await disableAlertEmailsForUser(email);
        continue;
      }

      if (!Array.isArray(favourites) || favourites.length === 0) {
        continue;
      }

      const datesToScan = resolveDatesFromPreferredDays(preferredDays);

      console.log(
        `👤 ${email}: ${favourites.length} favourite(s), days=${JSON.stringify(
          preferredDays
        )}, dates=${datesToScan.join(",")}, freq=${alertFrequencyRaw}`
      );

      const userHoles = holes ? Number(holes) : null;

      // 🔹 Frequency gating (per user, per tick)
      const windowMs = getFrequencyWindowMs(alertFrequencyRaw);
      const emailsAllowed = windowMs !== null; // null → POPUPS_ONLY / OFF
      let canSendEmailForUser = true;

      if (emailsAllowed && alertLastSentRaw) {
        try {
          const last = new Date(alertLastSentRaw);
          if (!isNaN(last.getTime())) {
            const diff = now.getTime() - last.getTime();
            if (diff < windowMs) {
              canSendEmailForUser = false;
              console.log(
                `⏱️ Skipping emails for ${email} – last sent ${Math.round(
                  diff / (60 * 1000)
                )} min ago (freq=${alertFrequencyRaw}).`
              );
            }
          }
        } catch {
          // ignore parse errors, treat as "never sent"
        }
      }

      // ✅ Collect all hits for this user for this tick so the email includes ALL favourites
      const emailHits = [];

      for (const fav of favourites) {
        const course = findCourseByFavourite(fav);
        if (!course) {
          console.log(`  ⚠️ Could not match favourite to course.json:`, fav);
          continue;
        }
          // ✅ BLOCKLIST: skip courses we cannot access (prevents scrape + emails)
  if (isBlockedAlertCourse(course)) {
    console.log(`  🚫 Skipping blocked alert course: ${course.name}`);
    continue;
  }

        // If user requested a specific hole count and course has a different fixed hole count, skip
        const courseHoles =
          course.holes != null ? Number(course.holes) : null;

        if (userHoles && courseHoles && courseHoles !== userHoles) {
          console.log(
            `Skipping ${course.name} – course is ${courseHoles} holes, user requested ${userHoles}`
          );
          continue;
        }

        const providerLabel = course.provider || "Course";

        for (const date of datesToScan) {
          const criteria = {
            date,
            earliest,
            latest,
            holes: userHoles || "",
            partySize: partySize || 1,
            state: (course.state || "").toUpperCase() || null,
          };

          try {
            let result = [];
const prov = (course.provider || "").toLowerCase();

if (prov === "miclub" || prov === "quick18") {
  result = await scrapeCourse(course, criteria, feeGroups);
} else {
  // ✅ TeeRadar/manual courses: read availability from DB instead of scraping
  result = await fetchTeeRadarSlotsFromDb(course, criteria);
}
            const count = Array.isArray(result) ? result.length : 0;

            console.log(
              `${providerLabel} → ${course.name} → ${count} slots (after partySize filter)`
            );

            if (count > 0) {
              console.log(
                `  ✅ ${email} – ${course.name} on ${date}: ${count} slot(s) found.`
              );

              // 🔹 Store this hit so we can email + show popups later
              try {
                await db.query(
                  `
                  INSERT INTO user_alert_hits (
                    email,
                    course_name,
                    provider,
                    date,
                    holes,
                    party_size,
                    earliest,
                    latest,
                    slots
                  )
                  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                  `,
                  [
                    email,
                    course.name,
                    course.provider || null,
                    date,
                    userHoles || null,
                    partySize || null,
                    earliest || null,
                    latest || null,
                    JSON.stringify(result || []),
                  ]
                );
              } catch (err) {
                console.error(
                  `  ⚠️ failed to insert alert hit for ${email} / ${course.name} / ${date}:`,
                  err.message
                );
              }

              // ✅ WIRED: analytics "alert_hit" (availability found)
              await recordEvent("alert_hit", {
                userId: email,
                courseName: course.name,
                plan: plan || null,
                at: new Date().toISOString(),
                meta: {
                  date,
                  count,
                  provider: course.provider || null,
                  earliest,
                  latest,
                  holes: userHoles || null,
                  partySize: partySize || null,
                },
              });

             // Build booking URL from actual returned tee times
const firstSlot =
  Array.isArray(result) && result.length
    ? result[0]
    : null;

const bookingLink =
  firstSlot?.bookingUrl ||
  firstSlot?.bookUrl ||
  firstSlot?.url ||
  firstSlot?.link ||
  firstSlot?.href ||
  buildBookingLinkForDate(course, date) ||
  course?.url ||
  course?.bookingUrl ||
  course?.bookUrl ||
  "";

const sampleTimes = Array.isArray(result)
  ? result
      .map((slot) => normaliseSlotTime(slot))
      .filter(Boolean)
      .slice(0, 3)
  : [];

emailHits.push({
  courseName: course.name,
  provider: course.provider || null,
  date,
  count,
  bookingLink,
  sampleTimes,
});
            } else {
              console.log(
                `  ⛔ ${email} – ${course.name} on ${date}: no slots.`
              );
            }
          } catch (err) {
            console.error(
              `  ❌ Alert scrape error for ${email} / ${course.name} / ${date}:`,
              err.message
            );
          }
        }
      }

      // ✅ Send ONE email per interval even if there are no hits (digest/heartbeat)
            if (emailsAllowed && canSendEmailForUser) {
        await sendAlertEmailSummaryForUser({
          email,
          plan,
          hits: emailHits,
          earliest,
          latest,
          userHoles,
          partySize,
        });
      }

            if (emailHits.length > 0) {
  await sendTeeTimePushSummaryForUser({
    email,
    hits: emailHits,
    earliest,
    latest,
    userHoles,
    partySize,
  });
}
    }

    console.log("🔔 Alert tick finished.");
  } catch (err) {
    console.error("❌ Alert worker tick failed:", err);
  }
}

// ---------------------------------------------------------
// Public entrypoint used by server.js
// ---------------------------------------------------------

export function startAlertWorker() {
  const disabled = (process.env.ALERT_WORKER_ENABLED || "").toLowerCase();
  if (disabled === "0" || disabled === "false" || disabled === "off") {
    console.log("🔕 Alert worker disabled via ALERT_WORKER_ENABLED.");
    return;
  }

  console.log("🔔 Starting alert worker…");

  // ✅ run once shortly after boot, then check frequently (email cadence is per-user)
  // ✅ Optional env override (ms) if you want: ALERT_TICK_INTERVAL_MS=60000
  const intervalMs =
    Number(process.env.ALERT_TICK_INTERVAL_MS) || 5 * 60 * 1000;

  setTimeout(runAlertTick, 15000);
  setInterval(runAlertTick, intervalMs);
}

// Optional: allow manual trigger when importing directly in scripts
export async function runAlertTickOnce() {
  await runAlertTick();
}
