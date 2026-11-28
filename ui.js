(function (global) {
  "use strict";
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;",
               '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var notifyTimer = null;

  function findNotifyEl() {
    return document.getElementById("toast") ||
           document.getElementById("flash-msg") ||
           null;
  }
  function notify(msg, opts) {
    opts = opts || {};
    var el = findNotifyEl();
    if (!el) { console.info("[notify]", msg); return; }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(function () {
      el.classList.remove("show");
    }, opts.ms || 2600);
  }
  function toast(msg, opts) { return notify(msg, opts); }
  function flash(msg, opts) { return notify(msg, opts); }       
  function modalIds() {
    var ov = document.getElementById("modal-overlay") ||
             document.getElementById("modalOverlay") || null;
    var title = document.getElementById("modal-title") ?
      "modal-title" :
      (document.getElementById("modalTitle") ? "modalTitle" : null);
    var msg = document.getElementById("modal-message") ?
      "modal-message" :
      (document.getElementById("modalMsg") ? "modalMsg" : null);
    var yes = document.getElementById("modal-yes") ?
      "modal-yes" :
      (document.getElementById("modalYes") ? "modalYes" : null);
    var no = document.getElementById("modal-no") ?
      "modal-no" :
      (document.getElementById("modalNo") ? "modalNo" : null);
    return {
      overlay: ov,
      title: title, msg: msg, yes: yes, no: no,
      complete: !!(ov && title && msg && yes && no)
    };
  }
  var modalResolve = null;
  var modalBox = null;  
  function settle(result) {
    if (modalResolve) {
      var r = modalResolve;
      modalResolve = null;
      r(result);
    }
    var m = modalIds();
    if (m.overlay) {
      m.overlay.classList.remove("open");
      var y = document.getElementById(m.yes);
      var n = document.getElementById(m.no);
      if (y) y.onclick = null;
      if (n) n.onclick = null;
      m.overlay.onclick = null;
    }
    if (modalBox) { modalBox.remove(); modalBox = null; }
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") settle(false); }
  function confirmBox(title, message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      settle(null);        
      modalResolve = resolve;

      var m = modalIds();
      if (m.complete) {
        document.getElementById(m.title).textContent = title;
        document.getElementById(m.msg).textContent = message;
        var y = document.getElementById(m.yes);
        var n = document.getElementById(m.no);
        y.textContent = opts.yes || "YES";
        n.textContent = opts.no || "NO";
        y.classList.toggle("destructive", !!opts.destructive);
        y.onclick = function () { settle(true); };
        n.onclick = function () { settle(false); };
        m.overlay.onclick = function (e) {
          if (e.target === m.overlay) settle(false);
        };
        m.overlay.classList.add("open");
      } else {
        modalBox = document.createElement("div");
        modalBox.className = "cbox-overlay";
        modalBox.innerHTML =
          '<div class="cbox">' +
          '<div class="cbox-title">' + esc(title) + "</div>" +
          '<div class="cbox-body">' + esc(message) + "</div>" +
          '<div class="cbox-btns">' +
          '<button type="button" class="' +
            (opts.destructive ? "cbox-destructive" : "cbox-yes") + '">' +
            esc(opts.yes || "YES") + '</button>' +
          '<button type="button" class="cbox-no">' +
            esc(opts.no || "NO") + "</button>" +
          "</div></div>";
        document.body.appendChild(modalBox);
        var yb = modalBox.querySelector(".cbox-yes, .cbox-destructive");
        var nb = modalBox.querySelector(".cbox-no");
        yb.onclick = function () { settle(true); };
        nb.onclick = function () { settle(false); };
        modalBox.onclick = function (e) {
          if (e.target === modalBox) settle(false);
        };
      }
      document.addEventListener("keydown", onKey);
    });
  }
  function askConfirm(title, message, destructive, a, b) {
    var opts = {};
    if (a && typeof a === "object") {
      opts.yes = a.yes; opts.no = a.no;
    } else {
      opts.yes = a; opts.no = b;
    }
    opts.destructive = !!destructive;
    return confirmBox(title, message, opts);
  }
  global.ui = {
    esc: esc,
    notify: notify,
    toast: toast,
    flash: flash,
    confirmBox: confirmBox,
    askConfirm: askConfirm,
    closeModal: function (result) { settle(result); }
  };
  global.esc = esc;
  global.notify = notify;
  global.toast = toast;
  global.flash = flash;
  global.confirmBox = confirmBox;
  global.askConfirm = askConfirm;

})(window);
