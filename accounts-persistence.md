# Why accounts "disappear" — and how to fix it

Your code is **not** the problem. Accounts save to `accounts.json` correctly, and
login works — verified even across a server restart when the file survives.

The real cause: **Render's free tier has an ephemeral filesystem.** Anything the
server writes at runtime (`accounts.json`) is wiped whenever the service:
- **sleeps** (free services spin down after ~15 min idle), or
- **redeploys** (every push).

So you sign up → the server later sleeps → wakes with a blank disk → your account
is gone → "no account, can't log in."

The server now supports three ways to fix this. Pick one.

---

## Option A — Free, proper fix: Upstash Redis (recommended)

A free cloud key-value store. Accounts survive sleeps *and* redeploys.

1. Go to **https://upstash.com** → sign up (free) → **Create Database** (Redis).
2. On the database page, find the **REST API** section. Copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
3. In **Render → your service → Environment**, add those two as environment
   variables (same names, paste the values).
4. Save — Render redeploys. Done. Accounts now persist forever.

No code changes needed — the server auto-detects the env vars. If they're absent
or wrong, it silently falls back to the local file (so nothing breaks).

Free tier is ~10,000 commands/day, which is plenty for a casual game (accounts
are only read on login and written on changes).

---

## Option B — Free, partial: never let it sleep

If the server never sleeps, `accounts.json` survives **between deploys** (but is
still reset on each redeploy).

1. Sign up at **https://uptimerobot.com** (free) or **https://cron-job.org**.
2. Add a monitor that pings `https://territory-game-5c0c.onrender.com/healthz`
   every **10 minutes**.

Good enough if you rarely redeploy. Not as solid as Option A.

---

## Option C — Paid, bulletproof: Render Persistent Disk

1. Render → your service → **Disks** → add a disk, mount path `/data`
   (requires a paid instance, ~$7/mo).
2. Add env var `DATA_DIR=/data`.

The server will read/write `accounts.json` on the persistent disk. Survives
everything.

---

**TL;DR:** do Option A. Two env vars, free, five minutes, and accounts stop
disappearing.
