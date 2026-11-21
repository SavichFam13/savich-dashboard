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
      const bar = host.parentElement;
      if (bar) {
        let sib = host.previousElementSibling;
        while (sib) {
          const next = sib.previousElementSibling;
          host.insertBefore(sib, host.firstChild);
          sib = next;
        }
      }
      const neighbor =
        bar && bar.querySelector("button:not(.menu-btn)");
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
