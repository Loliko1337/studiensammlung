/* ============================================================
   lti-systems.js  ·  gemeinsamer Glieder-Generator
   Wird von index.html (Quiz) und lti-explorer.html geladen.
   KEIN ES-Modul (läuft auch lokal per file://): setzt window.LTI.
   ============================================================ */
(function(global){
"use strict";

/* ---------- komplexe & Polynom-Helfer ---------- */
const C={
  add:(a,b)=>[a[0]+b[0],a[1]+b[1]], sub:(a,b)=>[a[0]-b[0],a[1]-b[1]],
  mul:(a,b)=>[a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]],
  div:(a,b)=>{const d=b[0]*b[0]+b[1]*b[1];return[(a[0]*b[0]+a[1]*b[1])/d,(a[1]*b[0]-a[0]*b[1])/d];},
  exp:(a)=>{const e=Math.exp(a[0]);return[e*Math.cos(a[1]),e*Math.sin(a[1])];},
  abs:(a)=>Math.hypot(a[0],a[1]), arg:(a)=>Math.atan2(a[1],a[0])
};
const conv=(a,b)=>{const r=Array(a.length+b.length-1).fill(0);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)r[i+j]+=a[i]*b[j];return r;};
const cevalC=(c,s)=>{let r=[0,0];for(let i=c.length-1;i>=0;i--)r=C.add(C.mul(r,s),[c[i]||0,0]);return r;};
function longDiv(num,den){num=num.slice();const dlead=den[den.length-1];
  let q=Array(Math.max(0,num.length-den.length)+1).fill(0);
  for(let k=num.length-1;k>=den.length-1;k--){const c=num[k]/dlead;q[k-(den.length-1)]=c;
    for(let j=0;j<den.length;j++)num[k-(den.length-1)+j]-=c*den[j];}
  while(num.length>1&&Math.abs(num[num.length-1])<1e-12)num.pop();return{q,r:num};}
const fact=n=>{let f=1;for(let i=2;i<=n;i++)f*=i;return f;};

/* ---------- Standard-Parameter & Slider-Metadaten ---------- */
const DEF={K:2, KI:1, KD:1, T:1, T1:2, T2:0.5, D:0.5, TI:1, TD:3, Tt:1};
const PM={
  K :{label:"K",   min:0.2,max:5,  step:0.1, unit:""},
  KI:{label:"K_I", min:0.2,max:5,  step:0.1, unit:" 1/s"},
  KD:{label:"K_D", min:0.2,max:5,  step:0.1, unit:" s"},
  T :{label:"T",   min:0.2,max:5,  step:0.1, unit:" s"},
  T1:{label:"T_1", min:0.2,max:5,  step:0.1, unit:" s"},
  T2:{label:"T_2", min:0.2,max:5,  step:0.1, unit:" s"},
  D :{label:"D",   min:0.05,max:2, step:0.05,unit:""},
  TI:{label:"T_I", min:0.2,max:5,  step:0.1, unit:" s"},
  TD:{label:"T_D", min:0.2,max:5,  step:0.1, unit:" s"},
  Tt:{label:"T_t", min:0.2,max:5,  step:0.1, unit:" s"}
};

/* ---------- Symbol-Rendering ---------- */
const SUB={"1":"₁","2":"₂","t":"ₜ","I":"_I","D":"_D"};
function sym(name){ // 'T1'->'T₁', 'Tt'->'Tₜ', 'TI'->'T_I', 'KD'->'K_D'
  if(name.length===1) return name;
  const head=name[0], tail=name.slice(1);
  if(tail==="1")return head+"₁"; if(tail==="2")return head+"₂"; if(tail==="t")return head+"ₜ";
  return head+"_"+tail; // T_I, K_D ...
}

