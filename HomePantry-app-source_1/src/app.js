"use strict";
import { initializeApp } from "firebase/app";
import {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile
} from "firebase/auth";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, collection, getDoc, setDoc, updateDoc, deleteDoc, addDoc, onSnapshot, query, orderBy, limit, getDocs, increment
} from "firebase/firestore";
import { App as CapApp } from "@capacitor/app";
import { FIREBASE_CONFIG } from "./firebase-config.js";

/* ============ Constants & validation ============ */
const CATEGORIES = ["Rice & Grains","Atta & Flours","Dal & Pulses","Oil & Ghee","Spices & Masala","Dairy","Vegetables & Fruits","Snacks","Beverages","Breakfast","Cleaning","Personal care","Other"];
const UNITS = ["pcs","kg","g","L","ml","pack","bottle","dozen","box"];
const LIMITS = { name: 60, qty: 100000, price: 10000000, person: 40, household: 40 };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{32,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CFG_STORE = "hp.firebaseConfig";
const HH_STORE = "hp.householdId";

function str(v, max){ return (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max); }
function num(v, min, max, dflt){ const n = typeof v === "number" ? v : parseFloat(v); if (!Number.isFinite(n)) return dflt; return Math.min(max, Math.max(min, n)); }
function round3(n){ return Math.round(n * 1000) / 1000; }
function oneOf(v, list, dflt){ return list.includes(v) ? v : dflt; }
function store(k, v){ try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
function load(k){ try { return localStorage.getItem(k); } catch (e) { return null; } }
function randomSecret(){ const b = new Uint8Array(24); crypto.getRandomValues(b); return b64url(b); }
function b64url(bytes){ let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function fromB64url(s){ const t = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(t + "===".slice((t.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }

/* Firebase web config is public, but anything pasted in is untrusted: whitelist fields + formats. */
function cleanConfig(c){
  if (!c || typeof c !== "object") return null;
  const out = {
    apiKey: str(c.apiKey, 80), authDomain: str(c.authDomain, 120),
    projectId: str(c.projectId, 60), appId: str(c.appId, 120)
  };
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(out.apiKey)) return null;
  if (!/^[a-z0-9-]{4,60}$/.test(out.projectId)) return null;
  if (!/^[a-z0-9.-]{4,120}$/.test(out.authDomain)) return null;
  if (!/^[0-9]+:[0-9]+:[a-z]+:[0-9a-f]+$/.test(out.appId)) return null;
  return out;
}
function parseConfigText(text){
  const t = String(text || "").slice(0, 4000);
  // Accept raw JSON, or the JS object Firebase console shows (const firebaseConfig = {...})
  const pick = k => { const m = t.match(new RegExp("[\"']?" + k + "[\"']?\\s*:\\s*[\"']([^\"']{1,120})[\"']")); return m ? m[1] : ""; };
  return cleanConfig({ apiKey: pick("apiKey"), authDomain: pick("authDomain"), projectId: pick("projectId"), appId: pick("appId") });
}
function makeInvite(cfg, hid, secret){
  const payload = { v: 1, h: hid, s: secret };
  if (!FIREBASE_CONFIG) payload.c = { a: cfg.apiKey, d: cfg.authDomain, p: cfg.projectId, i: cfg.appId };
  return "HP1." + b64url(new TextEncoder().encode(JSON.stringify(payload)));
}
function parseInvite(text){
  const t = str(text, 2000).replace(/\s+/g, "");
  if (!/^HP1\.[A-Za-z0-9_-]{10,1500}$/.test(t)) return null;
  let p; try { p = JSON.parse(fromB64url(t.slice(4))); } catch (e) { return null; }
  if (!p || p.v !== 1 || !ID_RE.test(p.h) || !SECRET_RE.test(p.s)) return null;
  let cfg = null;
  if (p.c) cfg = cleanConfig({ apiKey: p.c.a, authDomain: p.c.d, projectId: p.c.p, appId: p.c.i });
  return { hid: p.h, secret: p.s, cfg };
}

/* Shared data is untrusted: normalise every doc read from the store. */
function cleanItem(id, d){
  if (!ID_RE.test(id) || !d) return null;
  const name = str(d.name, LIMITS.name); if (!name) return null;
  return {
    id, name, nameLower: name.toLowerCase(),
    category: oneOf(d.category, CATEGORIES, "Other"),
    unit: oneOf(d.unit, UNITS, "pcs"),
    qty: round3(num(d.qty, 0, LIMITS.qty, 0)),
    minQty: round3(num(d.minQty, 0, LIMITS.qty, 0)),
    useStep: round3(num(d.useStep, 0.001, LIMITS.qty, 1)),
    lastPrice: num(d.lastPrice, 0, LIMITS.price, 0)
  };
}
function cleanEvent(id, d){
  if (!d) return null;
  return {
    id, itemId: ID_RE.test(d.itemId) ? d.itemId : "",
    itemName: str(d.itemName, LIMITS.name) || "Item",
    category: oneOf(d.category, CATEGORIES, "Other"),
    unit: oneOf(d.unit, UNITS, "pcs"),
    type: oneOf(d.type, ["buy","use","adjust"], "use"),
    qty: round3(num(d.qty, -LIMITS.qty, LIMITS.qty, 0)),
    price: num(d.price, 0, LIMITS.price, 0),
    by: str(d.by, 128),
    at: num(d.at, 0, 1e15, 0)
  };
}

/* ============ Formatting ============ */
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
function fq(n){ return (Math.round(n * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
function monthKey(d){ d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
function monthLabel(k){ const [y, m] = k.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" }); }
function shiftMonth(k, delta){ const [y, m] = k.split("-").map(Number); return monthKey(new Date(y, m - 1 + delta, 1)); }
function dayLabel(ts){ return new Date(ts).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }); }
function timeLabel(ts){ return new Date(ts).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }); }

/* ============ Safe DOM builder (text only, never innerHTML with data) ============ */
function h(tag, props, ...kids){
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)){
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()){
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const SVG_NS = "http://www.w3.org/2000/svg";
function icon(d){ const s = document.createElementNS(SVG_NS, "svg"); s.setAttribute("viewBox","0 0 24 24"); s.setAttribute("fill","none"); s.setAttribute("stroke","currentColor"); s.setAttribute("stroke-width","2"); s.setAttribute("stroke-linecap","round"); s.setAttribute("stroke-linejoin","round"); for (const p of d){ const e = document.createElementNS(SVG_NS, "path"); e.setAttribute("d", p); s.append(e);} return s; }
const ICONS = {
  stock: ["M3 7l9-4 9 4-9 4-9-4z","M3 7v10l9 4 9-4V7","M12 11v10"],
  shop: ["M6 6h15l-1.5 9h-12z","M6 6L5 3H2","M9 20a1 1 0 100-2 1 1 0 000 2z","M18 20a1 1 0 100-2 1 1 0 000 2z"],
  hist: ["M3 3v18h18","M7 15l4-4 3 3 5-6"],
  plus: ["M12 5v14","M5 12h14"],
  gear: ["M12 15a3 3 0 100-6 3 3 0 000 6z","M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"]
};

/* ============ State ============ */
const S = {
  cfg: null, app: null, auth: null, fs: null, user: null,
  hid: null, household: null, members: {}, isOwner: false,
  items: new Map(), loadedItems: false,
  monthEvents: [], curMonth: monthKey(),
  tab: "stock", cat: "All", q: "",
  histMonth: monthKey(), histEvents: null, histView: "summary",
  offline: false
};
let unsubs = [];
function stopAll(){ for (const u of unsubs) try { u(); } catch (e) {} unsubs = []; if (monthUnsub){ monthUnsub(); monthUnsub = null; } }

/* ============ Firestore paths ============ */
const P = {
  hh: () => doc(S.fs, "households", S.hid),
  items: () => collection(S.fs, "households", S.hid, "items"),
  item: id => doc(S.fs, "households", S.hid, "items", id),
  events: m => collection(S.fs, "households", S.hid, "months", m, "events"),
  members: () => collection(S.fs, "households", S.hid, "members"),
  member: uid => doc(S.fs, "households", S.hid, "members", uid),
  userDoc: () => doc(S.fs, "users", S.user.uid)
};

/* ============ Data layer ============ */
async function useItem(item, amount){
  const live = S.items.get(item.id) || item;
  const used = round3(Math.min(amount, live.qty));
  if (used <= 0){ toast(item.name + " is already out of stock"); return; }
  try {
    // increment() is atomic on the server and works offline — two phones can't overwrite each other.
    const p1 = updateDoc(P.item(item.id), { qty: increment(-used), updatedAt: Date.now() });
    const evRef = doc(P.events(monthKey()));
    const p2 = setDoc(evRef, eventBody(live, "use", used, 0));
    toast("Used " + fq(used) + " " + live.unit + " " + live.name, async () => {
      try { await updateDoc(P.item(item.id), { qty: increment(used), updatedAt: Date.now() }); await deleteDoc(evRef); toast("Undone"); } catch (e) { showError(e); }
    });
    await Promise.all([p1, p2]);
  } catch (e) { showError(e); }
}
function eventBody(item, type, qty, price){
  return { itemId: item.id, itemName: item.name, category: item.category, unit: item.unit, type,
    qty: round3(qty), price: Math.round((price || 0) * 100) / 100, by: S.user.uid, at: Date.now() };
}
async function buyItem(item, qty, price){
  const upd = { qty: increment(qty), updatedAt: Date.now() };
  if (price > 0) upd.lastPrice = Math.round(price / qty * 100) / 100;
  const p1 = updateDoc(P.item(item.id), upd);
  const p2 = addDoc(P.events(monthKey()), eventBody(item, "buy", qty, price));
  await Promise.race([Promise.all([p1, p2]), offlineGrace()]);
}
// With offline persistence, writes are queued locally and resolve once the server confirms.
// Don't block the UI forever when there's no signal: the local cache already shows the change.
function offlineGrace(){ return new Promise(r => setTimeout(r, navigator.onLine ? 8000 : 300)); }

async function createItem(f){
  const ref = doc(P.items());
  const body = { name: f.name, category: f.category, unit: f.unit, qty: 0, minQty: f.minQty, useStep: f.useStep, lastPrice: 0, createdBy: S.user.uid, updatedAt: Date.now() };
  await Promise.race([setDoc(ref, body), offlineGrace()]);
  return cleanItem(ref.id, body);
}

function showError(e){
  const code = (e && e.code) || "";
  let msg = "Something went wrong. Please try again.";
  if (code === "permission-denied") msg = "You don't have permission for that. Are you still a member of this household?";
  else if (code === "unavailable") msg = "No connection — your change will sync when you're back online.";
  else if (code === "resource-exhausted") msg = "Too many changes at once — wait a moment and retry.";
  else if (code === "not-found") msg = "That item no longer exists.";
  toast(msg);
  if (e && !code) console.warn(e);
}

/* ============ Toast ============ */
let toastEl = null, toastTimer = null;
function toast(text, undo){
  if (toastEl) toastEl.remove();
  clearTimeout(toastTimer);
  toastEl = h("div", { class: "toast", role: "status" }, h("span", null, text),
    undo ? h("button", { onclick: () => { toastEl.remove(); toastEl = null; undo(); } }, "Undo") : null);
  document.body.append(toastEl);
  toastTimer = setTimeout(() => { if (toastEl){ toastEl.remove(); toastEl = null; } }, undo ? 5000 : 2800);
}

/* ============ Sheets (in-page dialogs) ============ */
const sheetStack = [];
function openSheet(build){
  const bg = h("div", { class: "sheet-bg" });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
  const close = () => { bg.remove(); const i = sheetStack.indexOf(close); if (i >= 0) sheetStack.splice(i, 1); };
  bg.addEventListener("click", e => { if (e.target === bg) close(); });
  sheetStack.push(close);
  build(sheet, close);
  bg.append(sheet); document.body.append(bg);
  return close;
}
function field(label, input, hint){ return h("div", { class: "field" }, h("label", null, label), input, hint ? h("div", { class: "hint" }, hint) : null); }
function selectEl(list, value){ return h("select", null, list.map(v => h("option", { value: v, selected: v === value }, v))); }
async function copyText(text, okMsg){
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch (e) { toast("Couldn't copy automatically — long-press the text to copy"); }
}

/* Item details: edit, recount, use custom amount, delete */
function openItem(item){
  openSheet((sh, close) => {
    const live = () => S.items.get(item.id) || item;
    const it = live();
    const amt = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", value: String(it.useStep) });
    const err = h("div", { class: "err" });
    sh.append(
      h("h2", null, it.name),
      h("div", { class: "muted", style: "margin:-6px 0 10px" }, it.category + " · In stock: " + fq(it.qty) + " " + it.unit + (it.lastPrice ? " · last " + inr2.format(it.lastPrice) + "/" + it.unit : "")),
      h("div", { class: "stepper" },
        h("button", { "aria-label": "less", onclick: () => { amt.value = String(Math.max(0, round3((parseFloat(amt.value) || 0) - it.useStep))); } }, "−"),
        amt,
        h("button", { "aria-label": "more", onclick: () => { amt.value = String(round3((parseFloat(amt.value) || 0) + it.useStep)); } }, "+")),
      h("div", { class: "row" },
        h("button", { class: "btn primary", onclick: async () => {
          const a = num(amt.value, 0, LIMITS.qty, NaN);
          if (!(a > 0)) { err.textContent = "Enter an amount greater than 0"; return; }
          close(); await useItem(live(), round3(a));
        } }, "Mark used"),
        h("button", { class: "btn", onclick: () => { close(); openPurchase(live()); } }, "Add purchase")),
      err,
      h("div", { class: "group-h" }, "Item settings"));
    const nm = h("input", { value: it.name, maxLength: LIMITS.name });
    const cat = selectEl(CATEGORIES, it.category);
    const unit = selectEl(UNITS, it.unit);
    const min = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", value: String(it.minQty) });
    const step = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", value: String(it.useStep) });
    const exact = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", value: String(it.qty) });
    const err2 = h("div", { class: "err" });
    sh.append(
      field("Name", nm),
      h("div", { class: "row" }, field("Category", cat), field("Unit", unit)),
      h("div", { class: "row" }, field("Alert when ≤", min), field("Quick-use amount", step)),
      field("Correct stock count", exact, "Use after a physical recount; it's logged as an adjustment."),
      err2,
      h("button", { class: "btn primary block", onclick: async (ev) => {
        const name = str(nm.value, LIMITS.name);
        if (!name) { err2.textContent = "Name is required"; return; }
        const dupe = [...S.items.values()].find(x => x.id !== it.id && x.nameLower === name.toLowerCase());
        if (dupe) { err2.textContent = "Another item already has this name"; return; }
        const st = num(step.value, 0.001, LIMITS.qty, NaN), mn = num(min.value, 0, LIMITS.qty, NaN), ex = num(exact.value, 0, LIMITS.qty, NaN);
        if (!Number.isFinite(st) || !Number.isFinite(mn) || !Number.isFinite(ex)) { err2.textContent = "Check the numbers"; return; }
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const cur = live();
          const upd = { name, category: oneOf(cat.value, CATEGORIES, "Other"), unit: oneOf(unit.value, UNITS, "pcs"), minQty: round3(mn), useStep: round3(st), updatedAt: Date.now() };
          const diff = round3(round3(ex) - cur.qty);
          if (diff !== 0) upd.qty = round3(ex);
          const ps = [updateDoc(P.item(it.id), upd)];
          if (diff !== 0) ps.push(addDoc(P.events(monthKey()), eventBody(Object.assign({}, cur, upd), "adjust", diff, 0)));
          await Promise.race([Promise.all(ps), offlineGrace()]);
          close(); toast("Saved");
        } catch (e) { btn.disabled = false; showError(e); }
      } }, "Save changes"),
      h("div", { style: "height:8px" }),
      h("button", { class: "btn danger block", onclick: (ev) => {
        const b = ev.currentTarget;
        if (b.dataset.armed !== "1"){ b.dataset.armed = "1"; b.textContent = "Tap again to delete " + it.name; return; }
        deleteDoc(P.item(it.id)).catch(showError); close(); toast("Deleted " + it.name);
      } }, "Delete item"));
    const recent = S.monthEvents.filter(e => e.itemId === it.id).slice(0, 8);
    if (recent.length){ sh.append(h("div", { class: "group-h" }, "This month"), h("div", { class: "card" }, recent.map(evRow))); }
    sh.append(h("button", { class: "btn ghost block", onclick: close }, "Close"));
  });
}

/* Purchase entry — stays open for quick monthly-grocery entry */
function openPurchase(preset){
  openSheet((sh, close) => {
    const added = h("div", { class: "session" });
    const dl = h("datalist", { id: "itemnames" }, [...S.items.values()].sort((a, b) => a.name.localeCompare(b.name)).map(i => h("option", { value: i.name })));
    const nm = h("input", { list: "itemnames", maxLength: LIMITS.name, placeholder: "e.g. Toor dal", autocomplete: "off", value: preset ? preset.name : "" });
    const qty = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", placeholder: "1" });
    const price = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", placeholder: "optional" });
    const cat = selectEl(CATEGORIES, "Other"), unit = selectEl(UNITS, "pcs");
    const min = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", value: "1" });
    const step = h("input", { type: "number", inputMode: "decimal", min: "0", step: "any", value: "1" });
    const newBox = h("div", null, h("div", { class: "hint", style: "margin-bottom:8px" }, "New item — set it up once:"),
      h("div", { class: "row" }, field("Category", cat), field("Unit", unit)),
      h("div", { class: "row" }, field("Alert when ≤", min), field("Quick-use amount", step)));
    const info = h("div", { class: "hint" });
    const err = h("div", { class: "err" });
    const unitLbl = h("span");
    const match = () => { const n = str(nm.value, LIMITS.name).toLowerCase(); return n ? [...S.items.values()].find(i => i.nameLower === n) : null; };
    const refresh = () => {
      const m = match();
      newBox.hidden = !!m || !str(nm.value, LIMITS.name);
      unitLbl.textContent = m ? " (" + m.unit + ")" : str(nm.value, LIMITS.name) ? " (" + unit.value + ")" : "";
      info.textContent = m ? "In stock: " + fq(m.qty) + " " + m.unit + " · " + m.category : "";
    };
    nm.addEventListener("input", refresh); unit.addEventListener("change", refresh);
    const save = async (keepOpen, btn) => {
      err.textContent = "";
      const name = str(nm.value, LIMITS.name);
      const q = num(qty.value || "1", 0, LIMITS.qty, NaN);
      const p = price.value === "" ? 0 : num(price.value, 0, LIMITS.price, NaN);
      if (!name) { err.textContent = "Enter an item name"; return; }
      if (!(q > 0)) { err.textContent = "Quantity must be more than 0"; return; }
      if (!Number.isFinite(p)) { err.textContent = "Price must be a number"; return; }
      btn.disabled = true;
      try {
        let item = match();
        if (!item){
          const st = num(step.value, 0.001, LIMITS.qty, 1), mn = num(min.value, 0, LIMITS.qty, 0);
          item = await createItem({ name, category: oneOf(cat.value, CATEGORIES, "Other"), unit: oneOf(unit.value, UNITS, "pcs"), minQty: round3(mn), useStep: round3(st) });
        }
        await buyItem(item, round3(q), p);
        added.prepend(h("div", null, "✓ " + item.name + " + " + fq(q) + " " + item.unit + (p ? " · " + inr2.format(p) : "")));
        if (keepOpen){ nm.value = ""; qty.value = ""; price.value = ""; refresh(); nm.focus(); }
        else { close(); toast("Added " + fq(q) + " " + item.unit + " " + item.name); }
      } catch (e) { showError(e); }
      btn.disabled = false;
    };
    const b1 = h("button", { class: "btn primary" }, "Save & next");
    const b2 = h("button", { class: "btn" }, "Save & close");
    b1.addEventListener("click", () => save(true, b1));
    b2.addEventListener("click", () => save(false, b2));
    sh.append(h("h2", null, "Add purchase"), dl,
      field("Item", nm), info,
      h("div", { class: "row" }, h("div", { class: "field" }, h("label", null, "Quantity", unitLbl), qty), field("Total price ₹", price)),
      newBox, err, h("div", { class: "row" }, b1, b2), added,
      h("button", { class: "btn ghost block", style: "margin-top:8px", onclick: close }, "Done"));
    refresh();
  });
}

/* Household settings: members, invite code, sign out */
function openSettings(){
  openSheet((sh, close) => {
    const hhName = str(S.household && S.household.name, LIMITS.household) || "Our home";
    const memberIds = Object.keys(S.members);
    sh.append(h("h2", null, hhName),
      h("div", { class: "muted", style: "margin:-6px 0 12px" }, "Signed in as " + (S.user.email || "")));
    sh.append(h("div", { class: "card" }, h("h3", null, "Members (" + memberIds.length + ")"),
      memberIds.map(uid => h("div", { class: "member" },
        h("span", null, (S.members[uid] || "Member") + (uid === S.user.uid ? " (you)" : "") + (S.household && uid === S.household.owner ? " · owner" : "")),
        S.isOwner && uid !== S.user.uid ? h("button", { class: "link", style: "color:var(--bad)", onclick: (ev) => {
          const b = ev.currentTarget;
          if (b.dataset.armed !== "1"){ b.dataset.armed = "1"; b.textContent = "Confirm remove"; return; }
          deleteDoc(P.member(uid)).then(() => toast("Removed"), showError); close();
        } }, "Remove") : null))));
    if (S.household && S.household.secret){
      const code = makeInvite(S.cfg, S.hid, S.household.secret);
      const ta = h("textarea", { readOnly: true, rows: 3, value: code });
      sh.append(h("div", { class: "card" }, h("h3", null, "Invite family"),
        h("div", { class: "hint", style: "margin:0 0 8px" }, "Install the app on their phone, then they paste this code on the “Join a household” screen. Share it only with family."),
        ta, h("div", { style: "height:8px" }),
        h("button", { class: "btn block", onclick: () => copyText("Join our Home Pantry: open the app → Join a household → paste this code:\n" + code, "Invite copied — paste it in WhatsApp") }, "Copy invite"),
        S.isOwner ? h("button", { class: "link block", style: "width:100%;margin-top:4px", onclick: async () => {
          try { await updateDoc(P.hh(), { secret: randomSecret() }); toast("New code made — old invites no longer work"); close(); } catch (e) { showError(e); }
        } }, "Reset invite code") : null));
    }
    sh.append(
      h("button", { class: "btn block", onclick: async () => { close(); stopAll(); store(HH_STORE, null); await signOut(S.auth); } }, "Sign out"),
      h("div", { style: "height:8px" }),
      !S.isOwner ? h("button", { class: "btn danger block", onclick: async (ev) => {
        const b = ev.currentTarget;
        if (b.dataset.armed !== "1"){ b.dataset.armed = "1"; b.textContent = "Tap again to leave " + hhName; return; }
        try { await deleteDoc(P.member(S.user.uid)); await setDoc(P.userDoc(), { householdId: "" }); } catch (e) { showError(e); return; }
        close(); stopAll(); S.hid = null; store(HH_STORE, null); route();
      } }, "Leave household") : "",
      h("button", { class: "btn ghost block", onclick: close }, "Close"));
  });
}

/* ============ Views ============ */
function isOut(i){ return i.qty <= 0; }
function isLow(i){ return !isOut(i) && i.minQty > 0 && i.qty <= i.minQty; }
function lowList(){ return [...S.items.values()].filter(i => isOut(i) || isLow(i)); }

function itemRow(i){
  return h("div", { class: "item" },
    h("div", { class: "main", onclick: () => openItem(i), role: "button", tabIndex: 0 },
      h("div", { class: "name" }, i.name, isOut(i) ? h("span", { class: "tag out" }, "Out") : isLow(i) ? h("span", { class: "tag low" }, "Low") : null),
      h("div", { class: "meta" }, i.category + (i.minQty ? " · alert ≤ " + fq(i.minQty) : ""))),
    h("div", { class: "qty" }, fq(i.qty), h("small", null, i.unit)),
    h("button", { class: "usebtn", disabled: isOut(i), "aria-label": "Mark " + fq(i.useStep) + " " + i.unit + " of " + i.name + " used", onclick: () => useItem(i, i.useStep) }, "−" + fq(i.useStep)));
}

function viewStock(){
  const all = [...S.items.values()];
  const cats = ["All", ...CATEGORIES.filter(c => all.some(i => i.category === c))];
  if (!cats.includes(S.cat)) S.cat = "All";
  const spent = S.monthEvents.filter(e => e.type === "buy").reduce((s, e) => s + e.price, 0);
  const search = h("input", { type: "search", placeholder: "Search items", value: S.q, "aria-label": "Search items" });
  search.addEventListener("input", () => { S.q = search.value.slice(0, 60); renderList(); });
  const listBox = h("div");
  function renderList(){
    const q2 = S.q.toLowerCase();
    const l = all.filter(i => (S.cat === "All" || i.category === S.cat) && (!q2 || i.nameLower.includes(q2))).sort((a, b) => a.name.localeCompare(b.name));
    listBox.replaceChildren();
    if (!all.length){
      listBox.append(h("div", { class: "empty" }, h("b", null, "No items yet"), "Tap + to add this month's groceries. Each item is set up once, then you just add quantities.",
        h("div", { style: "margin-top:14px" }, h("button", { class: "btn primary", onclick: () => openPurchase() }, "Add first purchase"))));
      return;
    }
    if (!l.length){ listBox.append(h("div", { class: "empty" }, "No matching items")); return; }
    if (S.cat === "All" && !q2){
      for (const c of CATEGORIES){ const g = l.filter(i => i.category === c); if (g.length) listBox.append(h("div", { class: "group-h" }, c), ...g.map(itemRow)); }
    } else listBox.append(...l.map(itemRow));
  }
  renderList();
  return [
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("b", null, String(all.length)), h("span", null, "items")),
      h("div", { class: "stat" }, h("b", { style: lowList().length ? "color:var(--warn)" : "" }, String(lowList().length)), h("span", null, "low / out")),
      h("div", { class: "stat" }, h("b", null, inr.format(spent)), h("span", null, "spent this month"))),
    h("div", { class: "search" }, search),
    h("div", { class: "chips" }, cats.map(c => h("button", { class: "chip" + (S.cat === c ? " on" : ""), onclick: () => { S.cat = c; render(); } }, c))),
    listBox
  ];
}

function viewShop(){
  const low = lowList().sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  if (!low.length) return [h("div", { class: "empty" }, h("b", null, "All stocked up"), "Items appear here when they run out or fall to their alert level.")];
  const text = () => "Shopping list\n" + low.map(i => "• " + i.name + " (have " + fq(i.qty) + " " + i.unit + ")").join("\n");
  const out = [h("div", { class: "row", style: "margin-bottom:10px" },
    h("button", { class: "btn", onclick: () => copyText(text(), "List copied — paste it in WhatsApp") }, "Copy list"))];
  for (const c of CATEGORIES){
    const g = low.filter(i => i.category === c); if (!g.length) continue;
    out.push(h("div", { class: "group-h" }, c));
    for (const i of g) out.push(h("div", { class: "item" },
      h("div", { class: "main", onclick: () => openItem(i) },
        h("div", { class: "name" }, i.name, isOut(i) ? h("span", { class: "tag out" }, "Out") : h("span", { class: "tag low" }, "Low")),
        h("div", { class: "meta" }, "Have " + fq(i.qty) + " " + i.unit + (i.lastPrice ? " · last " + inr2.format(i.lastPrice) + "/" + i.unit : ""))),
      h("button", { class: "usebtn", onclick: () => openPurchase(i) }, "Bought")));
  }
  return out;
}

function evRow(e){
  const sign = e.type === "buy" ? "+" : e.type === "use" ? "−" : "±";
  const who = e.by && S.members[e.by] ? " · " + S.members[e.by] : "";
  const q = e.type === "adjust" ? (e.qty >= 0 ? "+" : "−") + fq(Math.abs(e.qty)) : fq(e.qty);
  const verb = e.type === "buy" ? "Bought " : e.type === "use" ? "Used " : "Recount ";
  return h("div", { class: "ev" },
    h("div", { class: "dot " + e.type }, sign),
    h("div", { class: "t" }, h("div", null, verb + q + " " + e.unit + " " + e.itemName), h("div", { class: "s" }, dayLabel(e.at) + ", " + timeLabel(e.at) + who)),
    e.price ? h("div", { class: "p" }, inr2.format(e.price)) : null);
}

function loadHistory(){
  if (S.histMonth === S.curMonth){ S.histEvents = null; return; }
  S.histEvents = "loading";
  const m = S.histMonth;
  getDocs(query(P.events(m), orderBy("at", "desc"), limit(1000))).then(snap => {
    if (S.histMonth !== m) return;
    S.histEvents = snap.docs.map(d => cleanEvent(d.id, d.data())).filter(Boolean);
    render();
  }, e => { S.histEvents = []; showError(e); render(); });
}

function viewHistory(){
  const evs = S.histMonth === S.curMonth ? S.monthEvents : S.histEvents;
  const out = [h("div", { class: "monthbar" },
    h("button", { "aria-label": "Previous month", onclick: () => { S.histMonth = shiftMonth(S.histMonth, -1); loadHistory(); render(); } }, "‹"),
    h("div", { class: "m" }, monthLabel(S.histMonth)),
    h("button", { "aria-label": "Next month", disabled: S.histMonth >= S.curMonth, onclick: () => { S.histMonth = shiftMonth(S.histMonth, 1); loadHistory(); render(); } }, "›"))];
  if (evs === "loading" || evs == null){ out.push(h("div", { class: "empty" }, "Loading…")); return out; }
  out.push(h("div", { class: "seg" }, [["summary","Summary"],["items","By item"],["log","Activity"]].map(([k, l]) => h("button", { class: S.histView === k ? "on" : "", onclick: () => { S.histView = k; render(); } }, l))));
  if (!evs.length){ out.push(h("div", { class: "empty" }, h("b", null, "Nothing recorded"), "Purchases and usage for this month will show here.")); return out; }
  const buys = evs.filter(e => e.type === "buy"), uses = evs.filter(e => e.type === "use");
  const total = buys.reduce((s, e) => s + e.price, 0);
  if (S.histView === "summary"){
    const byCat = {}; for (const e of buys) byCat[e.category] = (byCat[e.category] || 0) + e.price;
    const rows = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 1;
    out.push(h("div", { class: "card" }, h("div", { class: "muted", style: "font-size:13px" }, "Total spend"), h("div", { class: "spend" }, inr.format(total)),
      h("div", { class: "muted", style: "font-size:13px;margin-top:2px" }, buys.length + " purchases · " + uses.length + " times marked used")));
    if (rows.length) out.push(h("div", { class: "card" }, h("h3", null, "Spend by category"),
      rows.map(([c, v]) => h("div", { class: "bar" }, h("div", { class: "lbl" }, c), h("div", { class: "track" }, h("div", { class: "fill", style: "width:" + Math.max(3, Math.round(v / max * 100)) + "%" })), h("div", { class: "amt" }, inr.format(v))))));
    const topUsed = {}; for (const e of uses){ const k = e.itemName + "|" + e.unit; topUsed[k] = (topUsed[k] || 0) + e.qty; }
    const tu = Object.entries(topUsed).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (tu.length) out.push(h("div", { class: "card" }, h("h3", null, "Most used"), tu.map(([k, v]) => { const [n, u] = k.split("|"); return h("div", { class: "bar", style: "grid-template-columns:1fr auto" }, h("div", { class: "lbl" }, n), h("div", { class: "amt" }, fq(v) + " " + u)); })));
  } else if (S.histView === "items"){
    const agg = {};
    for (const e of evs){ const k = e.itemId || e.itemName; const a = agg[k] || (agg[k] = { name: e.itemName, unit: e.unit, b: 0, u: 0, p: 0 }); if (e.type === "buy"){ a.b += e.qty; a.p += e.price; } else if (e.type === "use") a.u += e.qty; }
    const rows = Object.values(agg).sort((a, b) => a.name.localeCompare(b.name));
    out.push(h("div", { class: "card" }, h("table", null,
      h("thead", null, h("tr", null, h("th", null, "Item"), h("th", null, "Bought"), h("th", null, "Used"), h("th", null, "Spent"))),
      h("tbody", null, rows.map(r => h("tr", null, h("td", null, r.name), h("td", null, r.b ? fq(r.b) + " " + r.unit : "–"), h("td", null, r.u ? fq(r.u) + " " + r.unit : "–"), h("td", null, r.p ? inr.format(r.p) : "–")))))));
  } else {
    out.push(h("div", { class: "card" }, evs.slice(0, 300).map(evRow)));
  }
  return out;
}

/* ============ Shell ============ */
function chrome(on){
  document.getElementById("hdr").hidden = !on;
  document.getElementById("nav").hidden = !on;
}
function renderTabs(){
  const n = lowList().length;
  const tb = (k, label, ic, badge) => h("button", { class: S.tab === k ? "on" : "", "aria-label": label, onclick: () => { S.tab = k; if (k === "hist") loadHistory(); render(); window.scrollTo(0, 0); } },
    icon(ic), h("span", null, label, badge ? h("span", { class: "badge" }, String(badge)) : null));
  document.getElementById("tabs").replaceChildren(
    tb("stock", "Stock", ICONS.stock),
    tb("shop", "To buy", ICONS.shop, n),
    h("button", { class: "add", "aria-label": "Add purchase", onclick: () => openPurchase() }, h("span", { class: "plus" }, icon(ICONS.plus)), h("span", null, "Add")),
    tb("hist", "History", ICONS.hist));
}
function render(){
  if (!S.hid) return;
  const v = document.getElementById("view");
  const y = window.scrollY;
  const active = document.activeElement && document.activeElement.type === "search";
  chrome(true);
  document.getElementById("title").textContent = str(S.household && S.household.name, LIMITS.household) || "Home Pantry";
  if (!S.loadedItems){ v.replaceChildren(h("div", { class: "empty" }, "Loading your pantry…")); renderTabs(); return; }
  v.replaceChildren(...(S.tab === "stock" ? viewStock() : S.tab === "shop" ? viewShop() : viewHistory()));
  renderTabs();
  window.scrollTo(0, y);
  if (active){ const s = v.querySelector("input[type=search]"); if (s){ s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  document.getElementById("sub").textContent = S.offline ? "Offline — changes will sync later" : monthLabel(S.curMonth) + " · " + Object.keys(S.members).length + " in household";
}
let rq = false;
function scheduleRender(){ if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; render(); }); }
function banner(text){ const b = document.getElementById("banner"); b.textContent = text || ""; b.hidden = !text; }

let monthUnsub = null;
function subscribeMonth(){
  if (monthUnsub) monthUnsub();
  S.curMonth = monthKey();
  monthUnsub = onSnapshot(query(P.events(S.curMonth), orderBy("at", "desc"), limit(1000)), snap => {
    S.monthEvents = snap.docs.map(d => cleanEvent(d.id, d.data())).filter(Boolean);
    scheduleRender();
  }, onSubError);
}
function onSubError(e){
  if (e && e.code === "permission-denied"){
    stopAll(); S.hid = null; store(HH_STORE, null);
    toast("You're no longer a member of that household.");
    route();
  } else showError(e);
}

function startHousehold(){
  stopAll();
  S.items = new Map(); S.loadedItems = false; S.monthEvents = []; S.members = {};
  render();
  unsubs.push(onSnapshot(P.hh(), snap => {
    const d = snap.data() || {};
    S.household = { name: str(d.name, LIMITS.household), owner: str(d.owner, 128), secret: SECRET_RE.test(d.secret) ? d.secret : "" };
    S.isOwner = S.household.owner === S.user.uid;
    scheduleRender();
  }, onSubError));
  unsubs.push(onSnapshot(P.members(), snap => {
    const m = {}; for (const d of snap.docs) m[d.id] = str(d.data().name, LIMITS.person) || "Member";
    S.members = m; scheduleRender();
  }, onSubError));
  unsubs.push(onSnapshot(query(P.items(), limit(1000)), { includeMetadataChanges: true }, snap => {
    const m = new Map();
    for (const d of snap.docs){ const it = cleanItem(d.id, d.data()); if (it) m.set(it.id, it); }
    S.items = m; S.loadedItems = true; S.offline = snap.metadata.fromCache && !navigator.onLine;
    scheduleRender();
  }, onSubError));
  subscribeMonth();
}

/* ============ Onboarding screens ============ */
function screen(title, lead, ...kids){
  chrome(false); banner("");
  const logo = h("div", { class: "logo" }, icon(ICONS.stock));
  document.getElementById("view").replaceChildren(h("div", { class: "auth" }, logo, h("h2", null, title), lead ? h("p", { class: "lead" }, lead) : null, ...kids));
  const first = document.querySelector("#view input, #view textarea"); if (first) setTimeout(() => first.focus(), 50);
}

function setupScreen(){
  const ta = h("textarea", { rows: 4, placeholder: "Paste the invite code from your family (starts with HP1.)" });
  const ta2 = h("textarea", { rows: 6, placeholder: "const firebaseConfig = { apiKey: \"...\", authDomain: \"...\", projectId: \"...\", appId: \"...\" };" });
  const err = h("div", { class: "err" });
  const ownerBox = h("div", { hidden: true },
    field("Firebase web config", ta2, "Firebase console → Project settings → Your apps → Web app → SDK setup and configuration → Config."),
    h("button", { class: "btn primary block", onclick: () => {
      const cfg = parseConfigText(ta2.value);
      if (!cfg){ err.textContent = "That doesn't look like a Firebase web config."; return; }
      store(CFG_STORE, JSON.stringify(cfg)); boot();
    } }, "Save config"));
  screen("Welcome to Home Pantry", "Track groceries with your household.",
    field("Have an invite code?", ta),
    h("button", { class: "btn primary block", onclick: () => {
      const inv = parseInvite(ta.value);
      if (!inv || !inv.cfg){ err.textContent = "That invite code isn't valid. Ask for a fresh one."; return; }
      confirmProject(inv.cfg, () => { store(CFG_STORE, JSON.stringify(inv.cfg)); pendingInvite = inv; boot(); });
    } }, "Continue with invite"),
    err,
    h("div", { class: "center", style: "margin-top:18px" }, h("button", { class: "link", onclick: (ev) => { ownerBox.hidden = false; ev.currentTarget.remove(); } }, "I'm setting this up for the first time")),
    ownerBox);
}
function confirmProject(cfg, ok){
  openSheet((sh, close) => {
    sh.append(h("h2", null, "Connect to this household server?"),
      h("p", null, "This invite connects the app to the Firebase project “" + cfg.projectId + "”. Only continue if the code came from someone you trust — you'll create your login on that server."),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: close }, "Cancel"), h("button", { class: "btn primary", onclick: () => { close(); ok(); } }, "Continue")));
  });
}

