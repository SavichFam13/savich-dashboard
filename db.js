// ============================================================
// db.js — shared cloud layer for the Savich Dashboard
// Put this file at the ROOT of your site folder.
//
// Every page includes it like this:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/db.js"></script>
// (pages in home/ and gw2/ can also use "../db.js" — both work once hosted)
//
// THEN, near the top of the page's script:
//   await requireAuth();   // bounces to login if not signed in
// ============================================================

// ---- PASTE YOUR VALUES HERE (Settings → API in Supabase) ----
const SUPABASE_URL  = "https://pgmlomrttcznxmoonkgl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_BrHe5dx8nd4Cs40QPEq7zg_mZwOGgqc";

// ============================================================
// ONE-TIME SQL SETUP FOR PER-USER STATE (run in Supabase SQL editor):
//
//   create table if not exists user_state (
//     user_id    uuid not null references auth.users(id) on delete cascade,
//     key        text not null,
//     data       jsonb not null default '{}'::jsonb,
//     updated_at timestamptz not null default now(),
//     primary key (user_id, key)
//   );
//   alter table user_state enable row level security;
//
//   create policy "read own state"    on user_state for select
//     using (auth.uid() = user_id);
//   create policy "insert own state" on user_state
//     for insert with check (auth.uid() = user_id);
//   create policy "update own state"  on user_state for update
//     using (auth.uid() = user_id) with check (auth.uid() = user_id);
//   create policy "delete own state"  on user_state for delete
//     using (auth.uid() = user_id);
//
// RLS makes the database itself enforce that each signed-in
// account can only ever read/write its OWN rows. Frontend bugs
// or console tampering cannot cross accounts.
// ============================================================

// ============================================================
let _sb = null;
function sb() {
  if (!_sb) _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _sb;
}

// ============================================================
// AUTH
// ============================================================
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
    .from("app_data").select("data")
    .eq("owner", "shared").eq("key", key).maybeSingle();
  if (error) {
    console.error("loadBlob failed for " + key + ":", error.message);
    return fallback;
  }
  return (data && data.data !== null && data.data !== undefined) ? data.data : fallback;
}

async function saveBlob(key, value) {
  const { error } = await sb()
    .from("app_data")
    .upsert({ key: key, owner: "shared", data: value });
  if (error) {
    console.error("saveBlob failed for " + key + ":", error.message);
    throw error;
  }
}

// ============================================================
// PER-USER BLOB STORAGE — the user_state table (one row per
// signed-in user per page-key). RLS-enforced isolation: the
// database only ever returns/mutates rows where user_id matches
// the caller's auth.uid().
//
//   user_id  uuid   (from the auth session — set automatically)
//   key      text   (e.g. "gw2-nodes", "gw2-legendaries",
//                   "gw2-daily-history", "gw2-trackers",
//                   "savich-bos", "savich-bucket")
//   data     jsonb  (whatever JSON the page saves)
//
// Used by pages whose data belongs to ONE account: nodes,
// legendaries, dailies, event timer settings, trackers,
// Book of Shadows, bucket list, etc.
// ============================================================
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

// Lightweight poll: returns the row's updated_at epoch ms (0 if
// no row). Lets pages detect newer data pushed from another
// device WITHOUT transferring the payload each time.
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

// ============================================================
// USER SYNC CONTROLLER — a reusable per-page sync engine.
// Wrap your page's state in it once; it handles debounced pushes,
// background polls (every 60s + on tab focus), and offline flags.
//
//   const sync = createUserSync({
//     key: "gw2-nodes",
//     loadLocal:  () => Store.get("gw2-nodes:" + uid),
//     saveLocal: (s) => Store.set("gw2-nodes:" + uid, s),
//     onRemote:  (s) => { state = s; render(); },   // newer cloud data arrived
//     setOnline: (ok) => setSync(ok)                // status label hook
//   });
//
// Page lifecycle:
//   await sync.init();     // auth check + merge + initial render hook
//   sync.save();            // after ANY local change (debounced push)
//   sync.save(true);        // push immediately (imports, restores)
//
// Merge strategy: cloud-vs-local is decided per top-level state
// section using state.updatedAt[field] timestamps (epoch ms),
// so a stale device can never clobber newer edits from another
// device. Empty section only adopts the non-empty side.
// ============================================================
function createUserSync(opts) {
  // ---- required opts ----
  const key = opts.key;                       // user_state row key
  const loadLocal = opts.loadLocal;           // () -> cached object|null
  const saveLocal = opts.saveLocal;           // (obj) -> void
  const getState = opts.getState;             // () -> current state object
  const setState = opts.setState;             // (obj) -> void
  // ---- optional opts ----
  const onRender = opts.onRender || function () {};   // repaint after pull
  const setOnline = opts.setOnline || function () {}; // status hook
  const sections = opts.sections || null;    // array of section names; default: all top-level keys

  let uid = null;
  let cacheKey = null;
  let stamp = 0;            // server updated_at of last seen/pushed row
  let savedAt = 0;          // savedAt inside data blob we last saw/pushed
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
      else out[f] = rt > lt ? rv : lv;
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

  // ---- background poll: pull if another device pushed newer ----
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

  // ---- lifecycle API ----
  return {
    get uid() { return uid; },
    async init() {
      const session = await requireAuth();   // bounces to login if needed
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
        return true; // offline mode: local data still usable
      }

      if (remoteState) {
        setState(merge(local || {}, remoteState));
      } else {
        // first run for this user: adopt local (migration), stamp sections
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

// ============================================================
// TABLE HELPERS — for the row-per-item tables
// (inventory_items, recipes, vault_history, daily_log)
// ============================================================
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
  // bulk insert — handy for importing a year of dailies or a pile of inventory
  const { data, error } = await sb().from(table).insert(objs).select();
  if (error) throw error;
  return data || [];
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

// ============================================================
// TOAST-STYLE ERROR REPORTING (optional convenience)
// Logs sync failures loudly so data loss is never silent.
// ============================================================
window.addEventListener("unhandledrejection", e => {
  if (e.reason && e.reason.message) console.error("Unhandled sync failure:", e.reason.message);
});