/* ---------- Rezept -> numerische Realisierung ---------- */
function gainVal(rec,p){ return (typeof rec.gain==="function")? rec.gain(p) : p[rec.gain||"K"]; }
function realize(rec,p){
  const K=gainVal(rec,p);
  let num=[K], den=[1]; const poles=[], zeros=[];
  const o=rec.origin||0;
  for(let i=0;i<Math.max(0,-o);i++){den=conv(den,[0,1]);poles.push([0,0]);}
  for(let i=0;i<Math.max(0, o);i++){num=conv(num,[0,1]);zeros.push([0,0]);}
  let lagTs=(rec.lags||[]).map(n=>p[n]);
  for(let i=0;i<lagTs.length;i++)for(let j=0;j<i;j++)if(Math.abs(lagTs[i]-lagTs[j])<1e-9)lagTs[i]*=1.0007;
  lagTs.forEach(T=>{den=conv(den,[1,T]);poles.push([-1/T,0]);});
  if(rec.pt2){const T=p[rec.pt2.T],D=p[rec.pt2.D]; den=conv(den,[1,2*D*T,T*T]);
    if(D<1){const re=-D/T,im=Math.sqrt(1-D*D)/T;poles.push([re,im],[re,-im]);}
    else{const r=Math.sqrt(D*D-1);poles.push([(-D+r)/T,0],[(-D-r)/T,0]);}}
  (rec.leads||[]).forEach(n=>{const T=p[n];num=conv(num,[1,T]);zeros.push([-1/T,0]);});
  (rec.aps||[]).forEach(n=>{const T=p[n];num=conv(num,[1,-T]);zeros.push([1/T,0]);});
  const dead=rec.dead?p[rec.dead]:0;
  return {num,den,poles,zeros,dead,K};
}

/* ---------- Klassifikation ---------- */
function classify(rec){
  const o=rec.origin||0;
  const nLag=(rec.lags?rec.lags.length:0)+(rec.pt2?2:0);
  return {
    stat: o>0?"D":o<0?"I":"P",
    verz: nLag>0, verzOrd:nLag,
    vorhalt: (rec.leads?rec.leads.length:0)>0,
    allpass: (rec.aps?rec.aps.length:0)>0,
    tot: !!rec.dead
  };
}
function relDegImproper(rec){
  const o=rec.origin||0;
  const nZ=(o>0?o:0)+(rec.leads?rec.leads.length:0)+(rec.aps?rec.aps.length:0);
  const nP=(o<0?-o:0)+(rec.lags?rec.lags.length:0)+(rec.pt2?2:0);
  return nZ>nP; // strikt improper -> Impulsanteil
}

/* ---------- Übertragungsfunktion als Text ---------- */
function autoTF(rec){
  const numF=[], denF=[]; const o=rec.origin||0;
  const Ks=sym(rec.gain&&typeof rec.gain==="string"?rec.gain:"K");
  if(o>0) numF.push(o===1?"s":"s"+ (o===2?"²":"^"+o));
  (rec.leads||[]).forEach(n=>numF.push("(1 + "+sym(n)+"·s)"));
  (rec.aps||[]).forEach(n=>numF.push("(1 − "+sym(n)+"·s)"));
  if(o<0) denF.push((-o)===1?"s":"s"+((-o)===2?"²":"^"+(-o)));
  (rec.lags||[]).forEach(n=>denF.push("(1 + "+sym(n)+"·s)"));
  if(rec.pt2) denF.push("("+sym(rec.pt2.T)+"²s² + 2"+sym(rec.pt2.D)+sym(rec.pt2.T)+"·s + 1)");
  let s="G(s) = "+Ks;
  if(numF.length) s+=" · "+numF.join("");
  if(rec.dead) s+=" · e^(−"+sym(rec.dead)+"·s)";
  if(denF.length) s+=" / "+(denF.length>1?"( "+denF.join("")+" )":denF.join(""));
  return s;
}

