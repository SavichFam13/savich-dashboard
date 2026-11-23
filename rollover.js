(function () {
  if (typeof loadUserState !== "function" ||
      typeof saveUserState !== "function" ||
      typeof currentUserId !== "function") return; 

  const DAILY_KEY   = "gw2-tracker-daily";
  const HISTORY_KEY = "gw2-daily-log";

  const LOCK_TTL_MS       = 30000; 
  const LOCK_WAIT_MS      = 30000; 
  const LOCK_POLL_MS      = 1000;  
  const LOCK_KEEPALIVE_MS = 10000; 
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
  function entryCovers(saved, wanted) {
    if (Array.isArray(wanted)) {
      if (!Array.isArray(saved)) return false;
      for (const w of wanted) if (!saved.includes(w)) return false;
      return true;
    }
    if (Array.isArray(saved)) return saved.includes(wanted);
    return saved === wanted;
  }
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
    return { value: incoming, changed: true };
  }
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
  function releaseLock(uid) {
    try {
      const k = "gw2-rollover-lock:" + uid;
      const raw = localStorage.getItem(k);
      if (!raw) return;
      const lock = JSON.parse(raw);
      if (lock && lock.tab !== TAB_ID) return; 
      localStorage.removeItem(k);
    } catch (e) {}
  }
  function readCloudDay() {
    return loadUserState(DAILY_KEY, null).then(function (row) {
      return (row && row.state) ? row.state : null;
    });
  }
  async function doCheck() {
    const uid = await currentUserId();
    if (!uid) return false;               
    const today = dailyEpoch(Date.now());
    function dayIsStillCurrent() {
      return dailyEpoch(Date.now()) === today;
    }
    const row = await loadUserState(DAILY_KEY, null);
    const cloudState = (row && row.state) || null;
    const st = cloudState && cloudState.daily;
    if (st === null || st === undefined) {
      return dayIsStillCurrent(); 
    }
    if (!isDayState(st)) return false;   
    if (st.epoch === today) return dayIsStillCurrent();
    if (st.epoch > today) return false;   
    let locked = false;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!locked && Date.now() < deadline) {
      if (acquireLock(uid)) { locked = true; break; }
      await sleep(LOCK_POLL_MS);
      const mid = await readCloudDay();
      const midDay = mid && mid.daily;
      if (isDayState(midDay) && midDay.epoch === today) {
        return dayIsStillCurrent(); 
      }
      if (midDay && Number.isSafeInteger(midDay.epoch) && midDay.epoch > today) {
        return false; 
      }
    }
    if (!locked) return false;        
    let lostOwnership = false;
    const keeper = setInterval(function () {
      if (!refreshLock(uid)) lostOwnership = true;
    }, LOCK_KEEPALIVE_MS);
    try {
      const fresh = await loadUserState(DAILY_KEY, null);
      const cur = fresh && fresh.state && fresh.state.daily;
      if (!isDayState(cur)) return false;      
      if (cur.epoch === today) return dayIsStillCurrent(); 
      if (cur.epoch > today) return false;  
      if (lostOwnership) return false;     
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
          hist.updatedAt.logs = Date.now();
          await saveUserState(HISTORY_KEY, { savedAt: Date.now(), state: hist });
        }
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
      if (lostOwnership || !stillOwnsLock(uid)) return false;
      const last = await loadUserState(DAILY_KEY, null);
      const cur2 = last && last.state && last.state.daily;
      if (!isDayState(cur2)) return false;  
      if (cur2.epoch === today) return dayIsStillCurrent(); 
      if (cur2.epoch > today) return false;    
      if (cur2.epoch !== cur.epoch) return false; 
      if (!stillOwnsLock(uid)) return false;   
      if (!dayIsStillCurrent()) return false;
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
      return dayIsStillCurrent(); 
    } finally {
      clearInterval(keeper);
      releaseLock(uid); 
    }
  }
  let chain = Promise.resolve();
  let inFlight = null;
  function runCheck() {
    if (inFlight) return inFlight; 
    const task = chain.then(function () {
      return doCheck();  
    });
    inFlight = task;
    chain = task.then(function () {}, function () {}); 
    task.then(
      function () { if (inFlight === task) inFlight = null; },
      function () { if (inFlight === task) inFlight = null; }
    );
    return task;
  }
  window.__gw2RolloverTick = runCheck;
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
