/*
 * rollover.js — the SINGLE daily-rollover mechanism, site-wide.
 *
 * Included by every page (after db.js). Triggers autonomously on
 * page load, tab focus, and a 60s heartbeat — AND on demand via
 * window.__gw2RolloverTick(), which db.js's push() awaits (opt-in,
 * daily-tracker sync only) BEFORE capturing in-memory state.
 *
 * CONTRACT (v6.4):
 *   - A `true` verdict is PERMISSION TO WRITE the daily key. It is
 *     only returned when the cloud day is confirmed current AT THE
 *     MOMENT THE VERDICT IS ISSUED — not merely at check start.
 *     EVERY success path — including "no cloud day exists" —
 *     revalidates the UTC day against the live clock before
 *     returning true. No exceptions.
 *   - doCheck() returns TRUE when:
 *       · the day is already current (revalidated), or
 *       · there is genuinely nothing to roll over (no cloud day,
 *         revalidated), or
 *       · this check performed archive -> verify -> reset, and
 *         the day was still current when the verdict was issued.
 *   - doCheck() returns FALSE when safety CANNOT be confirmed:
 *     no user / invalid state / lock contention outlasted the
 *     wait window / clock skew / state moved mid-check / lock
 *     ownership lost mid-work / UTC DAY CHANGED mid-check on any
 *     success path.
 *   - doCheck() THROWS on hard failures (archive write, archive
 *     verification, reset write).
 *   - MIDNIGHT-WRITE LIMIT: the pre-reset guard and post-write
 *     verdict check DETECT a day that expired around the reset
 *     write; they cannot PREVENT the remote write from committing
 *     after midnight. On detection the verdict is false and the
 *     next trigger rolls the stale epoch forward. Detect-and-
 *     retry is the strongest guarantee available without
 *     database-side transactions.
 *   - ARCHIVE CONFLICTS merge SYMMETRICALLY: any disagreement
 *     involving an array (either side) unions both sides' values,
 *     so scalar-vs-array and array-vs-scalar both preserve every
 *     timestamp. Pure scalar conflicts take the live daily value.
 *   - ALWAYS-VERIFY: even when nothing new was added, every task
 *     entry of the old day is checked against a fresh cloud read.
 *     Verification is COVERAGE-based: every entry (and, for
 *     multi-logs, every timestamp) must be present in the archive.
 *     A genuinely missing entry throws — the day is never reset.
 *   - LOCK OWNERSHIP: acquire is fail-closed (no localStorage →
 *     no rollover from this tab). The holder runs a 10s keep-alive
 *     heartbeat that is ownership-AWARE — if the lock was taken
 *     over while this tab was suspended, the heartbeat will NOT
 *     overwrite it, and the check ABORTS before the reset write.
 *     Release is also ownership-checked. Stale takeover after 30s
 *     remains available for genuinely crashed tabs.
 *     KNOWN LIMIT: localStorage is not an atomic cross-tab lock;
 *     the final ownership/day checks shrink (but cannot eliminate)
 *     the check-to-write window. Idempotent archives make any
 *     residual collision converge rather than corrupt.
 *   - EPOCH VALIDATION: day states require Number.isSafeInteger
 *     epoch >= 0 — NaN/negative/garbage never passes as a day.
 *   - db.js must require `=== true`:
 *       const rolloverOk = await window.__gw2RolloverTick();
 *       if (rolloverOk !== true) throw new Error(...);
 *     A false or rejection cancels that push; the next save
 *     attempt re-ticks with a freshly computed day.
 *   - Concurrent callers SHARE the in-flight check's promise and
 *     all receive its actual verdict — no dropped results.
 *
 * Sequence per check (archive -> verify -> reset):
 *   1. Read daily state straight from Supabase.
 *   2. Older day found: take the (fail-closed) lock; merge its
 *      completions into gw2-daily-log (symmetric union).
 *   3. If anything changed: AWAIT the history write (throws on
 *      failure).
 *   4. ALWAYS VERIFY: re-read history; confirm EVERY task entry
 *      (and timestamp) from the old day is present in the archive.
 *   5. Final re-read of the daily row + still-owns-lock check +
 *      day-boundary re-check.
 *   6. Only then write the fresh day (+ carry credits). Return
 *      true (day revalidated).
 *   On ANY failure the old day is left untouched — preservation
 *   beats tidiness; the next trigger retries (and converges).
 */

