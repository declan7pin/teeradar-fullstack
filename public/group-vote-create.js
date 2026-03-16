// public/group-vote-create.js
window.TeeRadarGroupVote = (() => {
  async function api(url, opts = {}) {
    const r = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts,
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