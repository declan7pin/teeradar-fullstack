// public/auth-ui.js
// Handles login/signup modal + logout, using /api/auth/* routes.

(function () {
  const accountBtn = document.getElementById("nav-account-btn");
  const logoutBtn = document.getElementById("nav-logout-btn");

  const backdrop = document.getElementById("auth-modal-backdrop");
  const closeBtn = document.getElementById("auth-close-btn");

  const loginForm = document.getElementById("auth-form-login");
  const signupForm = document.getElementById("auth-form-signup");

  const loginEmail = document.getElementById("auth-login-email");
  const loginPassword = document.getElementById("auth-login-password");

  const signupEmail = document.getElementById("auth-signup-email");
  const signupPassword = document.getElementById("auth-signup-password");
  const signupHomeCourse = document.getElementById("auth-signup-homecourse");

  const switchToSignup = document.getElementById("auth-switch-to-signup");
  const switchToLogin = document.getElementById("auth-switch-to-login");

  const modeTitle = document.getElementById("auth-mode-title");
  const errorBox = document.getElementById("auth-error");
  const loggedInBox = document.getElementById("auth-logged-in");
  const loggedInEmail = document.getElementById("auth-user-email");

  let authToken = localStorage.getItem("tr_auth_token") || null;
  let currentUser = null;
  let currentMode = "login"; // "login" | "signup"

  // cache of courses for autocomplete
  let authCourses = [];
  let homeCourseSuggestionsEl = null;

  function showBackdrop() {
    if (backdrop) backdrop.classList.remove("auth-hidden");
  }

  function hideBackdrop() {
    if (backdrop) backdrop.classList.add("auth-hidden");
    clearError();
  }

  function setMode(mode) {
    currentMode = mode;
    if (!loginForm || !signupForm || !modeTitle) return;

    if (mode === "login") {
      loginForm.classList.remove("auth-hidden");
      signupForm.classList.add("auth-hidden");
      modeTitle.textContent = "Log in";
    } else {
      signupForm.classList.remove("auth-hidden");
      loginForm.classList.add("auth-hidden");
      modeTitle.textContent = "Create account";
    }
  }

  function setError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.classList.remove("auth-hidden");
  }

  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.classList.add("auth-hidden");
  }

  function applyUserUi() {
    if (currentUser && loggedInEmail && loggedInBox) {
      loggedInEmail.textContent = currentUser.email || "";
      loggedInBox.classList.remove("auth-hidden");
    } else if (loggedInBox) {
      loggedInBox.classList.add("auth-hidden");
    }

    if (accountBtn) {
      accountBtn.textContent = currentUser ? "My Account" : "Log in";
    }
    if (logoutBtn) {
      logoutBtn.style.display = currentUser ? "" : "none";
    }
  }

  async function verifyExistingToken() {
    if (!authToken) return;
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: authToken }),
      });
      const data = await res.json();
      if (data && data.ok && data.user) {
        currentUser = data.user;
        if (currentUser.homeCourse) {
          localStorage.setItem(
            "teeradar_home_course",
            currentUser.homeCourse
          );
        }
        localStorage.setItem("tr_user", JSON.stringify(currentUser));
      } else {
        authToken = null;
        localStorage.removeItem("tr_auth_token");
      }
    } catch (err) {
      console.error("verifyExistingToken error", err);
    }
  }

  // --- helpers for hidden inputs used by autocomplete + signup ---
  function getHomeCourseIdInput() {
    let el = document.getElementById("auth-signup-homecourse-id");
    if (!el && signupForm) {
      el = document.createElement("input");
      el.type = "hidden";
      el.id = "auth-signup-homecourse-id";
      el.name = "homeCourseId";
      signupForm.appendChild(el);
    }
    return el;
  }

  function getHomeCourseStateInput() {
    let el = document.getElementById("auth-signup-homecourse-state");
    if (!el && signupForm) {
      el = document.createElement("input");
      el.type = "hidden";
      el.id = "auth-signup-homecourse-state";
      el.name = "homeCourseState";
      signupForm.appendChild(el);
    }
    return el;
  }

  // --- load courses for autocomplete ---
  async function loadAuthCoursesOnce() {
    if (authCourses.length) return;

    // 1) Prefer global allCourses if present (e.g. from other pages)
    if (Array.isArray(window.allCourses) && window.allCourses.length) {
      authCourses = window.allCourses;
      return;
    }

    // 2) Otherwise fetch from backend
    try {
      const res = await fetch("/api/courses");
      const data = await res.json();
      authCourses = Array.isArray(data) ? data : [];
    } catch (err) {
      console.error("Error loading courses for auth autocomplete", err);
      authCourses = [];
    }

    // 3) Last-resort fallback so you at least see *something* (includes Darwin)
    if (!authCourses.length) {
      authCourses = [
        {
          id: "darwin-golf-club-nt",
          name: "Darwin Golf Club",
          state: "NT",
        },
        {
          id: "araluen-estate-wa",
          name: "Araluen Estate Golf Course",
          state: "WA",
        },
        {
          id: "whaleback-wa",
          name: "Whaleback Golf Course",
          state: "WA",
        },
      ];
    }
  }

  // --- setup autocomplete on the home-course field ---
  function setupHomeCourseAutocomplete() {
    if (!signupHomeCourse || !signupForm) return;

    const idInput = getHomeCourseIdInput();
    const stateInput = getHomeCourseStateInput();

    // create a suggestions container right after the input
    homeCourseSuggestionsEl = document.createElement("div");
    homeCourseSuggestionsEl.className = "autocomplete-list";
    signupHomeCourse.parentNode.insertBefore(
      homeCourseSuggestionsEl,
      signupHomeCourse.nextSibling
    );

    signupHomeCourse.addEventListener("input", async () => {
      const q = signupHomeCourse.value.trim().toLowerCase();

      if (idInput) idInput.value = "";
      if (stateInput) stateInput.value = "";
      homeCourseSuggestionsEl.innerHTML = "";

      if (!q) return;

      await loadAuthCoursesOnce();

      const matches = authCourses
        .filter((c) =>
          (c.name || "").toLowerCase().includes(q)
        )
        .slice(0, 10);

      if (!matches.length) return;

      homeCourseSuggestionsEl.innerHTML = "";
      matches.forEach((c) => {
        const item = document.createElement("div");
        item.className = "suggestion";
        item.dataset.id = c.id || "";
        item.dataset.state = c.state || "";
        item.dataset.name = c.name || "";
        item.textContent = `${c.name} (${c.state || ""})`;
        homeCourseSuggestionsEl.appendChild(item);
      });
    });

    homeCourseSuggestionsEl.addEventListener("click", (e) => {
      const item = e.target.closest(".suggestion");
      if (!item) return;

      const name = item.dataset.name || "";
      const state = item.dataset.state || "";
      const id = item.dataset.id || "";

      signupHomeCourse.value = state ? `${name} (${state})` : name;
      if (idInput) idInput.value = id;
      if (stateInput) stateInput.value = state;

      homeCourseSuggestionsEl.innerHTML = "";
    });

    // hide suggestions when clicking outside
    document.addEventListener("click", (e) => {
      if (
        !homeCourseSuggestionsEl ||
        e.target === signupHomeCourse ||
        homeCourseSuggestionsEl.contains(e.target)
      ) {
        return;
      }
      homeCourseSuggestionsEl.innerHTML = "";
    });
  }

  async function doLogin(e) {
    e.preventDefault();
    clearError();

    const email = (loginEmail && loginEmail.value.trim()) || "";
    const password = (loginPassword && loginPassword.value) || "";

    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Login failed.");
        return;
      }

      authToken = data.token;
      if (authToken) {
        localStorage.setItem("tr_auth_token", authToken);
      }

      currentUser = data.user || null;

      if (currentUser && currentUser.homeCourse) {
        localStorage.setItem(
          "teeradar_home_course",
          currentUser.homeCourse
        );
      }

      if (currentUser) {
        localStorage.setItem("tr_user", JSON.stringify(currentUser));
      }

      applyUserUi();
      hideBackdrop();
    } catch (err) {
      console.error("Login error", err);
      setError("Login failed. Please try again.");
    }
  }

  async function doSignup(e) {
    e.preventDefault();
    clearError();

    const email = (signupEmail && signupEmail.value.trim()) || "";
    const password = (signupPassword && signupPassword.value) || "";
    const homeCourse =
      (signupHomeCourse && signupHomeCourse.value.trim()) || "";

    const homeCourseIdEl = getHomeCourseIdInput();
    const homeCourseStateEl = getHomeCourseStateInput();

    const homeCourseId =
      (homeCourseIdEl && homeCourseIdEl.value.trim()) || "";
    const homeCourseState =
      (homeCourseStateEl && homeCourseStateEl.value.trim()) || "";

    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          homeCourse,
          homeCourseId,
          homeCourseState,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Signup failed.");
        return;
      }

      authToken = data.token;
      if (authToken) {
        localStorage.setItem("tr_auth_token", authToken);
      }

      currentUser = data.user || null;

      if (currentUser && currentUser.homeCourse) {
        localStorage.setItem(
          "teeradar_home_course",
          currentUser.homeCourse
        );
      }

      if (currentUser) {
        localStorage.setItem("tr_user", JSON.stringify(currentUser));
      }

      applyUserUi();
      hideBackdrop();
    } catch (err) {
      console.error("Signup error", err);
      setError("Signup failed. Please try again.");
    }
  }

  function doLogout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem("tr_auth_token");
    localStorage.removeItem("tr_user");
    localStorage.removeItem("teeradar_home_course");
    applyUserUi();
  }

  // ---- Wire up events ----
  if (accountBtn) {
    accountBtn.addEventListener("click", () => {
      setMode("login");
      showBackdrop();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", doLogout);
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", hideBackdrop);
  }

  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) hideBackdrop();
    });
  }

  if (switchToSignup) {
    switchToSignup.addEventListener("click", () => {
      setMode("signup");
      clearError();
    });
  }

  if (switchToLogin) {
    switchToLogin.addEventListener("click", () => {
      setMode("login");
      clearError();
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", doLogin);
  }

  if (signupForm) {
    signupForm.addEventListener("submit", doSignup);
  }

  // Initial bootstrap
  (async function init() {
    setupHomeCourseAutocomplete();   // enable autocomplete
    await verifyExistingToken();
    applyUserUi();
  })();
})();