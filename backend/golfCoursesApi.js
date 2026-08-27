// backend/golfCoursesApi.js

const BASE_URL =
  "https://golfcoursesapi.com/api/v1";

const API_KEY =
  (process.env.GOLF_COURSES_API_KEY || "").trim();

function requireApiKey() {
  if (!API_KEY) {
    throw new Error(
      "GOLF_COURSES_API_KEY is not configured"
    );
  }
}

async function apiGet(path) {
  requireApiKey();

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

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Golf Courses API ${response.status}: ${body}`
    );
  }

  return response.json();
}


// =========================================================
// SEARCH COURSES
// =========================================================

export async function searchGolfCourses({
  query,
  country = "AU",
  perPage = 25,
}) {
  const q =
    encodeURIComponent(
      String(query || "").trim()
    );

  const countryCode =
    encodeURIComponent(country);

  const limit =
    Math.min(
      Math.max(
        Number(perPage) || 25,
        1
      ),
      100
    );

  const data = await apiGet(
    `/courses?q=${q}` +
    `&country=${countryCode}` +
    `&per_page=${limit}`
  );

  return data;
}


// =========================================================
// COURSE DETAIL
// =========================================================

export async function getGolfCourse(
  courseId
) {
  const id =
    encodeURIComponent(
      String(courseId)
    );

  const data = await apiGet(
    `/courses/${id}`
  );

  return data;
}


// =========================================================
// GREEN CENTRES
// =========================================================

export async function getGolfCourseGreenCenters(
  courseId
) {
  const id =
    encodeURIComponent(
      String(courseId)
    );

  const data = await apiGet(
    `/courses/${id}/green-centers`
  );

  return data;
}