/* ---------- automatischer Bezeichner (für gebaute/zufällige Glieder) ---------- */
function autoName(rec){
  const o=rec.origin||0;
  let core = o>0?(o===1?"D":"D"+o) : o<0?(o===-1?"I":"I"+(-o)) : "P";
  let s=core;
  const nLag1=rec.lags?rec.lags.length:0;
  if(rec.pt2){ s+="T2"+(p2complex(rec)?"*":""); if(nLag1) s+="T"+nLag1; }
  else if(nLag1) s+="T"+nLag1;
  const nv=rec.leads?rec.leads.length:0; if(nv) s+="Td"+nv;
  const na=rec.aps?rec.aps.length:0;     if(na) s+="AP"+(na>1?na:"");
  if(rec.dead) s+="Tt";
  return s;
}
function p2complex(rec){ return rec.pt2 ? (DEF[rec.pt2.D]<1) : false; }

/* ---------- params-Liste aus Rezept ---------- */
function paramsOf(rec){
  const set=[];
  const add=n=>{ if(n&&!set.includes(n)) set.push(n); };
  add(typeof rec.gain==="string"?rec.gain:"K");
  if(typeof rec.gain==="function"){ (rec.gainParams||[]).forEach(add); }
  (rec.lags||[]).forEach(add);
  if(rec.pt2){ add(rec.pt2.T); add(rec.pt2.D); }
  (rec.leads||[]).forEach(add);
  (rec.aps||[]).forEach(add);
  if(rec.dead) add(rec.dead);
  // sinnvolle Reihenfolge
  const order=["K","KI","KD","T","T1","T2","D","TI","TD","Tt"];
  return order.filter(n=>set.includes(n));
}

/* ---------- Sprungantwort-Fabrik (allgemein, numerisch exakt) ---------- */
function buildStep(rec,p){
  const R=realize(rec,p);
  let denY=conv(R.den,[0,1]);
  let numY=R.num.slice(), impulse=0;
  if(numY.length>=denY.length){const{q,r}=longDiv(numY,denY);impulse=q[0]||0;numY=r;}
  const cLead=denY[denY.length-1];
  const polesY=R.poles.concat([[0,0]]);
  const m=polesY.filter(z=>Math.abs(z[0])<1e-9&&Math.abs(z[1])<1e-9).length;
  const nz=polesY.filter(z=>!(Math.abs(z[0])<1e-9&&Math.abs(z[1])<1e-9))
                 .map(z=>z.slice());
  for(let i=0;i<nz.length;i++)for(let j=0;j<i;j++)
    if(Math.abs(nz[i][0]-nz[j][0])<1e-7&&Math.abs(nz[i][1]-nz[j][1])<1e-7) nz[i][0]=nz[i][0]*1.0007-1e-4;
  // Nullpol-Beitrag (Polynom in t)
  const zeroPoly=[];
  if(m>0){const Drest=denY.slice(m);const g=[];
    for(let n=0;n<m;n++){let s=(numY[n]||0);for(let k=1;k<=n;k++)s-=(Drest[k]||0)*g[n-k];g.push(s/Drest[0]);}
    for(let n=0;n<m;n++) zeroPoly.push({coef:g[n],pow:m-n-1});}
  // einfache Residuen der Nicht-Null-Pole
  const allP=nz.concat(Array.from({length:m},()=>[0,0]));
  const res=nz.map((pk)=>{const nv=cevalC(numY,pk);let prod=[1,0];
    allP.forEach((pj)=>{if(pj!==pk)prod=C.mul(prod,C.sub(pk,pj));});
    return C.div(nv,C.mul([cLead,0],prod));});
  const dead=R.dead;
  const fn=(t)=>{const tt=t-dead;if(tt<0)return 0;let h=0;
    zeroPoly.forEach(z=>h+=z.coef*Math.pow(tt,z.pow)/fact(z.pow));
    for(let k=0;k<nz.length;k++){const e=C.exp([nz[k][0]*tt,nz[k][1]*tt]);h+=res[k][0]*e[0]-res[k][1]*e[1];}
    return h;};
  fn.impulse=impulse; fn.dead=dead;
  return fn;
}