function authScreen(mode){
  mode = mode || "signin";
  const email = h("input", { type: "email", autocomplete: "email", inputMode: "email", maxLength: 254, placeholder: "you@example.com" });
  const pass = h("input", { type: "password", autocomplete: mode === "signup" ? "new-password" : "current-password", maxLength: 128 });
  const name = h("input", { autocomplete: "name", maxLength: LIMITS.person, placeholder: "e.g. Viswa" });
  const err = h("div", { class: "err" });
  const go = h("button", { class: "btn primary block" }, mode === "signup" ? "Create account" : "Sign in");
  go.addEventListener("click", async () => {
    err.textContent = "";
    const e = str(email.value, 254).toLowerCase(), p = String(pass.value || "");
    if (!EMAIL_RE.test(e)){ err.textContent = "Enter a valid email"; return; }
    if (mode === "signup"){
      if (!str(name.value, LIMITS.person)){ err.textContent = "Enter your name"; return; }
      if (p.length < 8){ err.textContent = "Password must be at least 8 characters"; return; }
    } else if (!p){ err.textContent = "Enter your password"; return; }
    go.disabled = true;
    try {
      if (mode === "signup"){
        const cred = await createUserWithEmailAndPassword(S.auth, e, p);
        await updateProfile(cred.user, { displayName: str(name.value, LIMITS.person) });
      } else await signInWithEmailAndPassword(S.auth, e, p);
    } catch (x) {
      const c = (x && x.code) || "";
      err.textContent = c === "auth/email-already-in-use" ? "An account with this email exists — sign in instead."
        : c === "auth/weak-password" ? "Choose a stronger password."
        : c === "auth/too-many-requests" ? "Too many attempts. Try again in a few minutes."
        : c === "auth/network-request-failed" ? "No internet connection."
        : c === "auth/operation-not-allowed" ? "Email sign-in isn't enabled in Firebase yet (Authentication → Sign-in method)."
        : mode === "signup" ? "Couldn't create the account." : "Email or password is incorrect.";
      go.disabled = false;
    }
  });
  const kids = [field("Email", email), field("Password", pass, mode === "signup" ? "At least 8 characters." : null)];
  if (mode === "signup") kids.unshift(field("Your name (shown to family)", name));
  screen(mode === "signup" ? "Create your account" : "Sign in", pendingInvite ? "Sign in or create an account to join your household." : "One account per person in the family.",
    ...kids, err, go,
    h("div", { class: "center", style: "margin-top:12px" },
      h("button", { class: "link", onclick: () => authScreen(mode === "signup" ? "signin" : "signup") }, mode === "signup" ? "I already have an account" : "New here? Create an account")),
    mode === "signin" ? h("div", { class: "center" }, h("button", { class: "link", style: "color:var(--muted)", onclick: async () => {
      const e = str(email.value, 254).toLowerCase();
      if (!EMAIL_RE.test(e)){ err.textContent = "Type your email above first"; return; }
      try { await sendPasswordResetEmail(S.auth, e); } catch (x) {}
      err.textContent = "If that account exists, a reset link has been sent.";
    } }, "Forgot password?")) : null,
    !FIREBASE_CONFIG ? h("div", { class: "center" }, h("button", { class: "link", style: "color:var(--muted);font-size:12px", onclick: () => { store(CFG_STORE, null); location.reload(); } }, "Use a different server")) : null);
}

