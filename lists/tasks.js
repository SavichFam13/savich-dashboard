function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;")
    .replace(/"/g, "&quot;");
}
function todayStr(d) {
  const dt = d || new Date();
  return dt.getFullYear() + "-" +
    String(dt.getMonth() + 1).padStart(2, "0") + "-" +
    String(dt.getDate()).padStart(2, "0");
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return todayStr(dt);
}
function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDateLong(dateStr) {
  const dt = parseDateStr(dateStr);
  return dt.toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}
function fmtTime(hhmm) {
  if (!hhmm) return null;
  let [h, m] = hhmm.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
function timeBucket(hhmm) {
  if (!hhmm) return "Anytime";
  const h = Number(hhmm.split(":")[0]);
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  if (h < 21) return "Evening";
  return "Night";
}
function flash(msg) {
  const el = document.getElementById("flash-msg");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1800);
}
function lastWeekdayOfMonth(y, m, weekday) {
  const last = new Date(y, m, 0);
  const back = (last.getDay() - weekday + 7) % 7;
  last.setDate(last.getDate() - back);
  return todayStr(last);
}
function nthWeekdayOfMonth(y, m, weekday, nth) {
  const first = new Date(y, m - 1, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (nth - 1) * 7;
  const probe = new Date(y, m - 1, day);
  if (probe.getMonth() !== m - 1) return null;
  return todayStr(probe);
}
function rollingDueDate(task) {
  const n = task.repeat_every || 3;
  let last = null;
  for (const o of occCache) {
    if (o.task_id !== task.id) continue;
    if (o.status !== "done" && o.status !== "skipped") continue;
    if (!last || o.orig_date > last) last = o.orig_date;
  }
  return last ? addDaysStr(last, n) : task.start_date;
}
function ruleFiresOn(task, dateStr) {
  const start = task.start_date;
  if (dateStr < start) return false;
  if (task.repeat_until && dateStr > task.repeat_until) return false;
  const wd = parseDateStr(dateStr).getDay();
  switch (task.repeat_type) {
    case "none":
      return dateStr === start;
    case "daily":
      return true;
    case "weekdays":
      return wd >= 1 && wd <= 5;
    case "weekly":
      return Array.isArray(task.repeat_days) && task.repeat_days.includes(wd);
    case "biweekly": {
      if (!Array.isArray(task.repeat_days) || !task.repeat_days.includes(wd))
        return false;
      const every = task.repeat_every || 2;
      const a = parseDateStr(start);
      const b = parseDateStr(dateStr);
      const weekOf = dt => {
        const d = new Date(dt);
        d.setDate(d.getDate() - d.getDay());
        return Math.round((d - new Date(d.getFullYear(), 0, 1)) / 604800000);
      };
      return weekOf(a) % every === weekOf(b) % every;
    }
    case "monthly": {
      const md = task.repeat_mday || Number(start.split("-")[2]);
      const [y, m] = dateStr.split("-").map(Number);
      const dayNum = Number(dateStr.split("-")[2]);
      if (md === 99) {
        if (dayNum !== new Date(y, m, 0).getDate()) return false;
      } else {
        if (dayNum !== md) return false;
      }
      const every = task.repeat_every || 1;
      const [sy, sm] = start.split("-").map(Number);
      const mdiff = (y * 12 + (m - 1)) - (sy * 12 + (sm - 1));
      return mdiff >= 0 && mdiff % every === 0;
    }
    case "nthmonth": {
      if (!Array.isArray(task.repeat_days) || !task.repeat_days.includes(wd))
        return false;
      const every = task.repeat_every || 1;
      const [y, m] = dateStr.split("-").map(Number);
      const [sy, sm] = start.split("-").map(Number);
      const mdiff = (y * 12 + (m - 1)) - (sy * 12 + (sm - 1));
      if (mdiff < 0 || mdiff % every !== 0) return false;
      if ((task.repeat_nth || 1) === 5)
        return lastWeekdayOfMonth(y, m, wd) === dateStr;
      return nthWeekdayOfMonth(y, m, wd, task.repeat_nth || 1) === dateStr;
    }
    case "afterdone":
      return dateStr === rollingDueDate(task);
    default:
      return false;
  }
}
function movedHereOn(occRows, taskId, dateStr) {
  return occRows.find(o =>
    o.task_id === taskId && o.moved_to === dateStr && o.status !== "done");
}
function countRemaining(t, occRows, onDate) {
  if (!t.repeat_count) return Infinity;
  let fired = 0;
  const doneDates = {};
  for (const o of occRows) {
    if (o.task_id === t.id && (o.status === "done" || o.status === "skipped"))
      doneDates[o.orig_date] = true;
  }
  for (let d = t.start_date; d <= onDate; d = addDaysStr(d, 1)) {
    if (doneDates[d]) fired++;
    else if (ruleFiresOn(t, d) && d < onDate) fired++;
  }
  return t.repeat_count - fired;
}
function buildDayModel(tasks, lists, occRows, dateStr, today) {
  const listById = {};
  for (const l of lists) listById[l.id] = l;
  const occByTaskDate = {};
  for (const o of occRows) {
    occByTaskDate[o.task_id + "|" + o.orig_date] = o;
  }
  const out = [];
  for (const t of tasks) {
    if (t.archived) continue;
    if (t.is_note || !t.start_date) continue;
    const key = t.id + "|" + dateStr;
    const o = occByTaskDate[key];
    if (o && (o.status === "skipped")) continue;
    if (o && o.status === "done" && dateStr === today) continue;
    if (o && o.status === "done" && dateStr !== today) continue;
    if (o && o.moved_to && o.moved_to !== dateStr) continue;
    const mh = movedHereOn(occRows, t.id, dateStr);
    if (mh) {
      out.push({ task: t, list: listById[t.list_id], occ: mh,
                 time: t.due_time, date: mh.orig_date, moved: true });
      continue;
    }
    if (ruleFiresOn(t, dateStr) && countRemaining(t, occRows, dateStr) > 0) {
      out.push({ task: t, list: listById[t.list_id], occ: o || null,
                 time: t.due_time, date: dateStr, moved: false });
    }
  }
  return out;
}
function collectOverdue(tasks, occRows, today, horizonDays = 60) {
  const from = addDaysStr(today, -horizonDays);
  const listById = {};
  for (const l of listsCache) listById[l.id] = l;
  const occByTD = {};
  for (const o of occRows) occByTD[o.task_id + "|" + o.orig_date] = o;
  const overdue = [];
  for (const t of tasks) {
    if (t.archived) continue;
    if (t.is_note || !t.start_date) continue;
    if (t.repeat_count && countRemaining(t, occRows, today) <= 0) continue;
    if (t.repeat_count && countRemaining(t, occRows, today) <= 0) continue;
    if (t.repeat_type === "none") {
      if (t.start_date >= from && t.start_date < today) {
        const o = occByTD[t.id + "|" + t.start_date];
        if (!o || (!o.status && !o.moved_to) ) {
          overdue.push({ task: t, list: listById[t.list_id], occ: o || null,
                         date: t.start_date });
        }
      }
      continue;
    }
    for (let d = from; d < today; d = addDaysStr(d, 1)) {
      if (!ruleFiresOn(t, d)) continue;
      const o = occByTD[t.id + "|" + d];
      if (o) {
        if (o.moved_to && o.moved_to < today && !o.status) {
          overdue.push({ task: t, list: listById[t.list_id], occ: o,
                         date: o.moved_to });
        }
        continue;
      }
      overdue.push({ task: t, list: listById[t.list_id], occ: null, date: d });
    }
  }
  return overdue;
}
let listsCache = [];
let tasksCache = [];
let occCache = [];
let realtimeChannel = null;
async function loadAll() {
  [listsCache, tasksCache, occCache] = await Promise.all([
    listRows("task_lists", { orderBy: "sort_order" }),
    listRows("tasks", { orderBy: "created_at" }),
    listRows("task_occurrences")
  ]);
}
async function refreshOcc() {
  occCache = await listRows("task_occurrences");
}
function subscribeRealtime(onChange) {
  try {
    if (!sb().channel) return false;
    realtimeChannel = sb()
      .channel("task-system-" + Math.random().toString(36).slice(2))
      .on("postgres_changes",
          { event: "*", schema: "public", table: "task_occurrences" },
          onChange)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "tasks" }, onChange)
      .on("postgres_changes",
          { event: "*", schema: "public", table: "task_lists" }, onChange)
      .subscribe(status => {
        if (status === "SUBSCRIPTION_ERROR") {
          console.warn("realtime failed, falling back to polling");
          setInterval(onChange, 30000);
        }
      });
    return true;
  } catch (e) {
    console.warn("realtime unavailable:", e.message);
    setInterval(onChange, 30000);
    return false;
  }
}
async function markDone(taskId, dateStr) {
  const existing = occCache.find(o =>
    o.task_id === taskId && o.orig_date === dateStr);
  const uid = await currentUserId();
  if (existing) {
    await updateRow("task_occurrences", existing.id, {
      status: "done", moved_to: existing.moved_to,
      done_by: uid, updated_at: new Date().toISOString()
    });
  } else {
    await insertRow("task_occurrences", {
      task_id: taskId, orig_date: dateStr, status: "done", done_by: uid
    });
  }
  await refreshOcc();
  flash("done — shift-click to undo");
}
async function markSkipped(taskId, dateStr) {
  const existing = occCache.find(o =>
    o.task_id === taskId && o.orig_date === dateStr);
  if (existing) {
    await updateRow("task_occurrences", existing.id, {
      status: "skipped", updated_at: new Date().toISOString()
    });
  } else {
    await insertRow("task_occurrences", {
      task_id: taskId, orig_date: dateStr, status: "skipped"
    });
  }
  const t = tasksCache.find(x => x.id === taskId);
  if (t && t.repeat_type === "none" && !t.archived) {
    await updateRow("tasks", t.id, { archived: true });
    flash("won't do — one-time task filed under Done · skipped today");
  } else {
    flash("won't do — instance only, future repeats unchanged");
  }
  await refreshOcc();
  await loadAll();
}
async function moveTask(taskId, fromDate, toDate) {
  const existing = occCache.find(o =>
    o.task_id === taskId && o.orig_date === fromDate);
  if (existing) {
    await updateRow("task_occurrences", existing.id, {
      moved_to: toDate, status: null,
      updated_at: new Date().toISOString()
    });
  } else {
    await insertRow("task_occurrences", {
      task_id: taskId, orig_date: fromDate, moved_to: toDate
    });
  }
  await refreshOcc();
  flash("moved to " + fmtDateLong(toDate));
}
async function undoOverride(taskId, dateStr) {
  const existing = occCache.find(o =>
    o.task_id === taskId && o.orig_date === dateStr);
  if (existing) await deleteRow("task_occurrences", existing.id);
  const t = tasksCache.find(x => x.id === taskId);
  if (t && t.archived) {
    await updateRow("tasks", t.id, { archived: false });
  }
  await refreshOcc();
  await loadAll();
  flash("undone — back on schedule");
}
function closeMenus() {
  document.querySelectorAll(".item-menu").forEach(m => m.remove());
}
let detailPopupEl = null;
function closeDetailPopup() {
  if (detailPopupEl) { detailPopupEl.remove(); detailPopupEl = null; }
}
function openDetailPopup(ev, t) {
  closeMenus(); closeDetailPopup();
  const el = document.createElement("div");
  el.className = "item-menu note-popup";
  el.innerHTML =
    '<button class="menu-x">✕</button>' +
    '<div class="np-title">' + esc(t.title) + "</div>" +
    '<div class="np-body">' + esc(t.notes || "no notes on this one") + "</div>" +
    '<button data-act="edit">✎ edit series</button>';
  document.body.appendChild(el);
  detailPopupEl = el;
  el.style.left = Math.min(ev.clientX, window.innerWidth - el.offsetWidth - 12) + "px";
  el.style.top = Math.min(ev.clientY, window.innerHeight - el.offsetHeight - 12) + "px";
  el.querySelector(".menu-x").onclick = closeDetailPopup;
  el.querySelector('[data-act="edit"]').onclick = () => { closeDetailPopup(); openEditor(t); };
  setTimeout(() => document.addEventListener("mousedown", function onDoc(mev) {
    if (detailPopupEl && !detailPopupEl.contains(mev.target)) closeDetailPopup();
    document.removeEventListener("mousedown", onDoc);
  }), 0);
  setTimeout(() => document.addEventListener("keydown", function onEsc(kev) {
    if (kev.key === "Escape") closeDetailPopup();
    document.removeEventListener("keydown", onEsc);
  }), 0);
}
function openTaskMenu(e, item, rerender) {
  e.preventDefault();
  closeMenus();
  const t = item.task;
  const orig = item.occ ? item.occ.orig_date : item.date;
  const menu = document.createElement("div");
  menu.className = "item-menu";
  menu.innerHTML =
    '<button class="menu-x">✕</button>' +
    '<button data-act="done">✓ mark done</button>' +
    '<button data-act="skip">✗ won\'t do (instance only)</button>' +
    '<button data-act="tomorrow">→ move to tomorrow</button>' +
    '<button data-act="moveto">📅 move to date…</button>' +
    '<button data-act="edit">✎ edit series</button>' +
    '<button data-act="delete" class="danger">🗑 delete entire series</button>' +
    '<button data-act="undo" class="danger">↺ undo override</button>';
  document.body.appendChild(menu);
  const rect = { x: e.clientX, y: e.clientY };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(rect.x, window.innerWidth - mw - 12) + "px";
  menu.style.top = Math.min(rect.y, window.innerHeight - mh - 12) + "px";
  menu.querySelector(".menu-x").onclick = closeMenus;
  menu.addEventListener("click", async ev => {
    const act = ev.target.getAttribute("data-act");
    if (!act) return;
    closeMenus();
    if (act === "done") { await markDone(t.id, orig); rerender(); }
    if (act === "skip") { await markSkipped(t.id, orig); rerender(); }
    if (act === "tomorrow") {
      await moveTask(t.id, orig, addDaysStr(orig, 1)); rerender();
    }
    if (act === "moveto") {
      openMiniDate(e, async dateStr => {
        if (dateStr) { await moveTask(t.id, orig, dateStr); rerender(); }
      });
    }
    if (act === "edit") { openEditor(t); }
    if (act === "delete") {
      const okDel = await confirmBox("Delete this task series?",
        "\"" + t.title + "\" will be removed — every occurrence, past overrides included. This cannot be undone.");
      if (okDel) {
        try { await deleteRow("tasks", t.id); }
        catch (err) { flash("delete failed: " + err.message); return; }
        await loadAll();
        rerender();
        flash("series deleted");
      }
      return;
    }
    if (act === "undo") { await undoOverride(t.id, orig); rerender(); }
  });
  setTimeout(() => document.addEventListener("keydown", function onEsc(ev) {
    if (ev.key === "Escape") { closeMenus(); openMiniCancel(); }
    document.removeEventListener("keydown", onEsc);
  }), 0);
  setTimeout(() => document.addEventListener("click", function onDoc(ev) {
    if (!menu.contains(ev.target)) { closeMenus(); openMiniCancel(); }
    document.removeEventListener("click", onDoc);
  }), 0);
}
let miniDateEl = null;
function openMiniCancel() { if (miniDateEl) { miniDateEl.remove(); miniDateEl = null; } }
let mdayCalEl = null;
let mdayCalY = 0, mdayCalM = 0;
function closeMdayCal() { if (mdayCalEl) { mdayCalEl.remove(); mdayCalEl = null; } }
function drawMdayCal() {
  const inp = document.getElementById("ed-mday");
  const el = mdayCalEl;
  const first = new Date(mdayCalY, mdayCalM - 1, 1);
  const days = new Date(mdayCalY, mdayCalM, 0).getDate();
  let cells = "";
  for (const n of ["Su","Mo","Tu","We","Th","Fr","Sa"])
    cells += '<div class="mc-dow">' + n + "</div>";
  for (let i = 0; i < first.getDay(); i++) cells += "<div></div>";
  for (let d = 1; d <= days; d++) {
    cells += '<button type="button" class="mc-day' +
      (Number(inp.value) === d ? " sel" : "") + '" data-d="' + d + '">' + d + "</button>";
  }
  el.innerHTML =
    '<button class="menu-x">✕</button>' +
    '<div class="mc-nav">' +
      '<button type="button" id="mc-prev">‹</button>' +
      '<span class="mc-title">' +
        first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) +
      '</span>' +
      '<button type="button" id="mc-next">›</button>' +
    '</div>' +
        '<div class="mc-grid">' + cells + "</div>" +
    '<button type="button" class="mc-last">last day of month</button>';
  el.querySelector(".menu-x").onclick = closeMdayCal;
  el.querySelector("#mc-prev").onclick = () => {
    mdayCalM--; if (mdayCalM < 1) { mdayCalM = 12; mdayCalY--; } drawMdayCal();
  };
  el.querySelector("#mc-next").onclick = () => {
    mdayCalM++; if (mdayCalM > 12) { mdayCalM = 1; mdayCalY++; } drawMdayCal();
  };
  el.querySelectorAll(".mc-day").forEach(b => {
    b.onclick = () => { inp.value = b.getAttribute("data-d"); closeMdayCal(); };
  });
    el.querySelector(".mc-last").onclick = () => {
    inp.value = "99"; closeMdayCal();
  };
}
function openDateCal() {
  closeMenus(); openMiniCancel(); closeMdayCal();
  const inp = document.getElementById("ed-date");
  const el = document.createElement("div");
  el.className = "item-menu mday-cal date-cal";
  document.body.appendChild(el);
  let y, m;
  const cur = inp.value ? inp.value.split("-").map(Number) : todayStr().split("-").map(Number);
  y = cur[0]; m = cur[1];
  function draw() {
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    let cells = "";
    for (const n of ["Su","Mo","Tu","We","Th","Fr","Sa"])
      cells += '<div class="mc-dow">' + n + "</div>";
    for (let i = 0; i < first.getDay(); i++) cells += "<div></div>";
    for (let d = 1; d <= days; d++) {
      const iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      cells += '<button type="button" class="mc-day' + (inp.value === iso ? " sel" : "") +
        '" data-iso="' + iso + '">' + d + "</button>";
    }
    el.innerHTML =
      '<button class="menu-x">✕</button>' +
      '<div class="mc-nav">' +
        '<button type="button" class="dc-prev">‹</button>' +
        '<span class="mc-title">' +
          first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) +
        '</span>' +
        '<button type="button" class="dc-next">›</button>' +
      '</div>' +
      '<div class="mc-grid">' + cells + "</div>" +
      '<button type="button" class="dc-today">today</button>';
    el.querySelector(".menu-x").onclick = () => { el.remove(); };
    el.querySelector(".dc-prev").onclick = () => { m--; if (m < 1) { m = 12; y--; } draw(); };
    el.querySelector(".dc-next").onclick = () => { m++; if (m > 12) { m = 1; y++; } draw(); };
    el.querySelector(".dc-today").onclick = () => { inp.value = todayStr(); el.remove(); };
    el.querySelectorAll(".mc-day").forEach(b => {
      b.onclick = () => { inp.value = b.getAttribute("data-iso"); el.remove(); };
    });
  }
  draw();
  const r = inp.getBoundingClientRect();
  el.style.left = Math.min(r.left, window.innerWidth - 290) + "px";
  el.style.top = Math.min(r.bottom + 6, window.innerHeight - 340) + "px";
  setTimeout(() => document.addEventListener("mousedown", function onDoc(ev) {
    if (!el.isConnected || (!el.contains(ev.target) &&
        ev.target !== document.getElementById("ed-date-cal"))) { el.remove(); }
    document.removeEventListener("mousedown", onDoc);
  }), 0);
}
  function wireDateCalRedirect() {
  const inp = document.getElementById("ed-date");
  if (!inp) return;
  inp.addEventListener("mousedown", ev => {
    if (ev.offsetX > inp.clientWidth - 30) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      openDateCal();
    }
  }, true);
}
  function openMdayCal() {
  closeMenus(); openMiniCancel(); closeMdayCal();
  const inp = document.getElementById("ed-mday");
  const base = (document.getElementById("ed-date").value || todayStr()).split("-");
  mdayCalY = Number(base[0]); mdayCalM = Number(base[1]);
  const el = document.createElement("div");
  el.className = "item-menu mday-cal";
  document.body.appendChild(el);
  mdayCalEl = el;
  const r = inp.getBoundingClientRect();
  el.style.left = Math.min(r.left, window.innerWidth - 290) + "px";
  el.style.top = Math.min(r.bottom + 6, window.innerHeight - 340) + "px";
  drawMdayCal();
  setTimeout(() => document.addEventListener("mousedown", function onDoc(ev) {
    if (mdayCalEl && !mdayCalEl.contains(ev.target) && ev.target !== inp) closeMdayCal();
    if (!mdayCalEl) document.removeEventListener("mousedown", onDoc);
  }), 0);
}
function openMiniDate(anchorEvent, cb) {
  closeMenus(); openMiniCancel(); closeDateCal(); closeMdayCal();
  const el = document.createElement("div");
  el.className = "item-menu mday-cal";
  document.body.appendChild(el);
  miniDateEl = el;
  const t0 = todayStr().split("-").map(Number);
  let y = t0[0], m = t0[1];
  function draw() {
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    let cells = "";
    for (const n of ["Su","Mo","Tu","We","Th","Fr","Sa"])
      cells += '<div class="mc-dow">' + n + "</div>";
    for (let i = 0; i < first.getDay(); i++) cells += "<div></div>";
    for (let d = 1; d <= days; d++) {
      const iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      cells += '<button type="button" class="mc-day" data-iso="' + iso + '">' + d + "</button>";
    }
    el.innerHTML =
      '<button class="menu-x">✕</button>' +
      '<div class="mc-nav">' +
        '<button type="button" class="dc-prev">‹</button>' +
        '<span class="mc-title">MOVE TO</span>' +
        '<button type="button" class="dc-next">›</button>' +
      '</div>' +
      '<div style="text-align:center;font-size:0.78rem;margin:0 0 6px;color:var(--dim)">' +
        first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) +
      '</div>' +
      '<div class="mc-grid">' + cells + "</div>" +
      '<button type="button" class="dc-today">today</button>';
    el.querySelector(".menu-x").onclick = openMiniCancel;
    el.querySelector(".dc-prev").onclick = () => { m--; if (m < 1) { m = 12; y--; } draw(); };
    el.querySelector(".dc-next").onclick = () => { m++; if (m > 12) { m = 1; y++; } draw(); };
    el.querySelector(".dc-today").onclick = () => { openMiniCancel(); cb(todayStr()); };
    el.querySelectorAll(".mc-day").forEach(b => {
      b.onclick = () => { const iso = b.getAttribute("data-iso"); openMiniCancel(); cb(iso); };
    });
  }
  draw();
  el.style.left = Math.min(anchorEvent.clientX, window.innerWidth - 290) + "px";
  el.style.top = Math.min(anchorEvent.clientY, window.innerHeight - 400) + "px";
  setTimeout(() => document.addEventListener("mousedown", function onDoc(ev) {
    if (miniDateEl && !miniDateEl.contains(ev.target)) openMiniCancel();
    if (!miniDateEl) document.removeEventListener("mousedown", onDoc);
  }), 0);
}
let editingTask = null;
let selectedDows = [];
function openEditor(task) {
  editingTask = task || null;
  const p = document.getElementById("editor-panel");
  const t = task || {};
  const rt = (t.repeat_type === "monthly" && Number(t.repeat_every) === 12)
    ? "yearly" : (t.repeat_type || "none");
  document.getElementById("ed-heading").textContent =
    task ? "Edit Task Series" : "New Task";
  document.getElementById("ed-title").value = t.title || "";
  document.getElementById("ed-notes").value = t.notes || "";
  document.getElementById("ed-list").value = t.list_id || edDefaultListId();
  document.getElementById("ed-date").value = t.start_date || "";
  document.getElementById("ed-section").value = t.section || "";
  document.getElementById("ed-note").checked = !!t.is_note;
  const dl = document.getElementById("ed-section-list");
  dl.innerHTML = "";
  const secs = new Set();
  const lid = t.list_id || edDefaultListId();
  for (const x of tasksCache)
    if (x.list_id === lid && x.section) secs.add(x.section);
  for (const s of [...secs].sort()) {
    const o = document.createElement("option");
    o.value = s; dl.appendChild(o);
  }
  document.getElementById("ed-time").value = t.due_time ? t.due_time.slice(0, 5) : "";
  document.getElementById("ed-repeat").value = rt;
  document.getElementById("ed-dow-row").style.display =
    (rt === "weekly" || rt === "biweekly" || rt === "nthmonth") ? "flex" : "none";
  document.getElementById("ed-mday").value =
    t.repeat_mday || Number((t.start_date || todayStr()).split("-")[2]);
  document.getElementById("ed-mday").dataset.own = t.repeat_mday || "";
  document.getElementById("ed-mday-row").style.display =
    (rt === "monthly" || rt === "yearly") ? "block" : "none";
  document.getElementById("ed-every").value = t.repeat_every ||
    (rt === "yearly" ? 12 : rt === "afterdone" ? 3 : rt === "biweekly" ? 2 :
     rt === "monthly" ? 1 : 6);
  document.getElementById("ed-every").dataset.own = t.repeat_every || "";
  document.getElementById("ed-every").dataset.rt0 = rt;
  document.getElementById("ed-every-row").style.display =
    (rt !== "yearly" &&
     (rt === "nthmonth" || rt === "biweekly" || rt === "afterdone" || rt === "monthly")) ? "block" : "none";
  document.getElementById("ed-every-label").textContent =
    (rt === "nthmonth" || rt === "monthly") ? "Every … months" :
    rt === "biweekly" ? "Every … weeks" :
    rt === "afterdone" ? "Every … days after completion" : "Every …";
  document.getElementById("ed-nth-row").style.display =
    (rt === "nthmonth") ? "block" : "none";
  document.getElementById("ed-count").value = t.repeat_count || "";
  document.getElementById("ed-until").value = t.repeat_until || "";
  document.getElementById("ed-ends-row").style.display =
    (rt === "none") ? "none" : "block";
  selectedDows = Array.isArray(t.repeat_days) ? t.repeat_days.slice() : [];
  renderDows();
  p.classList.add("open");
  document.getElementById("ed-title").focus();
}
function edDefaultListId() {
  if (window.EDITOR_DEFAULT_LIST) {
    const pref = listsCache.find(l => l.id === window.EDITOR_DEFAULT_LIST);
    if (pref) return pref.id;
  }
  return listsCache.length ? listsCache[0].id : "";
}
function closeEditor() {
  document.getElementById("editor-panel").classList.remove("open");
}
function renderDows() {
  const row = document.getElementById("ed-dow-row");
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  row.innerHTML = names.map((n, i) =>
    '<button type="button" class="dow-btn' +
    (selectedDows.includes(i) ? " sel" : "") + '" data-dow="' + i + '">' +
    n + "</button>").join("");
  row.querySelectorAll(".dow-btn").forEach(b => {
    b.onclick = () => {
      const i = Number(b.getAttribute("data-dow"));
      if (selectedDows.includes(i))
        selectedDows = selectedDows.filter(x => x !== i);
      else selectedDows.push(i);
      renderDows();
    };
  });
}
async function saveEditor() {
  const title = document.getElementById("ed-title").value.trim();
  if (!title) { flash("give the task a name first"); return; }
  let repeat = document.getElementById("ed-repeat").value;
  const isYearly = repeat === "yearly";
  if (isYearly) repeat = "monthly";
  const needsDow = repeat === "weekly" || repeat === "biweekly" || repeat === "nthmonth";
  const needsEvery = repeat === "nthmonth" || repeat === "biweekly" ||
    repeat === "afterdone" || repeat === "monthly";
  const isNote = document.getElementById("ed-note").checked;
  const dateVal = document.getElementById("ed-date").value;
  if (!isNote && repeat !== "none" && !dateVal) {
    flash("repeating tasks need a start date"); return;
  }
  const payload = {
    title: title,
    notes: document.getElementById("ed-notes").value.trim() || null,
    list_id: document.getElementById("ed-list").value,
    start_date: (isNote || repeat === "none") ? (dateVal || null) : (dateVal || todayStr()),
    is_note: isNote,
    section: document.getElementById("ed-section").value.trim() || null,
    due_time: document.getElementById("ed-time").value || null,
    repeat_type: repeat,
    repeat_days: needsDow ? selectedDows.slice().sort() : null,
    repeat_mday:
      repeat === "monthly"
        ? Number(document.getElementById("ed-mday").value) || 1
        : null,
    repeat_every: isYearly ? 12 : (needsEvery
      ? Number(document.getElementById("ed-every").value) || 1
      : null),
    repeat_nth: repeat === "nthmonth"
      ? Number(document.getElementById("ed-nth").value) || 1
      : null,
    repeat_count:
      (repeat !== "none" && document.getElementById("ed-count").value)
        ? Number(document.getElementById("ed-count").value)
        : null,
    repeat_until:
      (repeat !== "none" && document.getElementById("ed-until").value)
        ? document.getElementById("ed-until").value
        : null
  };
  if (!isNote && needsDow && !payload.repeat_days.length) {
    flash("pick at least one day of the week"); return;
  }
  try {
    if (editingTask) {
      await updateRow("tasks", editingTask.id, payload);
      flash("task updated");
    } else {
      await insertRow("tasks", payload);
      flash("task added");
    }
  } catch (err) {
    flash("save failed: " + err.message);
    return;
  }
  closeEditor();
  await loadAll();
  window.__rerender && window.__rerender();
}
async function deleteSeries() {
  if (!editingTask) return;
  const okDel = await confirmBox("Delete this task series?",
    "\"" + editingTask.title + "\" will be removed — every occurrence, past overrides included. This cannot be undone.");
  if (!okDel) return;
  try {
    await deleteRow("tasks", editingTask.id);
  } catch (err) {
    flash("delete failed: " + err.message);
    return;
  }
  closeEditor();
  await loadAll();
  window.__rerender && window.__rerender();
  flash("series deleted");
}
function initEditorUI() {
    wireDateCalRedirect();
  document.getElementById("ed-save").onclick = saveEditor;
  document.getElementById("ed-close").onclick = closeEditor;
  const del = document.getElementById("ed-delete");
  if (del) del.onclick = deleteSeries;
  document.getElementById("ed-repeat").addEventListener("change", function () {
    const v = this.value;
    document.getElementById("ed-dow-row").style.display =
      (v === "weekly" || v === "biweekly" || v === "nthmonth") ? "flex" : "none";
    document.getElementById("ed-mday-row").style.display =
      (v === "monthly" || v === "yearly") ? "block" : "none";
    const evEl = document.getElementById("ed-every");
    const mdEl = document.getElementById("ed-mday");
    const rt0 = evEl.dataset.rt0 || "none";
    if (v === rt0) {
      evEl.value = evEl.dataset.own ||
        (v === "yearly" ? 12 : v === "afterdone" ? 3 : v === "biweekly" ? 2 :
         v === "monthly" ? 1 : 6);
      if (v === "monthly" || v === "yearly")
        mdEl.value = mdEl.dataset.own ||
          Number((document.getElementById("ed-date").value || todayStr()).split("-")[2]);
    } else {
      evEl.value = v === "yearly" ? 12 : v === "monthly" ? 1 :
        v === "biweekly" ? 2 : v === "afterdone" ? 3 :
        v === "nthmonth" ? 6 : evEl.value;
      if (v === "monthly" || v === "yearly")
        mdEl.value = Number((document.getElementById("ed-date").value || todayStr()).split("-")[2]);
    }
    document.getElementById("ed-every-row").style.display =
      (v !== "yearly" &&
       (v === "nthmonth" || v === "biweekly" || v === "afterdone" || v === "monthly")) ? "block" : "none";
    document.getElementById("ed-every-label").textContent =
      (v === "nthmonth" || v === "monthly") ? "Every … months" :
      v === "biweekly" ? "Every … weeks" :
      v === "afterdone" ? "Every … days after completion" : "Every …";
    document.getElementById("ed-nth-row").style.display =
      (v === "nthmonth") ? "block" : "none";
    document.getElementById("ed-ends-row").style.display =
      (v === "none") ? "none" : "block";
  });
    for (const fid of ["ed-date", "ed-until"]) {
    const fi = document.getElementById(fid);
    if (!fi) continue;
    fi.addEventListener("click", () => openDateCalFor(fid));
    fi.addEventListener("keydown", () => closeDateCal());
    fi.addEventListener("blur", () => { normDateField(fi); });
  }
  const md = document.getElementById("ed-mday");

  if (md) md.addEventListener("click", openMdayCal);
}
function renderDay({ filterFn, rerender, containerId = "task-area" }) {
  const area = document.getElementById(containerId);
  if (!area) return;
  const viewDate = window.VIEW_DATE || todayStr();
  const today = todayStr();

  let dayItems = buildDayModel(tasksCache, listsCache, occCache, viewDate, today);
  dayItems = dayItems.filter(it => filterFn(it.list));
  dayItems.sort((a, b) => {
    if (!a.time && b.time) return -1;
    if (a.time && !b.time) return 1;
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    return a.task.title.localeCompare(b.task.title);
  });
  let over = collectOverdue(tasksCache, occCache, today);
  over = over.filter(it => filterFn(it.list));
  over.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
  const buckets = ["Anytime", "Morning", "Afternoon", "Evening", "Night"];
  const grouped = {};
  for (const b of buckets) grouped[b] = [];
  for (const it of dayItems) grouped[timeBucket(it.time)].push(it);
  let html = "";
  const overdueCount = over.length;

  if (overdueCount) {
    html += '<div class="sec-head overdue-label">Overdue · ' + overdueCount + "</div>";
    for (const it of over) html += taskRowHTML(it, true, rerender);
  }
  for (const b of buckets) {
    if (!grouped[b].length) continue;
    html += '<div class="sec-head">' + b + ' <span class="sec-count">· ' +
      grouped[b].length + "</span></div>";
    for (const it of grouped[b]) html += taskRowHTML(it, false, rerender);
  }
  if (!overdueCount && !dayItems.length) {
    html = '<div class="empty-note">Nothing scheduled for this day. ' +
      'Add a task with the button above.</div>';
  }
  area.innerHTML = html;
  wireRows(area, rerender, viewDate);
}
function taskRowHTML(it, isOverdue, rerender) {
  const t = it.task;
  const li = it.list || { name: "?", color: "c9a0ff" };
  const movedTag = it.moved
    ? ' <span style="color:var(--accent);font-size:0.7rem">(moved)</span>' : "";
  const odAttr = isOverdue ? " overdue" : "";
  const when = isOverdue ? fmtDateLong(it.date).split(",")[0] + " " +
    it.date.slice(5) : (fmtTime(it.time) || "anytime");
  return '<div class="task-row' + odAttr + '" data-task="' + t.id +
    '" data-date="' + (it.occ ? it.occ.orig_date : it.date) + '">' +
    '<span class="cb" title="click = done"></span>' +
    '<span class="t-time' + (it.time ? "" : " none") + '">' + when + "</span>" +
    '<span class="t-title" title="click to edit the series">' +
    esc(t.title) + movedTag + "</span>" +
    '<span class="t-icon">' + esc(li.icon || "") + "</span>" +
    '<span class="t-list">' + esc(li.name) + "</span>" +
    "</div>";
}
function wireRows(area, rerender, viewDate) {
  area.querySelectorAll(".task-row").forEach(row => {
    const taskId = row.getAttribute("data-task");
    const dateStr = row.getAttribute("data-date");
    const t = tasksCache.find(x => x.id === taskId);
    if (!t) return;
    row.addEventListener("click", async ev => {
      if (ev.target.classList.contains("cb")) {
        await markDone(taskId, dateStr); rerender();
      } else if (ev.target.classList.contains("t-title")) {
        openDetailPopup(ev, t);
      }
    });
    row.oncontextmenu = ev =>
      openTaskMenu(ev,
        { task: t,
          occ: occCache.find(o => o.task_id === taskId && o.orig_date === dateStr),
          date: dateStr, time: t.due_time },
        rerender);
  });
}
async function initTaskPage({ pageTitle, filterFn, rerender }) {
  initEditorUI();
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") closeEditor();
  });
  const session = await requireAuth();
  if (!session) return;
  window.__rerender = rerender;
  document.getElementById("sync-note").textContent = "connecting…";
  try {
    await loadAll();
  } catch (err) {
    document.getElementById("sync-note").textContent = "offline — changes NOT saved";
    document.getElementById("sync-note").classList.add("off");
    console.error("initial load failed:", err.message);
    rerender();
    return;
  }
  document.getElementById("sync-note").textContent = "✓";
  rerender();
  subscribeRealtime(async () => {
    await loadAll();
    rerender();
  });
  window.addEventListener("focus", async () => {
    await loadAll();
    rerender();
  });
}
function confirmBox(title, body) {
  return new Promise(res => {
    const ov = document.createElement("div");
    ov.className = "cbox-overlay";
    ov.innerHTML =
      '<div class="cbox">' +
      '<div class="cbox-title">' + esc(title) + "</div>" +
      '<div class="cbox-body">' + esc(body) + "</div>" +
      '<div class="cbox-btns">' +
      '<button type="button" class="cbox-no">NO</button>' +
      '<button type="button" class="cbox-yes">YES, DELETE</button>' +
      "</div></div>";
    document.body.appendChild(ov);
    const done = v => {
      ov.remove();
      document.removeEventListener("keydown", onKey);
      res(v);
    };
    const onKey = k => { if (k.key === "Escape") done(false); };
    ov.querySelector(".cbox-no").onclick = () => done(false);
    ov.querySelector(".cbox-yes").onclick = () => done(true);
    ov.onclick = ev => { if (ev.target === ov) done(false); };
    document.addEventListener("keydown", onKey);
  });
}
let dateCalEl = null;
function closeDateCal() { if (dateCalEl) { dateCalEl.remove(); dateCalEl = null; } }
function openDateCalFor(inpId) {
  closeMenus(); openMiniCancel(); closeMdayCal(); closeDateCal();
  const inp = document.getElementById(inpId);
  if (!inp) return;
  const el = document.createElement("div");
  el.className = "item-menu mday-cal date-cal";
  document.body.appendChild(el);
  dateCalEl = el;
  const v = (inp.value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const base = v ? inp.value.split("-").map(Number) : todayStr().split("-").map(Number);
  let y = base[0], m = base[1];
  function draw() {
    const first = new Date(y, m - 1, 1);
    const days = new Date(y, m, 0).getDate();
    let cells = "";
    for (const n of ["Su","Mo","Tu","We","Th","Fr","Sa"])
      cells += '<div class="mc-dow">' + n + "</div>";
    for (let i = 0; i < first.getDay(); i++) cells += "<div></div>";
    for (let d = 1; d <= days; d++) {
      const iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      cells += '<button type="button" class="mc-day' + (inp.value === iso ? " sel" : "") +
        '" data-iso="' + iso + '">' + d + "</button>";
    }
    el.innerHTML =
      '<button class="menu-x">✕</button>' +
      '<div class="mc-nav">' +
        '<button type="button" class="dc-prev">‹</button>' +
        '<span class="mc-title">' +
          first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) +
        '</span>' +
        '<button type="button" class="dc-next">›</button>' +
      '</div>' +
      '<div class="mc-grid">' + cells + "</div>" +
      '<button type="button" class="dc-today">today</button>';
    el.querySelector(".menu-x").onclick = closeDateCal;
    el.querySelector(".dc-prev").onclick = () => { m--; if (m < 1) { m = 12; y--; } draw(); };
    el.querySelector(".dc-next").onclick = () => { m++; if (m > 12) { m = 1; y++; } draw(); };
    el.querySelector(".dc-today").onclick = () => {
      inp.value = todayStr(); closeDateCal(); flash("set to today");
    };
    el.querySelectorAll(".mc-day").forEach(b => {
      b.onclick = () => { inp.value = b.getAttribute("data-iso"); closeDateCal(); };
    });
  }
  draw();
  const r = inp.getBoundingClientRect();
  el.style.left = Math.min(r.left, window.innerWidth - 290) + "px";
  el.style.top = Math.min(r.bottom + 6, window.innerHeight - 380) + "px";
  setTimeout(() => document.addEventListener("mousedown", function onDoc(ev) {
    if (dateCalEl && !dateCalEl.contains(ev.target) && ev.target !== inp) closeDateCal();
    if (!dateCalEl) document.removeEventListener("mousedown", onDoc);
  }), 0);
}
function normDateField(inp) {
  const v = (inp.value || "").trim();
  if (!v) return;
  const s = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const i = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (s) inp.value = s[3] + "-" +
    String(s[1]).padStart(2, "0") + "-" + String(s[2]).padStart(2, "0");
  else if (i) inp.value = i[1] + "-" +
    String(i[2]).padStart(2, "0") + "-" + String(i[3]).padStart(2, "0");
  else { inp.value = ""; flash("date didn't look right — cleared, use the calendar"); }
}