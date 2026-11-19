const SUPABASE_URL  = "https://pgmlomrttcznxmoonkgl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BrHe5dx8nd4Cs40QPEq7zg";
let _sb = null;
function sb() {
  if (!_sb) _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _sb;
}
async function requireAuth() {
  const { data, error } = await sb().auth.getSession();
  if (error || !data.session) {
    location.href = "/auth.html?next=" + encodeURIComponent(location.href);
    return null;
  }
  return data.session;
}
async function currentUser() {
  const { data } = await sb().auth.getUser();
  return data.user || null;
}
async function currentUserId() {
  const { data } = await sb().auth.getSession();
  return (data && data.session && data.session.user) ? data.session.user.id : null;
}
async function signOut() {
  await sb().auth.signOut();
  location.href = "/auth.html";
}
async function loadBlob(key, fallback = null) {
  const { data, error } = await sb()
    .from("app_data").select("data").eq("key", key).maybeSingle();
  if (error) {
    console.error("loadBlob failed for " + key + ":", error.message);
    return fallback;
  }
  return (data && data.data !== null && data.data !== undefined) ? data.data : fallback;
}
async function saveBlob(key, value) {
  const { error } = await sb()
    .from("app_data")
    .upsert({ key: key, data: value }, { onConflict: "key" });
  if (error) {
    console.error("saveBlob failed for " + key + ":", error.message);
    throw error;
  }
}
async function loadUserState(key, fallback = null) {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in");
  const { data, error } = await sb()
    .from("user_state")
    .select("data, updated_at")
    .eq("user_id", uid)
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error("loadUserState failed for " + key + ":", error.message);
    throw error;
  }
  return (data && data.data !== null && data.data !== undefined) ? data.data : fallback;
}
async function saveUserState(key, value) {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in");
  const { error } = await sb()
    .from("user_state")
    .upsert(
      { user_id: uid, key: key, data: value, updated_at: new Date().toISOString() },
      { onConflict: "user_id,key" }
    );
  if (error) {
    console.error("saveUserState failed for " + key + ":", error.message);
    throw error;
  }
}
async function peekUserStamp(key) {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in");
  const { data, error } = await sb()
    .from("user_state")
    .select("updated_at")
    .eq("user_id", uid)
    .eq("key", key)
    .maybeSingle();
  if (error) {
    console.error("peekUserStamp failed for " + key + ":", error.message);
    return null;
  }
  return data ? (Date.parse(data.updated_at) || 0) : 0;
}
function isEpochDone(v) {
  return v && typeof v === "object" && !Array.isArray(v) &&
         typeof v.epoch === "number" &&
         v.done && typeof v.done === "object" && !Array.isArray(v.done);
}
function mergeEpochDone(lv, rv) {
  if (!isEpochDone(lv)) return rv;
  if (!isEpochDone(rv)) return lv;
  if (lv.epoch > rv.epoch) return lv;
  if (rv.epoch > lv.epoch) return rv;
  const done = { ...lv.done };
  for (const tid in rv.done) if (done[tid] === undefined) done[tid] = rv.done[tid];
  return { epoch: lv.epoch, done: done };
}
function isPlainObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
function deepUnion(base, extra) {
  if (Array.isArray(base) && Array.isArray(extra)) {
    const out = base.slice();
    for (const v of extra) if (!out.includes(v)) out.push(v);
    return out;
  }
  if (isPlainObj(base) && isPlainObj(extra)) {
    const out = { ...base };
    for (const k in extra) {
      if (!(k in out)) out[k] = extra[k];
      else out[k] = deepUnion(out[k], extra[k]);
    }
    return out;
  }
  return base;
}
function createUserSync(opts) {
  const key = opts.key;
  const loadLocal = opts.loadLocal;
  const saveLocal = opts.saveLocal;
  const getState = opts.getState;
  const setState = opts.setState;
  const onRender = opts.onRender || function () {};
  const setOnline = opts.setOnline || function () {};
  const sections = opts.sections || null;
  const growSections = opts.growSections || [];
  let uid = null;
  let cacheKey = null;
  let stamp = 0;
  let savedAt = 0;
  let online = false;
  let pushTimer = null;
  let pushInFlight = false;
  let pushPending = false;
  let lastRemote = null;
  const prevSnap = {};

  function stampSections(obj) {
    obj.updatedAt = obj.updatedAt || {};
    const fields = sections || Object.keys(obj);
    for (const s of fields) {
      if (s === "updatedAt") continue;
      const ser = JSON.stringify(obj[s]);
      if (obj.updatedAt[s] === undefined || prevSnap[s] !== ser) {
        obj.updatedAt[s] = Date.now();
        prevSnap[s] = ser;
      }
    }
  }
  function primeStamps() {
    const state = getState();
    if (!state) return;
    const fields = sections || Object.keys(state);
    for (const s of fields) {
      if (s === "updatedAt") continue;
      prevSnap[s] = JSON.stringify(state[s]);
    }
  }
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  }
  function mergeSectionValue(f, lv, rv, lt, rt) {
    if (isEpochDone(lv) || isEpochDone(rv)) return mergeEpochDone(lv, rv);
    if (growSections.includes(f)) return deepUnion(lv, rv);
    return rt > lt ? rv : lv;
  }
  function merge(local, remote) {
    const out = {};
    const fields = sections ||
      Array.from(new Set([
        ...Object.keys(local || {}),
        ...Object.keys(remote || {})
      ])).filter(k => k !== "updatedAt");
    for (const f of fields) {
      const lv = (local && local[f] !== undefined) ? local[f] : null;
      const rv = (remote && remote[f] !== undefined) ? remote[f] : null;
      const lt = (local && local.updatedAt && local.updatedAt[f]) || 0;
      const rt = (remote && remote.updatedAt && remote.updatedAt[f]) || 0;
      if (isEmpty(lv) && isEmpty(rv)) out[f] = lv || rv;
      else if (isEmpty(lv)) out[f] = rv;
      else if (isEmpty(rv)) out[f] = lv;
      else out[f] = mergeSectionValue(f, lv, rv, lt, rt);
    }
    const upd = {};
    const lu = (local && local.updatedAt) || {};
    const ru = (remote && remote.updatedAt) || {};
    for (const s of Array.from(new Set([...Object.keys(lu), ...Object.keys(ru)]))) {
      upd[s] = Math.max(lu[s] || 0, ru[s] || 0);
    }
    out.updatedAt = upd;
    return out;
  }
  async function load() {
    const data = await loadUserState(key, null);
    if (data && data.state) {
      savedAt = data.savedAt || 0;
      const serverStamp = await peekUserStamp(key);
      stamp = serverStamp || stamp;
      return data.state;
    }
    return null;
  }
  async function push() {
    if (!uid) return;
    pushInFlight = true;
    try {
      const state = getState();
      let rescued = false;
      const fields = sections || Object.keys(state);
      for (const s of fields) {
        if (s === "updatedAt") continue;
        const remoteVal = lastRemote ? lastRemote[s] : null;
        const newVal = state[s];
        if (!isEmpty(remoteVal) && isEmpty(newVal)) {
          state[s] = remoteVal;
          rescued = true;
        } else if (growSections.includes(s) && !isEmpty(remoteVal) && !isEmpty(newVal)) {
          const mergedVal = deepUnion(remoteVal, newVal);
          if (JSON.stringify(mergedVal) !== JSON.stringify(newVal)) {
            state[s] = mergedVal;
            rescued = true;
          }
        }
      }
      if (rescued) {
        stampSections(state);
        setState(state);
        saveLocal(state);
      }
      const now = Date.now();
      await saveUserState(key, { savedAt: now, state: state });
      savedAt = now;
      lastRemote = JSON.parse(JSON.stringify(state));
      const serverStamp = await peekUserStamp(key);
      stamp = serverStamp || stamp;
      online = true;
      setOnline(true);
    } catch (err) {
      console.error("push failed for " + key + ":", err.message);
      online = false;
      setOnline(false);
    } finally {
      pushInFlight = false;
      if (pushPending) { pushPending = false; schedule(0); }
    }
  }
  function schedule(delay) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay);
  }
  async function poll() {
    if (!online || pushInFlight || document.hidden) return;
    try {
      const serverStamp = await peekUserStamp(key);
      if (serverStamp && serverStamp > stamp) {
        const remote = await load();
        if (remote && (remote.savedAt || 0) >= savedAt) {
          lastRemote = remote;
          savedAt = remote.savedAt || 0; // FIX (v6): keep local bookkeeping current
          setState(merge(getState(), remote));
          saveLocal(getState());
          primeStamps();
          onRender();
          setOnline(true, "synced from cloud ✓");
        }
      }
    } catch (e) { /* transient — next poll retries */ }
  }
  document.addEventListener("visibilitychange", poll);
  setInterval(poll, 60000);
  return {
    get uid() { return uid; },
    async init() {
      const session = await requireAuth();
      if (!session) return false;
      uid = session.user && session.user.id;
      cacheKey = key + ":" + uid;

      const local = loadLocal();
      let remoteState = null;
      try {
        remoteState = await load();
        online = true;
      } catch (err) {
        online = false;
        setOnline(false);
        if (local) setState(local);
        primeStamps();
        return true;
      }
      if (remoteState) {
        lastRemote = remoteState;
        const merged = merge(local || {}, remoteState);
        setState(merged);
        saveLocal(getState());
        if (JSON.stringify(merged) !== JSON.stringify(remoteState)) {
          schedule(0);
        }
      } else {
        const s = (local && Object.keys(local).length) ? local : {};
        stampSections(s);
        setState(s);
        try {
          const now = Date.now();
          await saveUserState(key, { savedAt: now, state: s });
          savedAt = now;
          lastRemote = JSON.parse(JSON.stringify(s)); // FIX (v3)
          const serverStamp = await peekUserStamp(key);
          stamp = serverStamp || stamp;
          setOnline(true);
        } catch (err) { setOnline(false); }
      }
      saveLocal(getState());
      primeStamps();
      setOnline(true);
      return true;
    },
    save(immediate) {
      if (!uid) { if (typeof loadLocal === "function") saveLocal(getState()); return; }
      stampSections(getState());
      saveLocal(getState());
      if (immediate) {
        if (pushInFlight) pushPending = true; else schedule(0);
      } else {
        if (pushInFlight) pushPending = true; else schedule(1500);
      }
    }
  };
}
async function listRows(table, { orderBy = null, ascending = true, eq = null } = {}) {
  let q = sb().from(table).select("*");
  if (eq) for (const col in eq) q = q.eq(col, eq[col]);
  if (orderBy) q = q.order(orderBy, { ascending });
  const { data, error } = await q;
  if (error) { console.error("listRows:", error.message); return []; }
  return data || [];
}
async function insertRow(table, obj) {
  const { data, error } = await sb().from(table).insert(obj).select().single();
  if (error) throw error;
  return data;
}
async function insertRows(table, objs) {
  const { data, error } = await sb().from(table).insert(objs).select();
  if (error) throw error;
  return data;
}
async function updateRow(table, id, patch) {
  const { data, error } = await sb().from(table).update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
async function deleteRow(table, id) {
  const { error } = await sb().from(table).delete().eq("id", id);
  if (error) throw error;
}
async function upsertRow(table, obj, conflictCol = "id") {
  const { data, error } = await sb()
    .from(table).upsert(obj, { onConflict: conflictCol }).select().single();
  if (error) throw error;
  return data;
}
window.addEventListener("unhandledrejection", e => {
  if (e.reason && e.reason.message) console.error("Unhandled sync failure:", e.reason.message);
});
