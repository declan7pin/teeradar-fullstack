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

// --- wire up on load ---
window.addEventListener("DOMContentLoaded", () => {
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

  // Signup
  const signupForm = $("signupForm");
  if (signupForm) {
    signupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage("Creating account...");
      try {
        const email = $("signupEmail").value;
        const password = $("signupPassword").value;
        await postJSON("/api/auth/signup", { email, password });
        setMessage("Account created. You can now log in.");
        showView("auth-view-login");
        $("loginEmail").value = email;
      } catch (err) {
        setMessage(err.message || "Could not create account", true);
      }
    });
  }

  // Login
  const loginForm = $("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage("Logging in...");
      try {
        const email = $("loginEmail").value;
        const password = $("loginPassword").value;
        await postJSON("/api/auth/login", { email, password });
        setMessage("Logged in!");
        // If you later add JWT or localStorage, do it here.
        closeAuth();
      } catch (err) {
        setMessage(err.message || "Login failed", true);
      }
    });
  }

  // Reset
  const resetForm = $("resetForm");
  if (resetForm) {
    resetForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      setMessage("Resetting password...");
      try {
        const email = $("resetEmail").value;
        const newPassword = $("resetPassword").value;
        await postJSON("/api/auth/reset", { email, newPassword });
        setMessage("Password updated. You can now log in.");
        showView("auth-view-login");
        $("loginEmail").value = email;
      } catch (err) {
        setMessage(err.message || "Reset failed", true);
      }
    });
  }
});
