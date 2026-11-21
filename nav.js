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
      const parent = host.parentElement;
      if (note && parent && note.parentElement !== parent) {
        parent.insertBefore(note, parent.firstChild);
      }
      const neighbor =
        parent && parent.querySelector("button:not(.menu-btn)");
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
      const here = location.pathname.split("/").pop();
      host.querySelectorAll(".menu-drop a").forEach(a => {
        const href = a.getAttribute("href");
        if (href.includes("#")) return;
        if (href.split("/").pop() === here) a.classList.add("active");
      });
    });
})();