(function (global) {
  "use strict";
  function perUser(opts) {
    if (typeof global.createUserSync !== "function") {
      throw new Error("blobsync: db.js must load before blobsync.js");
    }
    return global.createUserSync(opts);
  }
  function shared(opts) {
    if (typeof global.saveDash !== "function" ||
        typeof global.loadDash !== "function") {
      throw new Error("blobsync: db.js must load before blobsync.js");
    }
    var key = opts.key;
    var normalize = opts.normalize || function (v) { return v; };
    var getState = opts.getState;
    var setState = opts.setState;
    var onRender = opts.onRender || function () {};
    var setOnline = opts.setOnline || function (ok, msg) {};
    var cacheKey = opts.cacheKey || (key + "-cache");
    var debounceMs = opts.debounceMs || 900;

    var cloudReady = false;
    var lastSyncedPrint = null;
    var saveQueued = false;
    var saveTimer = null;
    var rtReloadTimer = null;
    function fingerprint(state) {
      try { return JSON.stringify(state); }
      catch (e) { return ""; }
    }
    function cacheLocal(state) {
      try {
        localStorage.setItem(cacheKey, JSON.stringify(state));
      } catch (e) { /* quota/private mode — cache is best-effort */ }
    }
    function readCache() {
      try {
        var raw = localStorage.getItem(cacheKey);
        return raw ? normalize(JSON.parse(raw)) : null;
      } catch (e) { return null; }
    }
    function loadLegacy() {
      if (!opts.legacyKeys || !opts.legacyKeys.length) return null;
      for (var i = 0; i < opts.legacyKeys.length; i++) {
        try {
          var raw = localStorage.getItem(opts.legacyKeys[i]);
          if (!raw) continue;
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") return parsed;
        } catch (e) { /* skip unreadable legacy key */ }
      }
      return null;
    }
    function save(immediate) {
      if (!cloudReady) return;
      clearTimeout(saveTimer);
      var finishOk = function () {
        lastSyncedPrint = fingerprint(getState());
        saveQueued = false;
        setOnline(true);
      };
      var fail = function (err) {
        saveQueued = false;
        console.error("blobsync shared save failed (" + key + "):",
          err && err.message);
        setOnline(false);
      };
      if (immediate) {
        global.saveDash(key, getState()).then(finishOk).catch(fail);
      } else {
        saveQueued = true;
        setOnline(true, "\u2601\uFE0F saving\u2026");
        saveTimer = setTimeout(function () {
          global.saveDash(key, getState()).then(finishOk).catch(fail);
        }, debounceMs);
      }
    }
    function persist(immediate) {
      cacheLocal(getState());
      save(immediate);
    }
    function setupRealtime() {
      if (typeof global.sb !== "function") return;
      try {
        global.sb()
          .channel("blob-" + key)
          .on("postgres_changes",
            { event: "*", schema: "public", table: "app_data",
              filter: "key=eq." + key },
            function () { scheduleRemoteReload(); })
          .subscribe();
      } catch (e) {
        console.warn("blobsync realtime unavailable for " + key + ":", e.message);
      }
    }
    function scheduleRemoteReload() {
      if (saveQueued) {
        clearTimeout(rtReloadTimer);
        rtReloadTimer = setTimeout(scheduleRemoteReload, 1000);
        return;
      }
      clearTimeout(rtReloadTimer);
      rtReloadTimer = setTimeout(async function () {
        try {
          var cloud = await global.loadDash(key);
          if (!cloud) return;
          var fresh = normalize(cloud);
          var fp = fingerprint(fresh);
          if (lastSyncedPrint !== null && fp === lastSyncedPrint) return;
          if (fp === fingerprint(getState())) return;
          setState(fresh);
          lastSyncedPrint = fp;
          cacheLocal(fresh);
          onRender();
        } catch (e) {
          console.warn("blobsync reload skipped:", e && e.message);
        }
      }, 300);
    }
    async function init() {
      var state = readCache();
      if (state && Object.keys(state).length) {
        setState(state);
      } else {
        var legacy = loadLegacy();
        if (legacy) {
          setState(normalize(legacy));
          cacheLocal(normalize(legacy));
        }
      }
      onRender();
      try {
        var cloud = await global.loadDash(key);
        if (cloud) {
          setState(normalize(cloud));
          cacheLocal(getState());
        } else {
          await global.saveDash(key, getState());
        }
        lastSyncedPrint = fingerprint(getState());
        cloudReady = true;
        setOnline(true);
        setupRealtime();
        return true;
      } catch (err) {
        console.error("blobsync init failed for " + key + ":",
          err && err.message);
        setOnline(false, "\u26A0 cloud init failed");
        return false;
      }
    }
    return {
      init: init,
      save: save,
      persist: persist,
      isReady: function () { return cloudReady; },
      putBlob: function (otherKey, dataObj) {
        return global.saveDash(otherKey, dataObj);
      },
      getBlob: function (otherKey) {
        return global.loadDash(otherKey);
      }
    };
  }
  global.Blobsync = { perUser: perUser, shared: shared };
})(window);
