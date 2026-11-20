(function () {
  const script = document.currentScript;
  const BASE = script.src.replace(/nav\.js.*$/, "");
  const host = document.getElementById("nav");
  if (!host) return;
  fetch(BASE + "nav.html")
    .then(r => r.text())
    .then(html => {
      host.innerHTML = html;
      host.querySelectorAll(".menu-drop a").forEach(a => {
        const href = a.getAttribute("href");
        if (href && !/^(https?:|\/)/.test(href)) a.setAttribute("href", BASE + href);
      });
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
        if (a.getAttribute("href").split("/").pop() === here) a.classList.add("active");
      });
    });
})();