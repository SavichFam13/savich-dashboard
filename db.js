const SUPABASE_URL  = "https://pgmlomrttcznxmoonkgl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BrHe5dx8nd4Cs40QPEq7zg_mZwOGgqc";
let _sb = null;
function sb() {
  if (!_sb) _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _sb;
}
async function requireAuth() {
  const { data, error } = await sb().auth.getSession();
  if (error || !data.session) {
    // bounce to the login screen, remembering where we came from
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
    return fallback;
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

function createUserSync(opts) {
  const key = opts.key;
  const loadLocal = opts.loadLocal;
  const saveLocal = opts.saveLocal;
  const getState = opts.getState;
  const setState = opts.setState;
  const onRender = opts.onRender || function () {};
  const setOnline = opts.setOnline || function () {};
  const sections = opts.sections || null;
  let uid = null;
  let cacheKey = null;
  let stamp = 0;
  let savedAt = 0;
  let online = false;
  let pushTimer = null;
  let pushInFlight = false;
  let pushPending = false;
  function stampSections(obj) {
    obj.updatedAt = obj.updatedAt || {};
    for (const s of (sections || Object.keys(obj))) {
      if (typeof obj[s] === "object" || Array.isArray(obj[s]))
        obj.updatedAt[s] = Date.now();
    }
  }
  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  }
  function mergeSectionValue(f, lv, rv, lt, rt) {
    // Shared {epoch, done} rows: union tid maps instead of picking a side.
    if (isEpochDone(lv) || isEpochDone(rv)) return mergeEpochDone(lv, rv);
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
      const now = Date.now();
      await saveUserState(key, { savedAt: now, state: getState() });
      savedAt = now;
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
          setState(merge(getState(), remote.state));
          saveLocal(getState());
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
        return true;
      }
      if (remoteState) {
        setState(merge(local || {}, remoteState));
      } else {
        const s = (local && Object.keys(local).length) ? local : {};
        stampSections(s);
        setState(s);
        try {
          const now = Date.now();
          await saveUserState(key, { savedAt: now, state: s });
          savedAt = now;
          const serverStamp = await peekUserStamp(key);
          stamp = serverStamp || stamp;
          setOnline(true);
        } catch (err) { setOnline(false); }
      }
      saveLocal(getState());
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
  if (eq) for (const col in eq) q = q.eq(col, col);
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
  // bulk insert — handy for importing a year of dailies or a pile of inventory
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
