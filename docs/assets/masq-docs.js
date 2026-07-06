/* ═══════════════════════════════════════════════════════════════════════════
   masqueradarr docs — site chrome.
   Minimal, no-dependency JS for: sidebar injection from window.MASQ_NAV,
   active-page marking, light/dark toggle (persist + OS default), the mobile
   drawer, and an on-page scroll-spy TOC. All progressive-enhancement: the page
   is fully readable with JS disabled (see each page's <noscript> nav).

   NOTE: the initial theme is applied by a tiny inline <script> in each page's
   <head> BEFORE first paint (no flash). This file only wires the toggle after.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var STORE_KEY = "masq-theme";
  var root = document.documentElement;

  /* ── theme ──────────────────────────────────────────────────────────── */
  function osPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function resolvedTheme() {
    var attr = root.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    return osPrefersDark() ? "dark" : "light";
  }
  function reflectToggle(btn) {
    var t = resolvedTheme();
    btn.setAttribute("data-resolved", t);
    btn.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
    btn.setAttribute("title", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  function setTheme(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem(STORE_KEY, t); } catch (e) {}
    document.querySelectorAll("[data-theme-toggle]").forEach(reflectToggle);
  }
  function wireThemeToggles() {
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      reflectToggle(btn);
      btn.addEventListener("click", function () {
        setTheme(resolvedTheme() === "dark" ? "light" : "dark");
      });
    });
    // Follow OS changes only while the user hasn't pinned a theme.
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        var pinned;
        try { pinned = localStorage.getItem(STORE_KEY); } catch (e) {}
        if (pinned !== "light" && pinned !== "dark") {
          document.querySelectorAll("[data-theme-toggle]").forEach(reflectToggle);
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ── sidebar nav injection ──────────────────────────────────────────── */
  function currentFile() {
    var p = location.pathname;
    if (!p || p.charAt(p.length - 1) === "/") return "index.html";
    var b = p.split("/").pop();
    return b || "index.html";
  }
  function pathPrefix() {
    return /\/pages\//.test(location.pathname) ? "../" : "";
  }
  function baseName(href) {
    return href.split("/").pop();
  }
  function buildNav() {
    var mount = document.getElementById("side-nav");
    if (!mount || !window.MASQ_NAV) return;
    var prefix = pathPrefix();
    var here = currentFile();
    var frag = document.createDocumentFragment();

    window.MASQ_NAV.forEach(function (group) {
      var g = document.createElement("div");
      g.className = "nav-group";
      var gl = document.createElement("div");
      gl.className = "g-label";
      gl.textContent = group.label;
      g.appendChild(gl);

      group.links.forEach(function (link) {
        var isActive = baseName(link.href) === here;
        var el;
        if (link.soon) {
          el = document.createElement("span");
          el.className = "nav-link soon";
        } else {
          el = document.createElement("a");
          el.className = "nav-link";
          el.href = prefix + link.href;
          if (isActive) el.setAttribute("aria-current", "page");
        }
        var ix = document.createElement("span");
        ix.className = "ix";
        ix.textContent = link.ix || "";
        var label = document.createElement("span");
        label.className = "t";
        label.textContent = link.title;
        el.appendChild(ix);
        el.appendChild(label);
        if (link.soon) {
          var tag = document.createElement("span");
          tag.className = "soon-tag";
          tag.textContent = "soon";
          el.appendChild(tag);
        }
        g.appendChild(el);
      });
      frag.appendChild(g);
    });

    mount.innerHTML = "";
    mount.appendChild(frag);
  }

  /* ── mobile drawer ──────────────────────────────────────────────────── */
  function wireDrawer() {
    var body = document.body;
    var open = function () { body.classList.add("nav-open"); };
    var close = function () { body.classList.remove("nav-open"); };
    document.querySelectorAll("[data-nav-open]").forEach(function (b) {
      b.addEventListener("click", open);
    });
    var scrim = document.querySelector(".scrim");
    if (scrim) scrim.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    // Close after tapping a link in the drawer.
    var side = document.querySelector(".sidebar");
    if (side) side.addEventListener("click", function (e) {
      if (e.target.closest("a")) close();
    });
  }

  /* ── scroll-spy TOC ─────────────────────────────────────────────────── */
  function buildToc() {
    var host = document.getElementById("toc");
    if (!host) return;
    var sections = Array.prototype.slice.call(
      document.querySelectorAll("main .doc section[id]")
    );
    var entries = sections
      .map(function (sec) {
        var h = sec.querySelector("h2");
        return h ? { id: sec.id, text: h.textContent.trim() } : null;
      })
      .filter(Boolean);
    if (entries.length < 2) return;

    var label = document.createElement("div");
    label.className = "t-label";
    label.textContent = "On this page";
    var nav = document.createElement("nav");
    var linkById = {};
    entries.forEach(function (e) {
      var a = document.createElement("a");
      a.href = "#" + e.id;
      a.textContent = e.text;
      nav.appendChild(a);
      linkById[e.id] = a;
    });
    host.appendChild(label);
    host.appendChild(nav);

    if (!("IntersectionObserver" in window)) return;
    var active = null;
    var obs = new IntersectionObserver(
      function (records) {
        records.forEach(function (r) {
          if (r.isIntersecting) {
            if (active) active.classList.remove("active");
            active = linkById[r.target.id];
            if (active) active.classList.add("active");
          }
        });
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 }
    );
    sections.forEach(function (s) { if (linkById[s.id]) obs.observe(s); });
  }

  /* ── copy buttons on code blocks ────────────────────────────────────── */
  function wireCopy() {
    if (!navigator.clipboard) return;
    document.querySelectorAll("pre.code").forEach(function (pre) {
      var wrap = pre.closest(".code-wrap");
      if (!wrap) return;
      var text = pre.innerText;
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.setAttribute("aria-label", "Copy to clipboard");
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = "copied";
          btn.classList.add("done");
          setTimeout(function () { btn.textContent = "copy"; btn.classList.remove("done"); }, 1400);
        }).catch(function () {});
      });
      wrap.appendChild(btn);
    });
  }

  /* ── boot ───────────────────────────────────────────────────────────── */
  function init() {
    wireThemeToggles();
    buildNav();
    wireDrawer();
    buildToc();
    wireCopy();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
