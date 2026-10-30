(function () {
  "use strict";

  var app = document.getElementById("app");
  var KEY_AUTH = "mordspel.auth";
  var KEY_READ = "mordspel.read";
  var data = null;
  var shell = null; // referenser till panel och innehall efter inloggning

  // localStorage kan saknas (privat läge) - då funkar sidan ändå, men utan minne.
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  function readSet() {
    try { return JSON.parse(lsGet(KEY_READ) || "{}"); } catch (e) { return {}; }
  }
  function markRead(id) { var r = readSet(); r[id] = 1; lsSet(KEY_READ, JSON.stringify(r)); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function sha256(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ("0" + b.toString(16)).slice(-2);
      }).join("");
    });
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function allDocs() {
    var out = [];
    data.kategorier.forEach(function (k) { k.dokument.forEach(function (d) { out.push(d); }); });
    return out;
  }

  function sidor(n) { return n + (n === 1 ? " sida" : " sidor"); }

  function setMenu(open) { document.body.classList.toggle("menu-open", open); }

  /* ---------- Login ---------- */
  function showLogin(msg) {
    shell = null;
    setMenu(false);
    clear(app);
    window.scrollTo(0, 0);
    var input = el("input", { type: "password", placeholder: "Kod", autocomplete: "off", autocapitalize: "none", "aria-label": "Kod" });
    var err = el("p", { class: "err", text: msg || "" });
    var form = el("form", {}, [input, el("button", { class: "btn", type: "submit", text: "Öppna akten" }), err]);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var code = input.value.trim().toLowerCase();
      sha256(data.salt + code).then(function (h) {
        if (h === data.kodHash) { lsSet(KEY_AUTH, h); route(); }
        else { err.textContent = "Fel kod."; input.select(); }
      });
    });
    app.appendChild(el("div", { class: "login" }, [
      el("h1", { text: data.titel }),
      el("p", { text: "Skriv koden du fick av spelledaren." }),
      form
    ]));
    input.focus();
  }

  /* ---------- Skal med sidopanel ---------- */
  function buildShell() {
    clear(app);

    var brandSub = el("div", { class: "sub" });
    var barFill = el("i");
    var brand = el("div", { class: "brand" }, [
      el("h1", { text: data.titel }),
      brandSub,
      el("div", { class: "bar" }, [barFill])
    ]);

    var nav = el("nav", { class: "nav", "aria-label": "Dokument" });
    data.kategorier.forEach(function (k) {
      // En kategori med bara ett dokument (t.ex. kartan) blir en enda länk.
      if (k.dokument.length === 1) {
        var d1 = k.dokument[0];
        nav.appendChild(el("a", { class: "nl single", href: "#/d/" + d1.id, "data-id": d1.id }, [
          el("span", { text: k.namn }), el("span", { class: "chk", text: "✓" })
        ]));
        return;
      }
      nav.appendChild(el("div", { class: "sh", text: k.namn }));
      k.dokument.forEach(function (d) {
        nav.appendChild(el("a", { class: "nl", href: "#/d/" + d.id, "data-id": d.id }, [
          el("span", { text: d.titel }), el("span", { class: "chk", text: "✓" })
        ]));
      });
    });

    var logout = el("button", { class: "link", type: "button", text: "Logga ut" });
    logout.addEventListener("click", function () { lsDel(KEY_AUTH); showLogin(); });

    var side = el("aside", { class: "side", id: "side" }, [brand, nav, el("div", { class: "sfoot" }, [logout])]);
    var backdrop = el("div", { class: "backdrop" });
    backdrop.addEventListener("click", function () { setMenu(false); });
    nav.addEventListener("click", function (e) { if (e.target.closest("a")) setMenu(false); });

    var burger = el("button", { class: "burger", type: "button", "aria-label": "Öppna menyn", "aria-controls": "side" });
    burger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span>Meny</span>';
    burger.addEventListener("click", function () { setMenu(true); });

    var vt = el("div", { class: "vt" });
    var vp = el("div", { class: "vp" });
    var topbar = el("div", { class: "topbar" }, [burger, vt, vp]);
    var content = el("div", { class: "content" });

    app.appendChild(side);
    app.appendChild(backdrop);
    app.appendChild(el("div", { class: "main" }, [topbar, content]));

    shell = { nav: nav, vt: vt, vp: vp, content: content, sub: brandSub, fill: barFill };
  }

  function refreshNav(activeId) {
    var read = readSet();
    var docs = allDocs();
    var done = docs.filter(function (d) { return read[d.id]; }).length;
    shell.sub.textContent = docs.length ? done + " av " + docs.length + " dokument lästa" : "";
    shell.fill.style.width = (docs.length ? Math.round(100 * done / docs.length) : 0) + "%";
    Array.prototype.forEach.call(shell.nav.querySelectorAll(".nl"), function (a) {
      var id = a.getAttribute("data-id");
      a.classList.toggle("active", id === activeId);
      a.classList.toggle("done", !!read[id]);
    });
  }

  /* ---------- Startsida ---------- */
  function showWelcome() {
    var docs = allDocs();
    clear(shell.content);
    shell.vt.textContent = data.titel;
    shell.vp.textContent = "";
    var box = el("div", { class: "welcome" }, [
      el("h2", { text: docs.length ? "Välkommen" : "Inget material uppladdat än" }),
      el("p", { text: docs.length ? "Välj ett dokument i menyn för att börja läsa." : "" })
    ]);
    if (docs.length) {
      var start = el("a", { class: "btn", href: "#/d/" + docs[0].id, text: "Börja med " + docs[0].titel });
      box.appendChild(start);
    }
    shell.content.appendChild(box);
    refreshNav(null);
    window.scrollTo(0, 0);
  }

  /* ---------- Dokument ---------- */
  function showDoc(id) {
    var docs = allDocs();
    var idx = -1;
    docs.forEach(function (d, i) { if (d.id === id) idx = i; });
    if (idx < 0) { location.hash = "#/"; return; }
    var d = docs[idx];
    markRead(d.id);

    clear(shell.content);
    shell.vt.textContent = d.titel;
    shell.vp.textContent = d.sidor.length > 1 ? sidor(d.sidor.length) : "";

    var pages = el("div", { class: "pages" });
    d.sidor.forEach(function (src, i) {
      pages.appendChild(el("img", { src: src, alt: d.titel + " - sida " + (i + 1), loading: i < 2 ? "eager" : "lazy" }));
    });

    var actions = el("div", { class: "actions" });
    if (idx + 1 < docs.length) {
      actions.appendChild(el("a", { class: "btn ghost", href: "#/d/" + docs[idx + 1].id, text: "Nästa: " + docs[idx + 1].titel + " →" }));
    }

    shell.content.appendChild(pages);
    shell.content.appendChild(el("div", { class: "hint", text: "Nyp med två fingrar för att zooma." }));
    shell.content.appendChild(actions);
    refreshNav(d.id);
    window.scrollTo(0, 0);
  }

  /* ---------- Router ---------- */
  function route() {
    if (!data) return;
    if (lsGet(KEY_AUTH) !== data.kodHash) { showLogin(); return; }
    if (!shell) buildShell();
    var m = location.hash.match(/^#\/d\/(.+)$/);
    if (m) showDoc(decodeURIComponent(m[1])); else showWelcome();
  }

  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setMenu(false); });

  fetch("data.json?v=" + Date.now())
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) { data = j; document.title = j.titel; route(); })
    .catch(function () {
      clear(app);
      app.appendChild(el("div", { class: "login" }, [el("h1", { text: "Kunde inte ladda" }), el("p", { text: "Kontrollera internet och ladda om sidan." })]));
    });
})();
