function nthName(n) {
  if (n === 5) return "last";
  return ["1st", "2nd", "3rd", "4th"][n - 1] || n + "th";
}
function dowsText(t) {
  if (!Array.isArray(t.repeat_days) || !t.repeat_days.length) return "?";
  return t.repeat_days.map(d => DNAMES[d]).join(", ");
}
function repeatDescr(t) {
  if (t.is_note) return "note";
  let tm = t.due_time ? " · " + fmtTime(t.due_time) : " · anytime";
  if (t.repeat_count) tm += " · " + t.repeat_count + "× total";
  if (t.repeat_until) tm += " · ends " + t.repeat_until.slice(5);
  switch (t.repeat_type) {
    case "none":     return "One-time" + tm;
    case "daily":    return "Every day" + tm;
    case "weekdays": return "Weekdays Mon–Fri" + tm;
    case "weekly": {
      const wk = t.repeat_every || 2;
      return (wk === 1 ? "Weekly on " : "Every " + wk + " weeks on ") +
             dowsText(t) + tm;
    }
    case "monthly": {
      const fb = Number((t.start_date || todayStr()).split("-")[2]);
      const md = t.repeat_mday || fb;
      const last = md === 99;
      return ((t.repeat_every || 1) === 12
        ? last ? "Yearly on the last day" : "Yearly on day " + fb
        : (t.repeat_every || 1) > 1
        ? last ? "Every " + t.repeat_every + " mo. on the last day"
               : "Every " + t.repeat_every + " mo. on day " + md
        : last ? "Monthly on the last day" : "Monthly on day " + md) + tm;
    }
    case "nthmonth": return ((t.repeat_every || 1) === 12
                      ? "Yearly on the " : "Every " + t.repeat_every + " mo. on the ") +
                      nthName(t.repeat_nth || 1) + " " + dowsText(t) + tm;
    case "afterdone":return "Every " + (t.repeat_every || 3) +
                      " days after completion" + tm;
    default:         return "";
  }
}
let LP_SEL = null;
function pageLists() {
  return listsCache.filter(l => l.page === LP_SCOPE);
}
function fillListSelectForPage() {
  const sel = document.getElementById("ed-list");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const l of pageLists()) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = l.name;
    sel.appendChild(opt);
  }
  if (prev && pageLists().some(l => l.id === prev)) sel.value = prev;
}
let notePopupEl = null;
function closeNotePopup() {
  if (notePopupEl) { notePopupEl.remove(); notePopupEl = null; }
}
function openNotePopup(ev, t) {
  closeMenus(); openMiniCancel(); closeNotePopup();
  const el = document.createElement("div");
  el.className = "item-menu note-popup";
  el.innerHTML =
    '<button class="menu-x">close ×</button>' +
    '<div class="np-title">' + esc(t.title) + "</div>" +
    '<div class="np-body">' + esc(t.notes || "no notes on this one") + "</div>" +
    '<button data-act="edit">✎ edit this note</button>';
  document.body.appendChild(el);
  notePopupEl = el;
  el.style.left = Math.min(ev.clientX, window.innerWidth - el.offsetWidth - 12) + "px";
  el.style.top = Math.min(ev.clientY, window.innerHeight - el.offsetHeight - 12) + "px";
  el.querySelector(".menu-x").onclick = closeNotePopup;
  el.querySelector('[data-act="edit"]').onclick = () => { closeNotePopup(); openEditor(t); };
  setTimeout(() => document.addEventListener("mousedown", function onDoc(mev) {
    if (notePopupEl && !notePopupEl.contains(mev.target)) closeNotePopup();
    document.removeEventListener("mousedown", onDoc);
  }), 0);
  setTimeout(() => document.addEventListener("keydown", function onEsc(kev) {
    if (kev.key === "Escape") closeNotePopup();
    document.removeEventListener("keydown", onEsc);
  }), 0);
}
function collapsedStoreKey() {
  return "lp-closed-sections-" + (LP_SEL || "none");
}
function getCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(collapsedStoreKey()) || "[]")); }
  catch (e) { return new Set(); }
}
function saveCollapsed(set) {
  try { localStorage.setItem(collapsedStoreKey(), JSON.stringify(Array.from(set))); }
  catch (e) { /*NO PEAKING */ }
}
function taskOrderKey(section) {
  return "lp-task-order-" + (LP_SEL || "none") + "::" + (section || "__loose__");
}
function getTaskOrder(section) {
  try { return JSON.parse(localStorage.getItem(taskOrderKey(section)) || "[]"); }
  catch (e) { return []; }
}
function saveTaskOrder(section, arr) {
  try { localStorage.setItem(taskOrderKey(section), JSON.stringify(arr)); }
  catch (e) { /* ignore */ }
}
function applyTaskOrder(arr, section) {
  const saved = getTaskOrder(section);
  if (!saved.length) return;
  const rank = new Map(saved.map((id, i) => [id, i]));
  arr.sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
    const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return 0;
  });
}
function nudgeTask(section, ids, taskId, dir) {
  const i = ids.indexOf(taskId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  ids.splice(j, 0, ids.splice(i, 1)[0]);
  saveTaskOrder(section, ids);
  renderListView();
}
function secOrderKey() {
  return "lp-sec-order-" + (LP_SEL || "none");
}
function getSecOrder() {
  try { return JSON.parse(localStorage.getItem(secOrderKey()) || "[]"); }
  catch (e) { return []; }
}
function saveSecOrder(arr) {
  try { localStorage.setItem(secOrderKey(), JSON.stringify(arr)); }
  catch (e) { /* ignore */ }
}
function taskDoneOcc(t) {
  if (t.repeat_type !== "none") return null;
  let best = null;
  for (const o of occCache) {
    if (o.task_id !== t.id) continue;
    if (o.status !== "done" && o.status !== "skipped") continue;
    if (!best || o.orig_date > best.orig_date) best = o;
  }
  return best;
}
function seriesEnded(t, today) {
  if (t.repeat_count && countRemaining(t, occCache, today) <= 0) return true;
  if (t.repeat_until && t.repeat_until < today) return true;
  return false;
}
function nextAppearance(t, today, movedLands) {
  if (!t.start_date) return null;
  for (let i = 0; i < 550; i++) {
    const d = addDaysStr(today, i);
    const lands = movedLands[t.id];
    if (lands && lands.includes(d)) return d;
    if (ruleFiresOn(t, d) && countRemaining(t, occCache, d) > 0) {
      const o = occCache.find(x => x.task_id === t.id && x.orig_date === d);
      if (o && (o.status === "done" || o.status === "skipped" ||
                (o.moved_to && o.moved_to !== d))) continue;
      return d;
    }
  }
  return null;
}
function renderListView() {
  const rail = document.getElementById("list-rail");
  const area = document.getElementById("task-area");
  const today = todayStr();
  const lists = pageLists();
  if (!LP_SEL || !lists.some(l => l.id === LP_SEL)) LP_SEL = lists.length ? lists[0].id : null;
  let railHtml = "";
  if (!lists.length) {
    railHtml = '<span class="empty-note">No lists visible for this page yet. ' +
      (LP_SCOPE === "personal"
        ? "Personal lists stay invisible until owner assignment SQL is run for your account."
        : "") + "</span>";
  } else {
    railHtml = lists.map(l => {
      const count = tasksCache.filter(
        t => !t.archived && !t.is_note && t.list_id === l.id).length;
      return '<button class="rail-chip' + (l.id === LP_SEL ? " sel" : "") +
        '" data-list="' + l.id + '">' +
        '<span class="t-icon">' + esc(l.icon || "") + "</span>" +
    '<span class="rail-name">' + esc(l.name) + '</span>' +
    '<span class="rail-count">' + count + "</span></button>";
    }).join("");
  }
  rail.innerHTML = railHtml;
  rail.querySelectorAll(".rail-chip[data-list]").forEach(b => {
    b.onclick = () => { LP_SEL = b.getAttribute("data-list"); renderListView(); };
  });
  fillListSelectForPage();
  window.EDITOR_DEFAULT_LIST = LP_SEL || undefined;
  if (!LP_SEL) {
    area.innerHTML = '<div class="empty-note">Nothing to show yet — add a list or a task.</div>';
    return;
  }
  let tsks = tasksCache.filter(t => !t.archived && t.list_id === LP_SEL);
  if (!tsks.length) {
    area.innerHTML = '<div class="empty-note">This list is empty — ' +
      'hit “+ add task” to create the first one.</div>';
    return;
  }
  const movedLands = {};
  for (const o of occCache) {
    if (o.moved_to && !o.status) {
      (movedLands[o.task_id] = movedLands[o.task_id] || []).push(o.moved_to);
    }
  }
  function nextSortDate(t) {
    const na = nextAppearance(t, today, movedLands);
    if (na) return na;
    if (t.repeat_type === "none") return t.start_date || null;
    return t.start_date || null;
  }
  const sorter = (a, b) => {
    const da = nextSortDate(a);
    const db = nextSortDate(b);
    if (da && db && da !== db) return da < db ? -1 : 1;
    if (da && !db) return -1;
    if (!da && db) return 1;
    const ta = a.due_time || "99";
    const tb = b.due_time || "99";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.title.localeCompare(b.title);
  };
  const notes = tsks.filter(t => t.is_note).sort(sorter);
  const real = tsks.filter(t => !t.is_note).sort(sorter);
  const groups = {};
  const order = [];
  for (const t of real) {
    const s = t.section || "";
    if (!groups[s]) { groups[s] = []; order.push(s); }
    groups[s].push(t);
  }
  const handledToday = new Set();
  for (const o of occCache)
    if (o.orig_date === today && (o.status === "done" || o.status === "skipped"))
      handledToday.add(o.task_id);
  const finRows = [];   
  const finIds = new Set();
  for (const t of real) {
    if (handledToday.has(t.id)) continue;
    if (t.repeat_type === "none") {
      const d = taskDoneOcc(t);
      if (d) {
        finIds.add(t.id);
        if (d.orig_date === today) {
          finRows.push({ t: t, effDate: d.orig_date,
            label: (d.status === "skipped" ? "won't do · " : "done · ") + d.orig_date.slice(5) });
        }
      }
    } else if (seriesEnded(t, today)) {
      finRows.push({ t: t, effDate: today, label: "series ended" });
      finIds.add(t.id);
    }
  }
  for (const s of order)
    groups[s] = groups[s].filter(t => !handledToday.has(t.id) && !finIds.has(t.id));

  for (const s of order) applyTaskOrder(groups[s], s);
  const rowFor = (t, note, opts) => {
    opts = opts || {};
    const effDate = opts.effDate ||
      ((t.repeat_type === "none") ? (t.start_date || today) : today);
    const occEff = occCache.find(o => o.task_id === t.id && o.orig_date === effDate);
    const done = !!opts.forceDone || (occEff && occEff.status === "done");
    const na = t.start_date ? nextAppearance(t, today, movedLands) : null;
    const nf = note ? "" :
      (!t.start_date ? "unscheduled"
       : na ? "next: " + na.slice(5)
       : t.repeat_type === "none" ? "past"
       : "—");
    const meta = (opts.label != null) ? opts.label : nf;
    const mv = (!note && !handledToday.has(t.id) && opts.label == null)
      ? '<span class="row-move"><button type="button" class="row-up" title="move up">▲</button>' +
        '<button type="button" class="row-down" title="move down">▼</button></span>'
      : "";
    return '<div class="task-row' + (note ? " note" : "") + (done ? " done" : "") +
      '" data-task="' + t.id + '" data-date="' + effDate + '">' +
      '<span class="cb" title="click = done"></span>' +
      '<span class="t-title">' + esc(t.title) + "</span>" +
      '<span class="t-meta">' + esc(repeatDescr(t)) + "</span>" +
      '<span class="t-next">' + esc(meta) + "</span>" + mv +
      "</div>";
  };
  const collapsed = getCollapsed();
  const pref = getSecOrder();
  order.sort((a, b) => {
    const pa = pref.indexOf(a), pb = pref.indexOf(b);
    if (pa === -1 && pb === -1) return 0;
    if (pa === -1) return 1;
    if (pb === -1) return -1;
    return pa - pb;
  });
  let html = "";
    if (notes.length) {
    html += '<div class="sec-block' + (collapsed.has("__notes__") ? " closed" : "") +
      '" data-sec="__notes__">' +
      '<div class="sec-head" data-sec="__notes__"><span class="sec-arrow">▾</span> Notes ' +
      '<span class="sec-count">· ' + notes.length + "</span></div>";
    for (const t of notes) html += rowFor(t, true);
    html += "</div>";
  }
  for (const s of order) {
    const label = s || "No Section";
    const key = s || "__loose__";
    if (!groups[s].length) continue;
    html += '<div class="sec-block' + (collapsed.has(key) ? " closed" : "") +
      '" data-sec="' + key + '">' +
      '<div class="sec-head" data-sec="' + key + '"><span class="sec-arrow">▾</span> ' +
      esc(label) + ' <span class="sec-count">· ' + groups[s].length +
      '</span><span class="sec-move"><button type="button" class="sec-up" title="move section up">▲</button>' +
      '<button type="button" class="sec-down" title="move section down">▼</button>' +
      '<button type="button" class="sec-reset" title="reset task order to automatic (date, time, A–Z)">⟲</button></span></div>';
    for (const t of groups[s]) html += rowFor(t, false);
    html += "</div>";
  }
  const handled = [];
  const handledSeen = new Set();
  for (const o of occCache) {
    if (o.orig_date !== today || (o.status !== "done" && o.status !== "skipped")) continue;
    const t = tasksCache.find(x => x.id === o.task_id);
    if (t && !t.is_note && !handledSeen.has(t.id)) {
      handledSeen.add(t.id);
      handled.push({ t: t, effDate: o.orig_date });
    }
  }
  const doneTotal = handled.length + finRows.length;
  if (doneTotal) {
    html += '<div class="sec-block' + (collapsed.has("__donetoday__") ? " closed" : "") +
      '" data-sec="__donetoday__">' +
      '<div class="sec-head" data-sec="__donetoday__"><span class="sec-arrow">▾</span> Completed ' +
      '<span class="sec-count">· ' + doneTotal + "</span></div>";
    for (const h of handled)
      html += rowFor(h.t, false, { effDate: h.effDate });
    for (const f of finRows)
      html += rowFor(f.t, false,
        { effDate: f.effDate, label: f.label, forceDone: true });
    html += "</div>";
  }
  area.innerHTML = html;
  area.querySelectorAll(".sec-head").forEach(h => {
    h.onclick = ev => {
      if (ev.target.closest(".sec-up") || ev.target.closest(".sec-down")) return;
      const blk = h.closest(".sec-block");
      const key = h.getAttribute("data-sec");
      const nowClosed = !blk.classList.contains("closed");
      blk.classList.toggle("closed", nowClosed);
      const set = getCollapsed();
      if (nowClosed) set.add(key); else set.delete(key);
      saveCollapsed(set);
    };
    const up = h.querySelector(".sec-up");
    const dn = h.querySelector(".sec-down");
    const rs = h.querySelector(".sec-reset");
    if (up) up.onclick = ev => { ev.stopPropagation(); moveSection(h.getAttribute("data-sec"), -1); };
    if (dn) dn.onclick = ev => { ev.stopPropagation(); moveSection(h.getAttribute("data-sec"), 1); };
    if (rs) rs.onclick = ev => {
      ev.stopPropagation();
      const key = h.getAttribute("data-sec");
      localStorage.removeItem(taskOrderKey(key === "__loose__" ? "" : key));
      renderListView();
      flash("task order reset to automatic");
    };
  });
  area.querySelectorAll(".task-row").forEach(row => {
    const taskId = row.getAttribute("data-task");
    const dateStr = row.getAttribute("data-date");
    const t = tasksCache.find(x => x.id === taskId);
    if (!t) return;
    row.addEventListener("click", async ev => {
      if (ev.target.classList.contains("cb")) {
        if (row.classList.contains("done")) { await undoOverride(taskId, dateStr); renderListView(); }
        else { await markDone(taskId, dateStr); renderListView(); }
      } else if (t.is_note || ev.target.classList.contains("t-title")) {
        if (t.is_note) openNotePopup(ev, t);
        else openTaskMenu(ev, {
          task: t,
          occ: occCache.find(o => o.task_id === taskId && o.orig_date === dateStr),
          date: dateStr, time: t.due_time
        }, renderListView);
      }
    });
    const gkey = t.section || "";
    const rowIds = (groups[gkey] || []).map(x => x.id);
    const rUp = row.querySelector(".row-up");
    const rDn = row.querySelector(".row-down");
    if (rUp) rUp.onclick = ev => { ev.stopPropagation(); ev.preventDefault(); nudgeTask(gkey, rowIds, t.id, -1); };
    if (rDn) rDn.onclick = ev => { ev.stopPropagation(); ev.preventDefault(); nudgeTask(gkey, rowIds, t.id, 1); };

    row.oncontextmenu = t.is_note
      ? ev => { ev.preventDefault(); openNotePopup(ev, t); }
      : ev => {
          if (ev.target.classList.contains("t-title")) {
            ev.preventDefault();
            openDetailPopup(ev, t);
            return;
          }
          openTaskMenu(ev, {
            task: t,
            occ: occCache.find(o => o.task_id === taskId && o.orig_date === dateStr),
            date: dateStr, time: t.due_time
          }, renderListView);
        };
  });
}
async function initListPage(pageScope) {
  LP_SCOPE = pageScope;
  await initTaskPage({
    pageTitle: pageScope,
    filterFn: () => true,
    rerender: renderListView
  });
}
function moveSection(key, dir) {
  const cur = [];
  for (const h of document.querySelectorAll('.sec-head[data-sec]'))
    cur.push(h.getAttribute("data-sec"));
  const pinned = getSecOrder().filter(x => cur.includes(x));
  for (const s of cur) if (!pinned.includes(s)) pinned.push(s);
  const i = pinned.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pinned.length) return;
  pinned.splice(j, 0, pinned.splice(i, 1)[0]);
  saveSecOrder(pinned);
  renderListView();
}
