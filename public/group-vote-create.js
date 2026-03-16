// public/group-vote-create.js
window.TeeRadarGroupVote = (() => {
    function getAuthToken() {
    try {
      return (
        localStorage.getItem("tr_token") ||
        localStorage.getItem("token") ||
        ""
      );
    } catch {
      return "";
    }
  }

  async function api(url, opts = {}) {
    const token = getAuthToken();

    const mergedHeaders = {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };

    if (token) {
      mergedHeaders.Authorization = `Bearer ${token}`;
    }

    const r = await fetch(url, {
      credentials: "include",
      ...opts,
      headers: mergedHeaders,
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(data?.error || "request_failed");
    }

    return data;
  }

  async function createVoteFromOptions({
    title = "Weekend Round",
    note = "",
    expiresAt = null,
    options = [],
  }) {
    if (!Array.isArray(options) || options.length < 2) {
      throw new Error("Pick at least 2 tee times");
    }

    return api("/api/group-votes", {
      method: "POST",
      body: JSON.stringify({
        title,
        note,
        expiresAt,
        options,
      }),
    });
  }

  return {
    createVoteFromOptions,
  };
})();