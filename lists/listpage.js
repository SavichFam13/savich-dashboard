const DNAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
    case "weekly":   return "Weekly on " + dowsText(t) + tm;
    case "biweekly": return "Every " + (t.repeat_every || 2) +
                      " weeks on " + dowsText(t) + tm;
    case "monthly":  return ((t.repeat_every || 1) === 12
                      ? "Yearly on day "
                      : (t.repeat_every || 1) > 1
                      ? "Every " + t.repeat_every + " mo. on day "
                      : "Monthly on day ") +
                      (t.repeat_mday || Number((t.start_date || todayStr()).split("-")[2])) + tm;
    case "nthmonth": return "Every " + (t.repeat_every || 1) + " mo. on the " +
                      nthName(t.repeat_nth || 1) + " " + dowsText(t) + tm;
    case "afterdone":return "Every " + (t.repeat_every || 3) +
                      " days after completion" + tm;
    default:         return "";
  }
}
function nextFireDate(t, fromStr, maxDays) {
  maxDays = maxDays || 550;
  for (let i = 1; i <= maxDays; i++) {
    const d = addDaysStr(fromStr, i);
    if (ruleFiresOn(t, d)) return d;
  }
  return null;
}
let LP_SCOPE = null;
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
    '<button class="menu-x">✕</button>' +
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
  catch (e) { /* private mode etc. — just don't remember it */ }
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
  railHtml += '<button class="rail-chip rail-new" id="rail-new-list">＋ new list</button>';
  rail.innerHTML = railHtml;
  rail.querySelectorAll(".rail-chip[data-list]").forEach(b => {
    b.onclick = () => { LP_SEL = b.getAttribute("data-list"); renderListView(); };
  });
  document.getElementById("rail-new-list").onclick = openNewList;
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
  const sorter = (a, b) =>
    (a.due_time || "99") < (b.due_time || "99") ? -1 :
    (a.due_time || "99") > (b.due_time || "99") ? 1 :
    a.title.localeCompare(b.title);
  const notes = tsks.filter(t => t.is_note).sort(sorter);
  const real = tsks.filter(t => !t.is_note).sort(sorter);
  const groups = {};
  const order = [];
  for (const t of real) {
    const s = t.section || "";
    if (!groups[s]) { groups[s] = []; order.push(s); }
    groups[s].push(t);
  }
  const rowFor = (t, note) => {
    const occToday = occCache.find(o => o.task_id === t.id && o.orig_date === today);
    const doneToday = occToday && occToday.status === "done";
    const nf = note ? "" : (t.start_date
      ? (t.repeat_type === "none"
        ? (t.start_date < today ? "past" : "next: " + t.start_date.slice(5))
        : "next: " + (nextFireDate(t, today) || "—").slice(5))
      : "unscheduled");
    return '<div class="task-row' + (note ? " note" : "") + (doneToday ? " done" : "") +
      '" data-task="' + t.id + '" data-date="' + today + '">' +
      '<span class="cb" title="done today · shift-click = undo"></span>' +
      '<span class="t-title">' + esc(t.title) + "</span>" +
      '<span class="t-meta">' + esc(repeatDescr(t)) + "</span>" +
      '<span class="t-next">' + nf + "</span>" +
      "</div>";
  };
  const collapsed = getCollapsed();
  let html = "";
  for (const s of order) {
    if (!s) {                                   
      for (const t of groups[s]) html += rowFor(t, false);
      continue;
    }
    html += '<div class="sec-block' + (collapsed.has(s) ? " closed" : "") +
      '" data-sec="' + esc(s) + '">' +
      '<div class="sec-head" data-sec="' + esc(s) + '"><span class="sec-arrow">▾</span> ' +
      esc(s) + ' <span class="sec-count">· ' + groups[s].length + "</span></div>";
    for (const t of groups[s]) html += rowFor(t, false);
    html += "</div>";
  }
  if (notes.length) {
    html += '<div class="sec-block' + (collapsed.has("__notes__") ? " closed" : "") +
      '" data-sec="__notes__">' +
      '<div class="sec-head" data-sec="__notes__"><span class="sec-arrow">▾</span> Notes ' +
      '<span class="sec-count">· ' + notes.length + "</span></div>";
    for (const t of notes) html += rowFor(t, true);
    html += "</div>";
  }
  area.innerHTML = html;
  area.querySelectorAll(".sec-head").forEach(h => {
    h.onclick = () => {
      const blk = h.closest(".sec-block");
      const key = h.getAttribute("data-sec");
      const nowClosed = !blk.classList.contains("closed");
      blk.classList.toggle("closed", nowClosed);
      const set = getCollapsed();
      if (nowClosed) set.add(key); else set.delete(key);
      saveCollapsed(set);
    };
  });
  area.querySelectorAll(".task-row").forEach(row => {
    const taskId = row.getAttribute("data-task");
    const t = tasksCache.find(x => x.id === taskId);
    if (!t) return;
    row.addEventListener("click", async ev => {
      if (ev.target.classList.contains("cb")) {
        if (row.classList.contains("done")) { await undoOverride(taskId, today); renderListView(); }
        else { await markDone(taskId, today); renderListView(); }
      } else if (t.is_note || ev.target.classList.contains("t-title")) {
        openDetailPopup(ev, t);
      }
    });
    row.oncontextmenu = t.is_note
      ? ev => { ev.preventDefault(); openDetailPopup(ev, t); }
      : ev => openTaskMenu(ev, {
          task: t,
          occ: occCache.find(o => o.task_id === taskId && o.orig_date === today),
          date: today, time: t.due_time
        }, renderListView);
  });
}
let newListOverlay = null;
function closeNewList() {
  if (newListOverlay) { newListOverlay.remove(); newListOverlay = null; }
}
function openNewList() {
  closeMenus(); closeDetailPopup(); closeNewList();
  const ov = document.createElement("div");
  ov.className = "new-list-overlay";
  ov.innerHTML =
    '<div class="new-list-modal">' +
    '<h3>' + (LP_SCOPE === "household" ? "New shared list" : "New personal list") + "</h3>" +
    '<label>List name<input id="nl-name" maxlength="60" placeholder="e.g. Stuff To Fix"></label>' +
    '<label>Emoji (optional)<input id="nl-icon" maxlength="8" placeholder="🔧"></label>' +
    '<div class="nl-btns"><button class="nl-cancel">cancel</button>' +
    '<button class="nl-create">create</button></div>' +
    '<div class="nl-msg"></div>' +
    "</div>";
  document.body.appendChild(ov);
  newListOverlay = ov;
  const msg = ov.querySelector(".nl-msg");
  const nameEl = ov.querySelector("#nl-name");
  ov.onclick = ev => { if (ev.target === ov) closeNewList(); };
  ov.querySelector(".nl-cancel").onclick = closeNewList;
  ov.querySelector(".nl-create").onclick = () => doCreateList();
  nameEl.addEventListener("keydown", ev => {
    if (ev.key === "Enter") doCreateList();
  });
  setTimeout(() => document.addEventListener("keydown", function onEsc(k) {
    if (k.key === "Escape") closeNewList();
    document.removeEventListener("keydown", onEsc);
  }), 0);
  nameEl.focus();
  async function doCreateList() {
    const name = nameEl.value.trim();
    if (!name) { msg.textContent = "Give it a name first."; nameEl.focus(); return; }
    const icon = ov.querySelector("#nl-icon").value.trim() || null;
    msg.textContent = "creating…";
    try {
      const l = await createNewList(name, icon);
      listsCache.push(l);
      LP_SEL = l.id;
      closeNewList();
      renderListView();
    } catch (err) {
      msg.textContent = "Couldn't create: " + (err && err.message ? err.message : err);
    }
  }
}
async function createNewList(name, icon) {
  const maxSort = listsCache.reduce((m, l) => Math.max(m, l.sort_order || 0), 0);
  const row = {
    id: crypto.randomUUID(),
    name: name,
    icon: icon,
    color: "8a7cff",
    page: LP_SCOPE,
    scope: LP_SCOPE === "household" ? "shared" : "personal",
    sort_order: maxSort + 1
  };
  if (row.scope === "personal") {
    const res = await sb.auth.getUser();
    if (res && res.data && res.data.user) row.owner_id = res.data.user.id;
  }
  const { data, error } = await sb.from("task_lists").insert(row).select().single();
  if (error) throw error;
  return data;
}
async function initListPage(pageScope) {
  LP_SCOPE = pageScope;
  await initTaskPage({
    pageTitle: pageScope,
    filterFn: () => true,
    rerender: renderListView
  });
}
