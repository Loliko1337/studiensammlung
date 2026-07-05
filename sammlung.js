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
      case "code":   el.innerHTML = `<div class="codeblock"><span class="code-label">${CODE_SPRACHEN[b.sprache]||"Code"}</span><pre><code>${codeHighlight(b.text, b.sprache)}</code></pre></div>`; break;
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

  /* ---------- Export ---------- */
  window.Sammlung = {
    CFG, repoKonfiguriert, getToken, setToken, eingeloggt, schreibmodus, tokenPruefen,
    indexLaden, manifestLaden, docLaden, docSpeichern, docEntfernen, lebendLaden,
    lokaleDocs, lokalSpeichern, lokalLoeschen,
    trainerHochladen, slug, renderDoc, renderBlock, esc, ABSTAENDE, abstandPx, codeHighlight, CODE_SPRACHEN,
  };
})();
