// public/js/mobileAppShell.js

function isRunningInsideNativeApp() {
  try {
    return Boolean(
      window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === "function" &&
      window.Capacitor.isNativePlatform()
    );
  } catch (error) {
    console.warn("Could not detect Capacitor platform:", error);
    return false;
  }
}

function getCurrentPage() {
  const pathname = window.location.pathname.toLowerCase();

  if (
    pathname.includes("scorecard") ||
    pathname.includes("my-games") ||
    pathname.includes("round")
  ) {
    return "play";
  }

  if (pathname.includes("book")) {
    return "search";
  }

  if (
    pathname.includes("friend") ||
    pathname.includes("shared-round") ||
    pathname.includes("compare")
  ) {
    return "friends";
  }

  if (
    pathname.includes("account") ||
    pathname.includes("subscribe") ||
    pathname.includes("settings")
  ) {
    return "account";
  }

  return "home";
}

function iconSvg(name) {
  const icons = {
    home: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M3 11.5 12 4l9 7.5"></path>
        <path d="M5.5 10.5V20h13v-9.5"></path>
        <path d="M9.5 20v-6h5v6"></path>
      </svg>
    `,

    search: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="11" cy="11" r="7"></circle>
        <path d="m20 20-4-4"></path>
      </svg>
    `,

    play: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M7 4v16"></path>
        <path d="M8 5h9l-2.5 3L17 11H8"></path>
      </svg>
    `,

    friends: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="9" cy="8" r="3"></circle>
        <circle cx="17" cy="10" r="2.5"></circle>
        <path d="M3.5 20c.4-4 2.3-6 5.5-6s5.1 2 5.5 6"></path>
        <path d="M14.5 15c3.4-.4 5.4 1.3 6 5"></path>
      </svg>
    `,

    account: `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="8" r="4"></circle>
        <path d="M4.5 21c.7-4.5 3.2-7 7.5-7s6.8 2.5 7.5 7"></path>
      </svg>
    `
  };

  return icons[name] || "";
}

function tabLink({ id, label, href, play = false }, currentPage) {
  const active = id === currentPage ? " active" : "";
  const playClass = play ? " app-tab-play" : "";

  if (play) {
    return `
      <a
        class="app-tab-link${playClass}${active}"
        href="${href}"
        data-app-tab="${id}"
        aria-label="${label}"
      >
        <span class="app-tab-play-icon">
          ${iconSvg(id)}
        </span>
        <span>${label}</span>
      </a>
    `;
  }

  return `
    <a
      class="app-tab-link${active}"
      href="${href}"
      data-app-tab="${id}"
      aria-label="${label}"
    >
      ${iconSvg(id)}
      <span>${label}</span>
    </a>
  `;
}

function createBottomNavigation() {
  if (document.querySelector(".app-tab-bar")) {
    return;
  }

  const currentPage = getCurrentPage();

  const tabs = [
    {
      id: "home",
      label: "Home",
      href: "/index.html"
    },
    {
      id: "search",
      label: "Search",
      href: "/book.html"
    },
    {
      id: "play",
      label: "Play",
      href: "/my-games.html",
      play: true
    },
    {
      id: "friends",
      label: "Friends",
      href: "/friends.html"
    },
    {
      id: "account",
      label: "Account",
      href: "/account.html"
    }
  ];

  const navigation = document.createElement("nav");

  navigation.className = "app-tab-bar app-only";
  navigation.setAttribute("aria-label", "Main app navigation");

  navigation.innerHTML = tabs
    .map((tab) => tabLink(tab, currentPage))
    .join("");

  document.body.appendChild(navigation);
}

function initialiseMobileAppShell() {
  if (!isRunningInsideNativeApp()) {
    return;
  }

  document.documentElement.classList.add("app-mode");
  document.body.classList.add("native-mobile-app");

  createBottomNavigation();

  window.dispatchEvent(
    new CustomEvent("teeradarAppReady", {
      detail: {
        native: true,
        platform:
          window.Capacitor?.getPlatform?.() || "unknown"
      }
    })
  );
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initialiseMobileAppShell
  );
} else {
  initialiseMobileAppShell();
}