/* ---------- compose: Rezept -> vollständiges System-Objekt ---------- */
function compose(rec){
  const cls=classify(rec);
  const improper=relDegImproper(rec);
  // Caches je Parametersatz
  let cacheKey=null, R=null, stepFn=null;
  const ensure=(p)=>{const key=JSON.stringify(p);
    if(key!==cacheKey){cacheKey=key;R=realize(rec,p);stepFn=buildStep(rec,p);}};
  const sys={
    id:rec.id, name:rec.name||autoName(rec), aliases:rec.aliases||[],
    level:rec.level||"erw", note:rec.note||"",
    recipe:rec, params:paramsOf(rec),
    tf: rec.tf || autoTF(rec),
    stat:cls.stat, verz:cls.verz, verzOrd:cls.verzOrd,
    vorhalt:cls.vorhalt, allpass:cls.allpass, tot:cls.tot,
    impulse:improper,
    G:(w,p)=>{ensure(p);
      let g=C.div(cevalC(R.num,[0,w]), cevalC(R.den,[0,w]));
      if(R.dead){const e=[Math.cos(w*R.dead),-Math.sin(w*R.dead)];g=C.mul(g,e);}
      return g;},
    step:(t,p)=>{ensure(p);return stepFn(t);},
    stepImpulse:(p)=>{ensure(p);return stepFn.impulse;},
    poles:(p)=>{ensure(p);return R.poles.map(z=>z.slice());},
    zeros:(p)=>{ensure(p);return R.zeros.map(z=>z.slice());}
  };
  return sys;
}

/* ============================================================
   Benannter Katalog (29 Grund- & Erweiterungsglieder)
   ============================================================ */
