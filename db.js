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
const SUPABASE_URL  = "https://abcdefghij.supabase.co";   // e.g. https://abcxyz.supabase.co
const SUPABASE_ANON_KEY = "sb_publishable_BrHe5dx8nd4Cs40QPEq7zg_mZwOGgqc";  // the long eyJ... string

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

async function signOut() {
  await sb().auth.signOut();
  location.href = "/auth.html";
}

// ============================================================
// BLOB STORAGE — the app_data table (one row per page-key)
//   key    text primary key   (e.g. "savich-vault-config", "gw2-nodes", "savichBucket")
//   data   jsonb              (whatever JSON the page saves)
// ============================================================
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
