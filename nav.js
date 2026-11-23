(function () {
  const script = document.currentScript;
  const BASE = script.src.replace(/nav\.js.*$/, "");
  const host = document.getElementById("nav");
  if (!host) return;
  fetch(BASE + "nav.html?v=3")
    .then(r => r.text())
    .then(html => {
      host.insertAdjacentHTML("beforeend", html);
      host.querySelectorAll(".menu-drop a").forEach(a => {
        const href = a.getAttribute("href");
        if (href && !/^(https?:|\/)/.test(href)) a.setAttribute("href", BASE + href);
      });
      const parent = host.parentElement;
      const neighbor = parent && parent.querySelector("button:not(.menu-btn)");
      const mb = host.querySelector(".menu-btn");
      if (neighbor && mb) {
        const cs = getComputedStyle(neighbor);
        mb.style.fontSize = cs.fontSize;
        mb.style.paddingTop = cs.paddingTop;
        mb.style.paddingBottom = cs.paddingBottom;
        mb.style.lineHeight = cs.lineHeight;
        mb.style.fontWeight = cs.fontWeight;
      }
      const wrap = host.querySelector(".nav-menu");
      const btn = host.querySelector(".menu-btn");
      btn.addEventListener("click", e => {
        e.stopPropagation();
        wrap.classList.toggle("open");
      });
      document.addEventListener("click", () => wrap.classList.remove("open"));
      document.addEventListener("keydown", e => {
        if (e.key === "Escape") wrap.classList.remove("open");
      });
      function markActive() {
        const here = location.pathname.split("/").pop();
        const hash = location.hash;
        let matchedHashLink = false;
        host.querySelectorAll(".menu-drop a").forEach(a => {
          a.classList.remove("active");
          const href = a.getAttribute("href");
          const file = href.split("#")[0].split("/").pop();
          const linkHash = href.includes("#") ? "#" + href.split("#")[1] : null;
          if (file === here && linkHash && linkHash === hash) {
            a.classList.add("active");
            matchedHashLink = true;
          }
        });
        if (!matchedHashLink) {
          host.querySelectorAll(".menu-drop a").forEach(a => {
            const href = a.getAttribute("href");
            if (href.includes("#")) return;
            if (href.split("/").pop() === here) a.classList.add("active");
          });
        }
      }
      markActive();
      window.addEventListener("hashchange", markActive);
    });
})();
(function () {
  const remScript = document.currentScript;
  const REM_BASE = remScript && remScript.src
    ? remScript.src.replace(/nav\.js.*$/, "")
    : "/";
  const REM_TODAY = REM_BASE + "lists/today.html";
  function remToday(d) {
    const dt = d || new Date();
    return dt.getFullYear() + "-" +
      String(dt.getMonth() + 1).padStart(2, "0") + "-" +
      String(dt.getDate()).padStart(2, "0");
  }
  function remAddDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return remToday(new Date(y, m - 1, d + n));
  }
  function remParse(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function remLastWeekdayOfMonth(y, m, weekday) {
    const last = new Date(y, m, 0);
    const back = (last.getDay() - weekday + 7) % 7;
    last.setDate(last.getDate() - back);
    return remToday(last);
  }
  function remNthWeekdayOfMonth(y, m, weekday, nth) {
    const first = new Date(y, m - 1, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    const day = 1 + offset + (nth - 1) * 7;
    const probe = new Date(y, m - 1, day);
    if (probe.getMonth() !== m - 1) return null;
    return remToday(probe);
  }
  function remRollingDue(t, occs) {
    const n = t.repeat_every || 3;
    let last = null;
    for (const o of occs) {
      if (o.task_id !== t.id) continue;
      if (o.status !== "done" && o.status !== "skipped") continue;
      const eff = o.moved_to || o.orig_date;
      if (!last || eff > last) last = eff;
    }
    return last ? remAddDays(last, n) : t.start_date;
  }
  function remFiresOn(t, dateStr, occs) {
    const start = t.start_date;
    if (!start || dateStr < start) return false;
    if (t.repeat_until && dateStr > t.repeat_until) return false;
    const wd = remParse(dateStr).getDay();
    switch (t.repeat_type) {
      case "none":     return dateStr === start;
      case "daily":    return true;
      case "weekdays": return wd >= 1 && wd <= 5;
      case "weekly":
        return Array.isArray(t.repeat_days) && t.repeat_days.includes(wd);
      case "biweekly": {
        if (!Array.isArray(t.repeat_days) || !t.repeat_days.includes(wd))
          return false;
        const every = t.repeat_every || 2;
        const weekOf = dt => {
          const d = new Date(dt);
          d.setDate(d.getDate() - d.getDay());
          return Math.round((d - new Date(d.getFullYear(), 0, 1)) / 604800000);
        };
        return weekOf(remParse(start)) % every === weekOf(remParse(dateStr)) % every;
      }
      case "monthly": {
        const md = t.repeat_mday || Number(start.split("-")[2]);
        const [y, m] = dateStr.split("-").map(Number);
        const dayNum = Number(dateStr.split("-")[2]);
        if (md === 99) {
          if (dayNum !== new Date(y, m, 0).getDate()) return false;
        } else if (dayNum !== md) return false;
        const every = t.repeat_every || 1;
        const [sy, sm] = start.split("-").map(Number);
        const mdiff = (y * 12 + (m - 1)) - (sy * 12 + (sm - 1));
        return mdiff >= 0 && mdiff % every === 0;
      }
      case "nthmonth": {
        if (!Array.isArray(t.repeat_days) || !t.repeat_days.includes(wd))
          return false;
        const every = t.repeat_every || 1;
        const [y, m] = dateStr.split("-").map(Number);
        const [sy, sm] = start.split("-").map(Number);
        const mdiff = (y * 12 + (m - 1)) - (sy * 12 + (sm - 1));
        if (mdiff < 0 || mdiff % every !== 0) return false;
        if ((t.repeat_nth || 1) === 5)
          return remLastWeekdayOfMonth(y, m, wd) === dateStr;
        return remNthWeekdayOfMonth(y, m, wd, t.repeat_nth || 1) === dateStr;
      }
      case "afterdone":
        return dateStr === remRollingDue(t, occs);
      default:
        return false;
    }
  }
  function remCountRemaining(t, occs, onDate) {
    if (!t.repeat_count) return Infinity;
    let fired = 0;
    const doneDates = {};
    for (const o of occs) {
      if (o.task_id === t.id && (o.status === "done" || o.status === "skipped"))
        doneDates[o.orig_date] = true;
    }
    for (let d = t.start_date; d <= onDate; d = remAddDays(d, 1)) {
      if (doneDates[d]) fired++;
      else if (remFiresOn(t, d, occs) && d < onDate) fired++;
    }
    return t.repeat_count - fired;
  }
  const FIRED_KEY = "task-rem-fired";
  function firedSet() {
    const today = remToday();
    let arr = [];
    try { arr = JSON.parse(localStorage.getItem(FIRED_KEY) || "[]"); }
    catch (e) { arr = []; }
    return new Set(arr.filter(x => typeof x === "string" && x.endsWith("|" + today)));
  }
  function markFired(id) {
    const today = remToday();
    const set = firedSet();
    const key = id + "|" + today;
    if (set.has(key)) return;
    set.add(key);
    localStorage.setItem(FIRED_KEY, JSON.stringify(Array.from(set)));
  }
  let remStyleDone = false;
  function remEnsureStyle() {
    if (remStyleDone) return;
    remStyleDone = true;
    const st = document.createElement("style");
    st.textContent =
      "#task-rem-stack { position: fixed; right: 18px; bottom: 18px; z-index: 200;" +
      "  display: flex; flex-direction: column; gap: 10px; max-width: min(340px, 88vw); }" +
      ".task-rem { background: var(--panel, #1c1922); border: 1px solid var(--accent, #c9a0ff);" +
      "  border-radius: 10px; padding: 12px 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);" +
      "  font-family: Verdana, Geneva, Tahoma, sans-serif; color: var(--text, #f2eef7);" +
      "  animation: task-rem-in 0.25s ease; }" +
      "@keyframes task-rem-in { from { opacity: 0; transform: translateY(12px); }" +
      "  to { opacity: 1; transform: translateY(0); } }" +
      ".task-rem.rem-hide { opacity: 0; transform: translateY(12px); transition: all 0.25s ease; }" +
      ".task-rem-title { font-size: 0.86rem; font-weight: 700; margin-bottom: 2px; }" +
      ".task-rem-sub { font-size: 0.72rem; color: var(--dim, #a89bbd); margin-bottom: 10px; }" +
      ".task-rem-btns { display: flex; gap: 8px; align-items: center; }" +
      ".task-rem-btns button { font-family: inherit; font-size: 0.78rem; font-weight: 700;" +
      "  border-radius: 6px; padding: 6px 14px; cursor: pointer; }" +
      ".task-rem-done { background: var(--good, #7ddba3); color: #121016; border: none; }" +
      ".task-rem-done:hover { filter: brightness(1.1); }" +
      ".task-rem-dismiss { background: none; color: var(--dim, #a89bbd);" +
      "  border: 1px solid var(--border, #332c3e); }" +
      ".task-rem-dismiss:hover { border-color: var(--accent, #c9a0ff); color: var(--text, #f2eef7); }" +
      ".task-rem-today { background: none; border: none; color: var(--dim, #a89bbd);" +
      "  font-weight: 600; font-size: 0.72rem; text-decoration: underline;" +
      "  padding: 6px 2px; margin-left: 2px; }" +
      ".task-rem-today:hover { color: var(--accent, #c9a0ff); }";
    document.head.appendChild(st);
  }
  function remStack() {
    let el = document.getElementById("task-rem-stack");
    if (!el) { el = document.createElement("div"); el.id = "task-rem-stack"; document.body.appendChild(el); }
    return el;
  }
  function remFmtTime(hhmm) {
    if (!hhmm) return "";
    const parts = hhmm.slice(0, 5).split(":").map(Number);
    let h = parts[0];
    const m = parts[1];
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + String(m).padStart(2, "0") + " " + ap;
  }
  function remRemove(card) {
    card.classList.add("rem-hide");
    setTimeout(() => { card.remove(); if (!remStack().children.length) remStack().remove(); }, 260);
  }
  function remShow(t, dueTimeStr) {
    remEnsureStyle();
    const card = document.createElement("div");
    card.className = "task-rem";
    const tt = document.createElement("div");
    tt.className = "task-rem-title";
    tt.textContent = t.title;
    const ss = document.createElement("div");
    ss.className = "task-rem-sub";
    ss.textContent = "due " + remFmtTime(dueTimeStr);
    const bb = document.createElement("div");
    bb.className = "task-rem-btns";
    const doneBtn = document.createElement("button");
    doneBtn.className = "task-rem-done";
    doneBtn.textContent = "✓ Done";
    const disBtn = document.createElement("button");
    disBtn.className = "task-rem-dismiss";
    disBtn.textContent = "Dismiss";
    const todayBtn = document.createElement("button");
    todayBtn.className = "task-rem-today";
    todayBtn.textContent = "Open Today ↗";
    todayBtn.title = "Go to the Today page";
    bb.appendChild(doneBtn); bb.appendChild(disBtn); bb.appendChild(todayBtn);
    card.appendChild(tt); card.appendChild(ss); card.appendChild(bb);
    remStack().appendChild(card);
    disBtn.onclick = () => { markFired(t.id); remRemove(card); };
    todayBtn.onclick = () => {
      markFired(t.id);
      window.location.href = REM_TODAY;
    };
    doneBtn.onclick = async () => {
      markFired(t.id);
      doneBtn.disabled = true;
      doneBtn.textContent = "…";
      try {
        const sbc = sb();
        const today = remToday();
        const { data: occs } = await sbc
          .from("task_occurrences")
          .select("*")
          .eq("task_id", t.id)
          .eq("orig_date", today);
        let uid = null;
        try { uid = await currentUserId(); } catch (e) { uid = null; }
        if (occs && occs.length) {
          await sbc.from("task_occurrences").update({
            status: "done", done_at: new Date().toISOString(),
            done_by: uid, updated_at: new Date().toISOString()
          }).eq("id", occs[0].id);
        } else {
          await sbc.from("task_occurrences").insert({
            task_id: t.id, orig_date: today, status: "done",
            done_by: uid, done_at: new Date().toISOString()
          });
        }
        if (t.repeat_type === "none") {
          await sbc.from("task_occurrences").delete().eq("task_id", t.id);
          await sbc.from("tasks").delete().eq("id", t.id);
        }
      } catch (e) {
        doneBtn.textContent = "failed — do it on the page";
        setTimeout(() => remRemove(card), 2200);
        return;
      }
      remRemove(card);
    };
  }
  let remBusy = false;
  async function remTick() {
    if (remBusy) return;
    if (!window.sb) return;
    remBusy = true;
    try {
      const sbc = sb();
      const today = remToday();
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const [tr, or] = await Promise.all([
        sbc.from("tasks").select("*"),
        sbc.from("task_occurrences").select("*")
      ]);
      if (!tr.data) return;
      const tasks = tr.data || [];
      const occs = or.data || [];
      const occToday = {};
      for (const o of occs) {
        if (o.orig_date === today) occToday[o.task_id] = o;
      }
      const fired = firedSet();
      const due = [];
      for (const t of tasks) {
        if (t.archived || t.is_note) continue;
        if (!t.due_time || !t.start_date) continue;
        const key = t.id + "|" + today;
        if (fired.has(key)) continue;
        if (!remFiresOn(t, today, occs)) continue;
        if (remCountRemaining(t, occs, today) <= 0) continue;
        const o = occToday[t.id];
        if (o && (o.status === "done" || o.status === "skipped")) continue;
        if (o && o.moved_to && o.moved_to !== today) continue;
        const parts = t.due_time.slice(0, 5).split(":").map(Number);
        const dueMin = parts[0] * 60 + parts[1];
        if (dueMin <= nowMin) due.push(t);
      }
      for (const t of due) {
        markFired(t.id);
        remShow(t, t.due_time);
      }
    } catch (e) {
    } finally {
      remBusy = false;
    }
  }
  remTick();
  setInterval(remTick, 60000);
})();