const G0={level:"grund"}, GE={level:"erw"};
function R(o){return o;}
const RECIPES=[
  /* Grundglieder */
  {id:"P",  name:"P",  level:"grund", origin:0, gain:"K",
   note:"Reines P-Glied: konstante Verstärkung, keine Dynamik."},
  {id:"I",  name:"I",  level:"grund", origin:-1, gain:"KI",
   note:"Integrierer: Pol im Ursprung, Betrag −20 dB/Dek., Phase −90°, Sprungantwort = Rampe."},
  {id:"D",  name:"D",  level:"grund", origin:1, gain:"KD",
   note:"Idealer Differenzierer: Nullstelle im Ursprung, +20 dB/Dek., Phase +90°, Sprungantwort = Impuls."},
  {id:"PT1",name:"PT1",level:"grund", origin:0, gain:"K", lags:["T"],
   note:"Verzögerung 1. Ordnung: ein Pol, −20 dB/Dek. ab Knickfrequenz, Phase 0→−90°."},
  {id:"PT2",name:"PT2",level:"grund", origin:0, gain:"K", pt2:{T:"T",D:"D"},
   note:"Verzögerung 2. Ordnung (schwingungsfähig bei D<1): −40 dB/Dek., Resonanz, Phase 0→−180°."},
  {id:"Tt", name:"Tt", level:"grund", origin:0, gain:"K", dead:"Tt",
   note:"Reine Totzeit: |G|=K konstant, Phase fällt linear/unbegrenzt, Sprung um Tₜ verschoben."},
  {id:"PD", name:"PTd1",level:"grund", origin:0, gain:"K", leads:["TD"],
   note:"P mit Vorhalt (idealer PD): +1-Knick, Phase nach oben, Sprungantwort mit Impuls + Sprung auf K."},
  {id:"PI", name:"PI", level:"grund", origin:-1, gain:(p)=>p.K/p.TI, gainParams:["K","TI"], leads:["TI"],
   note:"PI-Regler: Integrierer mit Vorhalt, stat. I-Verhalten, Sprungantwort steigt rampenartig ab Sprung."},
  {id:"DT1",name:"DT1",level:"grund", origin:1, gain:"KD", lags:["T"],
   note:"Realer Differenzierer: D-Verhalten mit Verzögerung, Sprungantwort springt und klingt ab."},
  {id:"IT1",name:"IT1",level:"grund", origin:-1, gain:"KI", lags:["T"],
   note:"Integrierer mit Verzögerung: Rampe mit verzögertem Anlauf."},
  /* Erweiterte Glieder */
  {id:"PT1Tt",name:"PT1Tt",level:"erw", origin:0, gain:"K", lags:["T"], dead:"Tt",
   note:"PT1 mit Totzeit: verzögerter Anstieg, um Tₜ nach rechts verschoben; Phase fällt unbegrenzt."},
  {id:"PID",name:"PID",level:"erw", origin:-1, gain:(p)=>p.K/p.TI, gainParams:["K","TI","TD"], leads:["TD","TI"],
   note:"PID-Regler: I-Verhalten stationär, Vorhalt durch P- und D-Anteil; Sprungantwort mit Impuls."},
  {id:"PDTt",name:"PTd1Tt",level:"erw", origin:0, gain:"K", leads:["TD"], dead:"Tt",
   note:"PD mit Totzeit: Vorhalt + Laufzeit, Phase erst nach oben, dann unbegrenzt fallend."},
  {id:"PT2Tt",name:"PT2Tt",level:"erw", origin:0, gain:"K", pt2:{T:"T",D:"D"}, dead:"Tt",
   note:"PT2 mit Totzeit: Resonanz + verschobener Start, Phase fällt durch Totzeit unbegrenzt."},
  {id:"PDT1",name:"PTd1T1",level:"erw", origin:0, gain:"K", lags:["T1"], leads:["TD"],
   note:"P mit Verzögerung und Vorhalt: +1- und −1-Knick, je nach Lage der Knickfrequenzen."},
  {id:"PIDT1",name:"PIDT1",level:"erw", origin:-1, gain:(p)=>p.K/p.TI, gainParams:["K","TI","TD"], leads:["TD","TI"], lags:["T1"],
   note:"Realer PID (mit Filterpol): I stationär, Vorhalt und zusätzliche Verzögerung."},
  {id:"PITt",name:"PITt",level:"erw", origin:-1, gain:(p)=>p.K/p.TI, gainParams:["K","TI"], leads:["TI"], dead:"Tt",
   note:"PI mit Totzeit."},
  {id:"PDT1Tt",name:"PTd1T1Tt",level:"erw", origin:0, gain:"K", lags:["T1"], leads:["TD"], dead:"Tt",
   note:"P mit Verzögerung, Vorhalt und Totzeit – die volle P-Kombination (Klausur-Beispiel)."},
  {id:"IT1T01",name:"IT1T01",level:"erw", origin:-1, gain:"KI", lags:["T1"], leads:["T2"],
   note:"Integrierer mit Verzögerung und Vorhalt."},
  {id:"DTt",name:"DTt",level:"erw", origin:1, gain:"KD", dead:"Tt",
   note:"Differenzierer mit Totzeit: Impuls um Tₜ verschoben."},
  {id:"DT1Tt",name:"DT1Tt",level:"erw", origin:1, gain:"KD", lags:["T"], dead:"Tt",
   note:"Realer Differenzierer mit Totzeit."},
  {id:"IT1Tt",name:"IT1Tt",level:"erw", origin:-1, gain:"KI", lags:["T"], dead:"Tt",
   note:"Integrierer mit Verzögerung und Totzeit."},
  {id:"PIDTt",name:"PIDTt",level:"erw", origin:-1, gain:(p)=>p.K/p.TI, gainParams:["K","TI","TD"], leads:["TD","TI"], dead:"Tt",
   note:"PID mit Totzeit."},
  {id:"PIDT1Tt",name:"PIDT1Tt",level:"erw", origin:-1, gain:(p)=>p.K/p.TI, gainParams:["K","TI","TD"], leads:["TD","TI"], lags:["T1"], dead:"Tt",
   note:"Realer PID mit Totzeit."},
  {id:"PT2Td",name:"PT2Td",level:"erw", origin:0, gain:"K", pt2:{T:"T",D:"D"}, leads:["TD"],
   note:"P mit Verzögerung 2. Ordnung und Vorhalt (Klausur 4-3c)."},
  {id:"DT2",name:"DT2",level:"erw", origin:1, gain:"KD", pt2:{T:"T",D:"D"},
   note:"Differenzierer mit Verzögerung 2. Ordnung (Klausur 4-4a)."},
  {id:"ITt",name:"ITt",level:"erw", origin:-1, gain:"KI", dead:"Tt",
   note:"Integrierer mit Totzeit: Rampe um Tₜ verschoben, Phase ab −90° unbegrenzt fallend."},
  {id:"AP",name:"Allpass",level:"erw", origin:0, gain:"K", lags:["T"], aps:["T"],
   aliases:["ALLPASS","AP","ALLPASS1","ALLPASS1ORDNUNG"],
   note:"Reiner Allpass 1. Ordnung: |G|=K konstant (−1-Knick des Pols und +1-Knick der rechtsseitigen Nullstelle heben sich auf), Phase 0→−180°. Nichtminimalphasig ⇒ Sprungantwort schwingt zuerst in die Gegenrichtung."},
  {id:"PT1AP",name:"PT1Allpass",level:"erw", origin:0, gain:"K", lags:["T","T1"], aps:["T"],
   aliases:["PT1ALLPASS","PT1AP","APPT1","PT1MITALLPASS"],
   note:"PT1 mit Allpass 1. Ordnung (Klausur 4-3a): Betrag rollt wie PT1 ab, rechtsseitige Nullstelle dreht die Phase zusätzlich um −180°, Sprungantwort mit Anfangs-Unterschwinger."}
];