(function () {
  if (typeof loadUserState !== "function" ||
      typeof saveUserState !== "function" ||
      typeof currentUserId !== "function") return; // db.js not present

  const DAILY_KEY   = "gw2-tracker-daily";
  const HISTORY_KEY = "gw2-daily-log";

  const LOCK_TTL_MS       = 30000; // lock considered stale after this
  const LOCK_WAIT_MS      = 30000; // max time to wait out a sibling tab
  const LOCK_POLL_MS      = 1000;  // contention poll interval
  const LOCK_KEEPALIVE_MS = 10000; // holder refresh cadence
  const CHECK_INTERVAL    = 60000;
  const STARTUP_DELAY     = 3000;

  const TAB_ID = Math.random().toString(36).slice(2);

  const sleep = ms => new Promise(res => setTimeout(res, ms));

  function dailyEpoch(ms) { return Math.floor(ms / 86400000); }

  function isDayState(v) {
    return v && typeof v === "object" && !Array.isArray(v) &&
           Number.isSafeInteger(v.epoch) && v.epoch >= 0 &&
           v.done && typeof v.done === "object" && !Array.isArray(v.done);
  }
  function dayHasEntries(st) { return Object.keys(st.done || {}).length > 0; }
  function dayKeyFor(epoch) {
    const d = new Date(epoch * 86400000);
    return String(d.getUTCFullYear()) + "-" +
           String(d.getUTCMonth() + 1).padStart(2, "0") +
           "-" + String(d.getUTCDate()).padStart(2, "0");
  }

  // Coverage test: does the archived value fully contain the day's
  // value? Arrays: every wanted timestamp present. Scalars: equal
  // (or absorbed into an archived array).
  function entryCovers(saved, wanted) {
    if (Array.isArray(wanted)) {
      if (!Array.isArray(saved)) return false;
      for (const w of wanted) if (!saved.includes(w)) return false;
      return true;
    }
    if (Array.isArray(saved)) return saved.includes(wanted);
    return saved === wanted;
  }

  // SYMMETRIC conflict-merge: never lose information from either
  // side. Any disagreement involving an array (either side) unions
  // both sides' values. Arrays contain primitive numeric
  // timestamps. Pure scalar-vs-scalar: live daily value wins.
  function mergeEntry(existing, incoming) {
    if (existing === undefined) {
      return { value: incoming, changed: true };
    }

    if (JSON.stringify(existing) === JSON.stringify(incoming)) {
      return { value: existing, changed: false };
    }

    if (Array.isArray(existing) || Array.isArray(incoming)) {
      const oldValues = Array.isArray(existing) ? existing : [existing];
      const newValues = Array.isArray(incoming) ? incoming : [incoming];

      const merged = oldValues.slice();

      for (const value of newValues) {
        if (!merged.includes(value)) merged.push(value);
      }

      merged.sort(function (a, b) { return a - b; });

      return { value: merged, changed: true };
    }

    // Scalar conflict: live daily value wins.
    return { value: incoming, changed: true };
  }

  // ---------- cross-tab lock (same browser; stale takeover) ----------
  // Fail-closed: if localStorage is unavailable, we never pretend
  // to have coordinated tabs — this tab declines to roll over.
  function acquireLock(uid) {
    try {
      const k = "gw2-rollover-lock:" + uid;
      const raw = localStorage.getItem(k);
      if (raw) {
        const lock = JSON.parse(raw);
        if (lock && lock.tab !== TAB_ID &&
            (Date.now() - lock.at) < LOCK_TTL_MS) return false;
      }
      localStorage.setItem(k, JSON.stringify({ tab: TAB_ID, at: Date.now() }));
      return true;
    } catch (e) {
      console.error("[rollover] could not access cross-tab lock:", e);
      return false;
    }
  }
  // Ownership-AWARE refresh: only refresh OUR lock. If another tab
  // took over while we were suspended, return false and leave
  // their claim intact — the caller must abort.
  function refreshLock(uid) {
    try {
      const k = "gw2-rollover-lock:" + uid;
      const raw = localStorage.getItem(k);
      if (!raw) return false;
      const lock = JSON.parse(raw);
      if (!lock || lock.tab !== TAB_ID) return false;
      localStorage.setItem(k, JSON.stringify({ tab: TAB_ID, at: Date.now() }));
      return true;
    } catch (e) {
      return false;
    }
  }
  function stillOwnsLock(uid) {
    try {
      const raw = localStorage.getItem("gw2-rollover-lock:" + uid);
      if (!raw) return false;
      const lock = JSON.parse(raw);
      return !!(lock && lock.tab === TAB_ID);
    } catch (e) {
      return false;
    }
  }
  // Ownership-checked release: never delete a successor's claim.
  function releaseLock(uid) {
    try {
      const k = "gw2-rollover-lock:" + uid;
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const lock = JSON.parse(raw);
      if (lock && lock.tab !== TAB_ID) return; // belongs to someone else now
      localStorage.removeItem(k);
    } catch (e) {}
  }

  function readCloudDay() {
    return loadUserState(DAILY_KEY, null).then(function (row) {
      return (row && row.state) ? row.state : null;
    });
  }

  // ---------- the check: true = confirmed safe, false = cannot confirm ----------
  async function doCheck() {
    const uid = await currentUserId();
    if (!uid) return false;                 // cannot confirm anything

    const today = dailyEpoch(Date.now());

    // Day-validity probe: is the UTC day captured at check start
    // STILL the current day right now? EVERY success path must
    // revalidate with this before returning true — a `true` verdict
    // is permission for the daily sync to write, and it must mean
    // the day is current at the moment the verdict is issued.
    function dayIsStillCurrent() {
      return dailyEpoch(Date.now()) === today;
    }

    // 1. Current daily state, straight from the cloud
    const row = await loadUserState(DAILY_KEY, null);
    const cloudState = (row && row.state) || null;
    const st = cloudState && cloudState.daily;

    if (st === null || st === undefined) {
      return dayIsStillCurrent(); // nothing to roll over — still revalidate
    }
    if (!isDayState(st)) return false;    // present but invalid — cannot confirm
    if (st.epoch === today) return dayIsStillCurrent(); // current — only if still
    if (st.epoch > today) return false;   // clock skew — this device must not write

    // 2. Old day exists — take the lock, WAITING OUT any sibling tab.
    let locked = false;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!locked && Date.now() < deadline) {
      if (acquireLock(uid)) { locked = true; break; }
      // Sibling tab owns it — wait, then re-check the cloud: it may
      // have finished while we waited.
      await sleep(LOCK_POLL_MS);
      const mid = await readCloudDay();
      const midDay = mid && mid.daily;
      if (isDayState(midDay) && midDay.epoch === today) {
        return dayIsStillCurrent(); // sibling finished — verify day still current
      }
      if (midDay && Number.isSafeInteger(midDay.epoch) && midDay.epoch > today) {
        return false; // cloud moved beyond us — do not touch
      }
    }
    if (!locked) return false;             // contended (or localStorage down) — cannot confirm

    // Holder keep-alive: ownership-aware. If it ever reports we no
    // longer own the lock, the keeper flags it and we abort before
    // the reset write.
    let lostOwnership = false;
    const keeper = setInterval(function () {
      if (!refreshLock(uid)) lostOwnership = true;
    }, LOCK_KEEPALIVE_MS);

    try {
      if (!refreshLock(uid)) { lostOwnership = true; return false; }

      // Re-read AFTER winning the lock (another tab may have finished)
      const fresh = await loadUserState(DAILY_KEY, null);
      const cur = fresh && fresh.state && fresh.state.daily;
      if (!isDayState(cur)) return false;      // moving target
      if (cur.epoch === today) return dayIsStillCurrent(); // already reset — verify still current
      if (cur.epoch > today) return false;     // skew — do not touch
      if (lostOwnership) return false;         // lost the lock mid-check

      // 3. ARCHIVE old day — symmetric merge, so a re-archive after
      //    an interrupted attempt converges without losing values.
      if (dayHasEntries(cur)) {
        const histWrap = await loadUserState(HISTORY_KEY, null) ||
          { state: { logs: {}, updatedAt: {} } };
        const hist = histWrap.state || (histWrap.state = {});
        if (!hist.logs) hist.logs = {};

        const year = String(new Date(cur.epoch * 86400000).getUTCFullYear());
        const dayKey = dayKeyFor(cur.epoch);

        hist.logs[year] = hist.logs[year] || {};
        const day = hist.logs[year][dayKey] || {};
        let changed = false;
        for (const tid in cur.done) {
          const res = mergeEntry(day[tid], cur.done[tid]);
          day[tid] = res.value;
          if (res.changed) changed = true;
        }
        if (changed) {
          hist.logs[year][dayKey] = day;
          hist.updatedAt = hist.updatedAt || {};
          hist.updatedAt.logs = Date.now();

          // AWAITED write — saveUserState throws on failure.
          await saveUserState(HISTORY_KEY, { savedAt: Date.now(), state: hist });
        }

        // 4. ALWAYS VERIFY — even when every entry already existed.
        //    Every task entry (and timestamp) of the old day must be
        //    covered by the archived day. Any gap = THROW — the day
        //    is never reset over an incomplete archive.
        const verify = await loadUserState(HISTORY_KEY, null);
        const vday = verify && verify.state && verify.state.logs &&
                     verify.state.logs[year] && verify.state.logs[year][dayKey];
        if (!vday) {
          throw new Error("[rollover] archive verify FAILED for " + dayKey +
                          " — daily state left untouched");
        }
        for (const tid in cur.done) {
          if (!entryCovers(vday[tid], cur.done[tid])) {
            throw new Error("[rollover] archive verify: entry '" + tid +
                            "' not fully archived for " + dayKey +
                            " — daily state left untouched");
          }
        }
      }

      // 5. FINAL re-read + ownership check + DAY BOUNDARY re-check
      //    before the reset.
      if (lostOwnership || !stillOwnsLock(uid)) return false;
      const last = await loadUserState(DAILY_KEY, null);
      const cur2 = last && last.state && last.state.daily;
      if (!isDayState(cur2)) return false;     // moving target
      if (cur2.epoch === today) return dayIsStillCurrent(); // reset elsewhere — verify still current
      if (cur2.epoch > today) return false;    // skew
      if (cur2.epoch !== cur.epoch) return false; // moving target
      if (!stillOwnsLock(uid)) return false;   // lock taken over mid-work

      // The UTC day may have changed while archive work was running
      // (lock wait + network round-trips). Never reset to a day
      // that is no longer current.
      if (!dayIsStillCurrent()) return false;

      // 6. ONLY NOW reset the daily state (+ apply carry for new day).
      const state = last.state || {};
      const newState = {
        daily: { epoch: today, done: {} },
        carry: state.carry || null,
        updatedAt: state.updatedAt || {}
      };
      if (isDayState(state.carry) && state.carry.epoch === today) {
        for (const tid in state.carry.done) {
          newState.daily.done[tid] = state.carry.done[tid];
        }
        newState.carry = { epoch: today, done: {} };
      }
      newState.updatedAt.daily = Date.now();
      await saveUserState(DAILY_KEY, { savedAt: Date.now(), state: newState });

      console.log("[rollover] archived " + dayKeyFor(cur.epoch) +
                  (dayHasEntries(cur) ? "" : " (was empty)") +
                  " and started fresh day " + today);
      return dayIsStillCurrent(); // rollover completed — verdict revalidated
      // If midnight crossed during the write itself, this returns
      // false: detected, not prevented. The next trigger archives
      // and rolls the stale epoch forward. See MIDNIGHT-WRITE LIMIT.
      //
      // Open pages converge via db.js poll()/merge on their next cycle.
    } finally {
      clearInterval(keeper);
      releaseLock(uid); // ownership-checked — a successor's claim survives
    }
  }

  // ---------- concurrent-call sharing (no dropped verdicts) ----------
  // Callers arriving while a check is in flight SHARE that check's
  // promise and all receive its actual true/false/rejection. A
  // caller arriving after completion queues a FRESH check. No
  // caller is ever handed an undefined result.
  let chain = Promise.resolve();
  let inFlight = null;

  function runCheck() {
    if (inFlight) return inFlight; // join the live check — share its verdict

    const task = chain.then(function () {
      return doCheck();            // true / false / rejects — flows to all
    });

    inFlight = task;
    chain = task.then(function () {}, function () {}); // keep chain alive

    task.then(
      function () { if (inFlight === task) inFlight = null; },
      function () { if (inFlight === task) inFlight = null; }
    );

    return task;
  }

  // 7. On-demand tick for db.js's rollover guard (daily sync only).
  //    Caller must require `=== true` and must not swallow rejections.
  window.__gw2RolloverTick = runCheck;

  // 8. Autonomous triggers: any page — load / focus / heartbeat.
  //    These log-and-retry; they never interrupt or alarm.
  function scheduledCheck() {
    runCheck().then(function (ok) {
      if (ok === false) {
        console.warn("[rollover] could not confirm (lock/skew/day boundary/moving target) — retrying next trigger");
      }
    }).catch(function (err) {
      console.error("[rollover] check failed:", err && err.message);
    });
  }
  if (document.readyState === "complete") {
    setTimeout(scheduledCheck, STARTUP_DELAY);
  } else {
    window.addEventListener("load", function () {
      setTimeout(scheduledCheck, STARTUP_DELAY);
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) scheduledCheck();
  });
  setInterval(scheduledCheck, CHECK_INTERVAL);
})();
