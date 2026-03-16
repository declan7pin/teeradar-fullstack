// public/group-vote-create.js
window.TeeRadarGroupVote = (() => {
  async function api(url, opts = {}) {
    const r = await fetch(url, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || "request_failed");
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

  async function promptAndCreate(options) {
    const title = window.prompt("Vote title", "Weekend Round") || "Weekend Round";
    const note = window.prompt("Optional note", "") || "";

    const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    const result = await createVoteFromOptions({
      title,
      note,
      expiresAt,
      options,
    });

    const fullUrl = new URL(result.shareUrl, window.location.origin).toString();

    const share = window.confirm(`Group vote created.\n\nShare link copied?\n\n${fullUrl}`);
    try {
      await navigator.clipboard.writeText(fullUrl);
    } catch {}

    if (share) {
      window.open(fullUrl, "_blank");
    }
    return result;
  }

  return {
    createVoteFromOptions,
    promptAndCreate,
  };
})();