const CAT=RECIPES.map(compose);
const byId={}; CAT.forEach(s=>byId[s.id]=s);

/* ---------- zufälliges Rezept aus dem gesamten Raum ---------- */
function randomRecipe(opts){
  opts=opts||{};
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  const origin=pick([0,0,0,-1,-1,1]); // P häufiger
  const rec={origin, gain: origin>0?"KD":origin<0?"KI":"K"};
  const nLag=pick([0,1,1,2]);
  if(nLag===2 && Math.random()<0.5){ rec.pt2={T:"T",D:"D"}; }
  else if(nLag>0){ const names=["T","T1"]; rec.lags=names.slice(0,nLag); }
  if(Math.random()<0.45){ rec.leads=[pick(["TD","T2"])]; }
  if(Math.random()<0.18 && !rec.aps){ rec.aps=["T"]; if(!(rec.lags&&rec.lags.length)&&!rec.pt2) rec.lags=["T"]; }
  if(Math.random()<0.35){ rec.dead="Tt"; }
  // I-Regler mit Vorhalt brauchen sinnvollen Gain
  if(origin<0 && rec.leads){ rec.gain=(p)=>p.K/p.TI; rec.gainParams=["K","TI"]; if(!rec.leads.includes("TI"))rec.leads=["TI"]; }
  rec.id="GEN_"+Math.random().toString(36).slice(2,8);
  return rec;
}

/* ---------- Quiz-Backen: parametrisches System -> feste Werte ---------- */
function bake(sys, p){
  p=p||DEF;
  const shift = sys.tot && sys.recipe && sys.recipe.dead ? (p[sys.recipe.dead]||0) : 0;
  return {
    id:sys.id, name:sys.name, aliases:sys.aliases, level:sys.level, note:sys.note,
    tf:sys.tf, stat:sys.stat, verz:sys.verz, vorhalt:sys.vorhalt, allpass:sys.allpass, tot:sys.tot,
    impulse:sys.impulse,
    impShift: shift,
    impBase: sys.impulse ? sys.step(shift+1e-6, p) : 0,
    G:(w)=>sys.G(w,p),
    step:(t)=>sys.step(t,p),
    poles:sys.poles(p),
    zeros:sys.zeros(p)
  };
}

/* ---------- Export ---------- */
global.LTI={
  C, DEF, PM, sym,
  compose, classify, autoTF, autoName, paramsOf, realize,
  RECIPES, CAT, byId, randomRecipe, bake
};
})(typeof window!=="undefined"?window:globalThis);
