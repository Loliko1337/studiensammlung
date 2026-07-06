/* ============================================================
   sammlung.js — gemeinsame Logik für Portal, Editor & Viewer
   - Login (GitHub-Token, nur lokal im Browser gespeichert)
   - Speichern/Laden über GitHub Contents API oder Lokal-Modus
   - Rendering der Übersichts-Blöcke (Editor & Viewer & PDF)
   ============================================================ */
(function(){
  const CFG = window.SAMMLUNG_CONFIG || {};
  const LS_TOKEN = "sammlung_gh_token";
  const LS_DOCS  = "sammlung_lokale_docs";   // { id: doc }

  /* ---------- Modus & Token ---------- */
  function repoKonfiguriert(){ return !!(CFG.owner && CFG.repo); }
  function getToken(){ try{ return localStorage.getItem(LS_TOKEN) || ""; }catch(e){ return ""; } }
  function setToken(t){ try{ t ? localStorage.setItem(LS_TOKEN,t) : localStorage.removeItem(LS_TOKEN); }catch(e){} }
  function eingeloggt(){ return !!getToken(); }
  function schreibmodus(){ return repoKonfiguriert() && eingeloggt() ? "github" : "lokal"; }

  /* ---------- GitHub Contents API ---------- */
  function apiUrl(pfad){
    return `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${pfad}`;
  }
  function b64encode(str){
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64decode(b64){
    return decodeURIComponent(escape(atob(b64.replace(/\n/g,""))));
  }
  async function ghLesen(pfad){
    const r = await fetch(apiUrl(pfad) + `?ref=${CFG.branch}`, {
      headers: kopf(), cache: "no-store"
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub: ${r.status} beim Lesen von ${pfad}`);
    const j = await r.json();
    return { text: b64decode(j.content), sha: j.sha };
  }
  async function ghSchreiben(pfad, text, nachricht, istBinaerB64){
    // sha holen, falls Datei existiert (nötig für Updates)
    let sha;
    try { const alt = await ghLesenSha(pfad); sha = alt && alt.sha; } catch(e){}
    const body = {
      message: nachricht || `Aktualisiert: ${pfad}`,
      content: istBinaerB64 ? text : b64encode(text),
      branch: CFG.branch,
    };
    if (sha) body.sha = sha;
    const r = await fetch(apiUrl(pfad), {
      method:"PUT", headers: kopf(true), body: JSON.stringify(body)
    });
    if (!r.ok){
      const j = await r.json().catch(()=>({}));
      throw new Error(`GitHub: ${r.status} beim Speichern (${j.message||"unbekannt"})`);
    }
    return r.json();
  }
  async function ghLesenSha(pfad){
    const r = await fetch(apiUrl(pfad) + `?ref=${CFG.branch}`, { headers: kopf(), cache:"no-store" });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub: ${r.status}`);
    const j = await r.json();
    return { sha: j.sha };
  }
  async function ghLoeschen(pfad, nachricht){
    const alt = await ghLesenSha(pfad);
    if (!alt) return;
    const r = await fetch(apiUrl(pfad), {
      method:"DELETE", headers: kopf(true),
      body: JSON.stringify({ message: nachricht||`Gelöscht: ${pfad}`, sha: alt.sha, branch: CFG.branch })
    });
    if (!r.ok) throw new Error(`GitHub: ${r.status} beim Löschen`);
  }
  function kopf(mitJson){
    const h = { "Accept":"application/vnd.github+json" };
    const t = getToken();
    if (t) h["Authorization"] = "Bearer " + t;
    if (mitJson) h["Content-Type"] = "application/json";
    return h;
  }
  async function tokenPruefen(t){
    const r = await fetch(`https://api.github.com/repos/${CFG.owner}/${CFG.repo}`, {
      headers: { "Accept":"application/vnd.github+json", "Authorization":"Bearer "+t }
    });
    if (!r.ok) return { ok:false, grund: r.status===401 ? "Token ungültig oder abgelaufen." : `Kein Zugriff auf ${CFG.owner}/${CFG.repo} (Status ${r.status}).` };
    const j = await r.json();
    if (j.permissions && !j.permissions.push)
      return { ok:false, grund:"Token hat keine Schreibrechte (Contents: Read & Write nötig)." };
    return { ok:true };
  }

  /* ---------- Lokale Entwürfe ---------- */
  function lokaleDocs(){
    try { return JSON.parse(localStorage.getItem(LS_DOCS) || "{}"); } catch(e){ return {}; }
  }
  function lokalSpeichern(doc){
    const alle = lokaleDocs(); alle[doc.id] = doc;
    localStorage.setItem(LS_DOCS, JSON.stringify(alle));
  }
  function lokalLoeschen(id){
    const alle = lokaleDocs(); delete alle[id];
    localStorage.setItem(LS_DOCS, JSON.stringify(alle));
  }

  /* ---------- Veröffentlichte Inhalte lesen ---------- */
  async function jsonHolen(relPfad){
    try {
      const r = await fetch(relPfad + "?t=" + Date.now(), { cache:"no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch(e){ return null; } // z. B. file:// ohne Server
  }
  // Bevorzugt die GitHub-API: zeigt Änderungen SOFORT (kein Warten auf den Pages-Build).
  async function apiJson(relPfad){
    if (!repoKonfiguriert()) return null;
    try {
      const h = { "Accept":"application/vnd.github.raw+json" };
      const t = getToken(); if (t) h["Authorization"] = "Bearer " + t;
      const r = await fetch(apiUrl(relPfad) + `?ref=${CFG.branch}&t=${Date.now()}`, { headers:h, cache:"no-store" });
      if (r.ok) return await r.json();
    } catch(e){ /* Fallback beim Aufrufer */ }
    return null;
  }
  async function frischHolen(relPfad){
    return (await apiJson(relPfad)) || jsonHolen(relPfad);
  }

  /* ---------- Schnell-Laden: sofort anzeigen, im Hintergrund auffrischen ----------
     Reihenfolge: 1) letzter Schnappschuss aus localStorage (0 ms)
                  2) gehostete Datei (CDN, schnell)
                  3) GitHub-API (garantiert frisch, gewinnt immer)
     cb wird nur aufgerufen, wenn sich der Inhalt tatsächlich geändert hat.        */
  const LS_CACHE = "sammlung_schnappschuss";
  function cacheLesen(p){
    try { return (JSON.parse(localStorage.getItem(LS_CACHE)||"{}"))[p] || null; } catch(e){ return null; }
  }
  function cacheSchreiben(p, data){
    try {
      const s = JSON.stringify(data);
      if (s.length > 400000) return; // große Übersichten (Bilder) nicht snapshotten
      const c = JSON.parse(localStorage.getItem(LS_CACHE)||"{}");
      c[p] = data; localStorage.setItem(LS_CACHE, JSON.stringify(c));
    } catch(e){ /* Quota voll o. ä. — Schnappschuss ist optional */ }
  }
  function lebendLaden(relPfad, cb){
    let stand = "", apiDa = false;
    const liefern = (d, vonApi) => {
      if (!d) return;
      if (apiDa && !vonApi) return;           // langsamere, ältere Quelle überschreibt keine API-Daten
      if (vonApi) apiDa = true;
      const s = JSON.stringify(d);
      if (s === stand) return;                // nichts Neues → kein Neuzeichnen
      stand = s; cacheSchreiben(relPfad, d); cb(d);
    };
    const c = cacheLesen(relPfad);
    if (c) liefern(c, false);
    jsonHolen(relPfad).then(d => liefern(d, false));
    apiJson(relPfad).then(d => liefern(d, true));
  }
  async function indexLaden(){   // Übersichten
    return (await frischHolen("docs-data/index.json")) || { docs: [] };
  }
  async function manifestLaden(){ // Trainer
    return (await frischHolen("trainer/manifest.json")) || { trainer: [] };
  }
  async function docLaden(id){
    // 1. frisch (API) bzw. veröffentlicht, 2. lokaler Entwurf
    const pub = await frischHolen(`docs-data/${id}.json`);
    if (pub) return pub;
    return lokaleDocs()[id] || null;
  }

  /* ---------- Übersicht speichern (Index mitpflegen) ---------- */
  async function docSpeichern(doc){
    doc.stand = new Date().toISOString().slice(0,10);
    if (schreibmodus() === "github"){
      await ghSchreiben(`docs-data/${doc.id}.json`, JSON.stringify(doc, null, 1), `Übersicht: ${doc.titel}`);
      const idxRaw = await ghLesen("docs-data/index.json");
      const idx = idxRaw ? JSON.parse(idxRaw.text) : { docs: [] };
      const eintrag = { id:doc.id, titel:doc.titel, untertitel:doc.untertitel||"", stand:doc.stand };
      const i = idx.docs.findIndex(d=>d.id===doc.id);
      if (i>=0) idx.docs[i] = eintrag; else idx.docs.unshift(eintrag);
      await ghSchreiben("docs-data/index.json", JSON.stringify(idx, null, 1), `Index: ${doc.titel}`);
      lokalLoeschen(doc.id); // Entwurf ist jetzt veröffentlicht
      return "github";
    } else {
      lokalSpeichern(doc);
      return "lokal";
    }
  }
  async function docEntfernen(id){
    if (schreibmodus() === "github"){
      await ghLoeschen(`docs-data/${id}.json`, `Übersicht gelöscht: ${id}`);
      const idxRaw = await ghLesen("docs-data/index.json");
      if (idxRaw){
        const idx = JSON.parse(idxRaw.text);
        idx.docs = idx.docs.filter(d=>d.id!==id);
        await ghSchreiben("docs-data/index.json", JSON.stringify(idx, null, 1), `Index: ${id} entfernt`);
      }
    }
    lokalLoeschen(id);
  }

  /* ---------- Trainer per Browser hochladen ---------- */
  async function trainerHochladen(datei, titel, beschreibung){
    if (schreibmodus() !== "github") throw new Error("Dafür bitte einloggen (GitHub-Modus).");
    const name = datei.name.replace(/[^\w.\-äöüÄÖÜß]/g,"_");
    const b64 = await new Promise((res,rej)=>{
      const fr = new FileReader();
      fr.onload = ()=>res(String(fr.result).split(",")[1]);
      fr.onerror = ()=>rej(new Error("Datei konnte nicht gelesen werden."));
      fr.readAsDataURL(datei);
    });
    await ghSchreiben(`trainer/${name}`, b64, `Trainer hinzugefügt: ${name}`, true);
    if (!titel) return; // Begleitdatei (z. B. .js): nur ablegen, nicht ins Manifest
    const mRaw = await ghLesen("trainer/manifest.json");
    const m = mRaw ? JSON.parse(mRaw.text) : { trainer: [] };
    m.trainer.push({ datei:`trainer/${name}`, titel: titel||name, beschreibung: beschreibung||"" });
    await ghSchreiben("trainer/manifest.json", JSON.stringify(m, null, 1), `Manifest: ${titel||name}`);
  }

  /* ---------- Slug ---------- */
  function slug(s){
    return (s||"uebersicht").toLowerCase()
      .replace(/ä/g,"ae").replace(/ö/g,"oe").replace(/ü/g,"ue").replace(/ß/g,"ss")
      .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60) || "uebersicht";
  }

  /* ---------- Rendering der Blöcke (Viewer & Druck) ---------- */
  const ABSTAENDE = { "0":"0px", "s":"6px", "m":"14px", "l":"28px", "xl":"48px" };
  function abstandPx(block, standard){
    return ABSTAENDE[(block && block.abstand) || standard || "m"] || ABSTAENDE.m;
  }
  function esc(s){ const d=document.createElement("div"); d.textContent=s||""; return d.innerHTML; }
  function renderDoc(doc, ziel){
    ziel.innerHTML = "";
    const art = document.createElement("article");
    art.className = "blatt";
    art.innerHTML = `
      <div class="druck-abstand oben" aria-hidden="true"><div></div></div>
      <header class="blatt-kopf">
        <div class="eyebrow">Übersicht · Stand ${esc(doc.stand||"")}</div>
        <h1>${esc(doc.titel||"Ohne Titel")}</h1>
        ${doc.untertitel ? `<p class="untertitel">${esc(doc.untertitel)}</p>` : ""}
      </header>`;
    (doc.bloecke||[]).forEach(b=> art.appendChild(renderBlock(b, doc.abstand)));
    const fuss = document.createElement("div");
    fuss.className = "druck-abstand unten";
    fuss.setAttribute("aria-hidden","true");
    fuss.innerHTML = "<div></div>";
    art.appendChild(fuss);
    ziel.appendChild(art);
  }
  function renderBlock(b, standardAbstand){
    const el = document.createElement("div");
    el.className = "blk blk-" + b.typ;
    el.style.marginBottom = abstandPx(b, standardAbstand);
    switch(b.typ){
      case "h2":     el.innerHTML = `<h2>${b.html||""}</h2>`; break;
      case "h3":     el.innerHTML = `<h3>${b.html||""}</h3>`; break;
      case "absatz": el.innerHTML = `<div class="fliess">${b.html||""}</div>`; break;
      case "liste":  el.innerHTML = b.geordnet ? `<ol>${b.html||""}</ol>` : `<ul>${b.html||""}</ul>`; break;
      case "formel": el.innerHTML = `<div class="formel">${b.html||""}</div>`; break;
      case "tabelle":el.innerHTML = `<div class="tabelle-huelle"><table>${b.html||""}</table></div>`; break;
      case "box":    el.innerHTML = `<div class="box box-${b.variante||"info"}"><div class="box-label">${boxLabel(b.variante)}</div><div>${b.html||""}</div></div>`; break;
      case "code": {
        el.innerHTML = `<div class="codeblock"><span class="code-label">${CODE_SPRACHEN[b.sprache]||"Code"}</span><pre><code>${codeHighlight(b.text, b.sprache)}</code></pre></div>`;
        if (b.sprache === "js" && b.ausfuehrbar){
          const huelle = document.createElement("div");
          huelle.className = "code-lauf-huelle kein-druck";
          huelle.innerHTML = `<button class="btn klein lauf-btn" type="button">▶ Ausführen</button><div class="lauf-ziel"></div>`;
          huelle.querySelector(".lauf-btn").addEventListener("click", () =>
            codeAusfuehren(b.text, huelle.querySelector(".lauf-ziel")));
          el.appendChild(huelle);
        }
        break;
      }
      case "diagramm": el.innerHTML = `<div class="diagramm">${diagrammSvg(b)}</div>`; break;
      case "spalten":el.innerHTML = `<div class="spalten"><div class="spalte">${b.links||""}</div><div class="spalte">${b.rechts||""}</div></div>`; break;
      case "bild":   el.innerHTML = `<figure><img src="${b.src||""}" alt="${esc(b.unterschrift||"")}" style="width:${b.breite||100}%">${b.unterschrift?`<figcaption>${esc(b.unterschrift)}</figcaption>`:""}</figure>`; break;
      case "linie":  el.innerHTML = `<hr>`; break;
      default:       el.innerHTML = `<p>${b.html||""}</p>`;
    }
    return el;
  }
  function boxLabel(v){
    return {info:"Info", merke:"Merke", achtung:"Achtung", beispiel:"Beispiel"}[v] || "Info";
  }

  /* ---------- Leichter Syntax-Highlighter (kein externes Paket nötig) ---------- */
  const RE_JS = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|async|await|typeof|instanceof|null|undefined|true|false|this|of|in)\b)|(\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b)/g;
  const RE_C  = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(^[ \t]*#[ \t]*\w+[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b(?:int|char|float|double|void|long|short|unsigned|signed|struct|typedef|enum|union|static|const|volatile|return|if|else|for|while|do|switch|case|break|continue|sizeof|default|goto|extern|NULL|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|bool|true|false)\b)|(\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b)/gm;
  function codeHighlight(text, sprache){
    const s = esc(text || "");
    const span = (cls, m) => `<span class="${cls}">${m}</span>`;
    if (sprache === "html"){
      return s.replace(/(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[a-zA-Z][^&]*?&gt;)|("(?:[^"\\\n]|\\.)*")/g,
        (m, com, tag, str) => com ? span("c-com", m) : tag ? span("c-kw", m) : span("c-str", m));
    }
    if (sprache === "js" || sprache === "c"){
      return s.replace(sprache === "js" ? RE_JS : RE_C, (m, com, a, b2, c2, d2) => {
        if (com) return span("c-com", m);
        if (sprache === "c"){
          if (a)  return span("c-kw",  m);  // Präprozessor (#include, #define …)
          if (b2) return span("c-str", m);
          if (c2) return span("c-kw",  m);
          if (d2) return span("c-num", m);
        } else {
          if (a)  return span("c-str", m);
          if (b2) return span("c-kw",  m);
          if (c2) return span("c-num", m);
        }
        return m;
      });
    }
    return s; // "anderes": nur monospaced, keine Farben
  }
  const CODE_SPRACHEN = { c:"C", js:"JavaScript", html:"HTML", andere:"Code" };

  /* ---------- Diagramm: abhängigkeitsfreier Funktionsplotter (SVG) ---------- */
  function funktionKompilieren(ausdruck){
    let s = String(ausdruck||"").trim();
    if (!s || !/^[-+*/^().,0-9x\sA-Za-z]*$/.test(s)) return null;
    s = s.replace(/\^/g, "**");
    s = s.replace(/\b(sin|cos|tan|asin|acos|atan|sinh|cosh|tanh|exp|log10|log2|log|sqrt|abs|min|max|floor|ceil|round|sign|pow)\b/gi, m => "Math." + m.toLowerCase());
    s = s.replace(/\bpi\b/gi, "Math.PI").replace(/\be\b/g, "Math.E");
    try { const f = new Function("x", `"use strict"; return (${s});`); f(0.123); return f; }
    catch(err){ return null; }
  }
  function niceStep(roh){
    const pow = Math.pow(10, Math.floor(Math.log10(roh)));
    const n = roh / pow;
    return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
  }
  function fmtZahl(v){
    if (Math.abs(v) < 1e-12) return "0";
    const s = (Math.abs(v) >= 1e4 || Math.abs(v) < 1e-3) ? v.toExponential(1) : String(+v.toFixed(3));
    return s.replace(".", ",");
  }
  function diagrammSvg(b){
    const W = 640, H = Math.max(160, +b.hoehe || 280);
    const pad = { l:48, r:14, t:12, b:28 };
    let xmin = isFinite(+b.xmin) ? +b.xmin : -10;
    let xmax = isFinite(+b.xmax) ? +b.xmax : 10;
    if (xmax <= xmin) xmax = xmin + 1;
    const farben = ["#0f7c44", "#0b7a8c", "#d98a1f", "#5f3dc4", "#d6453d"];
    const zeilen = String(b.funktionen||"").split("\n").map(z => z.trim()).filter(Boolean);
    const fns = zeilen.map(z => ({ z, f: funktionKompilieren(z) }));

    // Abtasten + y-Bereich bestimmen
    const N = 400;
    let ymin = Infinity, ymax = -Infinity;
    const daten = fns.map(o => {
      if (!o.f) return null;
      const pts = [];
      for (let i = 0; i <= N; i++){
        const x = xmin + (xmax - xmin) * i / N;
        let y; try { y = o.f(x); } catch(err){ y = NaN; }
        pts.push([x, y]);
        if (isFinite(y)){ ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
      }
      return pts;
    });
    if (!isFinite(ymin)){ ymin = -1; ymax = 1; }
    if (ymin === ymax){ ymin -= 1; ymax += 1; }
    const spann = ymax - ymin; ymin -= spann * 0.08; ymax += spann * 0.08;

    const sx = x => pad.l + (x - xmin) / (xmax - xmin) * (W - pad.l - pad.r);
    const sy = y => H - pad.b - (y - ymin) / (ymax - ymin) * (H - pad.t - pad.b);

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" style="width:100%;height:auto;display:block">`;
    svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fcfdfe"/>`;

    // Raster + Beschriftung
    const xs = niceStep((xmax - xmin) / 6), ys = niceStep((ymax - ymin) / 5);
    for (let gx = Math.ceil(xmin / xs) * xs; gx <= xmax + 1e-9; gx += xs){
      svg += `<line x1="${sx(gx)}" y1="${pad.t}" x2="${sx(gx)}" y2="${H - pad.b}" stroke="#e3e8ed" stroke-width="1"/>`;
      svg += `<text x="${sx(gx)}" y="${H - pad.b + 15}" font-size="10" font-family="JetBrains Mono,monospace" fill="#55606a" text-anchor="middle">${fmtZahl(gx)}</text>`;
    }
    for (let gy = Math.ceil(ymin / ys) * ys; gy <= ymax + 1e-9; gy += ys){
      svg += `<line x1="${pad.l}" y1="${sy(gy)}" x2="${W - pad.r}" y2="${sy(gy)}" stroke="#e3e8ed" stroke-width="1"/>`;
      svg += `<text x="${pad.l - 6}" y="${sy(gy) + 3.5}" font-size="10" font-family="JetBrains Mono,monospace" fill="#55606a" text-anchor="end">${fmtZahl(gy)}</text>`;
    }
    // Nullachsen
    if (ymin < 0 && ymax > 0) svg += `<line x1="${pad.l}" y1="${sy(0)}" x2="${W - pad.r}" y2="${sy(0)}" stroke="#9aa6af" stroke-width="1.3"/>`;
    if (xmin < 0 && xmax > 0) svg += `<line x1="${sx(0)}" y1="${pad.t}" x2="${sx(0)}" y2="${H - pad.b}" stroke="#9aa6af" stroke-width="1.3"/>`;

    // Kurven (bei Unendlichkeiten/Sprüngen Pfad unterbrechen)
    daten.forEach((pts, i) => {
      if (!pts) return;
      let d = "", offen = false;
      pts.forEach(([x, y]) => {
        if (!isFinite(y) || y < ymin - spann || y > ymax + spann){ offen = false; return; }
        d += (offen ? "L" : "M") + sx(x).toFixed(1) + " " + sy(y).toFixed(1);
        offen = true;
      });
      svg += `<path d="${d}" fill="none" stroke="${farben[i % farben.length]}" stroke-width="1.8" stroke-linejoin="round"/>`;
    });

    // Legende
    fns.forEach((o, i) => {
      const farbe = o.f ? farben[i % farben.length] : "#d6453d";
      const label = o.f ? "f(x) = " + o.z : "⚠ ungültig: " + o.z;
      svg += `<text x="${pad.l + 8}" y="${pad.t + 14 + i * 15}" font-size="11" font-family="JetBrains Mono,monospace" fill="${farbe}" font-weight="700">${esc(label)}</text>`;
    });
    svg += `</svg>`;
    return svg;
  }

  /* ---------- Ausführbarer JS-Code (Sandbox-iframe, kein Zugriff auf Token/Seite) ---------- */
  function codeAusfuehren(codeText, ziel){
    ziel.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts"); // eigene Origin: kein localStorage/Token erreichbar
    iframe.className = "code-lauf";
    const sicher = String(codeText||"").replace(/<\/script/gi, "<\\/script");
    iframe.srcdoc = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;font:12.5px/1.55 "JetBrains Mono",ui-monospace,Menlo,monospace;color:#1a2024;background:#fff}
canvas{display:none;max-width:100%;border-bottom:1px solid #e3e8ed}
#log{padding:9px 12px;white-space:pre-wrap;word-break:break-word}
#log .err{color:#d6453d}</style>
<canvas id="cv" width="600" height="300"></canvas><div id="log"></div>
<script>
const log = document.getElementById("log"), canvas = document.getElementById("cv");
let _ctx = null;
Object.defineProperty(window, "ctx", { get(){ canvas.style.display = "block"; if(!_ctx) _ctx = canvas.getContext("2d"); return _ctx; } });
function schreib(cls, args){ const d = document.createElement("div"); if (cls) d.className = cls;
  d.textContent = args.map(a => { try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch(e){ return String(a); } }).join(" ");
  log.appendChild(d); }
console.log = (...a) => schreib("", a); console.warn = console.log;
console.error = (...a) => schreib("err", a);
window.onerror = (m, s, l) => { schreib("err", ["⚠ " + m + (l ? " (Zeile " + l + ")" : "")]); };
try { (function(){ "use strict";
${sicher}
})(); } catch(e){ schreib("err", ["⚠ " + e.message]); }
if (!log.childNodes.length && canvas.style.display === "none")
  schreib("", ["(keine Ausgabe — console.log(…) schreibt hierher, ctx zeichnet auf die Fläche)"]);
<\/script>`;
    ziel.appendChild(iframe);
  }

  /* ---------- Export ---------- */
  window.Sammlung = {
    CFG, repoKonfiguriert, getToken, setToken, eingeloggt, schreibmodus, tokenPruefen,
    indexLaden, manifestLaden, docLaden, docSpeichern, docEntfernen, lebendLaden,
    lokaleDocs, lokalSpeichern, lokalLoeschen,
    trainerHochladen, slug, renderDoc, renderBlock, esc, ABSTAENDE, abstandPx, codeHighlight, CODE_SPRACHEN, diagrammSvg, codeAusfuehren,
  };
})();
