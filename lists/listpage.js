const DNAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nthName(n) {
  return ["1st", "2nd", "3rd", "4th", "5th"][n - 1] || n + "th";
}

function dowsText(t) {
  if (!Array.isArray(t.repeat_days) || !t.repeat_days.length) return "?";
  return t.repeat_days.map(d => DNAMES[d]).join(", ");
}

function repeatDescr(t) {
  const tm = t.due_time ? " · " + fmtTime(t.due_time) : " · anytime";
  switch (t.repeat_type) {
    case "none":     return "One-time" + tm;
    case "daily":    return "Every day" + tm;
    case "weekdays": return "Weekdays Mon–Fri" + tm;
    case "weekly":   return "Weekly on " + dowsText(t) + tm;
    case "biweekly": return "Every 2 weeks on " + dowsText(t) + tm;
    case "monthly":  return "Monthly on day " +
                      (t.repeat_mday || Number(t.start_date.split("-")[2])) + tm;
    case "nthmonth": return "Every " + (t.repeat_every || 1) + " mo. on the " +
                      nthName(t.repeat_nth || 1) + " " + dowsText(t) + tm;
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
function renderListView() {
  const rail = document.getElementById("list-rail");
  const area = document.getElementById("task-area");
  const today = todayStr();

  const lists = pageLists();
  if (!LP_SEL || !lists.some(l => l.id === LP_SEL)) LP_SEL = lists.length ? lists[0].id : null;
  if (!lists.length) {
    rail.innerHTML = '<span class="empty-note">No lists visible for this page yet. ' +
      (LP_SCOPE === "personal"
        ? "Personal lists stay invisible until owner assignment SQL is run for your account."
        : "") + "</span>";
  } else {
    rail.innerHTML = lists.map(l => {
      const count = tasksCache.filter(t => !t.archived && t.list_id === l.id).length;
      return '<button class="rail-chip' + (l.id === LP_SEL ? " sel" : "") +
        '" data-list="' + l.id + '">' +
        '<span class="t-dot" style="background:#' + esc(l.color) + '"></span>' +
        esc(l.name) + ' <span class="rail-count">' + count + "</span></button>";
    }).join("");
    rail.querySelectorAll(".rail-chip").forEach(b => {
      b.onclick = () => { LP_SEL = b.getAttribute("data-list"); renderListView(); };
    });
  }
  fillListSelectForPage();
  window.EDITOR_DEFAULT_LIST = LP_SEL || undefined;

  if (!LP_SEL) {
    area.innerHTML = '<div class="empty-note">Nothing to show yet — add a list or a task.</div>';
    return;
  }
  const list = lists.find(l => l.id === LP_SEL);
  document.getElementById("page-title").textContent = list.name;

  let tsks = tasksCache.filter(t => !t.archived && t.list_id === LP_SEL);
  tsks.sort((a, b) =>
    (a.due_time || "99") < (b.due_time || "99") ? -1 :
    (a.due_time || "99") > (b.due_time || "99") ? 1 :
    a.title.localeCompare(b.title));

  if (!tsks.length) {
    area.innerHTML = '<div class="empty-note">This list is empty — ' +
      'hit “+ add task” to create the first one.</div>';
    return;
  }

  let html = "";
  for (const t of tsks) {
    const occToday = occCache.find(o => o.task_id === t.id && o.orig_date === today);
    const doneToday = occToday && occToday.status === "done";
    const nf = t.repeat_type === "none"
      ? (t.start_date < today ? null : t.start_date)
      : nextFireDate(t, today);
    html +=
      '<div class="task-row' + (doneToday ? " done" : "") + '" data-task="' + t.id +
      '" data-date="' + today + '">' +
      '<span class="cb" title="done today · shift-click = undo"></span>' +
      '<span class="t-title">' + esc(t.title) + "</span>" +
      '<span class="t-meta">' + esc(repeatDescr(t)) + "</span>" +
      '<span class="t-next">' + (nf ? "next: " + nf.slice(5) : "past") + "</span>" +
      "</div>";
  }
  area.innerHTML = html;

  area.querySelectorAll(".task-row").forEach(row => {
    const taskId = row.getAttribute("data-task");
    const t = tasksCache.find(x => x.id === taskId);
    if (!t) return;
    row.addEventListener("click", async ev => {
      if (ev.target.classList.contains("cb")) {
        if (row.classList.contains("done")) { await undoOverride(taskId, today); renderListView(); }
        else { await markDone(taskId, today); renderListView(); }
      } else if (ev.target.classList.contains("t-title")) {
        openEditor(t);
      }
    });
    row.oncontextmenu = ev => openTaskMenu(ev, {
      task: t,
      occ: occCache.find(o => o.task_id === taskId && o.orig_date === today),
      date: today, time: t.due_time
    }, renderListView);
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
