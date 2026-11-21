(function () {
  const script = document.currentScript;
  const BASE = script.src.replace(/nav\.js.*$/, "");
  const host = document.getElementById("nav");
  if (!host) return;
  fetch(BASE + "nav.html")
    .then(r => r.text())
    .then(html => {
      host.insertAdjacentHTML("beforeend", html);
      host.querySelectorAll(".menu-drop a").forEach(a => {
        const href = a.getAttribute("href");
        if (href && !/^(https?:|\/)/.test(href)) a.setAttribute("href", BASE + href);
      });
      const note = document.getElementById("sync-note");
      const menu = host.querySelector(".nav-menu");
      if (note && menu) {
        host.insertBefore(note, menu);
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
      const here = location.pathname.split("/").pop();
      host.querySelectorAll(".menu-drop a").forEach(a => {
        const href = a.getAttribute("href");
        if (href.includes("#")) return; // skip hash links
        if (href.split("/").pop() === here) a.classList.add("active");
      });
    });
})();