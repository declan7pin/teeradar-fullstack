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
          localStorage.setItem("teeradar_home_course", currentUser.homeCourse);
        }
      } else {
        authToken = null;
        localStorage.removeItem("tr_auth_token");
      }
    } catch (err) {
      console.error("verifyExistingToken error", err);
    }
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
      localStorage.setItem("tr_auth_token", authToken);
      currentUser = data.user || null;

      if (currentUser && currentUser.homeCourse) {
        localStorage.setItem("teeradar_home_course", currentUser.homeCourse);
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
    const homeCourse = (signupHomeCourse && signupHomeCourse.value.trim()) || "";

    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, homeCourse }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Signup failed.");
        return;
      }

      authToken = data.token;
      localStorage.setItem("tr_auth_token", authToken);
      currentUser = data.user || null;

      if (currentUser && currentUser.homeCourse) {
        localStorage.setItem("teeradar_home_course", currentUser.homeCourse);
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
    await verifyExistingToken();
    applyUserUi();
  })();
})();
