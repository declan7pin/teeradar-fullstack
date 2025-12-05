// public/auth.js
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = { ok: false, error: "Unexpected server response" };
  }

  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function $(id) {
  return document.getElementById(id);
}

function showView(view) {
  ["auth-view-login", "auth-view-signup", "auth-view-reset"].forEach((v) => {
    const el = $(v);
    if (!el) return;
    el.classList.toggle("hidden", v !== view);
  });
  setMessage("");
}

function setMessage(msg, isError = false) {
  const el = $("authMessage");
  if (!el) return;
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

function openAuth() {
  const overlay = $("auth-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  showView("auth-view-login");
  setMessage("");
}

function closeAuth() {
  const overlay = $("auth-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  setMessage("");
}

// AUTOCOMPLETE (Home Course Signup)
function initHomeCourseAutocomplete() {
  const input = $("signupHomeCourseInput");
  const list = $("signupHomeCourseSuggestions");
  const hiddenId = $("signupHomeCourseId");
  const hiddenState = $("signupHomeCourseState");

  if (!input || !list) return;

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    hiddenId.value = "";
    hiddenState.value = "";
    list.innerHTML = "";

    if (!q) return;

    // allCourses must exist globally
    const matches = (window.allCourses || [])
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 10);

    if (!matches.length) return;

    list.innerHTML = matches
      .map(
        (c) => `
        <div class="suggestion"
             data-id="${c.id}"
             data-name="${c.name}"
             data-state="${c.state}">
          ${c.name} (${c.state})
        </div>
      `
      )
      .join("");
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest(".suggestion");
    if (!item) return;

    input.value = `${item.dataset.name} (${item.dataset.state})`;
    hiddenId.value = item.dataset.id;
    hiddenState.value = item.dataset.state;

    list.innerHTML = "";
  });
}

// ---------- WIRE UP ----------
window.addEventListener("DOMContentLoaded", () => {
  initHomeCourseAutocomplete();

  const openBtn = $("openAuthBtn");
  const closeBtn = $("authCloseBtn");

  if (openBtn) openBtn.addEventListener("click", openAuth);
  if (closeBtn) closeBtn.addEventListener("click", closeAuth);

  const overlay = $("auth-overlay");
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAuth();
    });
  }

  // Switch views
  const showSignup = $("showSignupView");
  const showLogin = $("showLoginView");
  const showReset = $("showResetView");
  const resetBackToLogin = $("resetBackToLogin");

  if (showSignup) showSignup.addEventListener("click", () => showView("auth-view-signup"));
  if (showLogin) showLogin.addEventListener("click", () => showView("auth-view-login"));
  if (showReset) showReset.addEventListener("click", () => showView("auth-view-reset"));
  if (resetBackToLogin) resetBackToLogin.addEventListener("click", () => showView("auth-view-login"));

  // ---------- SIGNUP ----------
  const signupForm = $("signupForm");
  if (signupForm) {
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage("Creating account...");

      try {
        const email = $("signupEmail").value;
        const password = $("signupPassword").value;

        const homeCourse = $("signupHomeCourseInput").value || null;
        const homeCourseId = $("signupHomeCourseId").value || null;
        const homeCourseState = $("signupHomeCourseState").value || null;

        const result = await postJSON("/api/auth/signup", {
          email,
          password,
          homeCourse,
          homeCourseId,
          homeCourseState,
        });

        // Store user for automatic state/course preload
        if (result.user) {
          localStorage.setItem("tr_user", JSON.stringify(result.user));
        }

        setMessage("Account created. You can now log in.");
        showView("auth-view-login");
        $("loginEmail").value = email;

      } catch (err) {
        setMessage(err.message || "Could not create account", true);
      }
    });
  }

  // ---------- LOGIN ----------
  const loginForm = $("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage("Logging in...");

      try {
        const email = $("loginEmail").value;
        const password = $("loginPassword").value;

        const result = await postJSON("/api/auth/login", {
          email,
          password,
        });

        if (result.user) {
          localStorage.setItem("tr_user", JSON.stringify(result.user));
        }

        setMessage("Logged in!");
        closeAuth();
      } catch (err) {
        setMessage(err.message || "Login failed", true);
      }
    });
  }

  // ---------- RESET PASSWORD ----------
  const resetForm = $("resetForm");
  if (resetForm) {
    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage("Resetting password...");

      try {
        const email = $("resetEmail").value;
        const newPassword = $("resetPassword").value;

        const result = await postJSON("/api/auth/reset", {
          email,
          newPassword,
        });

        if (result.user) {
          localStorage.setItem("tr_user", JSON.stringify(result.user));
        }

        setMessage("Password updated. You can now log in.");
        showView("auth-view-login");
        $("loginEmail").value = email;

      } catch (err) {
        setMessage(err.message || "Reset failed", true);
      }
    });
  }
});