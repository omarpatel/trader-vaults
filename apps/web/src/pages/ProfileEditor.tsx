import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { TraderProfile } from "@trader-vaults/shared";
import { usePageTitle } from "../lib/hooks";
import { useToast } from "../lib/toast";

// X usernames: 1-15 chars, letters/digits/underscore (leading @ stripped).
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const BIO_MAX = 240;

async function fetchMe(): Promise<TraderProfile> {
  const res = await fetch("/api/traders/me");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const r = (await res.json()) as { trader: TraderProfile };
  return r.trader;
}

async function patchMe(body: {
  displayName: string;
  bio: string;
  xHandle: string;
  avatarUrl: string;
}): Promise<TraderProfile> {
  const res = await fetch("/api/traders/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string };
      detail = j.error ?? "";
    } catch {
      /* not json */
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  const r = (await res.json()) as { trader: TraderProfile };
  return r.trader;
}

/** Avatar block: image when the URL renders, initial fallback otherwise. */
function AvatarBlock({ url, handle, size = 52 }: { url: string; handle: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const showImg = url.trim() !== "" && !broken;
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        background: "var(--panel-3)",
        border: "1px solid var(--line-2)",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--display)",
        fontSize: size * 0.42,
        color: "var(--amber)",
        overflow: "hidden",
      }}
    >
      {showImg ? (
        <img
          src={url.trim()}
          alt=""
          onError={() => setBroken(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        (handle.slice(0, 1) || "?").toUpperCase()
      )}
    </div>
  );
}

export function ProfileEditor() {
  usePageTitle("Edit profile");
  const toast = useToast();

  const [trader, setTrader] = useState<TraderProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [xHandle, setXHandle] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const syncForm = (t: TraderProfile) => {
    setDisplayName(t.displayName);
    setBio(t.bio ?? "");
    setXHandle(t.xHandle ?? "");
    setAvatarUrl(t.avatarUrl ?? "");
  };

  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((t) => {
        if (!alive) return;
        setTrader(t);
        syncForm(t);
      })
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : "failed"));
    return () => {
      alive = false;
    };
  }, []);

  // Client-side mirrors of the API validation, for inline feedback.
  const name = displayName.trim();
  const nameOk = name.length >= 2 && name.length <= 30;
  const bioOk = bio.trim().length <= BIO_MAX;
  const xNorm = xHandle.trim().replace(/^@+/, "");
  const xOk = xNorm === "" || X_HANDLE_RE.test(xNorm);
  const urlNorm = avatarUrl.trim();
  const urlOk =
    urlNorm === "" ||
    (() => {
      try {
        const u = new URL(urlNorm);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    })();
  const canSave = !busy && trader !== null && nameOk && bioOk && xOk && urlOk;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const t = await patchMe({
        displayName: name,
        bio: bio.trim(),
        xHandle: xNorm,
        avatarUrl: urlNorm,
      });
      setTrader(t);
      syncForm(t);
      toast("good", "Profile saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <div className="callout red">Couldn't load your profile: {loadError}</div>;
  if (!trader) return <div className="empty">Loading profile…</div>;

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Edit profile</h1>
          <div className="sub">
            What depositors see on your vaults and your public trader page.
          </div>
        </div>
      </div>

      <div className="grid2">
        <form onSubmit={(e) => void submit(e)} className="panel panel-pad">
          <div className="field">
            <label>Handle — immutable</label>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                flexWrap: "wrap",
                background: "var(--ink)",
                border: "1px solid var(--line)",
                padding: "9px 12px",
              }}
            >
              <span className="mono">@{trader.handle}</span>
              <Link to={`/trader/${encodeURIComponent(trader.handle)}`} className="mono">
                View public page →
              </Link>
            </div>
            <div className="hint">Handles are permanent — they anchor your track record.</div>
          </div>

          <div className="field">
            <label>Display name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Runner"
              maxLength={30}
              required
            />
            {!nameOk && <div className="hint" style={{ color: "var(--red)" }}>2-30 characters.</div>}
          </div>

          <div className="field">
            <label>
              Bio —{" "}
              <span style={{ color: bio.trim().length > BIO_MAX ? "var(--red)" : undefined }}>
                {bio.trim().length}/{BIO_MAX}
              </span>
            </label>
            <textarea
              rows={4}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Strategy, edge, hours you trade. Depositors read this."
            />
            {!bioOk && (
              <div className="hint" style={{ color: "var(--red)" }}>
                Over the {BIO_MAX}-character limit.
              </div>
            )}
          </div>

          <div className="field">
            <label>X handle</label>
            <input
              value={xHandle}
              onChange={(e) => setXHandle(e.target.value)}
              placeholder="@handle — leave empty to unlink"
              spellCheck={false}
            />
            {!xOk && (
              <div className="hint" style={{ color: "var(--red)" }}>
                1-15 letters, digits or underscores.
              </div>
            )}
          </div>
          <div className="callout" style={{ marginBottom: 13 }}>
            Display-only until X OAuth ships — the 𝕏 verified badge stays off for self-entered
            handles.
          </div>

          <div className="field">
            <label>Avatar URL</label>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
              <AvatarBlock url={urlNorm} handle={trader.handle} />
              <input
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                placeholder="https://… — leave empty for the initial block"
                spellCheck={false}
                style={{ flex: 1 }}
              />
            </div>
            {!urlOk && (
              <div className="hint" style={{ color: "var(--red)" }}>
                Must be an http(s) URL — or empty to clear.
              </div>
            )}
          </div>

          {error && <div className="callout red" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn primary" disabled={!canSave}>
            {busy ? "…" : "Save profile"}
          </button>
        </form>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="panel panel-pad">
            <div className="sectiontitle" style={{ marginTop: 0 }}>Preview</div>
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              <AvatarBlock url={urlNorm} handle={trader.handle} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span
                    style={{
                      fontFamily: "var(--display)",
                      fontSize: 16,
                      fontWeight: 700,
                      textTransform: "uppercase",
                    }}
                  >
                    {name || "—"}
                  </span>
                  {xNorm !== "" &&
                    (trader.xVerified && xNorm === (trader.xHandle ?? "") ? (
                      <span className="pill mirror" title="X account linked">
                        𝕏 verified
                      </span>
                    ) : (
                      <span className="pill neutral" title="Self-entered — verification needs X OAuth">
                        𝕏 unverified
                      </span>
                    ))}
                </div>
                <div
                  className="sub"
                  style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
                >
                  <span className="mono">@{trader.handle}</span>
                  {xNorm !== "" && <span className="mono">𝕏 @{xNorm}</span>}
                </div>
                {bio.trim() !== "" && (
                  <div className="sub" style={{ marginTop: 6 }}>
                    {bio.trim()}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="callout">
            Everything above is cosmetic. Your numbers — PnL, win rate, drawdown — are recomputed
            from chain data and can't be edited, here or anywhere.
          </div>
        </div>
      </div>
    </>
  );
}