function householdScreen(){
  const nm = h("input", { maxLength: LIMITS.household, placeholder: "e.g. Viswa's home" });
  const code = h("textarea", { rows: 3, placeholder: "Paste invite code (HP1.…)", value: pendingInvite ? "" : "" });
  const err = h("div", { class: "err" });
  const create = h("button", { class: "btn primary block" }, "Create household");
  create.addEventListener("click", async () => {
    const name = str(nm.value, LIMITS.household);
    if (!name){ err.textContent = "Give your household a name"; return; }
    create.disabled = true;
    try {
      const ref = doc(collection(S.fs, "households"));
      const secret = randomSecret();
      await setDoc(ref, { name, owner: S.user.uid, secret, createdAt: Date.now() });
      await setDoc(doc(S.fs, "households", ref.id, "members", S.user.uid), { name: myName(), secret, joinedAt: Date.now() });
      await setDoc(P.userDoc(), { householdId: ref.id });
      enterHousehold(ref.id);
    } catch (x) { create.disabled = false; err.textContent = x && x.code === "permission-denied" ? "Firestore rules aren't set up yet — see the setup guide." : "Couldn't create the household. Check your connection."; }
  });
  const join = h("button", { class: "btn block" }, "Join household");
  join.addEventListener("click", () => {
    const inv = parseInvite(code.value);
    if (!inv){ err.textContent = "That invite code isn't valid."; return; }
    if (inv.cfg && inv.cfg.projectId !== S.cfg.projectId){ err.textContent = "That code is for a different server. Sign out and use “Use a different server”."; return; }
    joinHousehold(inv, err);
  });
  screen("Set up your household", "Create one for your family, or join with an invite code.",
    field("New household name", nm), create,
    h("div", { class: "group-h center", style: "margin:20px 0 8px" }, "— or —"),
    field("Invite code", code), join, err,
    h("div", { class: "center", style: "margin-top:12px" }, h("button", { class: "link", style: "color:var(--muted)", onclick: () => signOut(S.auth) }, "Sign out")));
}
function myName(){ return str(S.user.displayName, LIMITS.person) || str((S.user.email || "").split("@")[0], LIMITS.person) || "Member"; }
async function joinHousehold(inv, err){
  try {
    await setDoc(doc(S.fs, "households", inv.hid, "members", S.user.uid), { name: myName(), secret: inv.secret, joinedAt: Date.now() });
    await setDoc(P.userDoc(), { householdId: inv.hid });
    pendingInvite = null;
    enterHousehold(inv.hid);
    toast("Welcome! You've joined the household.");
  } catch (x) {
    pendingInvite = null;
    const m = x && x.code === "permission-denied" ? "This invite has expired or was reset. Ask for a new code." : "Couldn't join. Check your connection and try again.";
    if (err) err.textContent = m; else { toast(m); householdScreen(); }
  }
}
function enterHousehold(hid){ S.hid = hid; store(HH_STORE, hid); S.tab = "stock"; startHousehold(); }

/* ============ Routing / boot ============ */
let pendingInvite = null;
async function route(){
  if (!S.user){ S.hid = null; stopAll(); authScreen(pendingInvite ? "signup" : "signin"); return; }
  if (pendingInvite){ joinHousehold(pendingInvite, null); return; }
  let hid = load(HH_STORE);
  if (!hid || !ID_RE.test(hid)){
    screen("Loading…", "");
    try { const u = await getDoc(P.userDoc()); hid = u.exists() ? str(u.data().householdId, 64) : ""; } catch (e) { hid = ""; }
  }
  if (hid && ID_RE.test(hid)) enterHousehold(hid); else householdScreen();
}

function boot(){
  let cfg = cleanConfig(FIREBASE_CONFIG);
  if (!cfg){ try { cfg = cleanConfig(JSON.parse(load(CFG_STORE) || "null")); } catch (e) { cfg = null; } }
  if (!cfg){ setupScreen(); return; }
  if (S.app){ route(); return; }
  S.cfg = cfg;
  S.app = initializeApp(cfg);
  S.auth = initializeAuth(S.app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  S.fs = initializeFirestore(S.app, { localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }) });
  onAuthStateChanged(S.auth, u => { S.user = u; route(); });
}

/* Android back button: close a sheet, else go to Stock, else leave the app */
try {
  CapApp.addListener("backButton", () => {
    if (sheetStack.length){ sheetStack[sheetStack.length - 1](); return; }
    if (S.hid && S.tab !== "stock"){ S.tab = "stock"; render(); return; }
    CapApp.minimizeApp().catch(() => CapApp.exitApp());
  });
} catch (e) { /* running in a browser */ }

document.getElementById("settingsBtn").append(icon(ICONS.gear));
document.getElementById("settingsBtn").addEventListener("click", () => { if (S.hid) openSettings(); });
window.addEventListener("online", () => { S.offline = false; scheduleRender(); });
window.addEventListener("offline", () => { S.offline = true; scheduleRender(); });
setInterval(() => { if (S.hid && monthKey() !== S.curMonth) subscribeMonth(); }, 60000);
boot();
