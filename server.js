// Weekmenu app — standalone backend
// Zero external dependencies: only Node's built-in http, fs, path, crypto modules.
// Requires Node.js 18+ (uses the built-in global fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { MongoClient } = require("mongodb");

// ---------- Minimal .env loader (no dependency) ----------
// Reads KEY=VALUE lines from .env in this folder and applies them to
// process.env, without overwriting variables already set in the real
// environment. Silently does nothing if .env doesn't exist.
(function loadDotEnv() {
  var envPath = path.join(__dirname, ".env");
  var raw;
  try { raw = fs.readFileSync(envPath, "utf8"); } catch (e) { return; }
  raw.split(/\r?\n/).forEach(function (line) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.indexOf("#") === 0) return;
    var eq = trimmed.indexOf("=");
    if (eq === -1) return;
    var key = trimmed.slice(0, eq).trim();
    var value = trimmed.slice(eq + 1).trim();
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') ||
        (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
})();

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_BASE_URL = String(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");   // alleen aanpassen voor een proxy of bij testen
const DAILY_GENERATE_CAP = parseInt(process.env.DAILY_GENERATE_CAP || "300", 10);
const PER_IP_HOURLY_CAP = parseInt(process.env.PER_IP_HOURLY_CAP || "20", 10);
// Nieuwe gerechten per gebruiker per maand. 0 = onbeperkt (standaard, dus er verandert niets tot je dit instelt).
const MONTHLY_DISH_CAP = parseInt(process.env.MONTHLY_DISH_CAP || "0", 10);
// Prijs per miljoen tokens in USD (Anthropic rekent in dollars af). Standaard de prijs van Claude Sonnet 4.6; pas aan bij een ander model.
const PRICE_IN_PER_M = Number(process.env.PRICE_IN_PER_M) >= 0 && process.env.PRICE_IN_PER_M ? Number(process.env.PRICE_IN_PER_M) : 3;
const PRICE_OUT_PER_M = Number(process.env.PRICE_OUT_PER_M) >= 0 && process.env.PRICE_OUT_PER_M ? Number(process.env.PRICE_OUT_PER_M) : 15;
const TIPS_PRICE_IN_PER_M = process.env.TIPS_PRICE_IN_PER_M ? Number(process.env.TIPS_PRICE_IN_PER_M) : PRICE_IN_PER_M;
const TIPS_PRICE_OUT_PER_M = process.env.TIPS_PRICE_OUT_PER_M ? Number(process.env.TIPS_PRICE_OUT_PER_M) : PRICE_OUT_PER_M;
// Tips voor de wachtcarrousel: eigen limieten, zodat ze de generatielimieten niet opeten.
const TIPS_PER_IP_HOURLY = parseInt(process.env.TIPS_PER_IP_HOURLY || "40", 10);
const DAILY_TIPS_CAP = parseInt(process.env.DAILY_TIPS_CAP || "500", 10);
const TIPS_MODEL = process.env.ANTHROPIC_TIPS_MODEL || ANTHROPIC_MODEL;
// Het openbare import-adres van Bring! (uit hun Import Developer Guide). De app haalt het via /api/config
// hier vandaan, zodat er in de app zelf geen vast Bring!-adres staat; met BRING_IMPORT_ENDPOINT te overschrijven.
const DEFAULT_BRING_IMPORT_ENDPOINT = "https://api.getbring.com/rest/bringrecipes/deeplink";
const BRING_IMPORT_ENDPOINT = process.env.BRING_IMPORT_ENDPOINT || DEFAULT_BRING_IMPORT_ENDPOINT;
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || "";
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB_NAME = process.env.MONGODB_DB || "weekmenu";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Balanza <onboarding@resend.dev>";

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- Tiny JSON-file store (docs + daily usage counter) ----------
// Fine for a small/personal deployment. For heavier use, swap this for a
// real database (SQLite/Postgres) — the read/write functions below are the
// only place that would need to change.

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return { docs: {}, usage: {} };
  }
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store), "utf8");
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ---------- User accounts: password hashing + stateless signed sessions ----------
// No external auth library — scrypt (built into Node) for password hashing,
// HMAC-SHA256 signed tokens for sessions. Signed tokens mean sessions survive
// server restarts (important: Render's free tier sleeps/restarts often)
// without needing a server-side session store.

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function makePasswordRecord(password) {
  var salt = crypto.randomBytes(16).toString("hex");
  return { salt: salt, hash: hashPassword(password, salt) };
}
function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  var candidate = Buffer.from(hashPassword(password, record.salt), "hex");
  var expected = Buffer.from(record.hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signSessionToken(payload) {
  var body = base64url(Buffer.from(JSON.stringify(payload)));
  var sig = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(body).digest());
  return body + "." + sig;
}
function verifySessionToken(token) {
  if (!token || token.indexOf(".") === -1) return null;
  var parts = token.split(".");
  if (parts.length !== 2) return null;
  var expectedSig = base64url(crypto.createHmac("sha256", SESSION_SECRET).update(parts[0]).digest());
  if (expectedSig !== parts[1]) return null;
  try {
    var payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) { return null; }
}
var SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
function issueUserSession(uid, email) {
  return signSessionToken({ uid: uid, email: email, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
}
// ---------- Login on/off (admin setting) ----------
// When login is required, only valid account sessions are accepted. When the
// admin switches it off, browsers may instead identify with an anonymous ID
// (prefix "anon_") — account IDs ("u_...") are never accepted that way, so
// existing accounts stay protected even while login is switched off.

// Default is "no login". Login is only required once the admin has explicitly
// switched it on. (If the setting can't be read because of a storage error,
// we fail closed and require login, since we can't tell what the admin chose.)
// ---------- Instellingen die de beheerder live kan aanpassen ----------
// Alles staat in één document (settings/app): inloggen verplicht of niet, welke onderdelen ("modules") aan of uit
// staan, de gebruikslimieten, een onderhoudsmodus en een mededeling voor alle gebruikers. Wat er niet in staat,
// valt terug op de standaard (modules aan, limieten uit de omgevingsvariabelen). Kan de opslag niet gelezen
// worden, dan gebruiken we de laatst bekende instellingen; bestaan die nog niet, dan geldt "inloggen verplicht",
// omdat we dan niet weten wat de beheerder koos.
var MODULE_DEFS = [
  { key: "generate", label: "Gerechten genereren", desc: "Het maken van gerechten en weekmenu's met AI. Uit: niemand kan nieuwe gerechten laten maken.", enforced: "server" },
  { key: "prices", label: "Kostenschatting", desc: "De prijsschatting op het boodschappenscherm (gebruikt ook de AI).", enforced: "server" },
  { key: "tips", label: "Tips tijdens het wachten", desc: "De weetjes en tips die getoond worden tijdens het genereren.", enforced: "server" },
  { key: "images", label: "Gerechtfoto's", desc: "Foto's bij gerechten (Unsplash) en de foto's in de PDF.", enforced: "server" },
  { key: "sharing", label: "Boodschappenlijst delen", desc: "Nieuwe lijsten delen en bijwerken (WhatsApp/link). Bestaande gedeelde lijsten blijven te lezen en af te vinken.", enforced: "server" },
  { key: "bring", label: "Importeren in Bring!", desc: "De Bring!-import en de pagina's die Bring! ophaalt.", enforced: "server" },
  { key: "pdf", label: "PDF-export", desc: "Het exporteren als PDF. Dit gebeurt in de app zelf: uitzetten verbergt de knoppen.", enforced: "app" },
  { key: "registration", label: "Nieuwe accounts (registreren)", desc: "Zelf een account aanmaken. Uit: alleen jij maakt accounts aan; inloggen blijft werken.", enforced: "server" },
  { key: "passwordReset", label: "Wachtwoord vergeten", desc: "De wachtwoord-vergeten-mail en de resetlink.", enforced: "server" }
];
var MAINTENANCE_OFF_MODULES = ["generate", "prices", "tips", "sharing", "bring", "registration"];
var LIMIT_DEFS = [
  { key: "dailyGenerateCap", label: "Generaties per dag (totaal)", def: DAILY_GENERATE_CAP, min: 0, max: 100000 },
  { key: "monthlyDishCap", label: "Nieuwe gerechten per gebruiker per maand (0 = onbeperkt)", def: MONTHLY_DISH_CAP, min: 0, max: 100000 },
  { key: "perIpHourlyCap", label: "Generaties per uur per IP-adres", def: PER_IP_HOURLY_CAP, min: 0, max: 10000 },
  { key: "dailyTipsCap", label: "Tip-verzoeken per dag (totaal)", def: DAILY_TIPS_CAP, min: 0, max: 100000 },
  { key: "tipsPerIpHourly", label: "Tip-verzoeken per uur per IP-adres", def: TIPS_PER_IP_HOURLY, min: 0, max: 10000 }
];
var liveLimits = {};
LIMIT_DEFS.forEach(function (d) { liveLimits[d.key] = d.def; });

function cleanText(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, max); }
// Notities mogen regeleinden houden (maximaal één lege regel achter elkaar).
function cleanNote(v, max) {
  return String(v == null ? "" : v).replace(/\r\n?/g, "\n").split("\n").map(function (l) { return l.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim(); }).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function normalizeSettings(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  var modules = {};
  MODULE_DEFS.forEach(function (d) { modules[d.key] = !(raw.modules && raw.modules[d.key] === false); });
  var limits = {};
  LIMIT_DEFS.forEach(function (d) {
    var v = raw.limits ? raw.limits[d.key] : undefined;
    limits[d.key] = (typeof v === "number" && isFinite(v) && v >= d.min && v <= d.max && Math.floor(v) === v) ? v : d.def;
  });
  var m = raw.maintenance && typeof raw.maintenance === "object" ? raw.maintenance : {};
  var a = raw.announcement && typeof raw.announcement === "object" ? raw.announcement : {};
  var b = raw.billing && typeof raw.billing === "object" ? raw.billing : {};
  function intIn(v, min, max, def) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= min && v <= max ? v : def; }
  var planOnly = {};
  PLAN_GATEABLE_MODULES.forEach(function (k) { planOnly[k] = !!(raw.planOnly && raw.planOnly[k] === true); });
  return {
    authRequired: raw.authRequired === true,
    modules: modules,
    planOnly: planOnly,
    limits: limits,
    billing: { enabled: b.enabled === true, plusMonthlyCents: intIn(b.plusMonthlyCents, 100, 99900, 399), plusYearlyCents: intIn(b.plusYearlyCents, 100, 999900, 3499), plusDishCap: intIn(b.plusDishCap, 0, 100000, 150), termsUrl: cleanTermsUrl(b.termsUrl) },
    maintenance: { enabled: m.enabled === true, message: cleanText(m.message, 300) },
    announcement: { enabled: a.enabled === true, message: cleanText(a.message, 300), level: a.level === "warning" ? "warning" : "info" }
  };
}
function effectiveModules(s) {
  var mods = Object.assign({}, s.modules);
  if (s.maintenance.enabled) MAINTENANCE_OFF_MODULES.forEach(function (k) { mods[k] = false; });
  return mods;
}
function applyLimits(s) { LIMIT_DEFS.forEach(function (d) { liveLimits[d.key] = s.limits[d.key]; }); }

var settingsCache = { value: null, expiry: 0 };
function getSettings() {
  if (settingsCache.value && Date.now() < settingsCache.expiry) return Promise.resolve(settingsCache.value);
  return dbGetDoc("settings/app").then(function (r) {
    var s = normalizeSettings(r.exists ? r.value : null);
    settingsCache = { value: s, expiry: Date.now() + 5000 };
    applyLimits(s);
    return s;
  }).catch(function () {
    if (settingsCache.value) return settingsCache.value;
    var s = normalizeSettings(null);
    s.authRequired = true;
    return s;
  });
}
function mergeSettings(cur, patch) {
  var next = JSON.parse(JSON.stringify(cur));
  if (typeof patch.authRequired === "boolean") next.authRequired = patch.authRequired;
  ["modules", "planOnly", "limits", "maintenance", "announcement", "billing"].forEach(function (k) {
    if (patch[k]) Object.keys(patch[k]).forEach(function (kk) { next[k][kk] = patch[k][kk]; });
  });
  return next;
}
function updateSettings(patch) {
  return dbGetDoc("settings/app").then(function (r) {
    var next = mergeSettings(normalizeSettings(r.exists ? r.value : null), patch);
    return dbSetDoc("settings/app", next).then(function () {
      settingsCache = { value: next, expiry: Date.now() + 5000 };
      applyLimits(next);
      return next;
    });
  });
}
// Controleert wat de beheerder instuurt. Geeft { patch } of { error }.
function validateSettingsPatch(body) {
  if (!body || typeof body !== "object") return { error: "Ongeldige aanvraag." };
  var patch = {}, n = 0;
  if (body.authRequired !== undefined) {
    if (typeof body.authRequired !== "boolean") return { error: "authRequired moet true of false zijn." };
    patch.authRequired = body.authRequired; n++;
  }
  if (body.modules !== undefined) {
    if (!body.modules || typeof body.modules !== "object" || Array.isArray(body.modules)) return { error: "modules moet een object zijn." };
    patch.modules = {};
    for (var k of Object.keys(body.modules)) {
      if (!MODULE_DEFS.some(function (d) { return d.key === k; })) return { error: "Onbekende module: " + k + "." };
      if (typeof body.modules[k] !== "boolean") return { error: "Module " + k + " moet aan (true) of uit (false) staan." };
      patch.modules[k] = body.modules[k]; n++;
    }
  }
  if (body.limits !== undefined) {
    if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits)) return { error: "limits moet een object zijn." };
    patch.limits = {};
    for (var lk of Object.keys(body.limits)) {
      var def = LIMIT_DEFS.filter(function (d) { return d.key === lk; })[0];
      if (!def) return { error: "Onbekende limiet: " + lk + "." };
      var v = body.limits[lk];
      if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v || v < def.min || v > def.max) {
        return { error: def.label + " moet een geheel getal zijn tussen " + def.min + " en " + def.max + "." };
      }
      patch.limits[lk] = v; n++;
    }
  }
  if (body.planOnly !== undefined) {
    if (!body.planOnly || typeof body.planOnly !== "object" || Array.isArray(body.planOnly)) return { error: "planOnly moet een object zijn." };
    patch.planOnly = {};
    for (var pk of Object.keys(body.planOnly)) {
      if (PLAN_GATEABLE_MODULES.indexOf(pk) === -1) return { error: "Dit onderdeel kan niet per abonnement worden ingesteld: " + pk + "." };
      if (typeof body.planOnly[pk] !== "boolean") return { error: "planOnly." + pk + " moet true (alleen Plus) of false (iedereen) zijn." };
      patch.planOnly[pk] = body.planOnly[pk]; n++;
    }
  }
  if (body.billing !== undefined) {
    var bl = body.billing;
    if (!bl || typeof bl !== "object" || Array.isArray(bl)) return { error: "billing moet een object zijn." };
    patch.billing = {};
    var BL = { plusMonthlyCents: [100, 99900, "De maandprijs"], plusYearlyCents: [100, 999900, "De jaarprijs"], plusDishCap: [0, 100000, "De Plus-limiet"] };
    for (var bk of Object.keys(bl)) {
      if (bk === "enabled") { if (typeof bl.enabled !== "boolean") return { error: "billing.enabled moet true of false zijn." }; patch.billing.enabled = bl.enabled; n++; }
      else if (BL[bk]) {
        var bv = bl[bk];
        if (typeof bv !== "number" || !isFinite(bv) || Math.floor(bv) !== bv || bv < BL[bk][0] || bv > BL[bk][1]) return { error: BL[bk][2] + " moet een geheel getal zijn tussen " + BL[bk][0] + " en " + BL[bk][1] + (bk === "plusDishCap" ? " (0 = onbeperkt)." : " (in centen).") };
        patch.billing[bk] = bv; n++;
      } else if (bk === "termsUrl") {
        if (typeof bl.termsUrl !== "string") return { error: "De link naar de voorwaarden moet tekst zijn." };
        var tu = cleanTermsUrl(bl.termsUrl);
        if (bl.termsUrl.trim() !== "" && !tu) return { error: "De link naar de voorwaarden moet met https:// beginnen." };
        patch.billing.termsUrl = tu; n++;
      } else return { error: "Onbekende betaalinstelling: " + bk + "." };
    }
  }
  if (body.maintenance !== undefined) {
    var m = body.maintenance;
    if (!m || typeof m !== "object") return { error: "maintenance moet een object zijn." };
    patch.maintenance = {};
    if (m.enabled !== undefined) { if (typeof m.enabled !== "boolean") return { error: "maintenance.enabled moet true of false zijn." }; patch.maintenance.enabled = m.enabled; n++; }
    if (m.message !== undefined) { if (typeof m.message !== "string") return { error: "De onderhoudsmelding moet tekst zijn." }; patch.maintenance.message = cleanText(m.message, 300); n++; }
  }
  if (body.announcement !== undefined) {
    var a = body.announcement;
    if (!a || typeof a !== "object") return { error: "announcement moet een object zijn." };
    patch.announcement = {};
    if (a.enabled !== undefined) { if (typeof a.enabled !== "boolean") return { error: "announcement.enabled moet true of false zijn." }; patch.announcement.enabled = a.enabled; n++; }
    if (a.message !== undefined) { if (typeof a.message !== "string") return { error: "De mededeling moet tekst zijn." }; patch.announcement.message = cleanText(a.message, 300); n++; }
    if (a.level !== undefined) { if (a.level !== "info" && a.level !== "warning") return { error: "Het type mededeling moet 'info' of 'warning' zijn." }; patch.announcement.level = a.level; n++; }
  }
  if (!n) return { error: "Geen geldige wijzigingen ontvangen." };
  return { patch: patch };
}
function moduleOffBody(key, s) {
  var def = MODULE_DEFS.filter(function (d) { return d.key === key; })[0];
  var msg = s.maintenance.enabled && MAINTENANCE_OFF_MODULES.indexOf(key) > -1
    ? (s.maintenance.message || "De app is tijdelijk in onderhoud.")
    : (def ? def.label : key) + " staat tijdelijk uit.";
  return { code: "module_disabled", module: key, message: msg };
}
// Zet een schakelaar voor een heel eindpunt: uit = 503 (of het antwoord dat onOff geeft).
function moduleGuard(key, handler, onOff) {
  return function () {
    var args = arguments, req = args[0], res = args[1];
    getSettings().then(function (s) {
      if (effectiveModules(s)[key]) return handler.apply(null, args);
      return onOff ? onOff(req, res, s) : sendJSON(res, 503, moduleOffBody(key, s));
    }).catch(function () {
      try { sendJSON(res, 500, { code: "error", message: "Interne fout." }); } catch (e) {}
    });
  };
}

function getAuthRequired() { return getSettings().then(function (s) { return s.authRequired; }); }
function setAuthRequired(value) { return updateSettings({ authRequired: !!value }); }

// ---------- Geblokkeerde accounts en ingetrokken sessies ----------
// Eén document (settings/blocked): uids die geblokkeerd zijn (ook anonieme) en per uid een tijdstip waarvoor
// uitgegeven sessies niet meer gelden ("overal uitloggen", na wachtwoord- of e-mailwijziging).
var blockedCache = { value: null, expiry: 0 };
function normalizeBlocked(raw) {
  raw = raw && typeof raw === "object" ? raw : {};
  return { uids: raw.uids && typeof raw.uids === "object" ? raw.uids : {}, invalidBefore: raw.invalidBefore && typeof raw.invalidBefore === "object" ? raw.invalidBefore : {} };
}
function getBlocked() {
  if (blockedCache.value && Date.now() < blockedCache.expiry) return Promise.resolve(blockedCache.value);
  return dbGetDoc("settings/blocked").then(function (r) {
    var b = normalizeBlocked(r.exists ? r.value : null);
    blockedCache = { value: b, expiry: Date.now() + 5000 };
    return b;
  }).catch(function () { return blockedCache.value || normalizeBlocked(null); });
}
function updateBlocked(mutator) {
  return dbGetDoc("settings/blocked").then(function (r) {
    var b = normalizeBlocked(r.exists ? r.value : null);
    mutator(b);
    return dbSetDoc("settings/blocked", b).then(function () {
      blockedCache = { value: b, expiry: Date.now() + 5000 };
      return b;
    });
  });
}
function sessionAllowed(b, uid, iat) {
  if (b.uids[uid]) return false;
  var inv = b.invalidBefore[uid];
  return !(inv && (iat || 0) < inv);
}

var ANON_ID_PATTERN = /^anon_[a-z0-9]{10,40}$/;

// Resolves to { uid, email } for a valid account session, or (only while login
// is switched off) for a well-formed anonymous ID. Resolves to null otherwise.
function resolveUser(req) {
  var auth = req.headers["authorization"] || "";
  var token = auth.indexOf("Bearer ") === 0 ? auth.slice(7) : "";
  var payload = verifySessionToken(token);
  if (payload && payload.uid) {
    return getBlocked().then(function (b) {
      return sessionAllowed(b, payload.uid, payload.iat) ? { uid: payload.uid, email: payload.email } : null;
    });
  }
  var anon = String(req.headers["x-anon-id"] || "");
  if (!ANON_ID_PATTERN.test(anon)) return Promise.resolve(null);
  return Promise.all([getAuthRequired(), getBlocked()]).then(function (r) {
    if (r[0]) return null;
    return r[1].uids[anon] ? null : { uid: anon, email: null };
  });
}
function sendUnauthorized(res) {
  sendJSON(res, 401, { code: "unauthorized", message: "Niet ingelogd of sessie verlopen." });
}

// ---------- Request logging (for the admin page) ----------
// Every /api/generate call logs its action, duration, and outcome. Capped at
// the most recent 1000 entries so it never grows unbounded.

var LOG_CAP = 5000;

function logRequest(entry) {
  mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      store.logs = store.logs || [];
      store.logs.push(entry);
      if (store.logs.length > LOG_CAP) store.logs = store.logs.slice(-LOG_CAP);
      saveStore(store);
      return;
    }
    return db.collection("logs").insertOne(entry).then(function () {
      return db.collection("logs").countDocuments().then(function (count) {
        if (count <= LOG_CAP) return;
        return db.collection("logs").find().sort({ ts: 1 }).limit(count - LOG_CAP).toArray().then(function (oldest) {
          return db.collection("logs").deleteMany({ _id: { $in: oldest.map(function (d) { return d._id; }) } });
        });
      });
    });
  }).catch(function () {});
}

function getRecentLogs(limit) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      return (store.logs || []).slice(-limit).reverse();
    }
    return db.collection("logs").find().sort({ ts: -1 }).limit(limit).toArray();
  });
}

function computeLogStats(logs) {
  var today = todayKey();
  var todays = logs.filter(function (l) { return l.ts && l.ts.slice(0, 10) === today; });
  var errors = todays.filter(function (l) { return !l.ok; });
  var totalDuration = todays.reduce(function (s, l) { return s + (l.durationMs || 0); }, 0);
  var byAction = {};
  todays.forEach(function (l) {
    var a = l.action || "onbekend";
    byAction[a] = (byAction[a] || 0) + 1;
  });
  return {
    requestsToday: todays.length,
    errorsToday: errors.length,
    avgDurationMs: todays.length ? Math.round(totalDuration / todays.length) : 0,
    byAction: byAction
  };
}

// ---------- Persistent storage: MongoDB Atlas if configured, else the local file above ----------
// The local file works for quick local testing, but on most hosting platforms (including
// Render's free tier) the filesystem is wiped on every restart/redeploy — so for anything
// long-lived, set MONGODB_URI (see .env.example / README) to use a real persistent database.

var mongoConnected = false;
var mongoReady = MONGODB_URI
  ? new MongoClient(MONGODB_URI).connect().then(function (client) {
      mongoConnected = true;
      console.log("Verbonden met MongoDB — data blijft nu bewaard tussen herstarts.");
      return client.db(MONGODB_DB_NAME);
    }).catch(function (err) {
      console.error("Kon niet verbinden met MongoDB (" + err.message + ") — val terug op lokale, niet-blijvende opslag.");
      return null;
    })
  : Promise.resolve(null);

function dbGetDoc(docPath) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      var exists = Object.prototype.hasOwnProperty.call(store.docs, docPath);
      return { exists: exists, value: exists ? store.docs[docPath] : null };
    }
    return db.collection("docs").findOne({ _id: docPath }).then(function (doc) {
      return { exists: !!doc, value: doc ? doc.value : null };
    });
  });
}

function dbSetDoc(docPath, value) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      store.docs[docPath] = value;
      saveStore(store);
      return;
    }
    return db.collection("docs").updateOne({ _id: docPath }, { $set: { value: value } }, { upsert: true });
  });
}

function getUsageToday() {
  var today = todayKey();
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      return store.usage[today] || 0;
    }
    return db.collection("usage").findOne({ _id: today }).then(function (doc) {
      return doc ? doc.count : 0;
    });
  });
}

function incrementUsageToday() {
  var today = todayKey();
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      store.usage[today] = (store.usage[today] || 0) + 1;
      saveStore(store);
      return;
    }
    return db.collection("usage").updateOne({ _id: today }, { $inc: { count: 1 } }, { upsert: true });
  });
}

// ---------- IP geolocation (best-effort, for the admin page only) ----------
// Uses a free public API (no key required); results are cached in memory for
// a day per IP so opening the admin page repeatedly doesn't re-query it.
// Private/local IPs (dev, or behind certain proxies) simply resolve to null.

var geoCache = new Map(); // ip -> { value: {city,country} | null, expiry }
var GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isPrivateIp(ip) {
  return !ip || ip === "unknown" || ip === "::1" || ip === "127.0.0.1" ||
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function resolveIpLocation(ip) {
  if (isPrivateIp(ip)) return Promise.resolve(null);
  var cached = geoCache.get(ip);
  if (cached && Date.now() < cached.expiry) return Promise.resolve(cached.value);
  return fetch("https://ipapi.co/" + encodeURIComponent(ip) + "/json/")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      var value = (data && !data.error) ? { city: data.city || null, country: data.country_name || null } : null;
      geoCache.set(ip, { value: value, expiry: Date.now() + GEO_CACHE_TTL_MS });
      return value;
    })
    .catch(function () { return null; });
}

function dbListUserIds() {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      var users = [];
      Object.keys(store.docs).forEach(function (key) {
        var m = key.match(/^auth\/users\/(.+)$/);
        if (m) { users.push({ uid: store.docs[key].uid, email: m[1], account: store.docs[key] }); return; }
        var a = key.match(/^data\/users\/(anon_[^\/]+)\/meta$/);
        if (a) users.push({ uid: a[1], email: null });
      });
      return users;
    }
    return Promise.all([
      db.collection("docs").find({ _id: { $regex: "^auth/users/" } }).toArray(),
      db.collection("docs").find({ _id: { $regex: "^data/users/anon_[^/]+/meta$" } }).toArray()
    ]).then(function (results) {
      var accounts = results[0].map(function (d) { return { uid: d.value.uid, email: d._id.slice("auth/users/".length), account: d.value }; });
      var anons = results[1].map(function (d) { return { uid: d._id.split("/")[2], email: null }; });
      return accounts.concat(anons);
    });
  });
}

// ---------- Simple admin auth: one shared password, random session tokens kept in memory ----------
// Tokens are lost on server restart (fine for a small personal monitoring tool) and expire after 24h.

var adminTokens = new Map(); // token -> expiry timestamp
var ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function issueAdminToken() {
  var token = crypto.randomBytes(24).toString("hex");
  adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
  return token;
}
function isValidAdminToken(token) {
  if (!token) return false;
  var expiry = adminTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) { adminTokens.delete(token); return false; }
  return true;
}
function requireAdmin(req, res) {
  var auth = req.headers["authorization"] || "";
  var token = auth.indexOf("Bearer ") === 0 ? auth.slice(7) : "";
  if (!isValidAdminToken(token)) {
    sendJSON(res, 401, { code: "unauthorized", message: "Niet ingelogd of sessie verlopen." });
    return false;
  }
  return true;
}

// ---------- Simple in-memory per-IP rate limiter (resets on restart) ----------

var ipHits = new Map(); // ip -> { count, windowStart }
function checkIpRateLimit(ip) {
  var now = Date.now();
  var hour = 60 * 60 * 1000;
  var entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart > hour) {
    entry = { count: 0, windowStart: now };
  }
  entry.count++;
  ipHits.set(ip, entry);
  return entry.count <= liveLimits.perIpHourlyCap;
}

// ---------- HTTP helpers ----------

function sendJSON(res, status, body) {
  var data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store"
  });
  res.end(data);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var total = 0;
    req.on("data", function (c) {
      total += c.length;
      if (total > 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", function () {
      try {
        var raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  var fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

// ---------- Extract the first JSON value (array or object) from a model's text reply ----------

function fixDutchDecimals(text) {
  // The model occasionally writes a Dutch-style decimal comma (e.g. 1,50)
  // instead of the JSON-required decimal point (1.50), which breaks JSON.parse.
  // Only touches number-like values right after a colon, followed by a
  // comma/brace/bracket — deliberately narrow so it never touches real
  // array/object separators.
  return text.replace(/(:\s*-?\d+),(\d{1,2})(?=\s*[,}\]])/g, "$1.$2");
}

function extractJson(text) {
  var cleaned = text.replace(/```json/gi, "```").trim();
  var fenceMatch = cleaned.match(/```([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  try { return JSON.parse(fixDutchDecimals(cleaned)); } catch (e) {}
  var firstArray = cleaned.indexOf("[");
  var firstObj = cleaned.indexOf("{");
  var start = -1;
  if (firstArray === -1) start = firstObj;
  else if (firstObj === -1) start = firstArray;
  else start = Math.min(firstArray, firstObj);
  if (start === -1) throw new Error("Geen JSON gevonden in antwoord");
  var lastArray = cleaned.lastIndexOf("]");
  var lastObj = cleaned.lastIndexOf("}");
  var end = Math.max(lastArray, lastObj);
  var candidate = cleaned.slice(start, end + 1);
  try { return JSON.parse(candidate); } catch (e) {}
  return JSON.parse(fixDutchDecimals(candidate));
}

// ---------- NEVO: macro's berekenen met het Nederlands Voedingsstoffenbestand (RIVM) ----------
// In plaats van de AI de macro's te laten schatten, levert de AI per ingrediënt {tekst, gram, nevo} en
// rekent Balanza kcal/eiwit/koolhydraten/vet zelf uit met de officiële NEVO-waarden (zie NOTICE.md).
// Is de dekking onvolledig (een ingrediënt zonder goede NEVO-match), dan blijft de AI-schatting staan,
// duidelijk gelabeld als schatting in plaats van als NEVO-berekening.
var NEVO_DATASET = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "nevo", "nevo2025_macros.json"), "utf8")); }
  catch (e) { return []; }   // ontbreekt het bestand, dan draait de app door op AI-schattingen (geen NEVO-badge)
})();
  // Balanza-aanvullingen staan apart in NEVO_ADDITIONS en zijn geen onderdeel van NEVO.
  var NEVO_VERSION = "NEVO online versie 2025/9.0";
  var NEVO_REFERENCE = "Gebaseerd op gegevens uit NEVO online versie 2025/9.0, RIVM, Bilthoven";
  var NEVO_ADDITIONS = [
    // [code, naam, kcal, eiwit, kh, vet] — Balanza-aanvulling (gemiddelde etiketwaarden), niet afkomstig uit NEVO
    ["B1", "Eiwitpoeder wei- (Balanza-aanvulling)", 380, 78, 7, 6],
    ["B2", "Eiwitpoeder erwten- (Balanza-aanvulling)", 375, 80, 3, 7]
  ];
  var NEVO_STAPLE_CODES = [
    1634, 1305, 1936, 1405, 1421, 1400, 1663, 1422, 1790, 1587, 1096, 820, 3322, 1590, 353, 3320, 83, 358, 5519, 5573,
    2654, 328, 784, 639, 2300, 2996,
    305, 5295, 5271, 2503, 301, 286, 294, 654, 1382, 513, 718, 1955, 3362, 3377, 1650, 1808, 2268, 299, 310,
    5, 712, 4, 811, 1889, 5518, 3153, 1015, 1, 671, 213, 246, 2351, 5482, 2359, 2790, 1779, 2675, 220,
    3049, 3184, 5176, 3185, 5174, 120, 971, 3207,
    921, 14, 959, 50, 922, 884, 51, 19, 71, 63, 5459, 830, 60, 2739, 2346, 2736, 10, 562, 1892, 23, 57, 682, 3220, 689, 832, 141, 1524, 2293,
    147, 151, 148, 161, 152, 692, 5369, 158, 1127,
    601, 317, 3376, 198, 206, 199, 204, 5275, 838, 3447, 2806,
    5470, 5471, 2178, 2290, 451, 824, 443, 5253, 1232, 871, 1528, 616,
    // Plantaardige eiwitbronnen (seitan, soja-/tarwe-vleesvervangers, mycoproteïne, sojadrink/-yoghurt, lupine)
    1458, 5561, 5485, 2030, 3180, 5247, 5610
  ];
  // Kruiden, zout en water leveren verwaarloosbaar weinig energie en tellen niet mee voor de dekking.
  var NEVO_NEGLIGIBLE = ["zout", "zeezout", "peper", "water", "ijsblokjes", "ijs", "kaneel", "oregano", "basilicum", "peterselie",
    "koriander", "tijm", "rozemarijn", "dille", "bieslook", "munt", "paprikapoeder", "komijn", "kerriepoeder", "kurkuma",
    "chilivlokken", "cayennepeper", "nootmuskaat", "laurier", "kruiden", "specerijen", "italiaanse kruiden", "knoflookpoeder",
    "uienpoeder", "gemberpoeder", "chilipoeder", "vanille", "zoetstof", "citroenrasp", "limoenrasp", "bakpoeder"];

  // Veelvoorkomende spreektaal → NEVO-code (alleen een verwijzing; de NEVO-waarden zelf blijven ongewijzigd).
  var NEVO_ALIASES = {
    "ei": 83, "eieren": 83, "ei kippen": 83, "kippenei": 83, "rijst": 5, "witte rijst": 5, "basmatirijst": 5, "jasmijnrijst": 5,
    "zilvervliesrijst": 712, "aardappel": 1, "aardappelen": 1, "kruimige aardappelen": 1, "zalm": 1587, "zalmfilet": 1587,
    "havermout": 213, "parmaham": 328, "serranoham": 328, "edamame": 971, "tomatensaus": 1524, "passata": 1524,
    "amandelen": 198, "bosui": 63, "lente ui": 63, "ui": 63, "gerookte kipfilet": 2654, "gekookte kipfilet": 1392, "gebakken kipfilet": 1392, "rundvlees reepjes": 1663,
    "biefstukreepjes": 1400, "pasta": 4, "spaghetti": 4, "penne": 4, "volkoren pasta": 811, "volkoren spaghetti": 811,
    "volkorenbrood": 246, "volkoren brood": 246, "bruin brood": 246, "brood": 246, "kaas": 513, "geraspte kaas": 513,
    "mozzarella": 1955, "feta": 3362, "kwark": 305, "griekse yoghurt": 5271, "yoghurt": 301, "melk": 286,
    "olijfolie": 601, "olie": 317, "zonnebloemolie": 317, "sesamolie": 3376, "boter": 310, "roomboter": 310,
    "kipdijfilet": 1305, "kippendij": 1305, "kipgehakt": 1305, "rundergehakt": 1405, "gehakt": 1405, "tonijn": 1590,
    "garnalen": 3320, "kabeljauw": 820, "kabeljauwfilet": 820, "tofu": 5519, "skyr": 5295, "cottage cheese": 654,
    "hummus": 3207, "pindakaas": 5275, "noten": 198, "wrap": 2359, "wraps": 2359, "volkoren wrap": 5482,
    "komkommer": 2739, "gember": 832, "verse gember": 832, "sperziebonen": 50, "boontjes": 50, "kerstomaatjes": 2731, "cherrytomaatjes": 2731, "cherrytomaten": 2731, "kerstomaten": 2731, "tomaat": 60, "tomaten": 60, "misopasta": 871, "miso": 871,
    "citroensap": 1127, "limoensap": 1127, "kokosmelk": 2290, "eiwitpoeder": "B1", "wei eiwitpoeder": "B1", "whey": "B1"
  };

  var nevoIndex = null;

  function nevoNorm(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9%+<>\s]/g, " ").replace(/\s+/g, " ").trim();
  }

  function nevoLoad() {
    if (nevoIndex) return nevoIndex;
    var rows = (NEVO_DATASET || []).concat(NEVO_ADDITIONS);
    var byCode = {};
    var list = rows.map(function (r) {
      var item = { code: String(r[0]), naam: r[1], kcal: r[2], eiwit: r[3], kh: r[4], vet: r[5],
        norm: nevoNorm(r[1]), extra: String(r[0]).charAt(0) === "B" };
      item.tokens = item.norm.split(" ").filter(Boolean);
      byCode[item.code] = item;
      return item;
    });
    var byNorm = {};
    list.forEach(function (it) { if (!byNorm[it.norm]) byNorm[it.norm] = it; });
    var staple = {};
    NEVO_STAPLE_CODES.forEach(function (c) { staple[String(c)] = true; });
    nevoIndex = { list: list, byCode: byCode, byNorm: byNorm, staple: staple };
    return nevoIndex;
  }

  function nevoAvailable() { return nevoLoad().list.length > NEVO_ADDITIONS.length; }

  // Hoe goed past een zoekwoord bij een NEVO-woord (0..1). Vangt samenstellingen op: "walnoten" ~ "noten wal".
  function nevoTokenScore(q, t) {
    if (q === t) return 1;
    if (t.length >= 3 && q.length >= 3) {
      var ratio = Math.min(q.length, t.length) / Math.max(q.length, t.length);
      if (q.indexOf(t) === 0 || t.indexOf(q) === 0) return ratio >= 0.6 ? 0.85 : 0.5;
      if (q.indexOf(t) > -1 || t.indexOf(q) > -1) return ratio >= 0.5 ? 0.7 : 0.45;
    }
    return 0;
  }

  var NEVO_STATE_WORDS = ["rauw", "gekookt", "bereid", "gebakken", "blik", "glas", "onbereid", "gedroogd", "diepvries"];

  function nevoMatch(query) {
    var idx = nevoLoad();
    var q = nevoNorm(query);
    if (!q) return null;
    if (idx.byNorm[q]) return { item: idx.byNorm[q], score: 1 };
    var qa = q.replace(/\b(verse|vers|gesneden|gehakte|geraspte|in blokjes|in reepjes|in plakjes|in linten|in partjes|in peul|uitgelekt|ongezouten|biologische|klein|kleine|grote|droog gewicht)\b/g, "").replace(/\s+/g, " ").trim();
    if (NEVO_ALIASES[qa] !== undefined && idx.byCode[String(NEVO_ALIASES[qa])]) return { item: idx.byCode[String(NEVO_ALIASES[qa])], score: 0.95 };
    if (qa && idx.byNorm[qa]) return { item: idx.byNorm[qa], score: 1 };
    var qTokens = (qa || q).split(" ").filter(Boolean);
    var best = null, bestScore = 0;
    idx.list.forEach(function (it) {
      var matched = 0, used = 0;
      it.tokens.forEach(function (t) {
        var b = 0;
        qTokens.forEach(function (qt) { var s = nevoTokenScore(qt, t); if (s > b) b = s; });
        matched += b;
        if (b > 0) used++;
      });
      if (!used) return;
      var qCovered = 0;
      qTokens.forEach(function (qt) {
        var b = 0;
        it.tokens.forEach(function (t) { var s = nevoTokenScore(qt, t); if (s > b) b = s; });
        qCovered += b;
      });
      var precision = matched / it.tokens.length;
      var recall = qCovered / qTokens.length;
      var score = precision * 0.45 + recall * 0.55;
      // Zonder bereidingswijze in de zoekterm: voorkeur voor rauw/onbereid (hoeveelheden zijn rauw gewicht).
      var qHasState = qTokens.some(function (x) { return NEVO_STATE_WORDS.indexOf(x) > -1; });
      if (!qHasState && (it.tokens.indexOf("rauw") > -1 || it.tokens.indexOf("onbereid") > -1)) score += 0.03;
      if (it.extra) score -= 0.02;
      if (idx.staple[it.code]) score += 0.08;
      if (score > bestScore || (score === bestScore && best && it.tokens.length < best.tokens.length)) {
        best = it; bestScore = score;
      }
    });
    return best && bestScore >= 0.62 ? { item: best, score: bestScore } : null;
  }

  function nevoIsNegligible(text) {
    // Langere alternatieven eerst (bijv. "snufje" vóór "snuf"), anders knipt de regex een langer woord verkeerd af.
    var n = nevoNorm(text).replace(/^[0-9.,/ ]+(gram|snufje|takjes|takje|handvol|handje|tenen|teen|gr|g|ml|tl|el|snuf|blaadjes)?\s*/, "");
    if (!n) return true;
    return NEVO_NEGLIGIBLE.some(function (w) { return n === w || n.indexOf(w + " ") === 0 || n === "verse " + w || n === "gedroogde " + w || n === w + " naar smaak"; }) ||
      /(^| )(naar smaak|snufje)( |$)/.test(n) && !/[0-9]/.test(n);
  }

  // Normaliseert AI-ingrediënten naar {tekst, gram, nevo}. Accepteert objecten en oude tekstregels.
  function nevoNormalizeIngredients(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      if (x && typeof x === "object") {
        var tekst = String(x.tekst || x.text || x.naam || "").trim();
        var gram = Number(String(x.gram == null ? "" : x.gram).replace(",", "."));
        return { tekst: tekst, gram: isFinite(gram) && gram > 0 ? gram : 0, nevo: String(x.nevo || "").trim() };
      }
      var t = String(x || "").trim();
      var m = t.match(/^(\d+(?:[.,]\d+)?)\s*(g|gr|gram|ml)\b\.?\s*(.*)$/i);
      if (m) return { tekst: t, gram: Number(m[1].replace(",", ".")), nevo: m[3].replace(/\(.*?\)/g, "").trim() };
      var u = t.match(/^(\d+(?:[.,]\d+)?|1\/2)\s*(el|eetlepels?|tl|theelepels?|sneetjes?|sneden|snee|eieren|ei)\b\.?\s*(.*)$/i);
      if (u) {
        var qty = u[1] === "1/2" ? 0.5 : Number(u[1].replace(",", "."));
        var unit = u[2].toLowerCase();
        var per = /^el|^eetlepel/.test(unit) ? 15 : /^tl|^theelepel/.test(unit) ? 5 : /^snee|^sneden/.test(unit) ? 35 : 50;
        var name = /^ei/.test(unit) ? "ei" : u[3].replace(/\(.*?\)/g, "").trim();
        return { tekst: t, gram: qty * per, nevo: name };
      }
      return { tekst: t, gram: 0, nevo: "" };
    }).filter(function (x) { return x.tekst; });
  }

  // Berekent macro's per portie uit NEVO. Geeft ook de dekking terug.
  function nevoCalculate(items) {
    var tot = { kcal: 0, eiwit: 0, kh: 0, vet: 0 };
    var relevant = 0, covered = 0, missing = [], detail = [];
    items.forEach(function (ing) {
      var negligible = nevoIsNegligible(ing.tekst);
      var m = ing.gram > 0 ? nevoMatch(ing.nevo || ing.tekst) : null;
      if (!m && ing.gram > 0 && ing.nevo) m = nevoMatch(ing.tekst);
      if (m && ing.gram > 0) {
        var f = ing.gram / 100;
        tot.kcal += m.item.kcal * f; tot.eiwit += m.item.eiwit * f; tot.kh += m.item.kh * f; tot.vet += m.item.vet * f;
        detail.push({ tekst: ing.tekst, gram: ing.gram, code: m.item.code, naam: m.item.naam });
        if (!negligible) { relevant++; covered++; }
      } else {
        detail.push({ tekst: ing.tekst, gram: ing.gram || 0, code: null, naam: null });
        if (!negligible) { relevant++; missing.push(ing.tekst); }
      }
    });
    return {
      kcal: Math.round(tot.kcal), eiwitG: Math.round(tot.eiwit), khG: Math.round(tot.kh), vetG: Math.round(tot.vet),
      relevant: relevant, covered: covered, missing: missing, detail: detail
    };
  }

  // Past NEVO-berekening toe op een gerecht. Bij onvoldoende dekking blijft de AI-schatting staan, duidelijk gelabeld.
  // Herberekent kcal/eiwit_g/kh_g/vet_g van een gerecht met NEVO, op basis van {tekst, gram, nevo} per ingrediënt
  // (zoals de AI die nu aanlevert). Dekken alle relevante ingrediënten (zout/kruiden tellen niet mee) een
  // NEVO-product, dan vervangen de NEVO-waarden de AI-schatting; anders blijft de AI-schatting staan, gelabeld.
  // "ingredienten" wordt altijd de leesbare tekstregel, zodat de rest van de app niets van dit schema hoeft te weten.
  function applyNevoToDish(dish, rawIngredients) {
    var items = nevoNormalizeIngredients(rawIngredients);
    dish.ingredienten = items.map(function (x) { return x.tekst; });
    if (!nevoAvailable() || !items.length) { dish.macroBron = "schatting"; return dish; }
    var calc = nevoCalculate(items);
    dish.nevo = { versie: NEVO_VERSION, gedekt: calc.covered, totaal: calc.relevant, ontbreekt: calc.missing };
    if (calc.kcal > 0 && calc.relevant > 0 && calc.covered === calc.relevant) {
      dish.kcal = calc.kcal;
      dish.kh_g = calc.khG; dish.eiwit_g = calc.eiwitG; dish.vet_g = calc.vetG;
      dish.macroBron = "nevo";
    } else {
      dish.macroBron = "schatting";
    }
    return dish;
  }

  function nevoStapleText() {
    var idx = nevoLoad();
    return NEVO_STAPLE_CODES.map(function (c) { return idx.byCode[String(c)]; }).filter(Boolean).concat(
      NEVO_ADDITIONS.map(function (a) { return idx.byCode[a[0]]; })
    ).map(function (it) {
      return it.naam.replace(" (Balanza-aanvulling)", "") + " | " + it.kcal + " kcal, " + it.eiwit + " E, " + it.kh + " KH, " + it.vet + " V";
    }).join("\n");
  }

  // Gedeelde promptinstructie voor ingrediënten in grammen met NEVO-naam.
  function nevoPromptText(forGeneration) {
    if (!nevoAvailable()) return "";
    return "\nVOEDINGSWAARDEN: Balanza rekent de macro's zelf uit met het Nederlands Voedingsstoffenbestand (NEVO). Daarom:\n" +
      "- Geef ELK ingrediënt als object {\"tekst\": \"180 g kipfilet\", \"gram\": 180, \"nevo\": \"Kipfilet rauw\"}.\n" +
      "- \"gram\" = gewicht per portie in gram (rauw/onbereid gewicht, vloeistoffen in ml = gram). Ook olie, boter, sauzen, dressings, " +
      "kaas en noten krijgen altijd een concrete hoeveelheid (1 el olie = 10 g, 1 tl = 4 g). Zout, peper en gedroogde kruiden mogen gram 1.\n" +
      "- \"tekst\" = de leesbare regel voor de gebruiker, mét hoeveelheid.\n" +
      "- \"nevo\" = de NEVO-productnaam; kies bij voorkeur exact een naam uit de lijst hieronder, anders de best passende NEVO-achtige naam.\n" +
      (forGeneration === false ? "" : "- Kies hoeveelheden zó dat de macro's, gerekend met deze waarden, het doel echt halen. Reken zelf na voordat je antwoordt. " +
        "Vul kcal/kh_g/eiwit_g/vet_g in met die eigen berekening.\n") +
      "NEVO 2025 per 100 g (naam | kcal, eiwit, koolhydraten, vet):\n" + nevoStapleText() + "\n";
  }

  var NEVO_INGREDIENT_SCHEMA = '[{"tekst": "180 g kipfilet", "gram": 180, "nevo": "Kipfilet rauw"}]';

  // Groen zegel: getande rozet met vinkje. Kleuren via CSS-tokens, zodat licht en donker thema kloppen.
  function nevoIngredientSchema() {
    return nevoAvailable() ? NEVO_INGREDIENT_SCHEMA : '["ingredient 1", "ingredient 2"]';
  }
  function nevoIngredientTexts(arr) {
    return nevoNormalizeIngredients(arr).map(function (x) { return x.tekst; });
  }

// ---------- Routes ----------

// ---------- Prompt construction (server-side only) ----------
// The exact prompt wording/structure lives here, not in the client JS —
// the browser only ever sends raw preference values (goal, cuisines, etc.),
// never the assembled instruction text. This keeps the prompt engineering
// out of anyone's browser dev tools / view-source.

var GOAL_DESCRIPTIONS = {
  "Onderhoud": "gelijke verdeling (±33% koolhydraten/eiwit/vet) om gewicht te behouden",
  "Vetverlies (spierbehoud)": "hoger eiwit, lager koolhydraten en vet, voor vetverlies met behoud van spiermassa (streef naar 30% koolhydraten / 40% eiwit / 30% vet)",
  "Cutting": "zeer hoog eiwit, laag koolhydraten, voor een agressiever calorietekort met maximaal spierbehoud (streef naar 25% koolhydraten / 45% eiwit / 30% vet)",
  "Spieropbouw (lean bulk)": "hoger koolhydraten en eiwit voor spieropbouw met een lichte overschot (streef naar 40% koolhydraten / 30% eiwit / 30% vet)",
  "Atleet (prestatiegericht)": "hoger koolhydraten voor trainings- en wedstrijdbrandstof, met voldoende eiwit voor herstel (streef naar 45% koolhydraten / 25% eiwit / 30% vet)"
};

var MEALTYPE_GUIDE = {
  "Ontbijt": { min: 350, max: 450, desc: "een ontbijt (bijv. eieren, havermout, kwark, yoghurt, brood) — geen zware avondmaaltijd-gerechten" },
  "Lunch": { min: 450, max: 550, desc: "een lunch (bijv. salade, bowl, belegd brood, soep met brood) — praktisch te bereiden of mee te nemen" },
  "Diner": { min: 550, max: 650, desc: "een volwaardige warme avondmaaltijd" },
  "Snack": { min: 150, max: 250, desc: "een tussendoortje, klein en snel" }
};

var GOAL_KCAL_MULTIPLIER = {
  "Onderhoud": 1,
  "Vetverlies (spierbehoud)": 0.85,
  "Cutting": 0.65,
  "Spieropbouw (lean bulk)": 1.15,
  "Atleet (prestatiegericht)": 1.1
};

var VARIATION_INSTRUCTIONS = {
  pittiger: "Maak dit gerecht duidelijk pittiger (meer chili/kruiden), zonder de kern van het gerecht te veranderen.",
  simpeler: "Maak dit gerecht simpeler en basic: minder stappen, alledaagse ingrediënten, makkelijker om te bereiden.",
  finedining: "Maak dit gerecht fine dining: verfijndere presentatie, technieken en smaakcombinaties, iets hoger culinair niveau.",
  wisselkh: "Vervang de koolhydraatbron door een andere (bijv. rijst i.p.v. aardappel of andersom), maar behoud dezelfde macroverdeling."
};

var FOTO_TERM_LINE = "\"foto_zoekterm\" is een korte Engelse zoekterm (2 tot 4 woorden) om een passende stockfoto van dit gerecht te vinden: " +
  "noem het hoofdingrediënt en het soort gerecht, zonder bijvoeglijke naamwoorden als pittig, gastronomisch of huisgemaakt " +
  "(bijv. \"grilled salmon asparagus\" of \"chicken curry rice\"). ";

var INGREDIENT_SPECIFICITY_LINE = "Elk ingrediënt moet specifiek en concreet benoemd zijn (bijv. \"1 tl oregano\" of \"2 tenen knoflook\"), " +
  "nooit een vaag verzamelwoord zoals \"kruiden\" of \"specerijen\" zonder te specificeren welke.\n";

function mealtypeGuideText(mealType, goal) {
  var g = MEALTYPE_GUIDE[mealType] || MEALTYPE_GUIDE["Diner"];
  var mult = GOAL_KCAL_MULTIPLIER[goal] || 1;
  var min = Math.max(80, Math.round(g.min * mult / 10) * 10);
  var max = Math.max(min + 40, Math.round(g.max * mult / 10) * 10);
  return min + "-" + max + " kcal per portie; " + g.desc;
}

function goalInstructionText(goal, dietStyle) {
  var desc = GOAL_DESCRIPTIONS[goal] || GOAL_DESCRIPTIONS["Onderhoud"];
  if (dietTargetAdjusted(goal, dietStyle)) {
    var t = goalTargetFor(goal, dietStyle);
    desc = "aangepast aan " + String(dietStyle).toLowerCase() + " eten: ca. " + t.kh + "% koolhydraten, " + t.eiwit + "% eiwit, " + t.vet + "% vet " +
      "(plantaardige eiwitbronnen bevatten van nature meer koolhydraten of vet, daarom ligt het eiwitdoel iets lager)";
  }
  return "Streef naar een macroverdeling passend bij het doel \"" + goal + "\": " + desc +
    " (elke macro binnen 2-3 procentpunt van het streefpercentage). ";
}

function dietStyleInstructionText(dietStyle) {
  if (!dietStyle) return "";
  var notes = {
    "Omnivoor": "geen beperkingen, alle voedingsmiddelen zijn toegestaan.",
    "Flexitarisch": "overwegend plantaardig; vlees of vis mag af en toe voorkomen, maar niet in elk gerecht.",
    "Vegetarisch": "geen vlees en geen vis; zuivel en eieren zijn wel toegestaan.",
    "Veganistisch": "volledig plantaardig; geen vlees, vis, zuivel, eieren, honing of andere dierlijke producten."
  };
  return "- Voedingsstijl: " + dietStyle + " (" + (notes[dietStyle] || "") + ")\n";
}

// ===== Voedingsstijl als harde eis =====
var DIET_FORBIDDEN_TEXT = {
  "Vegetarisch": "geen vlees, gevogelte, vis, schaal- of schelpdieren, en ook geen producten daarvan (zoals spek, ham, chorizo, worst, ansjovis, " +
    "vis- of kippenbouillon, vissaus, gelatine)",
  "Veganistisch": "geen vlees, gevogelte, vis, schaal- of schelpdieren, zuivel (melk, kaas, boter, room, yoghurt, kwark, skyr), eieren, honing, " +
    "gelatine, wei-eiwit of andere dierlijke producten; plantaardige varianten (sojamelk, havermelk, kokosmelk, tofu, tempeh) zijn wel goed"
};
// Eiwitstrategie: plantaardige eiwitbronnen die weinig koolhydraten/vet meebrengen, zodat de balans haalbaar blijft.
function plantProteinStrategyText(dietStyle) {
  if (!DIET_FORBIDDEN_TEXT[dietStyle]) return "";
  var sources = dietStyle === "Vegetarisch"
    ? "seitan, tempeh, stevige tofu, vegetarisch gehakt of vegetarische reepjes op basis van soja, mycoproteïne, magere kwark, skyr, eiwit(wit) van eieren, of eiwitpoeder"
    : "seitan, tempeh, stevige tofu, vegetarisch gehakt of reepjes op basis van soja (vegan), sojadrink of sojayoghurt zonder suiker, lupine, of erwteneiwitpoeder";
  return "EIWITSTRATEGIE: kies als hoofd-eiwitbron bij voorkeur " + sources + ". " +
    "Peulvruchten (linzen, kikkererwten, bonen) bevatten veel koolhydraten; gebruik ze als bijgerecht of aanvulling, niet als enige eiwitbron. " +
    "Houd vet laag (weinig olie, noten, kaas of kokos) en combineer eiwitbronnen waar nodig om het eiwitpercentage te halen.\n";
}
function dietHardRuleText(dietStyle) {
  var forbidden = DIET_FORBIDDEN_TEXT[dietStyle];
  if (!forbidden) return "";
  return "HARDE EIS \u2014 VOEDINGSSTIJL " + dietStyle.toUpperCase() + ": elk gerecht is volledig " + dietStyle.toLowerCase() + ": " + forbidden + ". " +
    "Deze eis gaat boven keukenstijl, smaak, apparatuur en doel. Bij klassieke gerechten met vlees of vis (bijv. paella, wokgerechten, stoofpot) " +
    "maak je de " + dietStyle.toLowerCase() + "e variant, met eiwitbronnen als peulvruchten, tofu, tempeh" + (dietStyle === "Vegetarisch" ? ", eieren of kaas" : "") +
    ". Controleer vóór je antwoordt elk ingrediënt hierop.\n" + plantProteinStrategyText(dietStyle);
}
var MEAT_FISH_RE = /\b(kip\w*|kippe\w*|kalkoen\w*|eend\w*|rund\w*|biefstuk\w*|ossenhaas|entrecote|gehakt\w*|varken\w*|spek\w*|bacon|ham|hammen|parmaham|serranoham|chorizo|salami|pancetta|prosciutto|\w*worst\w*|lams?\w*vlees|lamsrack|lamskotelet\w*|kalfs?\w*|hert\w*|konijn\w*|\w*vlees\w*|vis|vissen|visfilet\w*|vissaus|visbouillon|zalm\w*|tonijn\w*|kabeljauw\w*|pangasius|tilapia|makreel\w*|haring\w*|sardine\w*|sardientje\w*|ansjovis\w*|garnaal|garnalen\w*|gamba\w*|scampi|mossel\w*|inktvis\w*|octopus|calamaris?|kreeft\w*|krab\w*|oester\w*|sint-jakobsschelp\w*|schelpdier\w*|schaaldier\w*|zeevruchten|gelatine|kippenbouillon|runderbouillon)\b/i;
var ANIMAL_RE = /\b(kaas\w*|\w*kaas|melk|volle melk|halfvolle melk|magere melk|karnemelk|boter|roomboter|room|slagroom|kookroom|zure room|cr[eè]me fra[iî]che|yoghurt\w*|kwark\w*|skyr|ei|eieren|eidooier\w*|eiwitten|honing|ghee|mozzarella|feta|parmezaan\w*|ricotta|mascarpone|cottage cheese|h[uü]ttenk[aä]se|wei|wei-eiwit\w*|whey|gelatine)\b/i;
var PLANT_DAIRY_RE = /\b(kokos|haver|soja|amandel|rijst|cashew|erwten|noten|plantaardige?|vegan|vegetarische)[\s-]*(melk|room|yoghurt|boter|kaas|drink|kwark|ei)\w*\b|\b(pindakaas|pindaboter|notenboter|amandelboter|cashewboter|kokosmelk|kokosroom|sojamelk|havermelk|amandelmelk|sojayoghurt|kokosyoghurt|veganistische \w+|vegan \w+)\b/gi;
function dishDietViolations(d, dietStyle) {
  if (!d || !DIET_FORBIDDEN_TEXT[dietStyle]) return [];
  var parts = [String(d.name || "")];
  (Array.isArray(d.ingredienten) ? d.ingredienten : []).forEach(function (x) {
    if (x && typeof x === "object") parts.push(String(x.tekst || "") + " " + String(x.nevo || ""));
    else parts.push(String(x || ""));
  });
  var hits = [];
  parts.forEach(function (t) {
    var txt = t.toLowerCase();
    if (/\b(vegetarisch\w*|veganistisch\w*|vegan|plantaardig\w*|vleesvervanger\w*|vegaburger|vega\s?\w*)\b/.test(txt) && !/\b(ansjovis|zalm|tonijn)\b/.test(txt)) return;   // expliciet plantaardige vervanger
    var m = txt.match(MEAT_FISH_RE);
    if (m) { hits.push(m[0]); return; }
    if (dietStyle === "Veganistisch") {
      var cleaned = txt.replace(PLANT_DAIRY_RE, " ");
      var a = cleaned.match(ANIMAL_RE);
      if (a) hits.push(a[0]);
    }
  });
  return hits;
}
function dietViolationCount(parsed, dietStyle) {
  if (!DIET_FORBIDDEN_TEXT[dietStyle]) return 0;
  var dishes = Array.isArray(parsed) ? parsed : [parsed];
  return dishes.reduce(function (n, d) { return n + (dishDietViolations(d, dietStyle).length ? 1 : 0); }, 0);
}
// Voorbeelden en de NEVO-lijst in de prompt mogen geen vlees/vis voorzeggen bij een vegetarische of veganistische stijl.
function adaptPromptToDiet(prompt, dietStyle) {
  if (!DIET_FORBIDDEN_TEXT[dietStyle]) return prompt;
  var out = prompt
    .split('"180 g kipfilet", "gram": 180, "nevo": "Kipfilet rauw"').join('"150 g kikkererwten", "gram": 150, "nevo": "Kikkererwten blik/glas"')
    .split("grilled salmon asparagus").join(dietStyle === "Veganistisch" ? "tofu vegetable bowl" : "vegetable paella");
  var lines = out.split("\n");
  out = lines.filter(function (ln) {
    if (ln.indexOf(" | ") === -1 || !/kcal/.test(ln)) return true;   // alleen regels uit de NEVO-lijst filteren
    var name = ln.split(" | ")[0].toLowerCase();
    var plantBased = /\b(vegetarisch\w*|veganistisch\w*|vegan|plantaardig\w*|vega)\b|obv soja|obv mycoprote/.test(name);
    if (dietStyle === "Veganistisch" && /^eiwitpoeder wei|mycoprote/.test(name)) return false;   // mycoproteïne bevat vaak kippeneiwit
    if (dietStyle === "Veganistisch" && /^plantaardig alternatief/.test(name)) return true;
    if (MEAT_FISH_RE.test(name) && !plantBased) return false;
    if (dietStyle === "Veganistisch" && ANIMAL_RE.test(name.replace(PLANT_DAIRY_RE, " ").replace(/\bobv (soja|tarwe)\b/g, " "))) return false;
    return true;
  }).join("\n");
  return out;
}

// Een harde, doorlopende voorkeur (zoals voedingsstijl): geldt bij genereren, aanvullen én variëren.
function familyModeInstructionText(familyMode) {
  if (!familyMode) return "";
  return "- Kindvriendelijk (gezinsmodus): mild van smaak (niet te pittig of scherp), herkenbare in plaats van " +
    "exotische ingrediënten, geen hele vis met graten, en een presentatie die aanspreekt voor zowel kinderen " +
    "als volwassenen aan dezelfde tafel.\n";
}
function buildBodyProfileLine(p) {
  if (!p.gender && !p.heightCm && !p.weightKg && !p.age) return "";
  var bits = [];
  if (p.gender) bits.push(p.gender);
  if (p.age) bits.push(p.age + " jaar");
  if (p.heightCm) bits.push(p.heightCm + " cm");
  if (p.weightKg) bits.push(p.weightKg + " kg");
  bits.push("activiteitsniveau: " + String(p.activityLevel || "Gemiddeld actief").toLowerCase());
  return "- Lichaamsprofiel: " + bits.join(", ") + " — stem portiegrootte en calorieën hierop af (naast de " +
    "maaltijdmoment-richtlijn hierboven)\n";
}

function buildGeneratePrompt(p) {
  var cuisineTxt = (p.cuisines && p.cuisines.length) ? p.cuisines.join(", ") : "geen specifieke voorkeur";
  var flavorTxt = (p.flavors && p.flavors.length) ? p.flavors.join(", ") : "geen specifieke voorkeur";
  var equipTxt = (p.equipment && p.equipment.length) ? p.equipment.join(", ") : "standaard fornuis en oven";
  var excludeTxt = (p.exclude && String(p.exclude).trim()) ? String(p.exclude).trim() : "geen";
  var mealTypes = (p.mealTypes && p.mealTypes.length) ? p.mealTypes : ["Diner"];
  var count = p.count || 1;
  var mealGuideTxt = mealTypes.map(function (mt) { return mt + " (" + mealtypeGuideText(mt, p.goal) + ")"; }).join("; ");
  var totalCount = count * mealTypes.length;
  var mealInstruction = mealTypes.length === 1
    ? "Alle " + count + " gerechten zijn bedoeld als " + mealTypes[0].toLowerCase() + "."
    : "Genereer PRECIES " + count + " gerechten per maaltijdmoment (dus " + count + "x elk van: " +
      mealTypes.join(", ") + " — in totaal " + totalCount + " gerechten). Niet verdelen of afronden, exact " +
      count + " per moment.";
  return "Je bent een voedingskundige chef-kok. Genereer in totaal " + totalCount + " macro-gebalanceerde " +
    "gerechten (per 1 persoon) die voldoen aan:\n" +
    dietHardRuleText(p.dietStyle) +
    "- Maaltijdmomenten: " + mealGuideTxt + "\n" +
    mealInstruction + "\n" +
    "- Keukenstijl: " + cuisineTxt + "\n" +
    "- Smaakprofiel: " + flavorTxt + "\n" +
    "- Culinair niveau: " + (p.level || "Home-style") + "\n" +
dietStyleInstructionText(p.dietStyle) +
    familyModeInstructionText(p.familyMode) +
    "- Beschikbare apparatuur (mag je gebruiken, niet elk gerecht hoeft alles te gebruiken): " + equipTxt + "\n" +
    "- Uitgesloten ingrediënten: " + excludeTxt + "\n" +
    buildBodyProfileLine(p) +
    goalInstructionText(p.goal, p.dietStyle) +
    "Gebruik reële, haalbare porties en ingrediënten die passen " +
    "bij het gekozen maaltijdmoment van elk gerecht.\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug: een array van EXACT " + totalCount + " objecten (" + count +
    " per maaltijdmoment), exact dit schema, geen markdown-opmaak, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "mealType": "' + mealTypes[0] + '", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ' + nevoIngredientSchema() + ', ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + mealTypes.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
    FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd (koken, bakken, grillen, oven, sudderen); anders weglaten." +
    nevoPromptText();
}

function buildBackgroundGeneratePrompt(needed, p) {
  var cuisineTxt = (p.cuisines && p.cuisines.length) ? p.cuisines.join(", ") : "geen specifieke voorkeur";
  var flavorTxt = (p.flavors && p.flavors.length) ? p.flavors.join(", ") : "geen specifieke voorkeur";
  var equipTxt = (p.equipment && p.equipment.length) ? p.equipment.join(", ") : "standaard fornuis en oven";
  var types = Object.keys(needed || {});
  var totalCount = types.reduce(function (sum, m) { return sum + needed[m]; }, 0);
  var countTxt = types.map(function (m) { return needed[m] + "x " + m + " (" + mealtypeGuideText(m, p.goal) + ")"; }).join(", ");
  return "Je bent een voedingskundige chef-kok. Genereer in totaal " + totalCount + " macro-gebalanceerde " +
    "gerechten (per 1 persoon), verdeeld als: " + countTxt + ". Precies deze aantallen per maaltijdmoment.\n" +
    dietHardRuleText(p.dietStyle) +
    "- Keukenstijl: " + cuisineTxt + "\n- Smaakprofiel: " + flavorTxt + "\n- Culinair niveau: " + (p.level || "Home-style") + "\n" +
    dietStyleInstructionText(p.dietStyle) +
    familyModeInstructionText(p.familyMode) +
    "- Beschikbare apparatuur (mag je gebruiken, niet elk gerecht hoeft alles te gebruiken): " + equipTxt + "\n" +
    buildBodyProfileLine(p) +
    goalInstructionText(p.goal, p.dietStyle) + "\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug: een array van EXACT " + totalCount + " objecten, exact dit schema, " +
    "geen markdown-opmaak, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "mealType": "' + types[0] + '", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ' + nevoIngredientSchema() + ', ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + types.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
    FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten." +
    nevoPromptText();
}

function buildVariationPromptServer(current, kind, p) {
  return "Hier is een bestaand gerecht in JSON: " + JSON.stringify(current) + "\n\n" +
    "Opdracht: " + (VARIATION_INSTRUCTIONS[kind] || "") + "\n" +
    dietHardRuleText(p.dietStyle) +
    goalInstructionText(p.goal, p.dietStyle) + "\n" +
    (p.dietStyle ? dietStyleInstructionText(p.dietStyle) : "") +
    familyModeInstructionText(p.familyMode) +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug, exact dit schema, geen markdown, geen uitleg erbuiten:\n" +
    '{"name": "gerechtnaam", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ' + nevoIngredientSchema() + ', ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}\n' +
    "\"bereidingstijd_minuten\" is de bijgewerkte, realistische totale bereidingstijd in hele minuten, passend bij de opdracht. " +
    "Werk ook \"foto_zoekterm\" bij als het hoofdingrediënt of het soort gerecht door de opdracht verandert. " + FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten." +
    nevoPromptText();
}

function buildPrepPromptServer(dishes) {
  var lines = (dishes || []).map(function (item) {
    return "- " + item.name + " (" + item.count + "x deze week): benodigdheden: " + item.benodigdheden +
      "; ingrediënten: " + (item.ingredienten || []).join(", ");
  }).join("\n");
  return "Je bent een meal-prep expert. Hier is de lijst gerechten die deze week gepland staan, met hoe vaak elk " +
    "voorkomt:\n" + lines + "\n\n" +
    "Maak hier ÉÉN geconsolideerd prep-plan van voor aankomende zondag: welke onderdelen (eiwitbronnen, " +
    "koolhydraatbronnen) kunnen in bulk worden voorbereid voor de hele week, gegroepeerd per keukenapparaat " +
    "(gasfornuis, oven, airfryer, vleesgrill). Schaal hoeveelheden naar het aantal keren dat elk gerecht " +
    "voorkomt. Houd het praktisch: alleen dingen die goed te bewaren/portioneren zijn (vlees, granen, " +
    "geroosterde groenten) — geen verse garnering of dressing die je beter per maaltijd apart maakt.\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug, exact dit schema, geen markdown, geen uitleg erbuiten:\n" +
    '{"name": "Prepdag", "benodigdheden": "korte tekst met keukenapparatuur", ' +
    '"ingredienten": ["ingredient 1 met hoeveelheid", "ingredient 2 met hoeveelheid"], ' +
    '"bereidingstijd_minuten": 60, ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}\n' +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten.";
}

// Zet ingrediëntregels van BESTAANDE gerechten om naar het NEVO-schema, zonder het recept te veranderen.
// De AI verzint geen nieuwe macro's; die worden na dit antwoord met NEVO uitgerekend (applyNevoToDish).
function buildNevoRecalcPrompt(dishes) {
  var data = dishes.map(function (d) { return { id: d.id, name: d.name, ingredienten: d.ingredienten }; });
  return "Hieronder staan bestaande gerechten (per 1 persoon) met hun ingrediëntregels, in JSON:\n" + JSON.stringify(data) + "\n\n" +
    "Opdracht: zet elke ingrediëntregel om naar een object {\"tekst\", \"gram\", \"nevo\"}. Verander NIETS aan het recept of de hoeveelheden. " +
    "Staat er bij een regel geen hoeveelheid (bijv. \"olijfolie\" of \"melk\"), kies dan een realistische hoeveelheid voor 1 portie die past bij het gerecht " +
    "en zet die hoeveelheid ook in \"tekst\" (bijv. \"10 g olijfolie\"). Stuks omrekenen naar gram (1 ei = 50 g, 1 snee brood = 35 g).\n" +
    nevoPromptText(false) +
    "Geef ALLEEN geldig JSON terug, geen markdown, geen uitleg: een array met per gerecht {\"id\": \"...\", \"ingredienten\": " + NEVO_INGREDIENT_SCHEMA + "}.";
}

function buildPriceEstimatePrompt(items) {
  var list = items || [];
  return "Je bent een prijsexpert voor Nederlandse supermarkten (zoals Albert Heijn en Jumbo). " +
    "Geef voor elk van de onderstaande boodschappenlijst-items een realistische geschatte prijsrange in euro's, " +
    "gebaseerd op de vermelde hoeveelheid en een gemiddeld huismerk/A-merk. " +
    "Geef ALLEEN geldig JSON terug: een array van exact " + list.length + " objecten, in dezelfde volgorde " +
    "als de items hieronder, elk exact dit schema: {\"laag\": number, \"hoog\": number} (bedragen in euro's, " +
    "afgerond op 2 decimalen, laag <= hoog, gebruik ALTIJD een punt als decimaalteken zoals 1.50 — nooit een komma). " +
    "Geen markdown, geen uitleg erbuiten.\n\nItems:\n" +
    list.map(function (t, i) { return (i + 1) + ". " + t; }).join("\n");
}

function mergeDishArrays(results) {
  var merged = [];
  results.forEach(function (arr) { if (Array.isArray(arr)) merged = merged.concat(arr); });
  return merged;
}

// Runs the requested action, splitting a multi-mealtype "generate" or
// "background" request into one parallel sub-request per mealtype (each
// smaller and thus faster) instead of one big sequential request — same
// total tokens/cost, but wall-clock time drops roughly N-fold for N
// mealtypes since they're generated concurrently rather than one after
// another. Falls back to a single request when there's only one mealtype.
// Rekent de macro's van elk gerecht in het antwoord opnieuw uit met NEVO (indien mogelijk); "parsed" is één
// gerecht (variatie) of een lijst (genereren/achtergrond). Ingrediënten worden altijd platte tekstregels.
function applyNevoToParsed(parsed) {
  var dishes = Array.isArray(parsed) ? parsed : [parsed];
  dishes.forEach(function (d) { if (d && Array.isArray(d.ingredienten)) applyNevoToDish(d, d.ingredienten); });
  return parsed;
}
function runGenerateAction(body) {
  var action = body && body.action;
  var params = (body && body.params) || {};

  if (action === "generate") {
    var mealTypes = (params.mealTypes && params.mealTypes.length) ? params.mealTypes : ["Diner"];
    if (mealTypes.length > 1) {
      return Promise.all(mealTypes.map(function (mt) {
        var subParams = Object.assign({}, params, { mealTypes: [mt] });
        return generateWithBalansRetry(buildGeneratePrompt(subParams), params.goal, applyNevoToParsed, params.dietStyle);
      })).then(mergeDishArrays);
    }
    return generateWithBalansRetry(buildGeneratePrompt(params), params.goal, applyNevoToParsed, params.dietStyle);
  }

  if (action === "background") {
    var needed = (body && body.needed) || {};
    var types = Object.keys(needed);
    if (types.length > 1) {
      return Promise.all(types.map(function (mt) {
        var subNeeded = {};
        subNeeded[mt] = needed[mt];
        return generateWithBalansRetry(buildBackgroundGeneratePrompt(subNeeded, params), params.goal, applyNevoToParsed, params.dietStyle);
      })).then(mergeDishArrays);
    }
    return generateWithBalansRetry(buildBackgroundGeneratePrompt(needed, params), params.goal, applyNevoToParsed, params.dietStyle);
  }

  if (action === "variation") {
    return generateWithBalansRetry(buildVariationPromptServer(body.current || {}, body.kind, params), params.goal, applyNevoToParsed, params.dietStyle);
  }

  if (action === "prep") {
    return generateWithBalansRetry(buildPrepPromptServer(body.dishes || []), null);
  }

  if (action === "price") {
    return generateWithBalansRetry(buildPriceEstimatePrompt(body.items || []), null);
  }

  if (action === "nevo-recalc") {
    if (!nevoAvailable()) { var noNevoErr = new Error("NEVO-gegevens zijn niet beschikbaar op deze server."); noNevoErr.isBadRequest = true; return Promise.reject(noNevoErr); }
    var dishesIn = Array.isArray(body.dishes) ? body.dishes : [];
    dishesIn = dishesIn.filter(function (d) { return d && typeof d.id === "string" && d.id && Array.isArray(d.ingredienten); }).slice(0, 20);
    if (!dishesIn.length) { var noDishErr = new Error("Geen geldige gerechten om te herberekenen."); noDishErr.isBadRequest = true; return Promise.reject(noDishErr); }
    return generateWithBalansRetry(buildNevoRecalcPrompt(dishesIn), null, function (parsed) {
      var arr = Array.isArray(parsed) ? parsed : [];
      arr.forEach(function (d) { if (d && Array.isArray(d.ingredienten)) applyNevoToDish(d, d.ingredienten); });
      return arr;
    });
  }

  var badRequestErr = new Error("Ongeldig verzoek.");
  badRequestErr.isBadRequest = true;
  return Promise.reject(badRequestErr);
}

var GOAL_TARGETS = {
  "Onderhoud": { kh: 33, eiwit: 33, vet: 34 },
  "Vetverlies (spierbehoud)": { kh: 30, eiwit: 40, vet: 30 },
  "Cutting": { kh: 25, eiwit: 45, vet: 30 },
  "Spieropbouw (lean bulk)": { kh: 40, eiwit: 30, vet: 30 },
  "Atleet (prestatiegericht)": { kh: 45, eiwit: 25, vet: 30 }
};
// Plantaardig eten: realistische streefwaarden per doel (eiwit iets lager, koolhydraten iets hoger).
var DIET_GOAL_TARGETS = {
  "Vegetarisch": {
    "Onderhoud": { kh: 35, eiwit: 30, vet: 35 },
    "Vetverlies (spierbehoud)": { kh: 35, eiwit: 35, vet: 30 },
    "Cutting": { kh: 30, eiwit: 40, vet: 30 }
  },
  "Veganistisch": {
    "Onderhoud": { kh: 40, eiwit: 25, vet: 35 },
    "Vetverlies (spierbehoud)": { kh: 40, eiwit: 30, vet: 30 },
    "Cutting": { kh: 35, eiwit: 35, vet: 30 },
    "Spieropbouw (lean bulk)": { kh: 45, eiwit: 25, vet: 30 },
    "Atleet (prestatiegericht)": { kh: 50, eiwit: 22, vet: 28 }
  }
};
function goalTargetFor(goal, dietStyle) {
  var byDiet = DIET_GOAL_TARGETS[dietStyle];
  return (byDiet && byDiet[goal]) || GOAL_TARGETS[goal] || GOAL_TARGETS["Onderhoud"];
}
function dietTargetAdjusted(goal, dietStyle) {
  var byDiet = DIET_GOAL_TARGETS[dietStyle];
  return !!(byDiet && byDiet[goal]);
}
function computeBalanceServer(khPct, eiwitPct, vetPct, goal, dietStyle) {
  var t = goalTargetFor(goal, dietStyle);
  var maxDev = Math.max(Math.abs(khPct - t.kh), Math.abs(eiwitPct - t.eiwit), Math.abs(vetPct - t.vet));
  return Math.max(0, Math.min(100, Math.round(100 - 3 * maxDev)));
}
function dishBalans(d, goal, dietStyle) {
  var kcal = Number(d && d.kcal) || 0;
  if (!kcal) return 0;
  var khPct = Math.round((Number(d.kh_g || 0) * 4 / kcal) * 100);
  var eiwitPct = Math.round((Number(d.eiwit_g || 0) * 4 / kcal) * 100);
  var vetPct = Math.round((Number(d.vet_g || 0) * 9 / kcal) * 100);
  return computeBalanceServer(khPct, eiwitPct, vetPct, goal, dietStyle);
}
function minBalans(parsed, goal, dietStyle) {
  var dishes = Array.isArray(parsed) ? parsed : [parsed];
  if (!dishes.length) return 0;
  return dishes.reduce(function (min, d) { return Math.min(min, dishBalans(d, goal, dietStyle)); }, 100);
}

var BALANS_MIN_THRESHOLD = 75;
var BALANS_MAX_ATTEMPTS = 3;

function callAnthropicOnce(prompt, model, maxTokens) {
  return fetch(ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: model || ANTHROPIC_MODEL,
      max_tokens: maxTokens || 64000,
      messages: [{ role: "user", content: prompt }]
    })
  }).then(function (apiRes) {
    if (!apiRes.ok) {
      return apiRes.text().then(function (t) {
        throw new Error("Anthropic API error " + apiRes.status + ": " + t.slice(0, 300));
      });
    }
    return apiRes.json();
  }).then(function (data) {
    recordCallUsage(model, data);   // de tokens zijn verbruikt, ook als het antwoord daarna onbruikbaar blijkt
    var textBlock = (data.content || []).filter(function (b) { return b.type === "text"; })[0];
    if (!textBlock) throw new Error("Geen tekst in antwoord van model");
    try {
      return extractJson(textBlock.text);
    } catch (parseErr) {
      if (data.stop_reason === "max_tokens") {
        throw new Error("Antwoord werd afgekapt (te lang voor de ingestelde limiet). Probeer minder gerechten tegelijk te genereren, of verhoog max_tokens in server.js.");
      }
      throw parseErr;
    }
  });
}

// Retries generation (up to BALANS_MAX_ATTEMPTS times total) until every dish's
// Balans-score reaches BALANS_MIN_THRESHOLD, keeping the best-scoring attempt
// seen so far. Only applies when a goal is known (dish-generating actions);
// prep/price requests have no macros to score and skip this entirely.
// "post" mag het antwoord aanpassen vóórdat het op de Balans-score wordt beoordeeld (bijv. de NEVO-herberekening
// van de macro's): zo wordt er geretryd op de echte, uitgerekende macro's in plaats van de AI-schatting.
function generateWithBalansRetry(prompt, goal, post, dietStyle) {
  prompt = adaptPromptToDiet(prompt, dietStyle);
  if (!goal && !DIET_FORBIDDEN_TEXT[dietStyle]) return callAnthropicOnce(prompt).then(function (parsed) { return post ? post(parsed) : parsed; });

  var bestParsed = null;
  var bestScore = -Infinity;
  var attempt = 0;
  var currentPrompt = prompt;

  function tryOnce() {
    attempt++;
    return callAnthropicOnce(currentPrompt).then(function (parsed) {
      if (post) parsed = post(parsed);
      var violations = dietViolationCount(parsed, dietStyle);
      // Overtreding van de voedingsstijl weegt zwaarder dan elke balans-score.
      var score = (goal ? minBalans(parsed, goal, dietStyle) : 100) - violations * 1000;
      if (score > bestScore) { bestScore = score; bestParsed = parsed; }
      if ((violations === 0 && (!goal || score >= BALANS_MIN_THRESHOLD)) || attempt >= BALANS_MAX_ATTEMPTS) {
        return finalizeDiet(bestParsed, dietStyle);
      }
      if (violations) {
        var found = [];
        (Array.isArray(parsed) ? parsed : [parsed]).forEach(function (d) { dishDietViolations(d, dietStyle).forEach(function (h) { if (found.indexOf(h) === -1) found.push(h); }); });
        currentPrompt = prompt + "\nLET OP: een vorige poging bevatte ingrediënten die niet " + dietStyle.toLowerCase() + " zijn (" +
          found.slice(0, 8).join(", ") + "). Dat is niet toegestaan; maak alle gerechten volledig " + dietStyle.toLowerCase() + ".";
      }
      return tryOnce();
    });
  }

  return tryOnce();
}
// Blijft er na alle pogingen toch iets niet-passends over, dan laten we die gerechten weg (als er iets overblijft).
function finalizeDiet(parsed, dietStyle) {
  if (!DIET_FORBIDDEN_TEXT[dietStyle] || !Array.isArray(parsed)) return parsed;
  var ok = parsed.filter(function (d) { return !dishDietViolations(d, dietStyle).length; });
  if (ok.length && ok.length < parsed.length) console.warn("Voedingsstijl " + dietStyle + ": " + (parsed.length - ok.length) + " gerecht(en) weggelaten na herhaalde overtreding.");
  return ok.length ? ok : parsed;
}

function logEvent(type, action, ok, status, extra) {
  logRequest(Object.assign({ ts: new Date().toISOString(), type: type, action: action, ok: ok, status: status }, extra || {}));
}

function handleGenerate(req, res) {
  var ip = clientIp(req);
  var startTime = Date.now();
  var uidForLog = null;
  function log(action, ok, status, error, meter) {
    logRequest(Object.assign({ ts: new Date().toISOString(), type: "generate", action: action, durationMs: Date.now() - startTime, ok: ok, status: status, error: error || undefined, ip: ip, uid: uidForLog || undefined }, meter ? meterFields(meter.usage, meter.dishes) : {}));
  }
  if (!checkIpRateLimit(ip)) {
    log("onbekend", false, 429, "Rate limit (IP)");
    return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken vanaf dit adres. Probeer later opnieuw." });
  }

  getSettings().then(function (settings) {
    var mods = effectiveModules(settings);
    if (!mods.generate) {
      log("onbekend", false, 503, "Module uitgeschakeld: generate");
      sendJSON(res, 503, moduleOffBody("generate", settings));
      return undefined;
    }
    return resolveUser(req).then(function (user) {
      if (!user) {
        log("onbekend", false, 401, "Niet ingelogd");
        sendUnauthorized(res);
        return null;
      }
      uidForLog = user.uid;
      if (!ANTHROPIC_API_KEY) {
        log("onbekend", false, 500, "ANTHROPIC_API_KEY niet ingesteld");
        sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ANTHROPIC_API_KEY ingesteld." });
        return null;
      }
      return getUsageToday();
    }).then(function (usedToday) {
      if (usedToday === null) return; // already answered with 401
      if (usedToday + runningJobCount() >= liveLimits.dailyGenerateCap) {
        log("onbekend", false, 429, "Dagelijkse limiet bereikt");
        return sendJSON(res, 429, { code: "rate_limited", message: "De dagelijkse limiet voor het genereren van gerechten is bereikt. Probeer het morgen opnieuw." });
      }

      readBody(req).then(function (body) {
        var action = (body && body.action) || "onbekend";
        if (action === "price" && !mods.prices) {
          log(action, false, 503, "Module uitgeschakeld: prices");
          return sendJSON(res, 503, moduleOffBody("prices", settings));
        }
        return (action === "price" ? getUserPlan(uidForLog, settings) : Promise.resolve(null)).then(function (plan) {
          if (action === "price" && planBlocksModule(settings, "prices", plan)) {
            log(action, false, 503, "Kostenschatting is alleen voor Plus");
            return sendJSON(res, 503, moduleOffBody("prices", settings));
          }

          var isAsync = !!(body && body.async === true);
        return (DISH_ACTIONS[action] ? quotaState(uidForLog) : Promise.resolve(null)).then(function (q) {
          if (quotaBlocked(q, isAsync ? runningJobCount(uidForLog) : 0)) {
            log(action, false, 429, "Maandlimiet nieuwe gerechten bereikt (" + q.used + "/" + q.cap + ")");
            return sendJSON(res, 429, quotaBody(q));
          }
          if (isAsync) return startGenerateJob({ uid: uidForLog, body: body, action: action, host: req.headers.host, log: log, res: res });
          var usage = newUsage();
          return usageCtx.run(usage, function () { return runGenerateAction(body); }).then(function (parsed) {
            var dishes = dishesInResult(action, parsed);
            incrementUsageToday();
            return recordAccounting(uidForLog, action, usage, dishes, true).then(function () {   // eerst vastleggen, dan antwoorden: een direct volgend verzoek ziet dan de juiste stand
              log(action, true, 200, undefined, { usage: usage, dishes: dishes });
              sendJSON(res, 200, { result: parsed });
            });
          }).catch(function (err) {
            var status = err && err.isBadRequest ? 400 : 502;
            var code = err && err.isBadRequest ? "bad_request" : "error";
            var message = err && err.isBadRequest ? (err.message || "Ongeldig verzoek.") : "Genereren mislukt: " + err.message;
            return recordAccounting(uidForLog, action, usage, 0, false).then(function () {
              log(action, false, status, err.message, { usage: usage, dishes: 0 });
              sendJSON(res, status, { code: code, message: message });
            });
          });
        });
        });
      }).catch(function () {
        log("onbekend", false, 400, "Ongeldige aanvraag");
        sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
      });
    });
  }).catch(function (err) {
    log("onbekend", false, 502, "Opslag niet bereikbaar: " + (err && err.message ? err.message : "onbekende fout"));
    sendJSON(res, 502, { code: "error", message: "Opslag niet bereikbaar: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function handleAuthRegister(req, res) {
  var ip = clientIp(req);
  readBody(req).then(function (body) {
    var email = normalizeEmail(body && body.email);
    var password = (body && body.password) || "";
    if (!email || email.indexOf("@") === -1) {
      return sendJSON(res, 400, { code: "bad_request", message: "Vul een geldig e-mailadres in." });
    }
    if (password.length < 8) {
      return sendJSON(res, 400, { code: "bad_request", message: "Wachtwoord moet minstens 8 tekens zijn." });
    }
    return dbGetDoc("auth/users/" + email).then(function (existing) {
      if (existing.exists) {
        logEvent("auth", "register", false, 409, { error: "Bestaat al", email: email, ip: ip });
        return sendJSON(res, 409, { code: "conflict", message: "Er bestaat al een account met dit e-mailadres." });
      }
      var uid = "u_" + crypto.randomBytes(12).toString("hex");
      var record = makePasswordRecord(password);
      var now = new Date().toISOString();
      return dbSetDoc("auth/users/" + email, { uid: uid, salt: record.salt, hash: record.hash, createdAt: now, createdBy: "self", lastLoginAt: now, loginCount: 1 }).then(function () {
        logEvent("auth", "register", true, 200, { email: email, uid: uid, ip: ip });
        sendJSON(res, 200, { token: issueUserSession(uid, email), uid: uid });
      });
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Registreren mislukt: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

// ---------- Een anoniem profiel omzetten naar een account (met behoud van gegevens) ----------
// Een anoniem profiel is alleen te bewijzen met zijn ID (de header X-Anon-Id). Wie dat ID kent, mag de gegevens
// dus meenemen naar een nieuw account. De gegevens worden VERHUISD naar het nieuwe account-ID (nooit delen we
// een ID: account-ID's mogen nooit als anoniem ID werken), en daarna van het anonieme ID gewist.
// Volgorde: eerst kopiëren, dan het account aanmaken, dan opruimen. Gaat er iets mis vóór het account bestaat,
// dan draaien we de kopieën terug; daarna is opnieuw proberen met dezelfde gegevens veilig (herstelbaar).
var upgradeLocks = new Set();
var upgradeAllowed = makeHourlyLimiter(30);
var anonStatusAllowed = makeHourlyLimiter(120);
var UPGRADE_SUBPATHS = ["prefs", "dishes", "plannedWeeks"];

function anonIdOf(req) {
  var anon = String(req.headers["x-anon-id"] || "");
  return ANON_ID_PATTERN.test(anon) ? anon : null;
}
function countDishes(v) {
  var n = 0;
  if (v && typeof v === "object") Object.keys(v).forEach(function (k) { n += Array.isArray(v[k]) ? v[k].length : 0; });
  return n;
}
function countWeeks(v) { return v && Array.isArray(v.list) ? v.list.length : (Array.isArray(v) ? v.length : 0); }

// Wat er onder een anoniem ID staat (zonder iets te wijzigen).
function readAnonData(anon) {
  return Promise.all(UPGRADE_SUBPATHS.map(function (s) { return dbGetDoc("data/users/" + anon + "/" + s); }).concat([
    dbGetDoc("data/users/" + anon + "/meta"), dbGetDoc("adminMeta/" + anon), dbGetDoc("listsIndex/" + anon), dbGetDoc("push/" + anon), dbGetDoc("quota/" + anon)
  ])).then(function (r) {
    var tokens = r[5].exists && r[5].value && Array.isArray(r[5].value.tokens) ? r[5].value.tokens : [];
    return { prefs: r[0], dishes: r[1], plannedWeeks: r[2], meta: r[3], adminMeta: r[4], tokens: tokens, push: r[6], quota: r[7] };
  });
}
function anonSummary(d) {
  return { prefs: d.prefs.exists, dishes: countDishes(d.dishes.value), plannedWeeks: countWeeks(d.plannedWeeks.value), lists: d.tokens.length };
}

// Kopieert alles naar het nieuwe ID. Schrijft nooit iets wat aan de bron ontbreekt, en verandert de bron niet.
function copyAnonData(anon, uid, d, email, resume) {
  var writes = [];
  UPGRADE_SUBPATHS.forEach(function (s) { if (d[s].exists) writes.push(dbSetDoc("data/users/" + uid + "/" + s, d[s].value)); });
  if (d.adminMeta.exists) writes.push(dbSetDoc("adminMeta/" + uid, d.adminMeta.value));
  if (d.push && d.push.exists) writes.push(dbSetDoc("push/" + uid, d.push.value));
  if (d.quota && d.quota.exists) writes.push(dbSetDoc("quota/" + uid, d.quota.value));
  var m = d.meta.exists && d.meta.value ? d.meta.value : {};
  // Bij een herhaalde aanvraag (bron al opgeruimd) laten we het bestaande "laatst gezien" met rust.
  if (d.meta.exists || !resume) writes.push(dbSetDoc("data/users/" + uid + "/meta", { lastIp: m.lastIp || null, lastSeenAt: m.lastSeenAt || new Date().toISOString(), email: email }));
  // Lijsten: alleen wat écht van dit anonieme ID is; de eigenaar wordt het nieuwe ID.
  var listWork = Promise.all(d.tokens.map(function (t) {
    return dbGetDoc("lists/" + t).then(function (r) {
      if (!r.exists || !r.value || r.value.ownerUid !== anon) return null;
      return dbSetDoc("lists/" + t, Object.assign({}, r.value, { ownerUid: uid })).then(function () { return t; });
    });
  })).then(function (moved) {
    var tokens = moved.filter(Boolean);
    return dbGetDoc("listsIndex/" + uid).then(function (ex) {
      var have = ex.exists && ex.value && Array.isArray(ex.value.tokens) ? ex.value.tokens : [];
      tokens.forEach(function (t) { if (have.indexOf(t) === -1) have.push(t); });
      return tokens.length || ex.exists ? dbSetDoc("listsIndex/" + uid, { tokens: have }) : null;
    }).then(function () { return tokens; });
  });
  return Promise.all(writes).then(function () { return listWork; });
}
function removeCopies(uid, tokens, anon) {
  var paths = UPGRADE_SUBPATHS.map(function (s) { return "data/users/" + uid + "/" + s; }).concat(["data/users/" + uid + "/meta", "adminMeta/" + uid, "listsIndex/" + uid, "push/" + uid, "quota/" + uid]);
  return Promise.all(paths.map(dbDeleteDoc).concat((tokens || []).map(function (t) {
    return dbGetDoc("lists/" + t).then(function (r) { return r.exists && r.value ? dbSetDoc("lists/" + t, Object.assign({}, r.value, { ownerUid: anon })) : null; });
  }))).catch(function () {});
}
function cleanupAnon(anon) {
  var paths = UPGRADE_SUBPATHS.map(function (s) { return "data/users/" + anon + "/" + s; }).concat(["data/users/" + anon + "/meta", "adminMeta/" + anon, "listsIndex/" + anon, "push/" + anon, "quota/" + anon]);
  return Promise.all(paths.map(dbDeleteDoc)).then(function () {
    return updateBlocked(function (b) { delete b.uids[anon]; delete b.invalidBefore[anon]; });
  }).then(function () { invalidateSummaries(); });
}

function handleAnonStatus(req, res) {
  if (!anonStatusAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." });
  var anon = anonIdOf(req);
  if (!anon) return sendJSON(res, 200, { hasData: false });
  return Promise.all([getBlocked(), readAnonData(anon)]).then(function (r) {
    if (r[0].uids[anon]) return sendJSON(res, 200, { hasData: false });
    var s = anonSummary(r[1]);
    sendJSON(res, 200, { hasData: s.prefs || s.dishes > 0 || s.plannedWeeks > 0 || s.lists > 0, prefs: s.prefs, dishes: s.dishes, plannedWeeks: s.plannedWeeks, lists: s.lists });
  }).catch(function () { sendJSON(res, 500, { code: "error", message: "Opslag niet bereikbaar." }); });
}

function handleAuthUpgrade(req, res) {
  var ip = clientIp(req);
  if (!upgradeAllowed(ip)) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel pogingen. Probeer het later opnieuw." });
  var anon = anonIdOf(req);
  if (!anon) return sendJSON(res, 400, { code: "bad_request", message: "Er is geen anoniem profiel om om te zetten." });
  return readBody(req).then(function (body) {
    var email = normalizeEmail(body && body.email);
    var password = (body && typeof body.password === "string") ? body.password : "";
    if (!EMAIL_RE.test(email) || email.length > 200) return sendJSON(res, 400, { code: "bad_request", message: "Vul een geldig e-mailadres in." });
    if (password.length < 8) return sendJSON(res, 400, { code: "bad_request", message: "Wachtwoord moet minstens 8 tekens zijn." });
    if (password.length > 200) return sendJSON(res, 400, { code: "bad_request", message: "Een wachtwoord mag hoogstens 200 tekens hebben." });
    var lockKeys = ["email:" + email, "anon:" + anon];
    if (lockKeys.some(function (k) { return upgradeLocks.has(k); })) return sendJSON(res, 409, { code: "busy", message: "Je aanvraag wordt al verwerkt. Even geduld." });
    lockKeys.forEach(function (k) { upgradeLocks.add(k); });
    var release = function () { lockKeys.forEach(function (k) { upgradeLocks.delete(k); }); };
    var fail = function (status, code, message, why) {
      logEvent("auth", "upgrade", false, status, { error: why || message, email: email, fromUid: anon, ip: ip });
      sendJSON(res, status, { code: code, message: message });
    };
    return getBlocked().then(function (b) {
      if (b.uids[anon]) return fail(403, "blocked", "Dit profiel is geblokkeerd. Neem contact op met de beheerder.", "Anoniem profiel geblokkeerd");
      return Promise.all([dbGetDoc("auth/users/" + email), readAnonData(anon)]).then(function (r) {
        var existing = r[0], data = r[1], resumeUid = null;
        if (existing.exists) {
          // Een eerdere poging met dit profiel kan halverwege zijn gestopt (of het antwoord kwam niet aan): dan gaan we verder.
          if (existing.value && existing.value.upgradedFrom === anon && verifyPassword(password, existing.value)) resumeUid = existing.value.uid;
          else return fail(409, "conflict", "Er bestaat al een account met dit e-mailadres.", "Bestaat al");
        }
        var uid = resumeUid || "u_" + crypto.randomBytes(12).toString("hex");
        var now = new Date().toISOString();
        return copyAnonData(anon, uid, data, email, !!resumeUid).then(function (movedTokens) {
          var made = resumeUid ? Promise.resolve() : (function () {
            var record = makePasswordRecord(password);
            return dbSetDoc("auth/users/" + email, { uid: uid, salt: record.salt, hash: record.hash, createdAt: now, createdBy: "self", upgradedFrom: anon, lastLoginAt: now, loginCount: 1 });
          })();
          return made.catch(function (e) { return removeCopies(uid, movedTokens, anon).then(function () { throw e; }); }).then(function () {
            return reassignJobs(anon, uid);
          }).then(function () {
            return cleanupAnon(anon);
          }).then(function () {
            var s = anonSummary(data); s.lists = movedTokens.length;
            logEvent("auth", "upgrade", true, 200, { email: email, uid: uid, fromUid: anon, ip: ip });
            sendJSON(res, 200, { token: issueUserSession(uid, email), uid: uid, migrated: s });
          });
        });
      });
    }).then(release, function (e) { release(); throw e; });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Omzetten mislukt: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

// ---------- Inloggen met Apple of Google (OpenID Connect, zonder externe bibliotheek) ----------
// Beide knoppen verschijnen pas als de bijbehorende omgevingsvariabelen gezet zijn:
//   Apple:  APPLE_CLIENT_ID (de Services ID uit het Apple Developer-portaal)
//   Google: GOOGLE_CLIENT_ID en GOOGLE_CLIENT_SECRET
//   Optioneel: PUBLIC_BASE_URL (bijv. https://balanza.nl), anders afgeleid uit het verzoek.
// Terugkeer-URL's om bij Apple/Google op te geven: <basis>/api/auth/oauth/apple/callback en <basis>/api/auth/oauth/google/callback.
// Koppeling: auth/oauth/<provider>_<sub> = { uid, email }. Een bestaand account met hetzelfde (geverifieerde) e-mailadres
// wordt gekoppeld; anders komt er een nieuw account, desgewenst met de gegevens van het anonieme profiel.
const APPLE_CLIENT_ID = String(process.env.APPLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
var OAUTH_PROVIDERS = {
  apple: {
    label: "Apple",
    enabled: function () { return !!APPLE_CLIENT_ID; },
    clientId: function () { return APPLE_CLIENT_ID; },
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"]
  },
  google: {
    label: "Google",
    enabled: function () { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); },
    clientId: function () { return GOOGLE_CLIENT_ID; },
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"]
  }
};
var OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
var OAUTH_COOKIE = "bz_oauth";
var oauthStartAllowed = makeHourlyLimiter(60);
var oauthCallbackAllowed = makeHourlyLimiter(60);
var oauthLocks = new Set();

function oauthConfig() {
  return { apple: OAUTH_PROVIDERS.apple.enabled(), google: OAUTH_PROVIDERS.google.enabled() };
}
function publicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  var proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket && req.socket.encrypted ? "https" : "http");
  var host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return proto + "://" + host;
}
function oauthRedirectUri(req, provider) { return publicBaseUrl(req) + "/api/auth/oauth/" + provider + "/callback"; }
function parseCookies(req) {
  var out = {};
  String(req.headers.cookie || "").split(";").forEach(function (part) {
    var i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function oauthCookieHeader(value, maxAgeSec, secure) {
  // SameSite=None: Apple stuurt het antwoord terug als een POST vanaf zijn eigen domein.
  return OAUTH_COOKIE + "=" + encodeURIComponent(value) + "; Path=/api/auth/oauth; HttpOnly; Max-Age=" + maxAgeSec +
    (secure ? "; Secure; SameSite=None" : "; SameSite=Lax");
}
function sha256b64(s) { return base64url(crypto.createHash("sha256").update(s).digest()); }
function readFormBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], total = 0;
    req.on("data", function (c) { total += c.length; if (total > 64 * 1024) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", function () {
      var out = {};
      new URLSearchParams(Buffer.concat(chunks).toString("utf8")).forEach(function (v, k) { out[k] = v; });
      resolve(out);
    });
    req.on("error", reject);
  });
}
// Terug naar de app; het resultaat staat in het #-deel van de URL (dat gaat nooit naar de server).
function oauthFinish(res, params) {
  var hash = Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null; })
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])); }).join("&");
  res.writeHead(303, { "Location": "/#" + hash, "Cache-Control": "no-store", "Set-Cookie": oauthCookieHeader("", 0, true) });
  res.end();
}
function oauthFail(res, message) { return oauthFinish(res, { auth_error: message }); }

// --- JWT (id_token) controleren met de openbare sleutels van Apple/Google ---
var jwksCache = {};
function fetchJwks(url, force) {
  var c = jwksCache[url];
  if (c && !force && Date.now() - c.at < 60 * 60 * 1000) return Promise.resolve(c.keys);
  if (c && force && Date.now() - c.at < 60 * 1000) return Promise.resolve(c.keys);   // niet vaker dan eens per minuut opnieuw
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error("Sleutels niet op te halen (" + r.status + ")");
    return r.json();
  }).then(function (j) {
    var keys = Array.isArray(j && j.keys) ? j.keys : [];
    jwksCache[url] = { at: Date.now(), keys: keys };
    return keys;
  });
}
function b64urlToBuf(s) { return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64"); }
function verifyIdToken(token, provider, nonce) {
  var p = OAUTH_PROVIDERS[provider];
  var parts = String(token || "").split(".");
  if (parts.length !== 3) return Promise.reject(new Error("Ongeldig id_token"));
  var header, payload;
  try { header = JSON.parse(b64urlToBuf(parts[0]).toString()); payload = JSON.parse(b64urlToBuf(parts[1]).toString()); }
  catch (e) { return Promise.reject(new Error("Ongeldig id_token")); }
  if (header.alg !== "RS256") return Promise.reject(new Error("Onverwacht algoritme"));
  function findKey(force) {
    return fetchJwks(p.jwksUrl, force).then(function (keys) { return keys.filter(function (k) { return k.kid === header.kid; })[0] || null; });
  }
  return findKey(false).then(function (jwk) { return jwk || findKey(true); }).then(function (jwk) {
    if (!jwk) throw new Error("Onbekende sleutel");
    var key = crypto.createPublicKey({ key: jwk, format: "jwk" });
    var ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, b64urlToBuf(parts[2]));
    if (!ok) throw new Error("Handtekening klopt niet");
    var now = Math.floor(Date.now() / 1000);
    if (p.issuers.indexOf(payload.iss) === -1) throw new Error("Onverwachte uitgever");
    var aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (aud.indexOf(p.clientId()) === -1) throw new Error("Bestemd voor een andere app");
    if (!payload.exp || payload.exp + 60 < now) throw new Error("Verlopen");
    if (payload.iat && payload.iat - 300 > now) throw new Error("Tijd klopt niet");
    if (!payload.sub) throw new Error("Geen gebruikers-ID");
    if (payload.nonce !== nonce) throw new Error("Controlecode klopt niet");
    return payload;
  });
}

// --- Stap 1: naar Apple/Google ---
function handleOAuthStart(req, res, provider, url) {
  var p = OAUTH_PROVIDERS[provider];
  if (!p || !p.enabled()) return oauthFail(res, "Inloggen met " + (p ? p.label : "deze dienst") + " is nog niet ingesteld.");
  if (!oauthStartAllowed(clientIp(req))) return oauthFail(res, "Te veel pogingen. Probeer het later opnieuw.");
  // De terugkeer gaat altijd naar het hoofdadres; daar moet ook het controle-cookie staan.
  var canonStart = canonicalOrigin();
  var reqHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  if (canonStart && reqHost && reqHost !== new URL(canonStart).host.toLowerCase()) {
    res.writeHead(302, { "Location": canonStart + url.pathname + url.search, "Cache-Control": "no-store" });
    return res.end();
  }
  var anon = String(url.searchParams.get("anon") || "");
  var nonce = base64url(crypto.randomBytes(18));
  var state = signSessionToken({
    p: provider, n: nonce, exp: Date.now() + OAUTH_STATE_TTL_MS,
    anon: ANON_ID_PATTERN.test(anon) ? anon : null, take: url.searchParams.get("take") === "1"
  });
  var q = new URLSearchParams({ client_id: p.clientId(), redirect_uri: oauthRedirectUri(req, provider), state: state, nonce: nonce });
  if (provider === "apple") { q.set("response_type", "code id_token"); q.set("response_mode", "form_post"); q.set("scope", "name email"); }
  else { q.set("response_type", "code"); q.set("scope", "openid email profile"); q.set("prompt", "select_account"); }
  var secure = publicBaseUrl(req).indexOf("https://") === 0;
  res.writeHead(302, { "Location": p.authorizeUrl + "?" + q.toString(), "Cache-Control": "no-store", "Set-Cookie": oauthCookieHeader(sha256b64(nonce), OAUTH_STATE_TTL_MS / 1000, secure) });
  res.end();
}

// --- Stap 2: terug van Apple/Google ---
function handleOAuthCallback(req, res, provider, url) {
  var p = OAUTH_PROVIDERS[provider];
  var ip = clientIp(req);
  if (!p || !p.enabled()) return oauthFail(res, "Inloggen met deze dienst is niet ingesteld.");
  if (!oauthCallbackAllowed(ip)) return oauthFail(res, "Te veel pogingen. Probeer het later opnieuw.");
  var getParams = req.method === "POST" ? readFormBody(req) : Promise.resolve(Object.fromEntries(url.searchParams.entries()));
  return getParams.then(function (params) {
    if (params.error) {
      var cancelled = /cancel|access_denied/i.test(params.error);
      return oauthFail(res, cancelled ? "Inloggen met " + p.label + " is geannuleerd." : "Inloggen met " + p.label + " is niet gelukt.");
    }
    var st = verifySessionToken(params.state || "");
    if (!st || st.p !== provider || !st.n) return oauthFail(res, "Deze inlogpoging is verlopen. Probeer het opnieuw.");
    if (parseCookies(req)[OAUTH_COOKIE] !== sha256b64(st.n)) return oauthFail(res, "Deze inlogpoging hoort niet bij deze browser. Probeer het opnieuw.");
    var getIdToken;
    if (provider === "apple") getIdToken = Promise.resolve(params.id_token);
    else {
      getIdToken = fetch(p.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: params.code || "", client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: oauthRedirectUri(req, provider), grant_type: "authorization_code" }).toString()
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.id_token) throw new Error("Code inwisselen mislukt"); return j.id_token; }); });
    }
    return getIdToken.then(function (idToken) { return verifyIdToken(idToken, provider, st.n); }).then(function (claims) {
      var verified = claims.email_verified === true || claims.email_verified === "true";
      var email = verified ? normalizeEmail(claims.email) : "";
      return completeOAuthLogin(req, res, provider, claims.sub, email, st);
    }, function (err) {
      logEvent("auth", "oauth-" + provider, false, 401, { error: err && err.message ? err.message : "onbekend", ip: ip });
      return oauthFail(res, "Inloggen met " + p.label + " kon niet worden bevestigd. Probeer het opnieuw.");
    });
  }).catch(function (err) {
    try { oauthFail(res, "Inloggen mislukt: " + (err && err.message ? err.message : "onbekende fout")); } catch (e) {}
  });
}

// Zoekt het account bij een gekoppelde identiteit; geeft null als de koppeling niet (meer) klopt.
function accountForIdentity(link) {
  if (!link || !link.uid) return Promise.resolve(null);
  function check(email) {
    if (!email) return Promise.resolve(null);
    return dbGetDoc("auth/users/" + email).then(function (r) { return r.exists && r.value && r.value.uid === link.uid ? { email: email, acc: r.value } : null; });
  }
  return check(link.email).then(function (hit) {
    if (hit) return hit;
    return dbGetDoc("data/users/" + link.uid + "/meta").then(function (m) { return check(m.exists && m.value ? normalizeEmail(m.value.email) : ""); });
  });
}

function completeOAuthLogin(req, res, provider, sub, email, st) {
  var ip = clientIp(req), p = OAUTH_PROVIDERS[provider];
  var idPath = "auth/oauth/" + provider + "_" + String(sub).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  var lockKeys = ["oauth:" + idPath].concat(email ? ["email:" + email] : []).concat(st.anon ? ["anon:" + st.anon] : []);
  if (lockKeys.some(function (k) { return upgradeLocks.has(k) || oauthLocks.has(k); })) return oauthFail(res, "Je aanvraag wordt al verwerkt. Even geduld en probeer het opnieuw.");
  lockKeys.forEach(function (k) { oauthLocks.add(k); });
  var release = function () { lockKeys.forEach(function (k) { oauthLocks.delete(k); }); };
  var now = new Date().toISOString();

  function signIn(found, extra) {
    return getBlocked().then(function (b) {
      if (b.uids[found.acc.uid]) {
        logEvent("auth", "oauth-" + provider, false, 403, { error: "Account geblokkeerd", email: found.email, uid: found.acc.uid, ip: ip });
        return oauthFail(res, "Dit account is geblokkeerd. Neem contact op met de beheerder.");
      }
      var providers = Object.assign({}, found.acc.providers || {});
      providers[provider] = sub;
      var updated = Object.assign({}, found.acc, { providers: providers, lastLoginAt: now, loginCount: (found.acc.loginCount || 0) + 1 });
      return Promise.all([
        dbSetDoc("auth/users/" + found.email, updated),
        dbSetDoc(idPath, { uid: found.acc.uid, email: found.email, linkedAt: (extra && extra.linkedAt) || now })
      ]).then(function () {
        logEvent("auth", "oauth-" + provider, true, 200, { email: found.email, uid: found.acc.uid, ip: ip, linked: extra && extra.linked ? true : undefined });
        oauthFinish(res, { auth: issueUserSession(found.acc.uid, found.email), uid: found.acc.uid, via: provider, linked: extra && extra.linked ? 1 : undefined });
      });
    });
  }

  return dbGetDoc(idPath).then(function (link) {
    return accountForIdentity(link.exists ? link.value : null).then(function (found) {
      if (found) return signIn(found, { linkedAt: link.value.linkedAt });
      if (!email) return oauthFail(res, p.label + " gaf geen bevestigd e-mailadres door. Log in met e-mail en wachtwoord.");
      return dbGetDoc("auth/users/" + email).then(function (existing) {
        if (existing.exists && existing.value && existing.value.uid) return signIn({ email: email, acc: existing.value }, { linked: true });
        // Nieuw account: alleen als registreren aan staat.
        return getSettings().then(function (s) {
          if (!effectiveModules(s).registration) return oauthFail(res, "Nieuwe accounts kunnen op dit moment niet worden aangemaakt.");
          var uid = "u_" + crypto.randomBytes(12).toString("hex");
          var providers = {}; providers[provider] = sub;
          var accDoc = { uid: uid, createdAt: now, createdBy: "self", via: provider, providers: providers, lastLoginAt: now, loginCount: 1 };
          var anon = st.take ? st.anon : null;
          var migrate = anon ? getBlocked().then(function (b) {
            if (b.uids[anon]) return null;
            return readAnonData(anon).then(function (data) {
              var sum = anonSummary(data);
              if (!(sum.prefs || sum.dishes || sum.plannedWeeks || sum.lists)) return null;
              return copyAnonData(anon, uid, data, email, false).then(function (moved) { sum.lists = moved.length; return { data: data, moved: moved, sum: sum }; });
            });
          }) : Promise.resolve(null);
          return migrate.then(function (mig) {
            if (mig) accDoc.upgradedFrom = anon;
            var made = dbSetDoc("auth/users/" + email, accDoc).then(function () { return dbSetDoc(idPath, { uid: uid, email: email, linkedAt: now }); });
            if (!mig) made = made.then(function () { return dbSetDoc("data/users/" + uid + "/meta", { lastIp: ip, lastSeenAt: now, email: email }); });
            return made.catch(function (e) { return (mig ? removeCopies(uid, mig.moved, anon) : Promise.resolve()).then(function () { throw e; }); }).then(function () {
              return mig ? reassignJobs(anon, uid).then(function () { return cleanupAnon(anon); }) : null;
            }).then(function () {
              invalidateSummaries();
              logEvent("auth", "oauth-" + provider, true, 200, { email: email, uid: uid, ip: ip, created: true, fromUid: mig ? anon : undefined });
              oauthFinish(res, { auth: issueUserSession(uid, email), uid: uid, via: provider, created: 1,
                m: mig ? [mig.sum.dishes, mig.sum.plannedWeeks, mig.sum.lists, mig.sum.prefs ? 1 : 0].join(".") : undefined });
            });
          });
        });
      });
    });
  }).then(release, function (e) { release(); throw e; });
}

// ---------- Het eigen account beheren (voor de ingelogde gebruiker zelf) ----------
// Profielgegevens, gegevens downloaden, wachtwoord en e-mailadres wijzigen, op andere apparaten uitloggen en het
// account verwijderen. Alles wat een wachtwoord controleert heeft een strenge grens per IP-adres (tegen raden).
var accountSensitiveAllowed = makeHourlyLimiter(20);
var accountLightAllowed = makeHourlyLimiter(120);

function withAccountUser(req, res, opts, fn) {
  var limiter = opts.sensitive ? accountSensitiveAllowed : accountLightAllowed;
  if (!limiter(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel pogingen. Probeer het over een uur opnieuw." });
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (opts.needAccount && !user.email) return sendJSON(res, 403, { code: "forbidden", message: "Dit kan alleen met een account. Maak eerst een account aan." });
    return fn(user);
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Er ging iets mis: " + (err && err.message ? err.message : "onbekende fout") });
  });
}
function forbiddenPassword(res) { return sendJSON(res, 403, { code: "forbidden", message: "Je huidige wachtwoord klopt niet." }); }
// Het accountdocument van de ingelogde gebruiker, en alleen als het echt bij deze sessie hoort.
function loadOwnAccount(user) {
  return dbGetDoc("auth/users/" + user.email).then(function (r) {
    return r.exists && r.value && r.value.uid === user.uid ? r.value : null;
  });
}
function cleanBodyPassword(v) { return typeof v === "string" ? v : ""; }

function handleAccountInfo(req, res) {
  return withAccountUser(req, res, {}, function (user) {
    return Promise.all([readAnonData(user.uid), user.email ? loadOwnAccount(user) : Promise.resolve(null)]).then(function (r) {
      var s = anonSummary(r[0]), acc = r[1];
      sendJSON(res, 200, { type: user.email ? "account" : "anon", uid: user.uid, email: user.email || null,
        createdAt: acc ? acc.createdAt || null : null, lastLoginAt: acc ? acc.lastLoginAt || null : null, upgraded: !!(acc && acc.upgradedFrom),
        hasPassword: !!(acc && acc.hash), providers: acc && acc.providers ? Object.keys(acc.providers) : [],
        counts: { dishes: s.dishes, plannedWeeks: s.plannedWeeks, lists: s.lists } });
    });
  });
}

function handleAccountExport(req, res) {
  return withAccountUser(req, res, {}, function (user) {
    return Promise.all([readAnonData(user.uid), user.email ? loadOwnAccount(user) : Promise.resolve(null)]).then(function (r) {
      var d = r[0], acc = r[1];
      return Promise.all(d.tokens.map(function (t) {
        return dbGetDoc("lists/" + t).then(function (l) {
          if (!l.exists || !l.value || l.value.ownerUid !== user.uid) return null;
          return { link: "/l/" + t, title: l.value.title, items: l.value.items, state: l.value.state, createdAt: l.value.createdAt, expiresAt: l.value.expiresAt };
        });
      })).then(function (lists) {
        var data = JSON.stringify({
          exportedAt: new Date().toISOString(),
          account: { type: user.email ? "account" : "anon", email: user.email || null, createdAt: acc ? acc.createdAt || null : null },
          prefs: d.prefs.exists ? d.prefs.value : null, dishes: d.dishes.exists ? d.dishes.value : null, plannedWeeks: d.plannedWeeks.exists ? d.plannedWeeks.value : null,
          sharedLists: lists.filter(Boolean)
        }, null, 2);
        logEvent("auth", "export", true, 200, { uid: user.uid, email: user.email || undefined, ip: clientIp(req) });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": "attachment; filename=\"balanza-gegevens-" + new Date().toISOString().slice(0, 10) + ".json\"", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data) });
        res.end(data);
      });
    });
  });
}

function handleAccountChangePassword(req, res) {
  return withAccountUser(req, res, { sensitive: true, needAccount: true }, function (user) {
    return readBody(req).then(function (body) {
      var cur = cleanBodyPassword(body && body.currentPassword), nw = cleanBodyPassword(body && body.newPassword);
      if (nw.length < 8) return sendJSON(res, 400, { code: "bad_request", message: "Het nieuwe wachtwoord moet minstens 8 tekens zijn." });
      if (nw.length > 200) return sendJSON(res, 400, { code: "bad_request", message: "Een wachtwoord mag hoogstens 200 tekens hebben." });
      return loadOwnAccount(user).then(function (acc) {
        if (!acc) return sendUnauthorized(res);
        // Een account dat alleen via Apple/Google inlogt heeft nog geen wachtwoord: dan stel je er hier een in.
        if (acc.hash && !cur) return sendJSON(res, 400, { code: "bad_request", message: "Vul je huidige wachtwoord in." });
        if (acc.hash && !verifyPassword(cur, acc)) { logEvent("auth", "password-change", false, 403, { error: "Huidig wachtwoord onjuist", email: user.email, uid: user.uid, ip: clientIp(req) }); return forbiddenPassword(res); }
        if (nw === cur) return sendJSON(res, 400, { code: "bad_request", message: "Kies een ander wachtwoord dan je huidige." });
        var rec = makePasswordRecord(nw), stamp = Date.now();
        return dbSetDoc("auth/users/" + user.email, Object.assign({}, acc, { salt: rec.salt, hash: rec.hash })).then(function () {
          return updateBlocked(function (b) { b.invalidBefore[user.uid] = stamp; });
        }).then(function () {
          logEvent("auth", "password-change", true, 200, { email: user.email, uid: user.uid, ip: clientIp(req) });
          sendJSON(res, 200, { ok: true, token: issueUserSession(user.uid, user.email), uid: user.uid });   // alle andere sessies zijn nu ingetrokken; deze niet
        });
      });
    });
  });
}

function handleAccountChangeEmail(req, res) {
  return withAccountUser(req, res, { sensitive: true, needAccount: true }, function (user) {
    return readBody(req).then(function (body) {
      var password = cleanBodyPassword(body && body.password), next = normalizeEmail(body && body.newEmail);
      if (!EMAIL_RE.test(next) || next.length > 200) return sendJSON(res, 400, { code: "bad_request", message: "Vul een geldig e-mailadres in." });
      if (!password) return sendJSON(res, 400, { code: "bad_request", message: "Vul je wachtwoord in om je e-mailadres te wijzigen." });
      if (next === user.email) return sendJSON(res, 400, { code: "bad_request", message: "Dit is al je e-mailadres." });
      var lockKey = "email:" + next;
      if (upgradeLocks.has(lockKey)) return sendJSON(res, 409, { code: "busy", message: "Je aanvraag wordt al verwerkt. Even geduld." });
      upgradeLocks.add(lockKey);
      var release = function () { upgradeLocks.delete(lockKey); };
      return loadOwnAccount(user).then(function (acc) {
        if (!acc) return sendUnauthorized(res);
        if (!acc.hash) return sendJSON(res, 400, { code: "bad_request", message: "Stel eerst een wachtwoord in; daarna kun je je e-mailadres wijzigen." });
        if (!verifyPassword(password, acc)) { logEvent("auth", "email-change", false, 403, { error: "Wachtwoord onjuist", email: user.email, uid: user.uid, ip: clientIp(req) }); return forbiddenPassword(res); }
        return dbGetDoc("auth/users/" + next).then(function (taken) {
          if (taken.exists) { logEvent("auth", "email-change", false, 409, { error: "Bestaat al", email: user.email, uid: user.uid, ip: clientIp(req) }); return sendJSON(res, 409, { code: "conflict", message: "Er bestaat al een account met dit e-mailadres." }); }
          var stamp = Date.now();
          return dbSetDoc("auth/users/" + next, acc).then(function () {
            return dbDeleteDoc("auth/users/" + user.email).catch(function (e) { return dbDeleteDoc("auth/users/" + next).then(function () { throw e; }); });
          }).then(function () {
            return dbGetDoc("data/users/" + user.uid + "/meta").then(function (m) {
              return m.exists && m.value ? dbSetDoc("data/users/" + user.uid + "/meta", Object.assign({}, m.value, { email: next })) : null;
            });
          }).then(function () {
            return updateBlocked(function (b) { b.invalidBefore[user.uid] = stamp; });
          }).then(function () {
            invalidateSummaries();
            logEvent("auth", "email-change", true, 200, { email: next, fromEmail: user.email, uid: user.uid, ip: clientIp(req) });
            sendJSON(res, 200, { ok: true, token: issueUserSession(user.uid, next), uid: user.uid, email: next });
          });
        });
      }).then(release, function (e) { release(); throw e; });
    });
  });
}

function handleAccountLogoutOthers(req, res) {
  return withAccountUser(req, res, { needAccount: true }, function (user) {
    var stamp = Date.now();
    return updateBlocked(function (b) { b.invalidBefore[user.uid] = stamp; }).then(function () {
      logEvent("auth", "logout-others", true, 200, { email: user.email, uid: user.uid, ip: clientIp(req) });
      sendJSON(res, 200, { ok: true, token: issueUserSession(user.uid, user.email), uid: user.uid });
    });
  });
}

function handleAccountDelete(req, res) {
  return withAccountUser(req, res, { sensitive: true, needAccount: true }, function (user) {
    return readBody(req).then(function (body) {
      var password = cleanBodyPassword(body && body.password);
      if (!body || body.confirm !== "VERWIJDEREN") return sendJSON(res, 400, { code: "bad_request", message: "Typ VERWIJDEREN om te bevestigen." });
      return loadOwnAccount(user).then(function (acc) {
        if (!acc) return sendUnauthorized(res);
        if (acc.hash && !password) return sendJSON(res, 400, { code: "bad_request", message: "Vul je wachtwoord in om je account te verwijderen." });
        if (acc.hash && !verifyPassword(password, acc)) { logEvent("auth", "self-delete", false, 403, { error: "Wachtwoord onjuist", email: user.email, uid: user.uid, ip: clientIp(req) }); return forbiddenPassword(res); }
        return deleteUserEverywhere({ uid: user.uid, email: user.email }).then(function () {
          logEvent("auth", "self-delete", true, 200, { email: user.email, uid: user.uid, ip: clientIp(req) });
          sendJSON(res, 200, { ok: true });
        });
      });
    });
  });
}

// ---------- Verbruik: tokens, kosten en de maandlimiet ----------
// Elke AI-aanroep telt de tokens (en dus de kosten) op in een teller die bij het verzoek hoort. Zo tellen ook de
// herhaalpogingen mee (een gerecht dat de Balans-score mist wordt tot 3 keer gemaakt) en aanroepen die mislukten.
var usageCtx = new AsyncLocalStorage();
function newUsage() { return { calls: 0, inTok: 0, outTok: 0, costUsd: 0 }; }
function recordCallUsage(model, data) {
  var u = usageCtx.getStore();
  if (!u) return;
  var tin = data && data.usage && Number(data.usage.input_tokens) || 0, tout = data && data.usage && Number(data.usage.output_tokens) || 0;
  var tips = model && model === TIPS_MODEL && TIPS_MODEL !== ANTHROPIC_MODEL;
  u.calls++; u.inTok += tin; u.outTok += tout;
  u.costUsd += tin / 1e6 * (tips ? TIPS_PRICE_IN_PER_M : PRICE_IN_PER_M) + tout / 1e6 * (tips ? TIPS_PRICE_OUT_PER_M : PRICE_OUT_PER_M);
}
function round6(n) { return Math.round(n * 1e6) / 1e6; }
// Acties die nieuwe gerechten opleveren en dus van de maandlimiet afgaan.
var DISH_ACTIONS = { generate: true, background: true, variation: true };
function dishesInResult(action, parsed) {
  if (!DISH_ACTIONS[action]) return 0;
  if (action === "variation") return 1;
  var arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? Object.keys(parsed).map(function (k) { return parsed[k]; }).filter(Array.isArray)[0] : null);
  return arr ? arr.length : 0;
}
function meterFields(usage, dishes) {
  if (!usage) return {};
  var o = { tokensIn: usage.inTok, tokensOut: usage.outTok, aiCalls: usage.calls, costUsd: round6(usage.costUsd) };
  if (dishes) o.dishes = dishes;
  return o;
}
function monthKey() { return todayKey().slice(0, 7); }
function nextMonthStart() { var d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); }
function zeroQuota() { return { month: monthKey(), dishes: 0, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }; }
function getQuotaDoc(uid) {
  return dbGetDoc("quota/" + uid).then(function (r) {
    var v = r.exists && r.value && r.value.month === monthKey() ? r.value : null;
    return v ? Object.assign(zeroQuota(), v) : zeroQuota();
  });
}
var acctChain = Promise.resolve();   // schrijft één voor één, zodat gelijktijdige opdrachten elkaars teller niet overschrijven
// Legt het verbruik van één verzoek vast: per gebruiker (voor de maandlimiet) en per dag en actie (voor de beheerconsole).
function recordAccounting(uid, action, usage, dishes, ok) {
  if (!usage || !usage.calls) return Promise.resolve();
  acctChain = acctChain.then(function () {
    var day = "tokenUsage/" + todayKey();
    return Promise.all([uid ? getQuotaDoc(uid) : null, dbGetDoc(day)]).then(function (r) {
      var writes = [];
      if (uid) {
        var q = r[0];
        q.dishes += dishes || 0; q.calls += usage.calls; q.tokensIn += usage.inTok; q.tokensOut += usage.outTok; q.costUsd = round6(q.costUsd + usage.costUsd);
        writes.push(dbSetDoc("quota/" + uid, q));
      }
      var d = r[1].exists && r[1].value && r[1].value.byAction ? r[1].value : { byAction: {} };
      var a = d.byAction[action] = d.byAction[action] || { n: 0, fail: 0, dishes: 0, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
      a.n++; if (!ok) a.fail++; a.dishes += dishes || 0; a.calls += usage.calls; a.tokensIn += usage.inTok; a.tokensOut += usage.outTok; a.costUsd = round6(a.costUsd + usage.costUsd);
      writes.push(dbSetDoc(day, d));
      return Promise.all(writes);
    });
  }).catch(function () {});
  return acctChain;
}
// De eigen limiet van een gebruiker (beheer) gaat voor de algemene. Leeg = de algemene. 0 = onbeperkt.
// Volgorde: eigen limiet (beheer) > Plus (als abonnementen aan staan en het Plus is) > de algemene limiet.
// Het abonnement van een gebruiker, nu: "plus" of "free". Voor anonieme profielen (geen account) altijd "free",
// want Plus is alleen voor accounts. Wordt zowel voor de maandlimiet als voor het per-module vrijgeven gebruikt.
function getUserPlan(uid, settings) {
  if (!uid) return Promise.resolve("free");
  return dbGetDoc("billing/" + uid).then(function (r) {
    return billingLive(settings) && plusActiveDoc(r.exists ? r.value : null, Date.now()) ? "plus" : "free";
  }, function () { return "free"; });
}
function effectiveDishCap(uid) {
  return Promise.all([dbGetDoc("adminMeta/" + uid), getSettings()]).then(function (r) {
    var own = r[0].exists && r[0].value && typeof r[0].value.dishCap === "number" ? r[0].value.dishCap : null;
    var s = r[1];
    return getUserPlan(uid, s).then(function (plan) {
      return { cap: own !== null ? own : plan === "plus" ? s.billing.plusDishCap : s.limits.monthlyDishCap, own: own, plan: plan };
    });
  });
}
// Onderdelen die je (naast algeheel aan/uit) ook per abonnement kunt vrijgeven: "iedereen" of "alleen Plus".
var PLAN_GATEABLE_MODULES = ["prices", "bring", "sharing", "pdf", "images"];
// True als dit onderdeel voor deze gebruiker geblokkeerd is omdat het alleen voor Plus is vrijgegeven.
function planBlocksModule(s, key, plan) {
  return PLAN_GATEABLE_MODULES.indexOf(key) > -1 && !!(s.planOnly && s.planOnly[key]) && plan !== "plus";
}
function quotaState(uid) {
  return Promise.all([getQuotaDoc(uid), effectiveDishCap(uid)]).then(function (r) {
    return { used: r[0].dishes, cap: r[1].cap, own: r[1].own, plan: r[1].plan, doc: r[0] };
  }).catch(function () { return null; });   // opslag haperde: liever doorlaten dan iedereen blokkeren
}
function quotaBlocked(q, extraRunning) {
  return !!q && q.cap > 0 && q.used + (extraRunning || 0) >= q.cap;
}
function quotaBody(q) {
  return { code: "quota_exceeded", message: "Je hebt deze maand al " + q.used + " van je " + q.cap + " nieuwe gerechten gemaakt. Vanaf " + nextMonthStart().split("-").reverse().join("-") + " kun je weer nieuwe gerechten laten maken. Je opgeslagen gerechten, planning en boodschappenlijst blijven gewoon werken.", used: q.used, cap: q.cap, resetsOn: nextMonthStart() };
}
function handleUsageGet(req, res) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return quotaState(user.uid).then(function (q) {
      q = q || { used: 0, cap: 0 };
      sendJSON(res, 200, { plan: q.plan || "free", month: monthKey(), dishes: q.used, cap: q.cap, unlimited: !(q.cap > 0), remaining: q.cap > 0 ? Math.max(0, q.cap - q.used) : null, resetsOn: nextMonthStart() });
    });
  }).catch(function () { sendJSON(res, 500, { code: "error", message: "Verbruik ophalen mislukt." }); });
}

// ---------- Betalingen (Mollie): Balanza Plus ----------
// Voorbereid en standaard UIT. Alles werkt pas als (1) MOLLIE_API_KEY en PUBLIC_BASE_URL in de omgeving staan en (2) de
// beheerder abonnementen aanzet. Betalen gaat via een eerste betaling (iDEAL of kaart) die ook een machtiging voor de
// vervolgbetalingen aanmaakt; daarna maakt Mollie het abonnement aan. Een webhook van Mollie bevat alleen een betaal-id zonder
// handtekening: de enige juiste controle is de betaling zelf bij Mollie ophalen en alleen dát te geloven.
var MOLLIE_API_KEY = process.env.MOLLIE_API_KEY || "";
var MOLLIE_BASE_URL = String(process.env.MOLLIE_BASE_URL || "https://api.mollie.com").replace(/\/+$/, "");
var MOLLIE_BASE_OVERRIDDEN = !!process.env.MOLLIE_BASE_URL;   // alleen voor tests
var PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
var BILLING_GRACE_MS = 5 * 24 * 60 * 60 * 1000;   // een incasso kan een paar dagen duren; zo valt een betaalde klant er niet tussenuit
var UID_RE = /^u_[0-9a-f]{24}$/;
var billingLimiter = makeHourlyLimiter(60), webhookLimiter = makeHourlyLimiter(600);
var billingLocks = new Map();

function cleanTermsUrl(v) {
  var s = String(v == null ? "" : v).trim().slice(0, 300);
  if (!s) return "";
  try { var u = new URL(s); return u.protocol === "https:" && !u.username && !u.password ? u.toString() : ""; } catch (e) { return ""; }
}
function billingEnvInfo() {
  var baseOk = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(PUBLIC_BASE_URL);
  return { keyPresent: !!MOLLIE_API_KEY, mode: /^live_/.test(MOLLIE_API_KEY) ? "live" : /^test_/.test(MOLLIE_API_KEY) ? "test" : null, baseUrl: PUBLIC_BASE_URL || null, baseOk: baseOk, webhookUrl: baseOk ? PUBLIC_BASE_URL + "/api/billing/webhook" : null };
}
function billingReady() { var e = billingEnvInfo(); return e.keyPresent && e.baseOk; }
function billingLive(s) { return !!(s && s.billing && s.billing.enabled) && billingReady(); }
// Is dit een Plus-gebruiker? Een cadeau (beheer) of een lopend/afgelopen-maar-nog-betaald abonnement.
function plusActiveDoc(doc, now) {
  if (!doc) return false;
  if (doc.grantUntil > now) return true;
  return ["active", "canceled", "past_due"].indexOf(doc.status) > -1 && doc.currentPeriodEnd + BILLING_GRACE_MS > now;
}
function emptyBilling(uid) { return { uid: uid, status: "none", pendingPayments: [], seen: [], history: [] }; }
function getBillingDoc(uid) {
  return dbGetDoc("billing/" + uid).then(function (r) { return r.exists && r.value ? Object.assign(emptyBilling(uid), r.value) : emptyBilling(uid); });
}
// Per gebruiker één wijziging tegelijk (een webhook en een tik van de gebruiker kunnen tegelijk binnenkomen).
function withBillingLock(uid, fn) {
  var prev = billingLocks.get(uid) || Promise.resolve();
  var next = prev.then(fn, fn);
  var tail = next.then(function () {}, function () {});
  billingLocks.set(uid, tail);
  tail.then(function () { if (billingLocks.get(uid) === tail) billingLocks.delete(uid); });
  return next;
}
function moneyStr(cents) { return (cents / 100).toFixed(2); }
function addMonthsUTC(ms, n) {
  var d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function intervalMonths(iv) { return iv === "year" ? 12 : 1; }
function mollie(method, path, body) {
  var ctrl = new AbortController(), t = setTimeout(function () { ctrl.abort(); }, 15000);
  return fetch(MOLLIE_BASE_URL + "/v2" + path, {
    method: method, signal: ctrl.signal, body: body ? JSON.stringify(body) : undefined,
    headers: { "Authorization": "Bearer " + MOLLIE_API_KEY, "Content-Type": "application/json", "User-Agent": "Balanza" }
  }).then(function (res) {
    clearTimeout(t);
    return res.text().then(function (txt) {
      var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
      if (!res.ok) { var err = new Error("Mollie " + res.status + ": " + ((j && (j.detail || j.title)) || txt.slice(0, 200))); err.status = res.status; throw err; }
      return j;
    });
  }, function (e) { clearTimeout(t); throw e; });
}
function pushHistory(doc, entry) { doc.history = (doc.history || []).concat([Object.assign({ ts: new Date().toISOString() }, entry)]).slice(-20); }
function createSubscription(doc, startDate) {
  return mollie("POST", "/customers/" + doc.customerId + "/subscriptions", {
    amount: { currency: "EUR", value: moneyStr(doc.priceCents) }, interval: doc.interval === "year" ? "12 months" : "1 month", startDate: startDate,
    description: "Balanza Plus (" + (doc.interval === "year" ? "jaarlijks" : "maandelijks") + ")", webhookUrl: PUBLIC_BASE_URL + "/api/billing/webhook",
    metadata: { uid: doc.uid }, mandateId: doc.mandateId || undefined
  }).then(function (sub) { doc.subscriptionId = sub.id; delete doc.subscriptionError; }, function (e) { doc.subscriptionError = String(e.message).slice(0, 200); });
}
function cancelMollieSubscription(doc) {
  if (!doc.subscriptionId || !doc.customerId) return Promise.resolve();
  return mollie("DELETE", "/customers/" + doc.customerId + "/subscriptions/" + doc.subscriptionId).then(function () {}, function (e) { if (e.status === 404 || e.status === 422) return; throw e; });   // bestond al niet meer of was al opgezegd
}
// Verwerkt één betaling zoals Mollie die nú rapporteert (nooit wat de aanvrager beweert).
// Van welke gebruiker is deze betaling? Via de Mollie-klant (die leggen wij zelf vast); vervolgbetalingen van een abonnement
// hoeven geen eigen metadata mee te krijgen, dus daar rekenen we niet op. De metadata is alleen een terugval.
function resolveBillingUid(p) {
  if (!p || typeof p.id !== "string") return Promise.resolve(null);
  var meta = p.metadata && typeof p.metadata.uid === "string" && UID_RE.test(p.metadata.uid) ? p.metadata.uid : null;
  if (typeof p.customerId !== "string" || !/^cst_[A-Za-z0-9]{3,40}$/.test(p.customerId)) return Promise.resolve(null);
  return dbGetDoc("billingCustomer/" + p.customerId).then(function (r) {
    return r.exists && r.value && UID_RE.test(r.value.uid) ? r.value.uid : meta;
  });
}
function processMolliePayment(p) {
  return resolveBillingUid(p).then(function (uid) { return uid ? processForUser(uid, p) : undefined; });
}
function processForUser(uid, p) {
  return withBillingLock(uid, function () {
    return getBillingDoc(uid).then(function (doc) {
      if (!doc.customerId || doc.customerId !== p.customerId) return;   // niet één van onze klanten
      var value = p.amount && parseFloat(p.amount.value) || 0, cents = Math.round(value * 100);
      var charged = p.amountChargedBack && parseFloat(p.amountChargedBack.value) > 0;
      var refundedFull = value > 0 && p.amountRefunded && parseFloat(p.amountRefunded.value) >= value;
      var evKey = p.id + ":" + p.status + (charged ? ":cb" : "") + (refundedFull ? ":rf" : "");
      if (doc.seen.indexOf(evKey) > -1) return;   // dezelfde melding nog eens (Mollie herhaalt): niets dubbel doen
      var step = Promise.resolve();
      if (charged || refundedFull) {   // geld teruggehaald of volledig terugbetaald: toegang stopt en het abonnement ook
        step = cancelMollieSubscription(doc).catch(function (e) { doc.subscriptionError = String(e.message).slice(0, 200); }).then(function () {
          doc.status = "ended"; doc.currentPeriodEnd = Date.now(); doc.endReason = charged ? "chargeback" : "refund";   // een cadeau van de beheerder blijft staan
          pushHistory(doc, { id: p.id, status: charged ? "chargeback" : "refund", cents: cents });
        });
      } else if (p.sequenceType === "first") {
        var pend = doc.pendingPayments.filter(function (x) { return x.id === p.id; })[0];
        if (!pend) return;   // een betaling die wij niet zelf hebben gestart
        if (p.status === "paid") {
          if (pend.cents !== cents) { pushHistory(doc, { id: p.id, status: "bedrag-klopt-niet", cents: cents }); }
          else {
            doc.pendingPayments = doc.pendingPayments.filter(function (x) { return x.id !== p.id; });
            var now = Date.now(), base = doc.currentPeriodEnd > now ? doc.currentPeriodEnd : now, startDate = isoDate(addMonthsUTC(base, intervalMonths(pend.interval)));
            doc.interval = pend.interval; doc.priceCents = pend.cents; doc.status = "active"; doc.startedAt = doc.startedAt || new Date().toISOString();
            doc.currentPeriodEnd = Date.parse(startDate + "T00:00:00Z"); doc.mandateId = p.mandateId || doc.mandateId; delete doc.endReason;
            pushHistory(doc, { id: p.id, status: "betaald", cents: cents });
            step = createSubscription(doc, startDate);
          }
        } else if (["failed", "canceled", "expired"].indexOf(p.status) > -1) {
          doc.pendingPayments = doc.pendingPayments.filter(function (x) { return x.id !== p.id; });
          if (doc.status === "pending" && !doc.pendingPayments.length) doc.status = "none";
          pushHistory(doc, { id: p.id, status: p.status, cents: cents });
        } else return;   // nog open: wachten op de volgende melding
      } else {   // een vervolgbetaling van het abonnement
        if (!doc.subscriptionId || p.subscriptionId !== doc.subscriptionId) return;
        if (p.status === "paid") {
          doc.currentPeriodEnd = addMonthsUTC(doc.currentPeriodEnd || Date.now(), intervalMonths(doc.interval));
          if (doc.status === "past_due") doc.status = "active";
          pushHistory(doc, { id: p.id, status: "betaald", cents: cents });
        } else if (["failed", "canceled", "expired"].indexOf(p.status) > -1) {
          if (doc.status === "active") doc.status = "past_due";
          pushHistory(doc, { id: p.id, status: p.status, cents: cents });
        } else return;
      }
      return step.then(function () {
        doc.seen = doc.seen.concat([evKey]).slice(-40);
        return dbSetDoc("billing/" + uid, doc);
      });
    });
  });
}
// Betaald maar het abonnement kon niet worden aangemaakt (Mollie even niet bereikbaar): opnieuw proberen.
function healSubscription(uid) {
  return withBillingLock(uid, function () {
    return getBillingDoc(uid).then(function (doc) {
      if (doc.status !== "active" || doc.subscriptionId || !doc.subscriptionError || !doc.customerId) return;
      return createSubscription(doc, isoDate(doc.currentPeriodEnd)).then(function () { return dbSetDoc("billing/" + uid, doc); });
    });
  });
}
function refreshBilling(uid) {
  return getBillingDoc(uid).then(function (doc) {
    return Promise.all(doc.pendingPayments.slice(-3).map(function (x) {
      return mollie("GET", "/payments/" + x.id).then(processMolliePayment).catch(function () {});
    }));
  }).then(function () { return healSubscription(uid); }).then(function () { return getBillingDoc(uid); });
}
function billingPublic(doc, s, user) {
  var now = Date.now(), b = s.billing, active = plusActiveDoc(doc, now);
  return {
    enabled: true, isAccount: !!(user && user.email),
    plans: { month: { cents: b.plusMonthlyCents }, year: { cents: b.plusYearlyCents } },
    plusDishCap: b.plusDishCap, freeDishCap: s.limits.monthlyDishCap, termsUrl: b.termsUrl || null,
    plusActive: active, subscription: doc.status, interval: doc.interval || null,
    periodEnd: doc.currentPeriodEnd ? new Date(doc.currentPeriodEnd).toISOString() : null,
    renews: doc.status === "active", cancelAtPeriodEnd: doc.status === "canceled", pastDue: doc.status === "past_due",
    pending: doc.pendingPayments.length > 0, granted: doc.grantUntil > now, grantUntil: doc.grantUntil > now ? new Date(doc.grantUntil).toISOString() : null
  };
}
// Gedeelde voorbereiding van de eindpunten voor gebruikers: begrenzing, aan/uit, sessie, account.
function billingContext(req, res, needAccount) {
  if (!billingLimiter(clientIp(req))) { sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." }); return Promise.resolve(null); }
  return getSettings().then(function (s) {
    if (!billingLive(s)) { sendJSON(res, 404, { code: "billing_off", message: "Abonnementen zijn niet beschikbaar." }); return null; }
    return resolveUser(req).then(function (user) {
      if (!user) { sendUnauthorized(res); return null; }
      if (needAccount && !user.email) { sendJSON(res, 403, { code: "account_required", message: "Maak eerst een account aan om Plus te nemen." }); return null; }
      return { user: user, settings: s };
    });
  });
}
function handleBillingGet(req, res) {
  if (!billingLimiter(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." });
  return getSettings().then(function (s) {
    if (!billingLive(s)) return sendJSON(res, 200, { enabled: false });   // niets te zien voor gebruikers zolang het uit staat
    return resolveUser(req).then(function (user) {
      if (!user) return sendUnauthorized(res);
      var step = user.email ? refreshBilling(user.uid) : Promise.resolve(emptyBilling(user.uid));
      return step.then(function (doc) { sendJSON(res, 200, billingPublic(doc, s, user)); });
    });
  }).catch(function (err) { sendJSON(res, 500, { code: "error", message: "Abonnement ophalen mislukt." }); });
}
function handleBillingCheckout(req, res) {
  return billingContext(req, res, true).then(function (ctx) {
    if (!ctx) return;
    return readBody(req).then(function (body) {
      var interval = body && body.interval;
      if (interval !== "month" && interval !== "year") return sendJSON(res, 400, { code: "bad_request", message: "Kies maandelijks of jaarlijks." });
      if (!body || body.acceptTerms !== true) return sendJSON(res, 400, { code: "terms_required", message: "Ga akkoord met de voorwaarden om door te gaan." });
      var uid = ctx.user.uid, b = ctx.settings.billing, cents = interval === "year" ? b.plusYearlyCents : b.plusMonthlyCents;
      return withBillingLock(uid, function () {
        return getBillingDoc(uid).then(function (doc) {
          if (doc.status === "active" && plusActiveDoc(doc, Date.now())) { sendJSON(res, 409, { code: "already_active", message: "Je hebt al een actief abonnement." }); return; }
          var cust = doc.customerId ? Promise.resolve(doc.customerId) : mollie("POST", "/customers", { email: ctx.user.email, metadata: { uid: uid } }).then(function (c) {
            return dbSetDoc("billingCustomer/" + c.id, { uid: uid }).then(function () { return c.id; });   // zodat elke betaling van deze klant terug te vinden is
          });
          return cust.then(function (customerId) {
            doc.customerId = customerId;
            return mollie("POST", "/payments", {
              amount: { currency: "EUR", value: moneyStr(cents) }, customerId: customerId, sequenceType: "first", locale: "nl_NL",
              description: "Balanza Plus (" + (interval === "year" ? "jaarlijks" : "maandelijks") + ")",
              redirectUrl: PUBLIC_BASE_URL + "/?billing=return", cancelUrl: PUBLIC_BASE_URL + "/?billing=cancel", webhookUrl: PUBLIC_BASE_URL + "/api/billing/webhook",
              metadata: { uid: uid, kind: "first", interval: interval }
            });
          }).then(function (pay) {
            var href = pay && pay._links && pay._links.checkout && pay._links.checkout.href;
            var okHref = typeof href === "string" && (/^https:\/\/([A-Za-z0-9-]+\.)*mollie\.com\//.test(href) || (MOLLIE_BASE_OVERRIDDEN && /^https?:\/\//.test(href)));
            if (!okHref || !pay.id) throw new Error("Mollie gaf geen bruikbare betaallink terug.");
            doc.pendingPayments = doc.pendingPayments.slice(-4).concat([{ id: pay.id, interval: interval, cents: cents, at: new Date().toISOString() }]);
            if (doc.status === "none" || doc.status === "ended") doc.status = "pending";
            doc.consent = { at: new Date().toISOString(), interval: interval, cents: cents, termsUrl: b.termsUrl || null, ip: clientIp(req) };
            pushHistory(doc, { id: pay.id, status: "gestart", cents: cents });
            return dbSetDoc("billing/" + uid, doc).then(function () { sendJSON(res, 200, { checkoutUrl: href }); });
          });
        });
      });
    });
  }).catch(function (err) {
    sendJSON(res, 502, { code: "error", message: "Betalen starten mislukt: " + (err && err.message ? err.message : "onbekende fout") });
  });
}
// Opzeggen: geen nieuwe incasso's meer; Plus blijft tot het einde van de betaalde periode.
function cancelSubscriptionFor(uid) {
  return withBillingLock(uid, function () {
    return getBillingDoc(uid).then(function (doc) {
      if (["active", "past_due"].indexOf(doc.status) === -1) return { doc: doc, changed: false };
      return cancelMollieSubscription(doc).then(function () {
        doc.status = "canceled"; doc.canceledAt = new Date().toISOString();
        pushHistory(doc, { status: "opgezegd" });
        return dbSetDoc("billing/" + uid, doc).then(function () { return { doc: doc, changed: true }; });
      });
    });
  });
}
function handleBillingCancel(req, res) {
  return billingContext(req, res, true).then(function (ctx) {
    if (!ctx) return;
    return cancelSubscriptionFor(ctx.user.uid).then(function (r) {
      if (!r.changed) return sendJSON(res, 409, { code: "nothing_to_cancel", message: "Er is geen lopend abonnement om op te zeggen." });
      sendJSON(res, 200, billingPublic(r.doc, ctx.settings, ctx.user));
    });
  }).catch(function (err) { sendJSON(res, 502, { code: "error", message: "Opzeggen mislukt: " + (err && err.message ? err.message : "onbekende fout") + ". Er is niets gewijzigd, probeer het later opnieuw." }); });
}
function readRawText(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [], total = 0;
    req.on("data", function (c) { total += c.length; if (total > 8192) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}
// De webhook: Mollie stuurt id=tr_… . Altijd 200 behalve als wij het niet konden verwerken (dan probeert Mollie het opnieuw).
function handleBillingWebhook(req, res) {
  if (!webhookLimiter(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken." });
  return readRawText(req).then(function (raw) {
    var id = "";
    try { id = /json/i.test(req.headers["content-type"] || "") ? String((JSON.parse(raw) || {}).id || "") : String(new URLSearchParams(raw).get("id") || ""); } catch (e) {}
    if (!/^tr_[A-Za-z0-9]{4,40}$/.test(id) || !billingReady()) return sendJSON(res, 200, { ok: true });   // rommel of niet ingesteld: bevestigen, niets doen
    return mollie("GET", "/payments/" + id).then(processMolliePayment).then(function () { sendJSON(res, 200, { ok: true }); }, function (e) {
      if (e && e.status === 404) return sendJSON(res, 200, { ok: true });   // onbekend bij Mollie: niet opnieuw laten proberen
      logEvent("billing", "webhook", false, 500, { error: String(e && e.message).slice(0, 200) });
      sendJSON(res, 500, { code: "error", message: "Verwerken mislukt, probeer het opnieuw." });
    });
  }).catch(function () { sendJSON(res, 200, { ok: true }); });
}
// Een account verwijderen mag het abonnement niet laten doorlopen: eerst opzeggen, lukt dat niet dan niet verwijderen.
function cancelBillingForDeletion(uid) {
  return getBillingDoc(uid).then(function (doc) {
    return cancelBillingForDeletionInner(doc).then(function () { return doc.customerId ? dbDeleteDoc("billingCustomer/" + doc.customerId) : undefined; });
  });
}
function cancelBillingForDeletionInner(doc) {
  return Promise.resolve(doc).then(function (doc) {
    if (!doc.subscriptionId || ["canceled", "ended"].indexOf(doc.status) > -1) return;
    if (!billingReady()) throw new Error("Het abonnement kon niet worden opgezegd omdat betalingen niet zijn ingesteld. Het account is niet verwijderd.");
    return cancelMollieSubscription(doc).catch(function (e) {
      throw new Error("Het abonnement kon niet worden opgezegd bij de betaalprovider (" + String(e.message).slice(0, 120) + "). Het account is niet verwijderd; probeer het later opnieuw.");
    });
  });
}
function adminBillingView(doc) {
  var now = Date.now();
  return {
    status: doc.status, plusActive: plusActiveDoc(doc, now), interval: doc.interval || null, priceCents: doc.priceCents || null,
    periodEnd: doc.currentPeriodEnd ? new Date(doc.currentPeriodEnd).toISOString() : null, grantUntil: doc.grantUntil > now ? new Date(doc.grantUntil).toISOString() : null,
    customerId: doc.customerId || null, subscriptionId: doc.subscriptionId || null, subscriptionError: doc.subscriptionError || null, endReason: doc.endReason || null,
    pending: doc.pendingPayments.length, history: (doc.history || []).slice(-10).reverse()
  };
}

// ---------- Opdrachten op de achtergrond ----------
// Genereren duurt soms minuten. Een telefoon pauzeert of sluit een pagina die niet meer op de voorgrond staat, en dan
// ging het lopende verzoek (en het resultaat) verloren. Daarom start de app een "opdracht": de server werkt zelfstandig
// verder, bewaart het resultaat een tijd, en de app haalt het op zodra de gebruiker terug is. Duurt het lang en is de
// gebruiker weg, dan sturen we (als hij dat heeft aangezet) een pushmelding.
var JOB_TTL_MS = Number(process.env.JOB_TTL_MS) > 0 ? Number(process.env.JOB_TTL_MS) : 30 * 60 * 1000;   // hoe lang een klaar resultaat blijft staan
var JOB_MAX_RUN_MS = Number(process.env.JOB_MAX_RUN_MS) > 0 ? Number(process.env.JOB_MAX_RUN_MS) : 10 * 60 * 1000;   // daarna geven we het op
var JOB_WATCH_MS = Number(process.env.JOB_WATCH_MS) > 0 ? Number(process.env.JOB_WATCH_MS) : 20000;   // zo kort geleden gepeild = de gebruiker kijkt mee
var JOB_MAX_RUNNING_PER_USER = 4;
var jobs = new Map();            // id -> opdracht (lopend of klaar)
var jobRequestIds = new Map();   // uid:requestId -> id, zodat een herhaald verzoek dezelfde opdracht teruggeeft
var jobPollAllowed = makeHourlyLimiter(6000);
var JOB_ID_RE = /^[a-f0-9]{32}$/;
var REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function runningJobCount(uid) {
  var n = 0;
  jobs.forEach(function (j) { if (j.status === "running" && (!uid || j.uid === uid)) n++; });
  return n;
}
function saveJobDoc(job) {
  return dbSetDoc("jobs/" + job.id, { uid: job.uid, action: job.action, status: job.status, result: job.result, error: job.error, createdAt: job.createdAt, finishedAt: job.finishedAt, expiresAt: job.expiresAt }).catch(function () {});
}
function loadJob(id) {
  var j = jobs.get(id);
  if (j && j.status !== "running" && Date.now() > j.expiresAt) { jobs.delete(id); dbDeleteDoc("jobs/" + id).catch(function () {}); return Promise.resolve(null); }
  if (j) return Promise.resolve(j);
  return dbGetDoc("jobs/" + id).then(function (r) {
    if (!r.exists || !r.value) return null;
    if (Date.now() > r.value.expiresAt) { dbDeleteDoc("jobs/" + id).catch(function () {}); return null; }
    return Object.assign({ id: id, lastPollAt: 0 }, r.value);
  });
}
function jobFailure(err) {
  var bad = !!(err && err.isBadRequest);
  return { status: bad ? 400 : 502, code: bad ? "bad_request" : "error", message: bad ? (err && err.message ? err.message : "Ongeldig verzoek.") : "Genereren mislukt: " + (err && err.message ? err.message : "onbekende fout") };
}
function finishJob(job, err, result) {
  if (job.status !== "running") return;
  job.finishedAt = Date.now();
  job.expiresAt = job.finishedAt + JOB_TTL_MS;
  if (err) { job.status = "error"; job.error = jobFailure(err); } else { job.status = "done"; job.result = result; }
  saveJobDoc(job);
  notifyJobFinished(job);
}
function startGenerateJob(o) {
  var uid = o.uid, body = o.body, action = o.action, res = o.res;
  var rid = typeof body.requestId === "string" && REQUEST_ID_RE.test(body.requestId) ? body.requestId : null;
  if (rid) {   // hetzelfde verzoek nog eens (bijv. de verbinding viel weg vóór het antwoord): dezelfde opdracht, geen tweede
    var again = jobRequestIds.get(uid + ":" + rid);
    if (again && jobs.has(again)) return sendJSON(res, 202, { jobId: again, pollAfterMs: 1500 });
  }
  if (runningJobCount(uid) >= JOB_MAX_RUNNING_PER_USER) {
    o.log(action, false, 429, "Te veel lopende opdrachten");
    return sendJSON(res, 429, { code: "rate_limited", message: "Er lopen al meerdere opdrachten. Wacht tot een daarvan klaar is." });
  }
  var job = { id: crypto.randomBytes(16).toString("hex"), uid: uid, action: action, status: "running", createdAt: Date.now(), lastPollAt: 0, expiresAt: Date.now() + JOB_MAX_RUN_MS + JOB_TTL_MS, host: o.host };
  jobs.set(job.id, job);
  if (rid) jobRequestIds.set(uid + ":" + rid, job.id);
  sendJSON(res, 202, { jobId: job.id, pollAfterMs: 1500 });
  var timer = setTimeout(function () {
    var e = new Error("Het duurde te lang. Probeer het nogmaals."); o.log(action, false, 504, e.message); finishJob(job, e);
  }, JOB_MAX_RUN_MS);
  if (timer.unref) timer.unref();
  var payload = Object.assign({}, body); delete payload.async; delete payload.requestId;
  var run, usage = newUsage();
  try { run = usageCtx.run(usage, function () { return runGenerateAction(payload); }); } catch (e) { run = Promise.reject(e); }
  run.then(function (parsed) {
    clearTimeout(timer);
    var dishes = dishesInResult(action, parsed);
    incrementUsageToday();   // de AI-kosten zijn gemaakt, ook als het resultaat te laat komt
    return recordAccounting(uid, action, usage, dishes, true).then(function () {
      if (job.status !== "running") return;
      o.log(action, true, 200, undefined, { usage: usage, dishes: dishes });
      finishJob(job, null, parsed);
    });
  }, function (err) {
    clearTimeout(timer);
    return recordAccounting(uid, action, usage, 0, false).then(function () {
      if (job.status !== "running") return;
      o.log(action, false, err && err.isBadRequest ? 400 : 502, err && err.message, { usage: usage, dishes: 0 });
      finishJob(job, err);
    });
  });
}
function handleGenerateJobGet(req, res, id) {
  if (!jobPollAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Even geduld." });
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return loadJob(id).then(function (job) {
      if (!job || job.uid !== user.uid) return sendJSON(res, 404, { code: "not_found", message: "Deze opdracht bestaat niet meer." });
      job.lastPollAt = Date.now();
      if (job.status === "running") return sendJSON(res, 200, { status: "running", elapsedMs: Date.now() - job.createdAt });
      if (job.status === "done") return sendJSON(res, 200, { status: "done", result: job.result });
      sendJSON(res, 200, { status: "error", code: job.error.code, message: job.error.message, httpStatus: job.error.status });
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Er ging iets mis: " + (err && err.message ? err.message : "onbekende fout") });
  });
}
// Een omgezet anoniem profiel neemt zijn opdrachten mee, anders raakt een lopende opdracht zijn eigenaar kwijt.
function reassignJobs(fromUid, toUid) {
  jobs.forEach(function (j) { if (j.uid === fromUid) j.uid = toUid; });
  return dbListDocs("jobs/").then(function (docs) {
    return Promise.all(docs.filter(function (d) { return d.value && d.value.uid === fromUid; }).map(function (d) { return dbSetDoc(d.path, Object.assign({}, d.value, { uid: toUid })); }));
  }).catch(function () {});
}
function sweepJobs() {
  var now = Date.now();
  jobs.forEach(function (j, id) { if (j.status !== "running" && now > j.expiresAt) jobs.delete(id); });
  jobRequestIds.forEach(function (id, key) { if (!jobs.has(id)) jobRequestIds.delete(key); });
  dbListDocs("jobs/").then(function (docs) {
    return Promise.all(docs.filter(function (d) { return d.value && now > d.value.expiresAt; }).map(function (d) { return dbDeleteDoc(d.path); }));
  }).catch(function () {});
}
var jobSweeper = setInterval(sweepJobs, 10 * 60 * 1000);
if (jobSweeper.unref) jobSweeper.unref();

// ---------- Meldingen (Web Push) ----------
// Zonder extra pakketten: VAPID-handtekening (ES256) en versleuteling van de melding (RFC 8291) doen we met Node's eigen crypto.
// De VAPID-sleutels komen uit VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY, of worden één keer aangemaakt en in de database bewaard.
// Zonder blijvende opslag verdwijnen ze bij een herstart; dan schrijven telefoons zich vanzelf opnieuw in als de app opent.
var pushKeysPromise = null;
var pushSubscribeAllowed = makeHourlyLimiter(60);
var PUSH_MAX_SUBS_PER_USER = 5;
var PUSH_TEST_HOSTS = String(process.env.PUSH_TEST_HOSTS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);   // alleen voor tests

function fromBase64url(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
function makeVapid(pubB64, privB64, source) {
  var pub = fromBase64url(pubB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is geen geldige sleutel (verwacht 65 bytes, base64url).");
  var privateKey = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: String(privB64), x: base64url(pub.slice(1, 33)), y: base64url(pub.slice(33, 65)) }, format: "jwk" });
  return { publicKey: pubB64, privateKey: privateKey, source: source };
}
function getVapidKeys() {
  if (pushKeysPromise) return pushKeysPromise;
  pushKeysPromise = (function () {
    var envPub = process.env.VAPID_PUBLIC_KEY, envPriv = process.env.VAPID_PRIVATE_KEY;
    if (envPub && envPriv) { try { return Promise.resolve(makeVapid(envPub, envPriv, "env")); } catch (e) { return Promise.reject(e); } }
    return dbGetDoc("settings/vapid").then(function (r) {
      if (r.exists && r.value && r.value.publicKey && r.value.privateKey) return makeVapid(r.value.publicKey, r.value.privateKey, "database");
      var kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      var jwk = kp.privateKey.export({ format: "jwk" });
      var doc = { publicKey: base64url(Buffer.concat([Buffer.from([4]), fromBase64url(jwk.x), fromBase64url(jwk.y)])), privateKey: jwk.d, createdAt: new Date().toISOString() };
      return dbSetDoc("settings/vapid", doc).then(function () { return makeVapid(doc.publicKey, doc.privateKey, "database"); });
    });
  })();
  pushKeysPromise.catch(function () { pushKeysPromise = null; });
  return pushKeysPromise;
}
function signVapid(audience, subject, keys) {
  var head = base64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  var claims = base64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  var sig = crypto.sign("sha256", Buffer.from(head + "." + claims), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return head + "." + claims + "." + base64url(sig);
}
// Versleutelt een melding voor één toestel (RFC 8291, aes128gcm). 'fixed' is alleen voor tests met vaste sleutels.
function encryptWebPush(p256dh, authSecret, payload, fixed) {
  var uaPublic = fromBase64url(p256dh), auth = fromBase64url(authSecret);
  var ecdh = crypto.createECDH("prime256v1");
  if (fixed && fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate); else ecdh.generateKeys();
  var asPublic = ecdh.getPublicKey();
  var secret = ecdh.computeSecret(uaPublic);
  var salt = fixed && fixed.salt ? fixed.salt : crypto.randomBytes(16);
  var keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  var ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, keyInfo, 32));
  var cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  var nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  var cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  var enc = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  var header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, enc]);
}
// De server stuurt alleen naar de bekende pushdiensten van de browsers (anders kon iemand ons laten aankloppen bij een intern adres).
function pushEndpointAllowed(raw) {
  var u;
  try { u = new URL(String(raw)); } catch (e) { return false; }
  if (u.username || u.password || String(raw).length > 600) return false;
  if (PUSH_TEST_HOSTS.indexOf(u.host) > -1) return u.protocol === "http:" || u.protocol === "https:";
  if (u.protocol !== "https:" || u.port) return false;
  var h = u.hostname.toLowerCase();
  return h === "fcm.googleapis.com" || h === "android.googleapis.com" || h === "updates.push.services.mozilla.com" ||
    /(^|\.)push\.services\.mozilla\.com$/.test(h) || /(^|\.)push\.apple\.com$/.test(h) || /(^|\.)notify\.windows\.com$/.test(h);
}
function validPushSubscription(sub) {
  if (!sub || typeof sub !== "object" || typeof sub.endpoint !== "string" || !pushEndpointAllowed(sub.endpoint)) return false;
  var keys = sub.keys;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
  var k = fromBase64url(keys.p256dh), a = fromBase64url(keys.auth);
  return k.length === 65 && k[0] === 4 && a.length === 16;
}
function sendWebPush(sub, payload, host) {
  return getVapidKeys().then(function (keys) {
    var endpoint = new URL(sub.endpoint);
    var subject = process.env.VAPID_SUBJECT || (host ? "https://" + String(host).replace(/[^A-Za-z0-9.:-]/g, "") : "mailto:beheer@balanza.invalid");
    var jwt = signVapid(endpoint.origin, subject, keys);
    var body = encryptWebPush(sub.p256dh, sub.auth, Buffer.from(JSON.stringify(payload)));
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 10000);
    return fetch(sub.endpoint, {
      method: "POST", redirect: "manual", signal: ctrl.signal, body: body,
      headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", "Content-Length": String(body.length), "TTL": "3600", "Urgency": "normal", "Authorization": "vapid t=" + jwt + ", k=" + keys.publicKey }
    }).then(function (r) { clearTimeout(t); return r.status; }, function (e) { clearTimeout(t); throw e; });
  });
}
function notifyUser(uid, payload, host) {
  return dbGetDoc("push/" + uid).then(function (r) {
    var subs = r.exists && r.value && Array.isArray(r.value.subs) ? r.value.subs : [];
    if (!subs.length) return { sent: 0 };
    return Promise.all(subs.map(function (s) {
      return sendWebPush(s, payload, host).then(function (status) { return { s: s, status: status }; }, function () { return { s: s, status: 0 }; });
    })).then(function (results) {
      var sent = results.filter(function (x) { return x.status >= 200 && x.status < 300; }).length;
      var dead = results.filter(function (x) { return [400, 401, 403, 404, 410].indexOf(x.status) > -1; }).map(function (x) { return x.s.endpoint; });
      logEvent("push", "notify", sent > 0, sent > 0 ? 200 : (results[0] ? results[0].status : 0), { uid: uid, sent: sent, failed: results.length - sent, error: sent > 0 ? undefined : "Melding niet afgeleverd" });
      if (!dead.length) return { sent: sent, removed: 0 };
      return dbSetDoc("push/" + uid, { subs: subs.filter(function (s) { return dead.indexOf(s.endpoint) === -1; }) }).then(function () { return { sent: sent, removed: dead.length }; });
    });
  }).catch(function () { return { sent: 0 }; });
}
// Alleen bij een lange opdracht (gerechten maken) en alleen als de gebruiker niet meer meekijkt.
function notifyJobFinished(job) {
  if (job.action !== "generate") return;
  var lastSeen = job.lastPollAt || job.createdAt;
  if (Date.now() - lastSeen < JOB_WATCH_MS) return;
  notifyUser(job.uid, job.status === "done"
    ? { title: "Balanza", body: "Je gerechten zijn klaar. Tik om ze te bekijken.", url: "/", tag: "balanza-generate" }
    : { title: "Balanza", body: "Het genereren is niet gelukt. Tik om het opnieuw te proberen.", url: "/", tag: "balanza-generate" }, job.host);
}

function handlePushKey(req, res) {
  return getVapidKeys().then(function (k) { sendJSON(res, 200, { publicKey: k.publicKey }); }, function () {
    sendJSON(res, 503, { code: "push_unavailable", message: "Meldingen zijn op deze server niet beschikbaar." });
  });
}
function handlePushSubscribe(req, res) {
  if (!pushSubscribeAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." });
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return readBody(req).then(function (body) {
      var sub = body && body.subscription;
      if (!validPushSubscription(sub)) return sendJSON(res, 400, { code: "bad_request", message: "Dit toestel kan geen meldingen ontvangen (ongeldig abonnement)." });
      return dbGetDoc("push/" + user.uid).then(function (r) {
        var subs = r.exists && r.value && Array.isArray(r.value.subs) ? r.value.subs.filter(function (s) { return s.endpoint !== sub.endpoint; }) : [];
        subs.push({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, createdAt: new Date().toISOString() });
        while (subs.length > PUSH_MAX_SUBS_PER_USER) subs.shift();
        return dbSetDoc("push/" + user.uid, { subs: subs });
      }).then(function () { sendJSON(res, 200, { ok: true }); });
    });
  }).catch(function (err) {
    sendJSON(res, 400, { code: "bad_request", message: err && err.message ? err.message : "Ongeldige aanvraag." });
  });
}
function handlePushUnsubscribe(req, res) {
  if (!pushSubscribeAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." });
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return readBody(req).then(function (body) {
      var endpoint = body && typeof body.endpoint === "string" ? body.endpoint : "";
      return dbGetDoc("push/" + user.uid).then(function (r) {
        var subs = r.exists && r.value && Array.isArray(r.value.subs) ? r.value.subs : [];
        var next = subs.filter(function (s) { return s.endpoint !== endpoint; });
        return next.length === subs.length ? null : (next.length ? dbSetDoc("push/" + user.uid, { subs: next }) : dbDeleteDoc("push/" + user.uid));
      });
    }).then(function () { sendJSON(res, 200, { ok: true }); });
  }).catch(function (err) {
    sendJSON(res, 400, { code: "bad_request", message: err && err.message ? err.message : "Ongeldige aanvraag." });
  });
}

function handleAuthLogin(req, res) {
  var ip = clientIp(req);
  readBody(req).then(function (body) {
    var email = normalizeEmail(body && body.email);
    var password = (body && body.password) || "";
    return dbGetDoc("auth/users/" + email).then(function (result) {
      if (result.exists && result.value && !result.value.hash && result.value.providers && Object.keys(result.value.providers).length) {
        var via = Object.keys(result.value.providers).map(function (k) { return OAUTH_PROVIDERS[k] ? OAUTH_PROVIDERS[k].label : k; }).join(" of ");
        logEvent("auth", "login", false, 401, { error: "Account zonder wachtwoord", email: email.slice(0, 200), ip: ip });
        return sendJSON(res, 401, { code: "use_oauth", message: "Dit account logt in met " + via + ". Gebruik die knop, of stel via \u201cWachtwoord vergeten?\u201d een wachtwoord in." });
      }
      if (!result.exists || !verifyPassword(password, result.value)) {
        logEvent("auth", "login", false, 401, { error: "Onjuiste inloggegevens", email: email.slice(0, 200), ip: ip });
        return sendJSON(res, 401, { code: "unauthorized", message: "E-mailadres of wachtwoord onjuist." });
      }
      return getBlocked().then(function (b) {
        if (b.uids[result.value.uid]) {
          logEvent("auth", "login", false, 403, { error: "Account geblokkeerd", email: email, uid: result.value.uid, ip: ip });
          return sendJSON(res, 403, { code: "blocked", message: "Dit account is geblokkeerd. Neem contact op met de beheerder." });
        }
        var updated = Object.assign({}, result.value, { lastLoginAt: new Date().toISOString(), loginCount: (result.value.loginCount || 0) + 1 });
        return dbSetDoc("auth/users/" + email, updated).catch(function () {}).then(function () {
          logEvent("auth", "login", true, 200, { email: email, uid: result.value.uid, ip: ip });
          sendJSON(res, 200, { token: issueUserSession(result.value.uid, email), uid: result.value.uid });
        });
      });
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Inloggen mislukt: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

var ALLOWED_SUBPATHS = ["prefs", "dishes", "plannedWeeks"];
var RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function sendResetEmail(email, resetLink) {
  if (!RESEND_API_KEY) return Promise.reject(new Error("RESEND_API_KEY niet ingesteld."));
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [email],
      subject: "Wachtwoord resetten — Balanza",
      html: "<p>Je hebt een wachtwoordreset aangevraagd voor je Balanza-account.</p>" +
        "<p><a href=\"" + resetLink + "\">Klik hier om een nieuw wachtwoord in te stellen</a></p>" +
        "<p>Deze link is 1 uur geldig. Heb je dit niet zelf aangevraagd, dan kun je deze e-mail gewoon negeren.</p>"
    })
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error("Resend API error " + res.status + ": " + t.slice(0, 200)); });
    }
  });
}

function handleForgotPassword(req, res) {
  readBody(req).then(function (body) {
    var email = normalizeEmail(body && body.email);
    // Always return the same generic message, whether or not the account
    // exists — this prevents anyone from using this endpoint to check which
    // e-mail addresses have an account.
    function genericResponse() {
      sendJSON(res, 200, { message: "Als dit e-mailadres bekend is, ontvang je een link om je wachtwoord te resetten." });
    }
    if (!email) return genericResponse();
    dbGetDoc("auth/users/" + email).then(function (result) {
      if (!result.exists) return genericResponse();
      var token = crypto.randomBytes(24).toString("hex");
      logEvent("auth", "reset-request", true, 200, { email: email, uid: result.value.uid, ip: clientIp(req) });
      return dbSetDoc("auth/resets/" + token, { email: email, uid: result.value.uid, expiresAt: Date.now() + RESET_TOKEN_TTL_MS, used: false }).then(function () {
        var host = req.headers.host;
        var resetLink = "https://" + host + "/?reset=" + token;
        return sendResetEmail(email, resetLink);
      }).then(genericResponse).catch(function () {
        // Don't leak email-sending failures to the client either.
        genericResponse();
      });
    }).catch(genericResponse);
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

function handleResetPassword(req, res) {
  readBody(req).then(function (body) {
    var token = body && body.token;
    var newPassword = (body && body.newPassword) || "";
    if (!token) return sendJSON(res, 400, { code: "bad_request", message: "Ongeldige of verlopen link." });
    if (newPassword.length < 8) return sendJSON(res, 400, { code: "bad_request", message: "Wachtwoord moet minstens 8 tekens zijn." });
    dbGetDoc("auth/resets/" + token).then(function (result) {
      if (!result.exists || result.value.used || Date.now() > result.value.expiresAt) {
        return sendJSON(res, 400, { code: "bad_request", message: "Deze link is ongeldig of verlopen. Vraag een nieuwe aan." });
      }
      var email = result.value.email;
      return dbGetDoc("auth/users/" + email).then(function (userResult) {
        if (!userResult.exists) return sendJSON(res, 400, { code: "bad_request", message: "Account niet gevonden." });
        // Een link hoort bij één account: is het e-mailadres inmiddels gewijzigd en later aan iemand anders gegeven, dan werkt de oude link niet.
        if (result.value.uid && result.value.uid !== userResult.value.uid) return sendJSON(res, 400, { code: "bad_request", message: "Deze link is ongeldig of verlopen. Vraag een nieuwe aan." });
        var uid = userResult.value.uid;
        var record = makePasswordRecord(newPassword);
        return Promise.all([
          dbSetDoc("auth/users/" + email, Object.assign({}, userResult.value, { salt: record.salt, hash: record.hash })),
          dbSetDoc("auth/resets/" + token, { email: email, expiresAt: 0, used: true }),
          updateBlocked(function (b) { b.invalidBefore[uid] = Date.now(); })
        ]).then(function () {
          logEvent("auth", "reset-done", true, 200, { email: email, uid: uid, ip: clientIp(req) });
          sendJSON(res, 200, { token: issueUserSession(uid, email), uid: uid });
        });
      });
    }).catch(function (err) {
      sendJSON(res, 500, { code: "error", message: "Resetten mislukt: " + (err && err.message ? err.message : "onbekende fout") });
    });
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

function handleDbGet(req, res, query) {
  var subpath = query.get("subpath");
  if (ALLOWED_SUBPATHS.indexOf(subpath) === -1) return sendJSON(res, 400, { message: "Ongeldig subpath." });
  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return dbGetDoc("data/users/" + user.uid + "/" + subpath).then(function (result) {
      sendJSON(res, 200, result);
    });
  }).catch(function (err) {
    sendJSON(res, 500, { message: "Opslag niet bereikbaar: " + err.message });
  });
}

function handleDbSet(req, res) {
  readBody(req).then(function (body) {
    return resolveUser(req).then(function (user) {
      if (!user) return sendUnauthorized(res);
      var subpath = body && body.subpath;
      if (ALLOWED_SUBPATHS.indexOf(subpath) === -1) return sendJSON(res, 400, { message: "Ongeldig subpath." });
      var ip = clientIp(req);
      var fullPath = "data/users/" + user.uid + "/" + subpath;
      var trackIp = dbSetDoc("data/users/" + user.uid + "/meta", { lastIp: ip, lastSeenAt: new Date().toISOString(), email: user.email }).catch(function () {});
      return Promise.all([dbSetDoc(fullPath, body.value), trackIp]).then(function () {
        sendJSON(res, 200, { ok: true });
      });
    });
  }).catch(function (err) {
    sendJSON(res, 400, { message: err && err.message ? err.message : "Ongeldige aanvraag." });
  });
}

// ---------- Tips voor de wachtcarrousel ----------
// Tijdens het genereren toont de app een carrousel met weetjes en tips. Die worden in
// kleine pakketjes (8 stuks) door de AI geschreven, zodat er steeds nieuwe bij komen.
// Eigen eindpunt met eigen limieten: tips tellen niet mee voor de generatielimiet.

// Controleert een door de AI geleverde lijst met tips en houdt alleen bruikbare items over.
function cleanTipList(raw) {
  var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tips) ? raw.tips : []);
  var out = [], seen = {};
  list.forEach(function (item) {
    if (!item || typeof item !== "object") return;
    var text = String(item.tekst || item.text || "").replace(/\s+/g, " ").trim();
    if (text.length < 20 || text.length > 240) return;
    var key = text.toLowerCase().slice(0, 50);
    if (seen[key]) return;
    seen[key] = true;
    var type = item.type === "feit" || item.type === "balanza" ? item.type : "tip";
    out.push({ type: type, tekst: text });
  });
  return out.slice(0, 12);
}

var TIP_GOALS = ["Onderhoud", "Vetverlies (spierbehoud)", "Cutting", "Spieropbouw (lean bulk)", "Atleet (prestatiegericht)"];
var TIP_DIETS = ["Omnivoor", "Flexitarisch", "Vegetarisch", "Veganistisch"];
var TIP_TOPICS = ["eiwit", "koolhydraten", "vetten", "vezels en groente", "verzadiging en porties", "meal prep en bewaren",
  "slim boodschappen doen", "smaak en kruiden", "kooktechnieken", "ontbijt", "snacks", "sport en herstel", "drinken",
  "seizoensgroenten", "Balanza-functies"];

function pickRandomItems(list, n) {
  var pool = list.slice(), out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out;
}

// Bouwt de opdracht voor een nieuw pakket tips. Doel en voedingsstijl komen uit een vaste lijst
// (nooit vrije tekst) en de "avoid"-lijst wordt ingekort en van regeleinden ontdaan.
function buildTipsPrompt(p) {
  p = p || {};
  var goal = TIP_GOALS.indexOf(p.goal) > -1 ? p.goal : "Onderhoud";
  var diet = TIP_DIETS.indexOf(p.dietStyle) > -1 ? p.dietStyle : "";
  var family = p.familyMode === true;
  var avoid = (Array.isArray(p.avoid) ? p.avoid : []).slice(0, 30)
    .map(function (s) { return String(s).replace(/[\r\n"]+/g, " ").trim().slice(0, 90); })
    .filter(Boolean);
  var topics = pickRandomItems(TIP_TOPICS, 3);
  return "Je schrijft korte, prettig leesbare weetjes en tips voor de wachtcarrousel van Balanza, een app die gebalanceerde " +
    "maaltijden ontwerpt op basis van macro's. De lezer wacht even op het genereren van gerechten en wil zich vermaken en iets leren.\n\n" +
    "Schrijf 8 NIEUWE items in het Nederlands. Verdeel ze over deze onderwerpen: " + topics.join(", ") + ". " +
    "Maak van hooguit 1 item een tip over Balanza zelf.\n" +
    "Context van de lezer: doel \"" + goal + "\"" + (diet ? ", voedingsstijl \"" + diet + "\"" : "") + (family ? ", kookt in gezinsmodus (kindvriendelijk)" : "") + ". " +
    "Laat minstens twee items aansluiten op dat doel" + (diet ? " of die voedingsstijl" : "") + (family ? " of gezinsmodus" : "") + ".\n\n" +
    "Regels:\n" +
    "- Maximaal 190 tekens per item, één of twee korte zinnen, geen opsomming, geen emoji's, spreek de lezer aan met \"je\".\n" +
    "- Alleen algemeen erkende voedings- en kookkennis. Geen medische adviezen, geen beloftes over resultaten (zoals \"val zo af\"), " +
    "geen exacte cijfers behalve algemeen bekende (bijv. 4 kcal per gram eiwit of koolhydraten, 9 kcal per gram vet). " +
    "Twijfel je over de juistheid? Laat het item dan weg.\n" +
    "- Types: \"feit\" (verrassend weetje; begin niet met \"Wist je dat\"), \"tip\" (praktische kook- of voedingstip), " +
    "\"balanza\" (tip over een echte functie van Balanza).\n" +
    "- Echte Balanza-functies (verzin er geen andere): Balans-score per gerecht (hoe dicht de macroverdeling bij het doel ligt); " +
    "dag- en weektotalen van macro's; weekplanning per maaltijdmoment; boodschappenlijst (samengevoegd per week of per dag, " +
    "gegroepeerd per categorie, met prijsindicatie); prepdag-plan; een variant van een gerecht laten maken (pittiger, simpeler, " +
    "fine dining, andere koolhydraatbron); aantal personen per gerecht; kookmodus met timers; PDF-export; bereidingstijd per gerecht; " +
    "doel en voedingsstijl instellen.\n" +
    (avoid.length ? "- Herhaal deze eerder getoonde items niet en varieer sterk:\n" + avoid.map(function (a) { return "  * " + a; }).join("\n") + "\n" : "") +
    "\nGeef ALLEEN geldig JSON terug: een array van 8 objecten, exact dit schema, geen markdown, geen uitleg erbuiten:\n" +
    "[{\"type\": \"feit\", \"tekst\": \"...\"}]";
}

var tipsIpHits = new Map(); // ip -> { count, windowStart }
var tipsDay = { day: "", count: 0 };

// Geeft null als het verzoek mag, anders de melding waarom niet.
function checkTipsLimits(ip) {
  var now = Date.now();
  var entry = tipsIpHits.get(ip);
  if (!entry || now - entry.windowStart > 60 * 60 * 1000) entry = { count: 0, windowStart: now };
  entry.count++;
  tipsIpHits.set(ip, entry);
  if (entry.count > liveLimits.tipsPerIpHourly) return "Te veel tip-verzoeken vanaf dit adres.";
  var today = todayKey();
  if (tipsDay.day !== today) tipsDay = { day: today, count: 0 };
  tipsDay.count++;
  if (tipsDay.count > liveLimits.dailyTipsCap) return "De dagelijkse tip-limiet is bereikt.";
  return null;
}

function handleTips(req, res) {
  var ip = clientIp(req);
  var startTime = Date.now();
  var limitMessage = checkTipsLimits(ip);
  if (limitMessage) return sendJSON(res, 429, { code: "rate_limited", message: limitMessage });

  getSettings().then(function (settings) {
    if (!effectiveModules(settings).tips) { sendJSON(res, 503, moduleOffBody("tips", settings)); return undefined; }
    return resolveUser(req);
  }).then(function (user) {
    if (user === undefined) return;   // uitgeschakeld: al beantwoord
    if (!user) return sendUnauthorized(res);
    if (!ANTHROPIC_API_KEY) return sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ANTHROPIC_API_KEY ingesteld." });
    return readBody(req).then(function (body) {
      var prompt = buildTipsPrompt((body && body.params) || {});
      var usage = newUsage();
      return usageCtx.run(usage, function () { return callAnthropicOnce(prompt, TIPS_MODEL, 2000); }).then(function (parsed) {
        return recordAccounting(user.uid, "tips", usage, 0, true).then(function () {
          var tips = cleanTipList(parsed);
          if (!tips.length) throw new Error("Geen bruikbare tips ontvangen");
          sendJSON(res, 200, { result: tips });
        });
      }, function (e) { return recordAccounting(user.uid, "tips", usage, 0, false).then(function () { throw e; }); });
    });
  }).catch(function (err) {
    logRequest({ ts: new Date().toISOString(), type: "tips", action: "tips", durationMs: Date.now() - startTime, ok: false, status: 502, error: err.message, ip: ip });
    sendJSON(res, 502, { code: "error", message: "Tips ophalen mislukt: " + err.message });
  });
}

// ---------- Foto's (Unsplash; alleen actief als UNSPLASH_ACCESS_KEY is ingesteld) ----------
//
// Zo komt een foto tot stand:
//  1. Zoekterm: bij voorkeur de Engelse "foto_zoekterm" die de AI bij het gerecht
//     leverde. Ontbreekt die (oudere gerechten), dan vertalen we de Nederlandse
//     gerechtnaam met een woordenlijst.
//  2. We halen 15 kandidaten op en beoordelen elk op beschrijving en tags:
//     past het bij het gerecht, is het eten, staat er geen persoon of landschap op?
//  3. Is er geen degelijke match, dan komt er één tweede poging met de kern van
//     de zoekterm. Daarna geldt: liever géén foto dan een verkeerde foto.
//  4. Definitieve uitkomsten worden onthouden. Tijdelijke storingen (bijv. de
//     limiet van 50 aanvragen per uur bij een Unsplash-app in demomodus) worden
//     NIET als "geen foto" vastgelegd, zodat er later opnieuw gezocht wordt.

var IMAGE_CACHE_MAX = 500;
var IMAGE_CANDIDATES = 15;
var UNSPLASH_BACKOFF_MS = 10 * 60 * 1000;

var imageCache = new Map();      // zoekterm -> definitief resultaat { url, credit, final: true }
var imageInflight = new Map();   // zoekterm -> Promise (gelijktijdige gelijke aanvragen delen 1 opzoeking)
var unsplashBackoffUntil = 0;    // na een limiet-melding tijdelijk niet meer aankloppen

var TERM_STOPWORDS = ["met", "en", "van", "op", "in", "de", "het", "een", "uit", "aan", "voor", "of", "naar", "bij", "door",
  "onder", "over", "zonder", "la", "al", "alla", "di", "del", "the", "and", "with", "of", "on", "a", "food", "dish", "meal", "recipe"];

var TERM_MODIFIERS = ["italian", "mexican", "asian", "thai", "indian", "greek", "japanese", "chinese", "french", "spanish", "turkish",
  "moroccan", "grilled", "fried", "roasted", "braised", "smoked", "baked", "poached"];

var NL_TO_EN = {
  // vlees, vis, ei, vega-eiwit
  kip: "chicken", kipfilet: "chicken breast", kippendij: "chicken thigh", kipdij: "chicken thigh", kalkoen: "turkey",
  gehakt: "minced meat", gehaktballetjes: "meatballs", gehaktbal: "meatballs", gehaktballen: "meatballs",
  rundvlees: "beef", rund: "beef", runderlappen: "beef stew", biefstuk: "steak", entrecote: "steak", ribeye: "steak",
  varkensvlees: "pork", varkenshaas: "pork tenderloin", spek: "bacon", ham: "ham", worst: "sausage", lam: "lamb", lamsvlees: "lamb",
  kalfsvlees: "veal", zalm: "salmon", tonijn: "tuna", kabeljauw: "cod", forel: "trout", makreel: "mackerel", garnalen: "shrimp",
  gamba: "shrimp", gambas: "shrimp", mosselen: "mussels", inktvis: "squid", vis: "fish", ei: "egg", eieren: "eggs", omelet: "omelette",
  roerei: "scrambled eggs", tofu: "tofu", tempeh: "tempeh", kikkererwten: "chickpeas", linzen: "lentils", bonen: "beans",
  kidneybonen: "kidney beans", edamame: "edamame", shoarma: "shawarma", gyros: "gyros",
  // groente
  tomaat: "tomato", tomaten: "tomato", tomatensaus: "tomato sauce", komkommer: "cucumber", paprika: "bell pepper", ui: "onion", uien: "onion",
  knoflook: "garlic", wortel: "carrot", wortels: "carrot", peen: "carrot", broccoli: "broccoli", bloemkool: "cauliflower",
  spinazie: "spinach", courgette: "zucchini", aubergine: "eggplant", champignons: "mushrooms", paddenstoelen: "mushrooms",
  prei: "leek", sla: "salad", rucola: "arugula", avocado: "avocado", pompoen: "pumpkin", aardappel: "potato", aardappelen: "potatoes",
  aardappels: "potatoes", zoete: "sweet", mais: "corn", erwten: "peas", asperges: "asparagus", boerenkool: "kale", spruitjes: "brussels sprouts",
  kool: "cabbage", snijbonen: "green beans", sperziebonen: "green beans", venkel: "fennel", radijs: "radish", bieten: "beetroot",
  groenten: "vegetables", groente: "vegetables",
  // fruit
  bessen: "berries", bosbes: "blueberry", blauwe: "blue", rode: "red", groene: "green", gele: "yellow", witte: "white",
  appel: "apple", banaan: "banana", aardbei: "strawberry", aardbeien: "strawberries", frambozen: "raspberries", bosbessen: "blueberries",
  mango: "mango", ananas: "pineapple", citroen: "lemon", limoen: "lime", sinaasappel: "orange", peer: "pear", druiven: "grapes",
  // granen en brood
  rijst: "rice", pasta: "pasta", spaghetti: "spaghetti", penne: "penne", lasagne: "lasagna", noedels: "noodles", couscous: "couscous",
  quinoa: "quinoa", bulgur: "bulgur", brood: "bread", wrap: "wrap", tortilla: "tortilla", pannenkoek: "pancake", pannenkoeken: "pancakes",
  havermout: "oatmeal", muesli: "muesli", granola: "granola", boterham: "sandwich",
  // zuivel
  kaas: "cheese", feta: "feta", mozzarella: "mozzarella", parmezaan: "parmesan", yoghurt: "yogurt", kwark: "quark", skyr: "skyr",
  room: "cream", roomkaas: "cream cheese", boter: "butter",
  // soorten gerecht
  soep: "soup", salade: "salad", stoofpot: "stew", curry: "curry", bowl: "bowl", burger: "burger", pizza: "pizza", taco: "taco", tacos: "tacos",
  burrito: "burrito", sandwich: "sandwich", toast: "toast", smoothie: "smoothie", ovenschotel: "casserole", roerbak: "stir fry",
  roerbakschotel: "stir fry", wok: "stir fry", risotto: "risotto", gratin: "gratin", frittata: "frittata", shakshuka: "shakshuka",
  falafel: "falafel", hummus: "hummus", sushi: "sushi", ramen: "ramen", saus: "sauce", pesto: "pesto", satay: "satay", saté: "satay",
  // bereiding
  gegrild: "grilled", gebakken: "fried", gebraden: "roasted", geroosterd: "roasted", gestoofd: "braised", gerookt: "smoked",
  ovengebakken: "baked", gepocheerd: "poached", gefrituurd: "fried",
  // keuken
  italiaans: "italian", mexicaans: "mexican", aziatisch: "asian", thais: "thai", indiaas: "indian", grieks: "greek",
  japans: "japanese", chinees: "chinese", frans: "french", spaans: "spanish", turks: "turkish", marokkaans: "moroccan"
};

function tokenize(text) {
  return String(text || "").toLowerCase().replace(/[^a-zà-ÿ0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
}

// Vertaalt één Nederlands woord (ook samenstellingen als "tomatensoep" of "kipsaté") naar Engelse woorden.
function translateToken(tok) {
  if (NL_TO_EN[tok]) return [NL_TO_EN[tok]];
  var keys = Object.keys(NL_TO_EN);
  for (var i = 0; i < keys.length; i++) {
    var a = keys[i];
    if (a.length < 3 || tok.indexOf(a) !== 0 || tok.length <= a.length) continue;
    var restRaw = tok.slice(a.length);
    var rest = NL_TO_EN[restRaw] ? restRaw : restRaw.replace(/^s/, ""); // "s" als schakelklank (bijv. kip-s-oep)
    if (NL_TO_EN[rest]) return [NL_TO_EN[a], NL_TO_EN[rest]];
  }
  for (var j = 0; j < keys.length; j++) {
    var k = keys[j];
    if (k.length >= 3 && tok.length > k.length && tok.indexOf(k) === 0) return [NL_TO_EN[k]];
  }
  for (var m = 0; m < keys.length; m++) {
    var s = keys[m];
    if (s.length >= 4 && tok.length > s.length && tok.slice(-s.length) === s) return [NL_TO_EN[s]];
  }
  return [];
}

function uniqueWords(list) {
  var seen = {}, out = [];
  list.forEach(function (w) {
    w.split(/\s+/).forEach(function (part) {
      if (part && !seen[part]) { seen[part] = true; out.push(part); }
    });
  });
  return out;
}

// De AI-zoekterm: kleine letters, alleen letters/cijfers/spaties, maximaal 6 woorden.
function cleanSearchTerm(term) {
  return tokenize(term).filter(function (w) { return TERM_STOPWORDS.indexOf(w) === -1; }).slice(0, 6).join(" ");
}

// Terugval voor gerechten zonder AI-zoekterm: Nederlandse naam -> Engelse zoekwoorden.
function translateDutchDishName(name) {
  var toks = tokenize(name).filter(function (w) { return TERM_STOPWORDS.indexOf(w) === -1; });
  var english = [];
  toks.forEach(function (t) { translateToken(t).forEach(function (w) { english.push(w); }); });
  // Hoofdingrediënten eerst; keuken- en bereidingswoorden achteraan, zodat bij het
  // afkappen op 4 woorden de kern van het gerecht behouden blijft.
  var words = uniqueWords(english);
  var core = words.filter(function (w) { return TERM_MODIFIERS.indexOf(w) === -1; });
  var mods = words.filter(function (w) { return TERM_MODIFIERS.indexOf(w) > -1; });
  var ordered = core.concat(mods).slice(0, 4);
  return ordered.length ? ordered.join(" ") : toks.slice(0, 3).join(" ");
}

var FOOD_HINT_RE = /\b(food|dish|meal|plate|plated|bowl|salad|soup|stew|pasta|noodles?|rice|bread|toast|sandwich|burger|pizza|breakfast|lunch|dinner|snack|cuisine|cooking|cooked|grilled|roasted|baked|fried|dessert|vegetables?|fruits?|meat|steak|chicken|beef|pork|fish|seafood|salmon|eggs?|cheese|sauce|curry|tomato(es)?|cucumber|avocado|potato(es)?|pancakes?|yogh?urt|oatmeal|granola|smoothie|tacos?|wrap|sushi|ingredients?|healthy|gourmet|delicious|tasty|recipe|table)\b/;
var PEOPLE_RE = /\b(man|men|woman|women|person|people|portrait|girl|boy|child|children|baby|face|couple|family|smiling|standing|sitting|walking)\b/;
var NONFOOD_RE = /\b(landscape|mountain|city|building|street|beach|ocean|forest|sky|animal|dog|cat|car|road|logo|sign|book|phone|laptop|flower|flowers)\b/;

function photoText(photo) {
  var parts = [photo.alt_description, photo.description];
  (photo.tags || []).forEach(function (t) { if (t && t.title) parts.push(t.title); });
  return parts.filter(Boolean).join(" ").toLowerCase();
}

// Geeft de beste foto terug, of null als geen enkele kandidaat degelijk genoeg is.
function pickBestPhoto(photos, keywords) {
  var best = null;
  (photos || []).forEach(function (photo, index) {
    if (!photo || !photo.urls) return;
    var text = photoText(photo);
    var matched = 0;
    keywords.forEach(function (kw) { if (text.indexOf(kw) > -1) matched++; });
    var foodHint = matched > 0 || FOOD_HINT_RE.test(text);
    var score = matched * 3 + (foodHint ? 2 : 0);
    if (PEOPLE_RE.test(text)) score -= 4;
    if (!foodHint && NONFOOD_RE.test(text)) score -= 5;
    if (!foodHint || score < 2) return;
    if (!best || score > best.score) best = { photo: photo, score: score, index: index };
  });
  return best ? best.photo : null;
}

function searchUnsplash(term) {
  var url = "https://api.unsplash.com/search/photos?per_page=" + IMAGE_CANDIDATES +
    "&orientation=landscape&content_filter=high&query=" + encodeURIComponent(term + " food");
  return fetch(url, { headers: { "Authorization": "Client-ID " + UNSPLASH_ACCESS_KEY } }).then(function (r) {
    if (r.status === 403 || r.status === 429) {
      unsplashBackoffUntil = Date.now() + UNSPLASH_BACKOFF_MS;
      var limitErr = new Error("Unsplash-limiet bereikt");
      limitErr.transient = true;
      throw limitErr;
    }
    if (!r.ok) {
      var httpErr = new Error("Unsplash API error " + r.status);
      httpErr.transient = true;
      throw httpErr;
    }
    return r.json();
  });
}

function photoResult(photo) {
  return {
    url: photo.urls.small || photo.urls.regular,
    credit: photo.user ? { name: photo.user.name, profileUrl: photo.user.links && photo.user.links.html } : null,
    final: true
  };
}

function resolvePhoto(term) {
  var keywords = term.split(" ").filter(function (w) { return w.length >= 3; });
  return searchUnsplash(term).then(function (data) {
    var best = pickBestPhoto(data.results, keywords);
    if (best) return photoResult(best);
    if (keywords.length < 2) return { url: null, credit: null, final: true };
    var core = keywords.slice(0, 2).join(" ");
    return searchUnsplash(core).then(function (data2) {
      var best2 = pickBestPhoto(data2.results, core.split(" "));
      return best2 ? photoResult(best2) : { url: null, credit: null, final: true };
    });
  });
}

function rememberImage(term, result) {
  imageCache.set(term, result);
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
}

function handleImage(req, res, query) {
  var name = (query.get("query") || "").trim();
  var aiTerm = (query.get("term") || "").trim();
  if (!name && !aiTerm) return sendJSON(res, 400, { message: "query ontbreekt" });

  if (!UNSPLASH_ACCESS_KEY) {
    return sendJSON(res, 200, { url: null, credit: null, final: true });
  }
  // Geen harde 401 hier (anders dan bij de foto-proxy): een oudere, gecachte pagina die nog geen
  // identiteit meestuurt, moet gewoon een foto blijven krijgen. Zonder identiteit geldt "free".
  return getSettings().then(function (s) {
    return resolveUser(req).then(function (user) { return getUserPlan(user && user.uid, s); }, function () { return "free"; }).then(function (plan) {
      if (planBlocksModule(s, "images", plan)) return sendJSON(res, 200, { url: null, credit: null, final: true });
      return continueImage();
    });
  });

  function continueImage() {
  var term = aiTerm ? cleanSearchTerm(aiTerm) : translateDutchDishName(name);
  if (!term) return sendJSON(res, 200, { url: null, credit: null, final: true });

  if (imageCache.has(term)) return sendJSON(res, 200, imageCache.get(term));
  if (Date.now() < unsplashBackoffUntil) return sendJSON(res, 200, { url: null, credit: null, final: false });

  var pending = imageInflight.get(term);
  if (!pending) {
    pending = resolvePhoto(term).then(function (result) {
      rememberImage(term, result);
      return result;
    });
    imageInflight.set(term, pending);
    var clear = function () { imageInflight.delete(term); };
    pending.then(clear, clear);
  }
  pending.then(function (result) {
    sendJSON(res, 200, result);
  }).catch(function () {
    sendJSON(res, 200, { url: null, credit: null, final: false });
  });
  }
}

// ---------- Foto-proxy (voor de PDF-export) ----------
// Een browser mag een plaatje van een andere site wel tonen, maar niet uitlezen om het in een
// PDF te zetten (CORS). Daarom haalt de server de foto op en geeft die door. Streng begrensd:
// alleen https://images.unsplash.com, alleen voor ingelogde (of, als inloggen uit staat,
// anonieme) gebruikers, alleen afbeeldingen, en maximaal 6 MB.

var PHOTO_MAX_BYTES = 6 * 1024 * 1024;
var PHOTO_HOST = "images.unsplash.com";

// Geeft een URL-object terug als het adres een toegestane Unsplash-afbeelding is, anders null.
function parsePhotoUrl(raw) {
  var u;
  try { u = new URL(String(raw || "")); } catch (e) { return null; }
  if (u.protocol !== "https:" || u.hostname !== PHOTO_HOST || u.port) return null;
  if (u.username || u.password) return null;
  return u;
}

function fetchPhotoBytes(urlString) {
  return fetch(urlString, { redirect: "error" }).then(function (r) {
    if (!r.ok) throw new Error("Foto-bron gaf status " + r.status);
    var type = r.headers.get("content-type") || "";
    if (!/^image\//i.test(type)) throw new Error("Geen afbeelding");
    return r.arrayBuffer().then(function (buf) {
      if (buf.byteLength > PHOTO_MAX_BYTES) throw new Error("Foto te groot");
      return { type: type, buffer: Buffer.from(buf) };
    });
  });
}

function handlePhoto(req, res, query) {
  var target = parsePhotoUrl(query.get("url"));
  if (!target) return sendJSON(res, 400, { message: "Ongeldige foto-url." });
  // Voor print willen we meer pixels dan de 400 px van het lijstje. Alleen de breedte aanpassen.
  var width = Math.max(400, Math.min(1600, parseInt(query.get("w") || "1000", 10) || 1000));
  var original = target.toString();
  var larger = new URL(original);
  larger.searchParams.set("w", String(width));

  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return getSettings().then(function (s) { return getUserPlan(user.uid, s).then(function (plan) { return { s: s, plan: plan }; }); }).then(function (r) {
      if (planBlocksModule(r.s, "images", r.plan)) return sendJSON(res, 503, moduleOffBody("images", r.s));
      return fetchPhotoBytes(larger.toString()).catch(function () {
        return fetchPhotoBytes(original); // grotere variant niet beschikbaar: val terug op het origineel
      }).then(function (photo) {
        res.writeHead(200, {
          "Content-Type": photo.type,
          "Content-Length": photo.buffer.length,
          "Cache-Control": "private, max-age=86400"
        });
        res.end(photo.buffer);
      });
    });
  }).catch(function () {
    sendJSON(res, 502, { message: "Foto niet beschikbaar." });
  });
}

// ---------- Gedeelde boodschappenlijst ----------
// Een lijst delen maakt een momentopname op de server, bereikbaar via een lange, willekeurige
// link (/l/<code>, 128 bit). Iedereen met de link kan de lijst zien en per product "in mandje" of
// "niet nodig" aanvinken; de vinkjes staan op de server, zodat iedereen dezelfde stand ziet.
// Alleen wie de lijst maakte kan de inhoud bijwerken of het delen stoppen. In de lijst staat
// alleen wat de maker meestuurt (producten, categorie, titel), nooit een naam of e-mailadres.
// Lijsten verlopen 30 dagen na de laatste wijziging.

var LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
var LIST_MAX_ITEMS = 300;
var LIST_MAX_TEXT = 140;
var LIST_MAX_CAT = 40;
var LIST_MAX_TITLE = 80;
var LIST_MAX_PER_OWNER = 20;
var LIST_FLAG_TTL_MS = 12 * 60 * 60 * 1000;   // zo lang blijft een product als 'nieuw' of 'aangepast' gemarkeerd
var LIST_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
var LIST_ID_RE = /^[a-z0-9-]{1,80}$/;

// Eenvoudige begrenzing per IP-adres per uur (in het geheugen).
function makeHourlyLimiter(maxPerHour) {
  var hits = new Map();
  return function (ip) {
    var now = Date.now();
    var entry = hits.get(ip);
    if (!entry || now - entry.start > 60 * 60 * 1000) entry = { count: 0, start: now };
    entry.count++;
    hits.set(ip, entry);
    if (hits.size > 5000) {
      hits.forEach(function (v, k) { if (now - v.start > 60 * 60 * 1000) hits.delete(k); });
    }
    return entry.count <= maxPerHour;
  };
}
var listCreateAllowed = makeHourlyLimiter(30);     // nieuwe lijsten
var listUpdateAllowed = makeHourlyLimiter(300);    // bijwerken van een eigen lijst (ook automatisch vanuit de app)
var listReadAllowed = makeHourlyLimiter(2400);
var listWriteAllowed = makeHourlyLimiter(1200);

function dbDeleteDoc(docPath) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      delete store.docs[docPath];
      saveStore(store);
      return;
    }
    return db.collection("docs").deleteOne({ _id: docPath });
  });
}

// Zet of wist het vinkje van één product. Bewust per product (niet de hele lijst overschrijven),
// zodat twee telefoons die tegelijk afvinken elkaars wijzigingen niet wissen.
function dbSetListItemState(docPath, itemId, status, now) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      var doc = store.docs[docPath];
      if (!doc) return;
      doc.state = doc.state || {};
      if (status) doc.state[itemId] = status; else delete doc.state[itemId];
      doc.rev = (doc.rev || 0) + 1;
      doc.updatedAt = now;
      doc.expiresAt = now + LIST_TTL_MS;
      saveStore(store);
      return;
    }
    var set = { "value.updatedAt": now, "value.expiresAt": now + LIST_TTL_MS };
    var update = { $set: set, $inc: { "value.rev": 1 } };
    if (status) set["value.state." + itemId] = status;
    else { update.$unset = {}; update.$unset["value.state." + itemId] = ""; }
    return db.collection("docs").updateOne({ _id: docPath }, update);
  });
}

function dbResetListState(docPath, now) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      var doc = store.docs[docPath];
      if (!doc) return;
      doc.state = {};
      doc.rev = (doc.rev || 0) + 1;
      doc.updatedAt = now;
      doc.expiresAt = now + LIST_TTL_MS;
      saveStore(store);
      return;
    }
    return db.collection("docs").updateOne({ _id: docPath },
      { $set: { "value.state": {}, "value.updatedAt": now, "value.expiresAt": now + LIST_TTL_MS }, $inc: { "value.rev": 1 } });
  });
}

function cleanListText(v, max) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitizeListItems(raw) {
  var out = [], seen = {};
  (Array.isArray(raw) ? raw : []).slice(0, LIST_MAX_ITEMS).forEach(function (it) {
    if (!it || typeof it !== "object") return;
    var id = String(it.id || "");
    var text = cleanListText(it.text, LIST_MAX_TEXT);
    if (!LIST_ID_RE.test(id) || !text || seen[id]) return;
    seen[id] = true;
    var item = { id: id, cat: cleanListText(it.cat, LIST_MAX_CAT) || "Overige", text: text };
    // Naam en hoeveelheid apart (optioneel): daar heeft de Bring!-import iets aan.
    var nm = cleanListText(it.name, 80), sp = cleanListText(it.spec, 40);
    if (nm) item.name = nm;
    if (sp) item.spec = sp;
    out.push(item);
  });
  return out;
}

function cleanListState(raw, items) {
  var ids = {};
  items.forEach(function (it) { ids[it.id] = true; });
  var out = {};
  if (raw && typeof raw === "object") {
    Object.keys(raw).forEach(function (k) {
      if (ids[k] && (raw[k] === "basket" || raw[k] === "skip")) out[k] = raw[k];
    });
  }
  return out;
}

function listCounts(doc) {
  var state = doc.state || {}, basket = 0, skip = 0;
  (doc.items || []).forEach(function (it) {
    if (state[it.id] === "basket") basket++;
    else if (state[it.id] === "skip") skip++;
  });
  return { total: (doc.items || []).length, basket: basket, skip: skip };
}

// Bepaalt bij een bijwerking wat er is veranderd, zodat de ontvanger dat in het product zelf ziet:
// nieuw (kind "new"), aangepast (kind "changed", met de eerdere tekst in "was"), of weggehaald.
// Een markering blijft 12 uur staan, ook als er intussen nog een keer wordt bijgewerkt, en vervalt
// als een product terug is naar wat de ontvanger al kende. Deze velden zet alleen de server; wat de
// aanvrager meestuurt, wordt bij het opschonen weggegooid.
function applyItemChangeFlags(oldItems, newItems, now, removedBefore) {
  var oldById = {};
  (oldItems || []).forEach(function (it) { oldById[it.id] = it; });
  var newIds = {};
  newItems.forEach(function (it) {
    newIds[it.id] = true;
    var old = oldById[it.id];
    if (!old) { it.changedAt = now; it.kind = "new"; return; }
    var fresh = !!old.changedAt && now - old.changedAt < LIST_FLAG_TTL_MS;
    if (old.text !== it.text) {
      if (fresh && old.kind === "new") { it.changedAt = now; it.kind = "new"; return; }
      var was = fresh && old.kind === "changed" && old.was ? old.was : old.text;
      if (was === it.text) return;
      it.changedAt = now; it.kind = "changed"; it.was = was;
      return;
    }
    if (fresh) { it.changedAt = old.changedAt; it.kind = old.kind; if (old.was) it.was = old.was; }
  });
  var removed = (removedBefore || []).filter(function (r) { return now - r.at < LIST_FLAG_TTL_MS && !newIds[r.id]; });
  (oldItems || []).forEach(function (it) { if (!newIds[it.id]) removed.push({ id: it.id, text: it.text, at: now }); });
  return removed.slice(-20);
}

function publicList(doc) {
  var now = Date.now();
  return {
    title: doc.title,
    items: (doc.items || []).map(function (it) {
      var out = { id: it.id, cat: it.cat, text: it.text };
      if (it.changedAt && now - it.changedAt < LIST_FLAG_TTL_MS) {
        out.flag = { kind: it.kind, was: it.was || null, ageSec: Math.round((now - it.changedAt) / 1000) };
      }
      return out;
    }),
    removed: (doc.removed || []).filter(function (r) { return now - r.at < LIST_FLAG_TTL_MS; })
      .map(function (r) { return { text: r.text, ageSec: Math.round((now - r.at) / 1000) }; }),
    state: doc.state || {}, rev: doc.rev || 1, updatedAt: doc.updatedAt, counts: listCounts(doc)
  };
}

// Geeft de lijst terug, of null als die niet bestaat of verlopen is (verlopen lijsten ruimen we meteen op).
function getLiveList(token) {
  return dbGetDoc("lists/" + token).then(function (r) {
    if (!r.exists || !r.value) return null;
    if (r.value.expiresAt && r.value.expiresAt < Date.now()) {
      dbDeleteDoc("lists/" + token).catch(function () {});
      return null;
    }
    return r.value;
  });
}

// Bijhouden welke lijsten iemand heeft gemaakt, zodat het aantal begrensd blijft (oudste vervalt).
function addToOwnerIndex(uid, token) {
  return dbGetDoc("listsIndex/" + uid).then(function (r) {
    var tokens = r.exists && r.value && Array.isArray(r.value.tokens) ? r.value.tokens.slice() : [];
    tokens.push(token);
    var drop = [];
    while (tokens.length > LIST_MAX_PER_OWNER) drop.push(tokens.shift());
    return Promise.all(drop.map(function (t) { return dbDeleteDoc("lists/" + t); })).then(function () {
      return dbSetDoc("listsIndex/" + uid, { tokens: tokens });
    });
  });
}
function removeFromOwnerIndex(uid, token) {
  return dbGetDoc("listsIndex/" + uid).then(function (r) {
    if (!r.exists || !r.value || !Array.isArray(r.value.tokens)) return;
    return dbSetDoc("listsIndex/" + uid, { tokens: r.value.tokens.filter(function (t) { return t !== token; }) });
  });
}

function listNotFound(res) {
  sendJSON(res, 404, { code: "not_found", message: "Deze lijst bestaat niet meer of is verlopen." });
}

// POST /api/lists — maakt een lijst, of werkt een eigen bestaande lijst bij (zelfde link blijft werken).
// Met updateOnly: true wordt er nooit een nieuwe lijst gemaakt; bestaat de lijst niet (meer) of is hij van
// iemand anders, dan volgt een 404. Zo maakt het automatisch bijwerken vanuit de app nooit stilletjes een
// nieuwe lijst aan naast een link die niet meer bestaat.
function handleListCreate(req, res) {
  var ip = clientIp(req);
  if (!listWriteAllowed(ip)) {
    return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan. Probeer het over een tijdje opnieuw." });
  }
  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return readBody(req).then(function (body) {
      var items = sanitizeListItems(body && body.items);
      if (!items.length) return sendJSON(res, 400, { code: "bad_request", message: "De lijst is leeg." });
      var title = cleanListText(body.title, LIST_MAX_TITLE) || "Boodschappenlijst";
      var now = Date.now();
      var wanted = typeof body.token === "string" && LIST_TOKEN_RE.test(body.token) ? body.token : null;
      var updateOnly = body.updateOnly === true;
      return (wanted ? getLiveList(wanted) : Promise.resolve(null)).then(function (existing) {
        function reply(token, doc) {
          sendJSON(res, 200, { token: token, path: "/l/" + token, counts: listCounts(doc), rev: doc.rev });
        }
        var mine = !!existing && existing.ownerUid === user.uid;
        if (updateOnly && !mine) return listNotFound(res);
        if (mine) {
          if (!listUpdateAllowed(ip)) {
            return sendJSON(res, 429, { code: "rate_limited", message: "Je hebt deze lijst net al vaak bijgewerkt. Probeer het over een tijdje opnieuw." });
          }
          existing.title = title;
          var oldIds = {};
          existing.items.forEach(function (it) { oldIds[it.id] = true; });
          existing.removed = applyItemChangeFlags(existing.items, items, now, existing.removed);
          existing.items = items;
          existing.state = cleanListState(existing.state, items);
          // Nieuwe producten nemen de stand van de maker over (bijvoorbeeld "niet nodig"); bestaande producten houden
          // hun stand, zodat een update nooit overschrijft wat de ander net heeft afgevinkt.
          var startState = cleanListState(body.state, items);
          Object.keys(startState).forEach(function (id) {
            if (!oldIds[id] && !existing.state[id]) existing.state[id] = startState[id];
          });
          existing.rev = (existing.rev || 0) + 1;
          existing.updatedAt = now;
          existing.expiresAt = now + LIST_TTL_MS;
          return dbSetDoc("lists/" + wanted, existing).then(function () { reply(wanted, existing); });
        }
        if (!listCreateAllowed(ip)) {
          return sendJSON(res, 429, { code: "rate_limited", message: "Je hebt net al veel lijsten gedeeld. Probeer het over een tijdje opnieuw." });
        }
        return getSettings().then(function (s) { return getUserPlan(user.uid, s).then(function (plan) { return { s: s, plan: plan }; }); }).then(function (r) {
          // Alleen het delen van een NIEUWE lijst kan aan Plus gebonden zijn; een lijst die al bestond blijft altijd werken.
          if (planBlocksModule(r.s, "sharing", r.plan)) return sendJSON(res, 503, moduleOffBody("sharing", r.s));
          var token = crypto.randomBytes(16).toString("base64url");
          var doc = { title: title, ownerUid: user.uid, createdAt: now, updatedAt: now, expiresAt: now + LIST_TTL_MS, rev: 1,
            items: items, state: cleanListState(body.state, items) };
          return dbSetDoc("lists/" + token, doc).then(function () {
            return addToOwnerIndex(user.uid, token);
          }).then(function () { reply(token, doc); });
        });
      });
    });
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

// GET /api/lists/<code>[?rev=n] — iedereen met de link. Met rev: alleen antwoorden als er iets veranderd is.
function handleListGet(req, res, token, query) {
  if (!listReadAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan." });
  getLiveList(token).then(function (doc) {
    if (!doc) return listNotFound(res);
    var rev = parseInt(query.get("rev") || "0", 10);
    if (rev && rev === (doc.rev || 1)) return sendJSON(res, 200, { unchanged: true, rev: rev });
    sendJSON(res, 200, publicList(doc));
  }).catch(function () {
    sendJSON(res, 500, { code: "error", message: "Lijst ophalen mislukt." });
  });
}

// POST /api/lists/<code>/item  { id, status: "basket" | "skip" | null }
function handleListItem(req, res, token) {
  if (!listWriteAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan." });
  readBody(req).then(function (body) {
    var id = String((body && body.id) || "");
    var status = body ? body.status : undefined;
    if (!LIST_ID_RE.test(id) || !(status === "basket" || status === "skip" || status === null)) {
      return sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
    }
    return getLiveList(token).then(function (doc) {
      if (!doc) return listNotFound(res);
      if (!doc.items.some(function (it) { return it.id === id; })) {
        return sendJSON(res, 404, { code: "item_not_found", message: "Dit product staat niet meer op de lijst." });
      }
      return dbSetListItemState("lists/" + token, id, status, Date.now()).then(function () {
        return getLiveList(token);
      }).then(function (fresh) {
        sendJSON(res, 200, { ok: true, counts: fresh ? listCounts(fresh) : null });
      });
    });
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

// POST /api/lists/<code>/reset — alle vinkjes wissen.
function handleListReset(req, res, token) {
  if (!listWriteAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan." });
  getLiveList(token).then(function (doc) {
    if (!doc) return listNotFound(res);
    return dbResetListState("lists/" + token, Date.now()).then(function () {
      sendJSON(res, 200, { ok: true });
    });
  }).catch(function () {
    sendJSON(res, 500, { code: "error", message: "Wissen mislukt." });
  });
}

// POST /api/lists/<code>/delete — alleen de maker.
function handleListDelete(req, res, token) {
  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return getLiveList(token).then(function (doc) {
      if (!doc) return sendJSON(res, 200, { ok: true });
      if (doc.ownerUid !== user.uid) return sendJSON(res, 403, { code: "forbidden", message: "Alleen wie de lijst deelde kan het delen stoppen." });
      return dbDeleteDoc("lists/" + token).then(function () {
        return removeFromOwnerIndex(user.uid, token);
      }).then(function () { sendJSON(res, 200, { ok: true }); });
    });
  }).catch(function () {
    sendJSON(res, 500, { code: "error", message: "Stoppen mislukt." });
  });
}

// ---------- Importeren in Bring! ----------
// Bring! kent een officiële "web-to-app"-import: je geeft Bring! het adres van een openbare pagina (of een
// JSON-bestand) met producten, en Bring! haalt die op en opent de app om ze te importeren. Daarvoor serveren
// we een gedeelde lijst in de twee formaten uit de Bring!-documentatie:
//   /l/<code>/bring        pagina met schema.org-markup (Bring! raadt dit aan)
//   /l/<code>/bring.json   JSON-bestand (door Bring! "niet aanbevolen" genoemd, maar eenduidig)
// Standaard alleen producten die nog niet in het mandje liggen of op "niet nodig" staan; met ?alle=1 alles.
// De lijst is dezelfde als die je deelt, dus wie de link heeft, kan hem lezen (zoals altijd bij delen).

var BRING_UNITS = "g|gr|gram|kg|ml|cl|dl|l|el|tl|stuks|stuk|blik|blikje|blikjes|bosje|bosjes|teen|tenen|teentje|teentjes|plak|plakjes|snee|sneetjes|pak|pakje|zak|zakje|handvol|snuf|scheut|takje|takjes|bol|bollen|doosje|potje|pot";
var BRING_SPLIT_RE = new RegExp("^(\\d+(?:[.,/]\\d+)?(?:\\s*(?:" + BRING_UNITS + "))?)\\s+(.+)$", "i");

// Splitst een product in hoeveelheid ("250 g", "2") en naam ("zalmfilet"). Zonder losse velden
// (lijsten van vóór deze functie) proberen we de tekst zelf te splitsen.
function bringParts(it) {
  if (it.name) {
    return { name: it.name, spec: String(it.spec || "").replace(/^(\d+(?:[.,]\d+)?)\s*x$/i, "$1").trim() };
  }
  var text = String(it.text || "").replace(/^(\d+(?:[.,]\d+)?)\s*x\s+/i, "$1 ");
  var m = BRING_SPLIT_RE.exec(text);
  return m ? { spec: m[1].trim(), name: m[2].trim() } : { spec: "", name: text.trim() };
}

function bringItems(doc, includeAll) {
  var state = doc.state || {};
  return (doc.items || []).filter(function (it) { return includeAll || !state[it.id]; }).map(bringParts);
}

// Bring! mag dit bestand ophalen vanuit zijn eigen pagina's/scripts (CORS), maar niemand anders.
function bringCorsHeaders(req) {
  var origin = String(req.headers.origin || "");
  return /^https?:\/\/([a-z0-9-]+\.)*getbring\.com(:\d{1,5})?$/i.test(origin) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : { "Vary": "Origin" };
}

function handleListBring(req, res, token, asJson, query) {
  if (!listReadAllowed(clientIp(req))) { res.writeHead(429, { "Content-Type": "text/plain" }); res.end("Even rustig aan."); return; }
  getLiveList(token).then(function (doc) {
    var headers = Object.assign({
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer"
    }, bringCorsHeaders(req));
    if (!doc) {
      res.writeHead(404, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, headers));
      res.end("Deze lijst bestaat niet meer of is verlopen.");
      return null;
    }
    // Bring! zelf haalt dit op (geen ingelogde sessie); het abonnement van de EIGENAAR van de lijst is bepalend,
    // steeds opnieuw opgevraagd (geen "bevroren" stand van het moment dat de lijst werd gedeeld).
    return getSettings().then(function (s) { return getUserPlan(doc.ownerUid, s).then(function (plan) { return { s: s, plan: plan }; }); }).then(function (r) {
      if (planBlocksModule(r.s, "bring", r.plan)) {
        res.writeHead(503, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, headers));
        res.end(moduleOffBody("bring", r.s).message);
        return;
      }
      return continueBring();
    });
    function continueBring() {
    var host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    var proto = String(req.headers["x-forwarded-proto"] || (/^localhost|^127\./.test(host) ? "http" : "https")).split(",")[0].trim();
    var origin = proto + "://" + host;
    var parts = bringItems(doc, query.get("alle") === "1");
    var title = "Boodschappenlijst \u00b7 " + doc.title;
    if (asJson) {
      var json = {
        author: "Balanza",
        linkOutUrl: origin + "/l/" + token,
        imageUrl: origin + "/icons/icon-512.png",
        name: title,
        tagline: "",
        yield: "",
        time: "",
        nutrition: { calories: "" },
        items: parts.map(function (p) { var o = { itemId: p.name }; if (p.spec) o.spec = p.spec; return o; })
      };
      res.writeHead(200, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers));
      res.end(JSON.stringify(json));
      return;
    }
    var lis = parts.map(function (p) {
      return '    <li itemprop="ingredients recipeIngredient">' + escapeHtmlAttr((p.spec ? p.spec + " " : "") + p.name) + "</li>";
    }).join("\n");
    var html = '<!DOCTYPE html>\n<html lang="nl">\n<head>\n<meta charset="utf-8">\n<meta name="robots" content="noindex, nofollow">\n<meta name="referrer" content="no-referrer">\n' +
      "<title>" + escapeHtmlAttr(title) + "</title>\n</head>\n<body>\n" +
      '<div itemscope itemtype="http://schema.org/Recipe">\n' +
      '  <h1 itemprop="name">' + escapeHtmlAttr(title) + "</h1>\n" +
      '  <div>Door <span itemprop="author">Balanza</span></div>\n' +
      '  <img src="' + escapeHtmlAttr(origin + "/icons/icon-512.png") + '" itemprop="image" alt="">\n' +
      "  <p>Producten om te importeren in Bring!</p>\n" +
      "  <ul>\n" + lis + "\n  </ul>\n</div>\n</body>\n</html>\n";
    res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers));
    res.end(html);
    }
  }).catch(function () {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Lijst ophalen mislukt.");
  });
}

function escapeHtmlAttr(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
}

// GET /l/<code> — de pagina die de ontvanger opent. De titel en omschrijving komen in de
// link-voorbeeldtags te staan, zodat WhatsApp een nette kaart met titel toont.
function handleListPage(req, res, token) {
  fs.readFile(path.join(PUBLIC_DIR, "list.html"), "utf8", function (err, html) {
    if (err) { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Kan de lijstpagina niet laden"); return; }
    getLiveList(token).catch(function () { return null; }).then(function (doc) {
      var host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
      var proto = String(req.headers["x-forwarded-proto"] || (/^localhost|^127\./.test(host) ? "http" : "https")).split(",")[0].trim();
      var origin = proto + "://" + host;
      var title = doc ? "Boodschappenlijst \u00b7 " + doc.title : "Boodschappenlijst";
      var desc = doc ? listCounts(doc).total + " producten. Vink af wat in je mandje ligt, of tik \u201cNiet nodig\u201d." : "Gedeelde boodschappenlijst";
      var page = html
        .replace(/\{\{OG_TITLE\}\}/g, escapeHtmlAttr(title))
        .replace(/\{\{OG_DESC\}\}/g, escapeHtmlAttr(desc))
        .replace(/\{\{OG_IMAGE\}\}/g, escapeHtmlAttr(origin + "/icons/icon-512.png"))
        .replace(/\{\{OG_URL\}\}/g, escapeHtmlAttr(origin + "/l/" + token));
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": "no-referrer"
      });
      res.end(page);
    });
  });
}

var MIME_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveFile(req, res, relativePath) {
  var safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, "");
  var filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, function (err, content) {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    var ext = path.extname(filePath);
    var headers = { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" };
    if (relativePath === "sw.js" || relativePath === "admin.html") headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    res.writeHead(200, headers);
    res.end(content);
  });
}

function serveStatic(req, res) {
  var filePath = path.join(PUBLIC_DIR, "index.html");
  fs.readFile(filePath, function (err, content) {
    if (err) { res.writeHead(500); res.end("Kan index.html niet laden"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate" });
    res.end(content);
  });
}

// ======================================================================================
// ADMIN-API
// Alles onder /api/admin/ (behalve inloggen) vraagt een geldige beheerderssessie. Elke wijziging komt in het
// auditlog te staan (wie/wat/wanneer, nooit wachtwoorden). Zoeken, filteren, sorteren en pagineren gebeurt op
// de server, zodat de pagina snel blijft bij veel gebruikers.
// ======================================================================================

function HttpError(status, code, message) {
  var e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
var DAY_MS = 24 * 60 * 60 * 1000;

// ---- beheerder inloggen (met begrenzing op mislukte pogingen) ----
var adminFails = new Map();          // ip -> { count, start }
var ADMIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
var ADMIN_FAIL_MAX = 10;
function adminLockedFor(ip) {
  var e = adminFails.get(ip);
  if (!e) return 0;
  if (Date.now() - e.start > ADMIN_FAIL_WINDOW_MS) { adminFails.delete(ip); return 0; }
  return e.count >= ADMIN_FAIL_MAX ? Math.ceil((e.start + ADMIN_FAIL_WINDOW_MS - Date.now()) / 1000) : 0;
}
function adminRegisterFail(ip) {
  var e = adminFails.get(ip);
  if (!e || Date.now() - e.start > ADMIN_FAIL_WINDOW_MS) e = { count: 0, start: Date.now() };
  e.count++;
  adminFails.set(ip, e);
}
function safeEqual(a, b) {
  var ha = crypto.createHash("sha256").update(String(a)).digest();
  var hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function handleAdminLogin(req, res) {
  if (!ADMIN_PASSWORD) {
    return sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ADMIN_PASSWORD ingesteld." });
  }
  var ip = clientIp(req);
  var wait = adminLockedFor(ip);
  if (wait) {
    return sendJSON(res, 429, { code: "rate_limited", retryAfterSec: wait, message: "Te veel mislukte pogingen. Probeer het over " + Math.ceil(wait / 60) + " min opnieuw." });
  }
  readBody(req).then(function (body) {
    var password = body && body.password;
    if (typeof password !== "string" || !safeEqual(password, ADMIN_PASSWORD)) {
      adminRegisterFail(ip);
      auditLog(req, "admin.login-mislukt", null, null);
      return sendJSON(res, 401, { code: "unauthorized", message: "Onjuist wachtwoord." });
    }
    adminFails.delete(ip);
    auditLog(req, "admin.login", null, null);
    sendJSON(res, 200, { token: issueAdminToken() });
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

// ---- opslag-hulpjes voor logboeken en lijsten ----
var AUDIT_CAP = 3000;
function cappedInsert(collection, storeKey, entry, cap) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      store[storeKey] = store[storeKey] || [];
      store[storeKey].push(entry);
      if (store[storeKey].length > cap) store[storeKey] = store[storeKey].slice(-cap);
      saveStore(store);
      return;
    }
    return db.collection(collection).insertOne(Object.assign({}, entry)).then(function () {
      return db.collection(collection).countDocuments().then(function (count) {
        if (count <= cap) return;
        return db.collection(collection).find().sort({ ts: 1 }).limit(count - cap).toArray().then(function (oldest) {
          return db.collection(collection).deleteMany({ _id: { $in: oldest.map(function (d) { return d._id; }) } });
        });
      });
    });
  });
}
function cappedReadAll(collection, storeKey, limit) {
  return mongoReady.then(function (db) {
    if (!db) return (loadStore()[storeKey] || []).slice(-limit).reverse();
    return db.collection(collection).find().sort({ ts: -1 }).limit(limit).toArray();
  });
}
function auditLog(req, action, target, detail) {
  var entry = { ts: new Date().toISOString(), action: action, target: target || null, detail: detail || null, ip: req ? clientIp(req) : null };
  return cappedInsert("audit", "audit", entry, AUDIT_CAP).catch(function () {});
}
function dbListDocs(prefix) {
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      return Object.keys(store.docs).filter(function (k) { return k.indexOf(prefix) === 0; }).map(function (k) { return { path: k, value: store.docs[k] }; });
    }
    var rx = "^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return db.collection("docs").find({ _id: { $regex: rx } }).toArray().then(function (docs) {
      return docs.map(function (d) { return { path: d._id, value: d.value }; });
    });
  });
}
function dayKeyOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
function lastDayKeys(n) {
  var keys = [];
  for (var i = n - 1; i >= 0; i--) keys.push(dayKeyOf(Date.now() - i * DAY_MS));
  return keys;
}
function getUsageHistory(n) {
  var keys = lastDayKeys(n);
  return mongoReady.then(function (db) {
    if (!db) {
      var store = loadStore();
      return keys.map(function (k) { return { day: k, count: (store.usage && store.usage[k]) || 0 }; });
    }
    return db.collection("usage").find({ _id: { $in: keys } }).toArray().then(function (docs) {
      var m = {};
      docs.forEach(function (d) { m[d._id] = d.count; });
      return keys.map(function (k) { return { day: k, count: m[k] || 0 }; });
    });
  });
}
function mapLimit(items, limit, fn) {
  var results = new Array(items.length), next = 0;
  function worker() {
    if (next >= items.length) return Promise.resolve();
    var i = next++;
    return fn(items[i], i).then(function (r) { results[i] = r; return worker(); });
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  return Promise.all(workers).then(function () { return results; });
}
function intParam(q, name, def, min, max) {
  var v = parseInt(q.get(name) || "", 10);
  if (!isFinite(v)) v = def;
  return Math.max(min, Math.min(max, v));
}
function paginate(rows, q, defSize) {
  var pageSize = intParam(q, "pageSize", defSize || 25, 1, 200);
  var pages = Math.max(1, Math.ceil(rows.length / pageSize));
  var page = Math.min(intParam(q, "page", 1, 1, 100000), pages);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page: page, pageSize: pageSize, pages: pages, total: rows.length };
}
function csvCell(v) {
  var s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                 // voorkomt dat een spreadsheet tekst als formule uitvoert
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, columns) {
  return [columns.join(",")].concat(rows.map(function (r) { return columns.map(function (c) { return csvCell(r[c]); }).join(","); })).join("\r\n") + "\r\n";
}
function parseDateBound(v, endOfDay) {
  if (!v) return null;
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
  var t = Date.parse(s);
  return isFinite(t) ? t : null;
}

// ---- gebruikers: overzicht ----
var summariesCache = { value: null, expiry: 0 };
function invalidateSummaries() { summariesCache = { value: null, expiry: 0 }; }

function latestTimestamp(a, b) {
  var ta = a ? Date.parse(a) : NaN, tb = b ? Date.parse(b) : NaN;
  if (!isFinite(ta) && !isFinite(tb)) return null;
  return (isFinite(ta) && (!isFinite(tb) || ta >= tb)) ? a : b;
}
// Bouwt het overzicht van één gebruiker (leest de vier documenten van die gebruiker).
function buildSummary(account, blocked, noteDoc) {
  var uid = account.uid;
  return Promise.all([
    dbGetDoc("data/users/" + uid + "/prefs"), dbGetDoc("data/users/" + uid + "/dishes"),
    dbGetDoc("data/users/" + uid + "/plannedWeeks"), dbGetDoc("data/users/" + uid + "/meta")
  ]).then(function (res) {
    var prefs = res[0].exists && res[0].value && typeof res[0].value === "object" ? res[0].value : null;
    var dishes = res[1].exists ? res[1].value : null;
    var weeks = res[2].exists ? res[2].value : null;
    var meta = res[3].exists && res[3].value ? res[3].value : null;
    var dishCount = 0;
    if (dishes && typeof dishes === "object") Object.keys(dishes).forEach(function (mt) { dishCount += Array.isArray(dishes[mt]) ? dishes[mt].length : 0; });
    var acc = account.account || null;
    var weekList = weeks && Array.isArray(weeks.list) ? weeks.list : (Array.isArray(weeks) ? weeks : []);
    return {
      uid: uid,
      email: account.email || null,
      type: account.email ? "account" : "anon",
      name: prefs && typeof prefs.name === "string" ? prefs.name.slice(0, 40) : null,
      goal: prefs ? prefs.goal || null : null,
      dietStyle: prefs ? prefs.dietStyle || null : null,
      level: prefs ? prefs.level || null : null,
      dishCount: dishCount,
      plannedWeekCount: weekList.length,
      lastSeenAt: latestTimestamp(meta ? meta.lastSeenAt : null, acc ? acc.lastLoginAt : null),   // laatst actief: gegevens bewaard of ingelogd
      lastIp: meta ? meta.lastIp || null : null,
      createdAt: acc ? acc.createdAt || null : null,
      createdBy: acc ? acc.createdBy || null : null,
      upgradedFrom: acc ? acc.upgradedFrom || null : null,
      lastLoginAt: acc ? acc.lastLoginAt || null : null,
      loginCount: acc ? acc.loginCount || 0 : 0,
      disabled: !!blocked.uids[uid],
      disabledAt: blocked.uids[uid] ? blocked.uids[uid].at || null : null,
      disabledReason: blocked.uids[uid] ? blocked.uids[uid].reason || "" : "",
      note: noteDoc && noteDoc.note ? noteDoc.note : ""
    };
  });
}
// Het overzicht van iedereen; wordt 15 seconden onthouden zodat zoeken en bladeren de opslag niet belast.
function loadUserSummaries() {
  if (summariesCache.value && Date.now() < summariesCache.expiry) return Promise.resolve(summariesCache.value);
  return Promise.all([dbListUserIds(), getBlocked(), dbListDocs("adminMeta/")]).then(function (r) {
    var blocked = r[1], notes = {};
    r[2].forEach(function (d) { notes[d.path.slice("adminMeta/".length)] = d.value; });
    var accounts = r[0].filter(function (a) { return a && a.uid; });
    return mapLimit(accounts, 20, function (account) { return buildSummary(account, blocked, notes[account.uid]); });
  }).then(function (list) {
    summariesCache = { value: list, expiry: Date.now() + 15000 };
    return list;
  });
}
// Eén gebruiker, altijd vers (voor detail, wijzigen en acties).
function loadSummaryFresh(uid) {
  return Promise.all([dbListUserIds(), getBlocked(), dbGetDoc("adminMeta/" + uid)]).then(function (r) {
    var account = r[0].filter(function (a) { return a && a.uid === uid; })[0];
    return account ? buildSummary(account, r[1], r[2].exists ? r[2].value : null) : null;
  });
}
function findSummary(uid) {
  return loadUserSummaries().then(function (list) { return list.filter(function (u) { return u.uid === uid; })[0] || null; });
}
function needSummary(uid) {
  return loadSummaryFresh(uid).then(function (u) {
    if (!u) throw HttpError(404, "not_found", "Gebruiker niet gevonden.");
    return u;
  });
}
function withLocation(u) {
  if (!u.lastIp) return Promise.resolve(Object.assign({}, u, { location: null }));
  var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 2500); });
  return Promise.race([resolveIpLocation(u.lastIp), timeout]).then(function (loc) { return Object.assign({}, u, { location: loc }); });
}
function filterUsers(list, q) {
  var text = (q.get("q") || "").trim().toLowerCase();
  var type = q.get("type") || "all", status = q.get("status") || "all";
  var goal = q.get("goal") || "", diet = q.get("diet") || "", active = q.get("active") || "", created = q.get("created") || "";
  var now = Date.now();
  function within(ts, days) { var t = ts ? Date.parse(ts) : NaN; return isFinite(t) && now - t <= days * DAY_MS; }
  return list.filter(function (u) {
    if (type === "account" && u.type !== "account") return false;
    if (type === "anon" && u.type !== "anon") return false;
    if (status === "active" && u.disabled) return false;
    if (status === "disabled" && !u.disabled) return false;
    if (goal && u.goal !== goal) return false;
    if (diet && u.dietStyle !== diet) return false;
    if (active === "24h" && !within(u.lastSeenAt, 1)) return false;
    if (active === "7d" && !within(u.lastSeenAt, 7)) return false;
    if (active === "30d" && !within(u.lastSeenAt, 30)) return false;
    if (active === "inactive30" && within(u.lastSeenAt, 30)) return false;
    if (created === "7d" && !within(u.createdAt, 7)) return false;
    if (created === "30d" && !within(u.createdAt, 30)) return false;
    if (text) {
      var hay = [u.email, u.name, u.uid, u.note, u.lastIp, u.goal, u.dietStyle].join(" ").toLowerCase();
      if (hay.indexOf(text) === -1) return false;
    }
    return true;
  });
}
function sortUsers(rows, q) {
  var sort = q.get("sort") || "lastSeen";
  var textCols = { name: "name", email: "email" };
  var numCols = { dishes: "dishCount", weeks: "plannedWeekCount", logins: "loginCount" };
  var dateCols = { lastSeen: "lastSeenAt", created: "createdAt", lastLogin: "lastLoginAt" };
  var dir = q.get("dir") || (textCols[sort] ? "asc" : "desc");
  var mul = dir === "asc" ? 1 : -1;
  rows.sort(function (a, b) {
    var x, y;
    if (textCols[sort]) { x = String(a[textCols[sort]] || "").toLowerCase(); y = String(b[textCols[sort]] || "").toLowerCase(); if (!x && y) return 1; if (x && !y) return -1; return x < y ? -mul : x > y ? mul : 0; }
    if (numCols[sort]) { x = a[numCols[sort]] || 0; y = b[numCols[sort]] || 0; return (x - y) * mul; }
    var col = dateCols[sort] || "lastSeenAt";
    x = a[col] ? Date.parse(a[col]) : 0; y = b[col] ? Date.parse(b[col]) : 0;
    return (x - y) * mul;
  });
  return rows;
}

function handleAdminUserList(req, res, url) {
  var q = url.searchParams;
  return loadUserSummaries().then(function (list) {
    var rows = sortUsers(filterUsers(list, q), q);
    var pg = paginate(rows, q, 25);
    var goals = {}, diets = {};
    list.forEach(function (u) { if (u.goal) goals[u.goal] = true; if (u.dietStyle) diets[u.dietStyle] = true; });
    return mapLimit(pg.rows, 5, withLocation).then(function (users) {
      sendJSON(res, 200, {
        users: users, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages,
        counts: {
          all: list.length,
          accounts: list.filter(function (u) { return u.type === "account"; }).length,
          anon: list.filter(function (u) { return u.type === "anon"; }).length,
          disabled: list.filter(function (u) { return u.disabled; }).length
        },
        facets: { goals: Object.keys(goals).sort(), diets: Object.keys(diets).sort() }
      });
    });
  });
}

// ---- gebruikers: gegevens controleren en aanpassen ----
var PREF_MEALTYPES = ["Ontbijt", "Lunch", "Diner", "Snack"];
function numericPref(v, label, min, max, errors) {
  if (v === "" || v === null) return "";
  var n = Number(v);
  if (!isFinite(n) || n < min || n > max) { errors.push(label + " moet tussen " + min + " en " + max + " liggen (of leeg zijn)."); return undefined; }
  return String(n);
}
function stringList(v, label, max, errors) {
  if (!Array.isArray(v) || v.length > 40) { errors.push(label + " moet een lijst van maximaal 40 items zijn."); return undefined; }
  return v.map(function (x) { return cleanText(x, max); }).filter(Boolean);
}
function sanitizePrefsPatch(patch) {
  var clean = {}, errors = [], ignored = [];
  Object.keys(patch && typeof patch === "object" ? patch : {}).forEach(function (k) {
    var v = patch[k], r;
    switch (k) {
      case "name": clean.name = cleanText(v, 40); break;
      case "level": case "activityLevel": case "dietStyle": clean[k] = cleanText(v, 40); break;
      case "gender": clean.gender = cleanText(v, 20); break;
      case "exclude": clean.exclude = cleanText(v, 300); break;
      case "bringListLink": clean.bringListLink = cleanText(v, 500); break;
      case "familyMode": clean.familyMode = v === true; break;
      case "goal":
        if (typeof v !== "string" || !GOAL_TARGETS[v]) errors.push("Onbekend doel: " + cleanText(v, 60) + "."); else clean.goal = v;
        break;
      case "count":
        if (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 14) errors.push("Aantal gerechten moet een geheel getal van 1 tot en met 14 zijn."); else clean.count = Number(v);
        break;
      case "heightCm": r = numericPref(v, "Lengte", 100, 250, errors); if (r !== undefined) clean.heightCm = r; break;
      case "weightKg": r = numericPref(v, "Gewicht", 30, 300, errors); if (r !== undefined) clean.weightKg = r; break;
      case "age": r = numericPref(v, "Leeftijd", 10, 100, errors); if (r !== undefined) clean.age = r; break;
      case "cuisines": case "flavors": case "equipment":
        r = stringList(v, k, 40, errors); if (r !== undefined) clean[k] = r; break;
      case "mealTypes":
        r = stringList(v, "Maaltijdsoorten", 20, errors);
        if (r !== undefined) {
          if (r.some(function (x) { return PREF_MEALTYPES.indexOf(x) === -1; })) errors.push("Maaltijdsoorten mogen alleen " + PREF_MEALTYPES.join(", ") + " zijn.");
          else clean.mealTypes = r;
        }
        break;
      default: ignored.push(k);
    }
  });
  return { clean: clean, errors: errors, ignored: ignored };
}
function randomPassword() { return crypto.randomBytes(9).toString("base64url"); }
function createResetLink(req, email) {
  var token = crypto.randomBytes(24).toString("hex");
  return dbGetDoc("auth/users/" + email).then(function (acc) {
    return dbSetDoc("auth/resets/" + token, { email: email, uid: acc.exists && acc.value ? acc.value.uid : undefined, expiresAt: Date.now() + RESET_TOKEN_TTL_MS, used: false });
  }).then(function () {
    return { token: token, link: "https://" + req.headers.host + "/?reset=" + token };
  });
}
function writeAdminMeta(uid, change) {
  return dbGetDoc("adminMeta/" + uid).then(function (r) {
    var meta = Object.assign({}, r.exists && r.value ? r.value : {}, change);
    if (!meta.note) delete meta.note;
    if (typeof meta.dishCap !== "number") delete meta.dishCap;
    return Object.keys(meta).length ? dbSetDoc("adminMeta/" + uid, meta) : dbDeleteDoc("adminMeta/" + uid);
  });
}
function writeAdminNote(uid, note) { return writeAdminMeta(uid, { note: cleanNote(note, 500) }); }
function mergePrefs(uid, clean) {
  return dbGetDoc("data/users/" + uid + "/prefs").then(function (r) {
    var cur = r.exists && r.value && typeof r.value === "object" ? r.value : {};
    return dbSetDoc("data/users/" + uid + "/prefs", Object.assign({}, cur, clean));
  });
}
function requireBody(req) {
  return readBody(req).catch(function () { throw HttpError(400, "bad_request", "Ongeldige aanvraag."); });
}

function handleAdminUserCreate(req, res) {
  return requireBody(req).then(function (body) {
    var email = normalizeEmail(body.email);
    if (!EMAIL_RE.test(email) || email.length > 200) throw HttpError(400, "bad_request", "Vul een geldig e-mailadres in.");
    var generated = body.password === undefined || body.password === null || body.password === "";
    var password = generated ? randomPassword() : String(body.password);
    if (password.length < 8 || password.length > 200) throw HttpError(400, "bad_request", "Wachtwoord moet tussen 8 en 200 tekens zijn.");
    var patch = Object.assign({}, body.prefs && typeof body.prefs === "object" ? body.prefs : {});
    if (body.name !== undefined) patch.name = body.name;
    var pr = sanitizePrefsPatch(patch);
    if (pr.errors.length) throw HttpError(400, "bad_request", pr.errors.join(" "));
    return dbGetDoc("auth/users/" + email).then(function (existing) {
      if (existing.exists) throw HttpError(409, "conflict", "Er bestaat al een account met dit e-mailadres.");
      var uid = "u_" + crypto.randomBytes(12).toString("hex");
      var record = makePasswordRecord(password);
      return dbSetDoc("auth/users/" + email, { uid: uid, salt: record.salt, hash: record.hash, createdAt: new Date().toISOString(), createdBy: "admin", loginCount: 0 }).then(function () {
        var jobs = [];
        if (Object.keys(pr.clean).length) jobs.push(mergePrefs(uid, pr.clean));
        if (body.note) jobs.push(writeAdminNote(uid, body.note));
        return Promise.all(jobs);
      }).then(function () {
        invalidateSummaries();
        auditLog(req, "gebruiker.aanmaken", uid, { email: email, wachtwoord: generated ? "gegenereerd" : "opgegeven" });
        var out = { generated: generated };
        var mail = Promise.resolve();
        if (body.sendResetLink === true) {
          mail = createResetLink(req, email).then(function (r) {
            out.resetLink = r.link;
            return sendResetEmail(email, r.link).then(function () { out.emailSent = true; }, function (e) { out.emailSent = false; out.emailError = e.message; });
          });
        }
        return mail.then(function () { return needSummary(uid); }).then(function (user) {
          out.user = user;
          if (generated) out.password = password;   // wordt maar één keer getoond
          sendJSON(res, 200, out);
        });
      });
    });
  });
}

function handleAdminUserUpdate(req, res, uid) {
  return Promise.all([needSummary(uid), requireBody(req)]).then(function (r) {
    var user = r[0], body = r[1];
    var changes = [], sessionsOut = false;
    var patch = Object.assign({}, body.prefs && typeof body.prefs === "object" ? body.prefs : {});
    if (body.name !== undefined) patch.name = body.name;
    var pr = sanitizePrefsPatch(patch);
    if (pr.errors.length) throw HttpError(400, "bad_request", pr.errors.join(" "));

    var newEmail = null;
    if (body.email !== undefined && normalizeEmail(body.email) !== user.email) {
      if (user.type !== "account") throw HttpError(400, "bad_request", "Anonieme gebruikers hebben geen e-mailadres.");
      newEmail = normalizeEmail(body.email);
      if (!EMAIL_RE.test(newEmail) || newEmail.length > 200) throw HttpError(400, "bad_request", "Vul een geldig e-mailadres in.");
    }
    var newPassword = null;
    if (body.newPassword !== undefined && body.newPassword !== "") {
      if (user.type !== "account") throw HttpError(400, "bad_request", "Anonieme gebruikers hebben geen wachtwoord.");
      newPassword = String(body.newPassword);
      if (newPassword.length < 8 || newPassword.length > 200) throw HttpError(400, "bad_request", "Wachtwoord moet tussen 8 en 200 tekens zijn.");
    }
    if (body.note !== undefined && typeof body.note !== "string") throw HttpError(400, "bad_request", "De notitie moet tekst zijn.");
    var newDishCap;   // undefined = niet wijzigen, null = eigen limiet weghalen (algemene geldt weer)
    if (body.dishCap !== undefined) {
      if (body.dishCap === null || body.dishCap === "") newDishCap = null;
      else if (typeof body.dishCap === "number" && isFinite(body.dishCap) && Math.floor(body.dishCap) === body.dishCap && body.dishCap >= 0 && body.dishCap <= 100000) newDishCap = body.dishCap;
      else throw HttpError(400, "bad_request", "De limiet moet een geheel getal van 0 tot 100000 zijn (0 = onbeperkt), of leeg voor de algemene limiet.");
    }

    var step = Promise.resolve();
    if (newEmail || newPassword) {
      step = dbGetDoc("auth/users/" + user.email).then(function (acc) {
        if (!acc.exists) throw HttpError(404, "not_found", "Account niet gevonden.");
        var doc = Object.assign({}, acc.value);
        if (newPassword) { var rec = makePasswordRecord(newPassword); doc.salt = rec.salt; doc.hash = rec.hash; changes.push("wachtwoord"); }
        if (!newEmail) return dbSetDoc("auth/users/" + user.email, doc);
        return dbGetDoc("auth/users/" + newEmail).then(function (clash) {
          if (clash.exists) throw HttpError(409, "conflict", "Er bestaat al een account met dit e-mailadres.");
          return dbSetDoc("auth/users/" + newEmail, doc).then(function () {
            return dbDeleteDoc("auth/users/" + user.email);
          }).then(function () {
            return dbGetDoc("data/users/" + uid + "/meta");
          }).then(function (m) {
            if (m.exists && m.value) return dbSetDoc("data/users/" + uid + "/meta", Object.assign({}, m.value, { email: newEmail }));
          }).then(function () { changes.push("e-mailadres"); });
        });
      }).then(function () {
        sessionsOut = true;
        return updateBlocked(function (b) { b.invalidBefore[uid] = Date.now(); });
      });
    }
    return step.then(function () {
      var jobs = [];
      if (Object.keys(pr.clean).length) { jobs.push(mergePrefs(uid, pr.clean)); Object.keys(pr.clean).forEach(function (k) { changes.push("voorkeur: " + k); }); }
      var metaChange = {};   // notitie en eigen limiet staan in hetzelfde document: één schrijfactie, anders overschrijven ze elkaar
      if (body.note !== undefined && cleanNote(body.note, 500) !== user.note) { metaChange.note = cleanNote(body.note, 500); changes.push("notitie"); }
      if (newDishCap !== undefined) { metaChange.dishCap = newDishCap; changes.push("eigen limiet nieuwe gerechten"); }
      if (Object.keys(metaChange).length) jobs.push(writeAdminMeta(uid, metaChange));
      return Promise.all(jobs);
    }).then(function () {
      invalidateSummaries();
      if (changes.length) auditLog(req, "gebruiker.wijzigen", uid, { velden: changes, emailVan: newEmail ? user.email : undefined, emailNaar: newEmail || undefined, sessiesUitgelogd: sessionsOut });
      return needSummary(uid);
    }).then(function (updated) {
      sendJSON(res, 200, { user: updated, changes: changes, ignored: pr.ignored, sessionsSignedOut: sessionsOut });
    });
  });
}

function listsOfUser(uid) {
  return dbGetDoc("listsIndex/" + uid).then(function (r) {
    var tokens = r.exists && r.value && Array.isArray(r.value.tokens) ? r.value.tokens : [];
    return mapLimit(tokens, 5, function (t) {
      return dbGetDoc("lists/" + t).then(function (d) { return d.exists && d.value ? listSummary(t, d.value) : null; });
    }).then(function (arr) { return arr.filter(Boolean); });
  });
}
function listSummary(token, doc) {
  var c = listCounts(doc);
  return { token: token, title: doc.title, ownerUid: doc.ownerUid, itemCount: (doc.items || []).length, basket: c.basket, skip: c.skip,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null, updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt).toISOString() : null, expired: !!(doc.expiresAt && doc.expiresAt < Date.now()), rev: doc.rev || 1 };
}

function handleAdminUserDetail(req, res, uid) {
  return needSummary(uid).then(function (user) {
    return Promise.all([
      dbGetDoc("data/users/" + uid + "/prefs"), dbGetDoc("data/users/" + uid + "/dishes"), dbGetDoc("data/users/" + uid + "/plannedWeeks"),
      listsOfUser(uid), getRecentLogs(LOG_CAP), withLocation(user), quotaState(uid), getBillingDoc(uid)
    ]).then(function (r) {
      var logs = r[4].filter(function (l) { return l.uid === uid; }).slice(0, 50).map(cleanLogRow);
      var q = r[6];
      sendJSON(res, 200, {
        billing: adminBillingView(r[7]),
        quota: q ? { plan: q.plan, month: q.doc.month, dishes: q.doc.dishes, calls: q.doc.calls, tokensIn: q.doc.tokensIn, tokensOut: q.doc.tokensOut, costUsd: q.doc.costUsd, cap: q.cap, own: q.own } : null,
        user: r[5],
        prefs: r[0].exists ? r[0].value : null,
        dishes: r[1].exists ? r[1].value : null,
        plannedWeeks: r[2].exists ? r[2].value : null,
        lists: r[3],
        logs: logs
      });
    });
  });
}

function deleteUserEverywhere(user) {
  var uid = user.uid;
  return cancelBillingForDeletion(uid).then(function () {
    // Koppelingen met Apple/Google opruimen
    if (!user.email) return null;
    return dbGetDoc("auth/users/" + user.email).then(function (acc) {
      var prov = acc.exists && acc.value && acc.value.uid === uid && acc.value.providers ? acc.value.providers : {};
      return Promise.all(Object.keys(prov).map(function (k) { return dbDeleteDoc("auth/oauth/" + k + "_" + String(prov[k]).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200)); }));
    }).catch(function () {});
  }).then(function () { return dbGetDoc("listsIndex/" + uid); }).then(function (r) {
    var tokens = r.exists && r.value && Array.isArray(r.value.tokens) ? r.value.tokens : [];
    return Promise.all(tokens.map(function (t) { return dbDeleteDoc("lists/" + t); }));
  }).then(function () {
    var paths = ["data/users/" + uid + "/prefs", "data/users/" + uid + "/dishes", "data/users/" + uid + "/plannedWeeks", "data/users/" + uid + "/meta", "listsIndex/" + uid, "adminMeta/" + uid, "push/" + uid, "quota/" + uid, "billing/" + uid];
    if (user.email) paths.push("auth/users/" + user.email);
    return Promise.all(paths.map(dbDeleteDoc));
  }).then(function () {
    // Een verwijderd account houdt zijn 'ingetrokken'-stempel: zijn uid komt nooit terug, dus oude sessies blijven ongeldig.
    // Bij een anonieme gebruiker ruimen we alles op: dat ID is niet te controleren en kan gewoon opnieuw beginnen.
    return updateBlocked(function (b) {
      delete b.uids[uid];
      if (user.email) b.invalidBefore[uid] = Date.now(); else delete b.invalidBefore[uid];
    });
  }).then(function () { invalidateSummaries(); });
}

function handleAdminUserAction(req, res, uid, action) {
  return needSummary(uid).then(function (user) {
    return requireBody(req).then(function (body) {
      switch (action) {
        case "billing-grant": {
          var days = body.days;
          if (typeof days !== "number" || !isFinite(days) || Math.floor(days) !== days || days < 1 || days > 3650) throw HttpError(400, "bad_request", "Vul een aantal dagen in tussen 1 en 3650.");
          return withBillingLock(uid, function () {
            return getBillingDoc(uid).then(function (doc) {
              doc.grantUntil = Math.max(Date.now(), doc.grantUntil || 0) + days * DAY_MS;
              pushHistory(doc, { status: "cadeau +" + days + " dagen" });
              return dbSetDoc("billing/" + uid, doc).then(function () { return doc; });
            });
          }).then(function (doc) {
            invalidateSummaries(); auditLog(req, "gebruiker.plus-geven", uid, { email: user.email, dagen: days, tot: new Date(doc.grantUntil).toISOString() });
            sendJSON(res, 200, { billing: adminBillingView(doc) });
          });
        }
        case "billing-revoke":
          return withBillingLock(uid, function () {
            return getBillingDoc(uid).then(function (doc) {
              delete doc.grantUntil; pushHistory(doc, { status: "cadeau ingetrokken" });
              return dbSetDoc("billing/" + uid, doc).then(function () { return doc; });
            });
          }).then(function (doc) {
            invalidateSummaries(); auditLog(req, "gebruiker.plus-intrekken", uid, { email: user.email });
            sendJSON(res, 200, { billing: adminBillingView(doc) });
          });
        case "billing-cancel":
          return cancelSubscriptionFor(uid).then(function (r) {
            if (!r.changed) throw HttpError(409, "conflict", "Deze gebruiker heeft geen lopend abonnement om op te zeggen.");
            auditLog(req, "gebruiker.abonnement-opzeggen", uid, { email: user.email });
            sendJSON(res, 200, { billing: adminBillingView(r.doc) });
          });
        case "disable":
          return updateBlocked(function (b) { b.uids[uid] = { at: new Date().toISOString(), reason: cleanText(body.reason, 200) }; }).then(function () {
            invalidateSummaries(); auditLog(req, "gebruiker.blokkeren", uid, { email: user.email, reden: cleanText(body.reason, 200) || undefined });
            sendJSON(res, 200, { ok: true });
          });
        case "enable":
          return updateBlocked(function (b) { delete b.uids[uid]; }).then(function () {
            invalidateSummaries(); auditLog(req, "gebruiker.deblokkeren", uid, { email: user.email });
            sendJSON(res, 200, { ok: true });
          });
        case "logout":
          return updateBlocked(function (b) { b.invalidBefore[uid] = Date.now(); }).then(function () {
            auditLog(req, "gebruiker.uitloggen", uid, { email: user.email });
            sendJSON(res, 200, { ok: true });
          });
        case "reset-password": {
          if (user.type !== "account") throw HttpError(400, "bad_request", "Anonieme gebruikers hebben geen wachtwoord.");
          var generated = body.password === undefined || body.password === null || body.password === "";
          var password = generated ? randomPassword() : String(body.password);
          if (password.length < 8 || password.length > 200) throw HttpError(400, "bad_request", "Wachtwoord moet tussen 8 en 200 tekens zijn.");
          return dbGetDoc("auth/users/" + user.email).then(function (acc) {
            var rec = makePasswordRecord(password);
            return dbSetDoc("auth/users/" + user.email, Object.assign({}, acc.value, { salt: rec.salt, hash: rec.hash }));
          }).then(function () {
            return updateBlocked(function (b) { b.invalidBefore[uid] = Date.now(); });
          }).then(function () {
            auditLog(req, "gebruiker.wachtwoord-resetten", uid, { email: user.email, wachtwoord: generated ? "gegenereerd" : "opgegeven" });
            sendJSON(res, 200, generated ? { ok: true, password: password } : { ok: true });
          });
        }
        case "reset-link": {
          if (user.type !== "account") throw HttpError(400, "bad_request", "Anonieme gebruikers hebben geen wachtwoord.");
          return createResetLink(req, user.email).then(function (r) {
            var out = { link: r.link, expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000) };
            var mail = Promise.resolve();
            if (body.send === true) {
              mail = sendResetEmail(user.email, r.link).then(function () { out.emailSent = true; }, function (e) { out.emailSent = false; out.emailError = e.message; });
            }
            return mail.then(function () {
              auditLog(req, "gebruiker.resetlink", uid, { email: user.email, verstuurd: body.send === true ? out.emailSent === true : false });
              sendJSON(res, 200, out);
            });
          });
        }
        case "clear-data": {
          var what = body.what;
          var map = { dishes: ["dishes"], plannedWeeks: ["plannedWeeks"], prefs: ["prefs"], all: ["dishes", "plannedWeeks", "prefs"] };
          if (!map[what]) throw HttpError(400, "bad_request", "Kies wat er gewist moet worden: dishes, plannedWeeks, prefs of all.");
          return Promise.all(map[what].map(function (sp) { return dbDeleteDoc("data/users/" + uid + "/" + sp); })).then(function () {
            invalidateSummaries(); auditLog(req, "gebruiker.gegevens-wissen", uid, { wat: what });
            sendJSON(res, 200, { ok: true });
          });
        }
        case "delete": {
          var expected = user.email || user.uid;
          if (body.confirm !== expected) throw HttpError(400, "confirm_required", "Bevestig het verwijderen door het e-mailadres (of de uid) exact in te vullen.");
          return deleteUserEverywhere(user).then(function () {
            auditLog(req, "gebruiker.verwijderen", uid, { email: user.email, type: user.type });
            sendJSON(res, 200, { ok: true });
          });
        }
        default:
          throw HttpError(404, "not_found", "Onbekende actie.");
      }
    });
  });
}

function handleAdminUserExport(req, res, uid) {
  return needSummary(uid).then(function (user) {
    return Promise.all([
      dbGetDoc("data/users/" + uid + "/prefs"), dbGetDoc("data/users/" + uid + "/dishes"), dbGetDoc("data/users/" + uid + "/plannedWeeks"),
      dbListDocs("lists/")
    ]).then(function (r) {
      var lists = r[3].filter(function (d) { return d.value && d.value.ownerUid === uid; }).map(function (d) { return { token: d.path.slice(6), title: d.value.title, items: d.value.items, state: d.value.state, createdAt: d.value.createdAt, updatedAt: d.value.updatedAt }; });
      var data = JSON.stringify({ exportedAt: new Date().toISOString(), user: user, prefs: r[0].exists ? r[0].value : null, dishes: r[1].exists ? r[1].value : null, plannedWeeks: r[2].exists ? r[2].value : null, sharedLists: lists }, null, 2);
      auditLog(req, "gebruiker.exporteren", uid, { email: user.email });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": "attachment; filename=\"balanza-" + uid + ".json\"", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(data) });
      res.end(data);
    });
  });
}

function handleAdminUserBulk(req, res) {
  return requireBody(req).then(function (body) {
    var uids = Array.isArray(body.uids) ? body.uids.filter(function (u) { return typeof u === "string"; }) : [];
    var action = body.action;
    if (!uids.length || uids.length > 200) throw HttpError(400, "bad_request", "Kies tussen 1 en 200 gebruikers.");
    if (["disable", "enable", "logout", "delete"].indexOf(action) === -1) throw HttpError(400, "bad_request", "Onbekende actie.");
    if (action === "delete" && body.confirm !== "VERWIJDEREN") throw HttpError(400, "confirm_required", "Bevestig het verwijderen door VERWIJDEREN in te vullen.");
    return loadUserSummaries().then(function (list) {
      var byUid = {};
      list.forEach(function (u) { byUid[u.uid] = u; });
      var found = uids.filter(function (u) { return byUid[u]; });
      var missing = uids.filter(function (u) { return !byUid[u]; });
      var step = Promise.resolve();
      if (action === "disable") step = updateBlocked(function (b) { found.forEach(function (u) { b.uids[u] = { at: new Date().toISOString(), reason: cleanText(body.reason, 200) }; }); });
      else if (action === "enable") step = updateBlocked(function (b) { found.forEach(function (u) { delete b.uids[u]; }); });
      else if (action === "logout") step = updateBlocked(function (b) { found.forEach(function (u) { b.invalidBefore[u] = Date.now(); }); });
      else step = mapLimit(found, 3, function (u) { return deleteUserEverywhere(byUid[u]); });
      return step.then(function () {
        invalidateSummaries();
        auditLog(req, "gebruikers.bulk-" + action, null, { aantal: found.length, uids: found.slice(0, 50) });
        sendJSON(res, 200, { ok: true, done: found.length, missing: missing });
      });
    });
  });
}

// ---- logboek ----
function logType(l) { return l.type || (l.action === "tips" ? "tips" : "generate"); }
function cleanLogRow(l) {
  var o = Object.assign({}, l);
  delete o._id;
  o.type = logType(l);
  return o;
}
function handleAdminLogs(req, res, url) {
  var q = url.searchParams;
  return getRecentLogs(LOG_CAP).then(function (raw) {
    var all = raw.map(cleanLogRow);
    var text = (q.get("q") || "").trim().toLowerCase();
    var type = q.get("type") || "", status = q.get("status") || "", action = q.get("action") || "";
    var uid = (q.get("uid") || "").trim(), ip = (q.get("ip") || "").trim();
    var from = parseDateBound(q.get("from"), false), to = parseDateBound(q.get("to"), true);
    var minMs = parseInt(q.get("minMs") || "", 10);
    var rows = all.filter(function (l) {
      if (type && l.type !== type) return false;
      if (status === "ok" && !l.ok) return false;
      if (status === "error" && l.ok) return false;
      if (action && l.action !== action) return false;
      if (uid && l.uid !== uid) return false;
      if (ip && l.ip !== ip) return false;
      var t = Date.parse(l.ts);
      if (from !== null && !(t >= from)) return false;
      if (to !== null && !(t <= to)) return false;
      if (isFinite(minMs) && !((l.durationMs || 0) >= minMs)) return false;
      if (text && [l.type, l.action, l.error, l.ip, l.uid, l.email, l.status].join(" ").toLowerCase().indexOf(text) === -1) return false;
      return true;
    });
    rows.sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); });
    if (q.get("format") === "csv") {
      var csv = toCsv(rows, ["ts", "type", "action", "ok", "status", "durationMs", "error", "uid", "email", "ip"]);
      auditLog(req, "logboek.exporteren", null, { rijen: rows.length });
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=\"balanza-logboek.csv\"", "Cache-Control": "no-store" });
      return res.end("\uFEFF" + csv);
    }
    var types = {}, actions = {};
    all.forEach(function (l) { types[l.type] = (types[l.type] || 0) + 1; actions[l.action || "onbekend"] = (actions[l.action || "onbekend"] || 0) + 1; });
    var pg = paginate(rows, q, 50);
    sendJSON(res, 200, { logs: pg.rows, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages, capped: all.length >= LOG_CAP, facets: { types: types, actions: actions } });
  });
}

function handleAdminAudit(req, res, url) {
  var q = url.searchParams;
  return cappedReadAll("audit", "audit", AUDIT_CAP).then(function (raw) {
    var all = raw.map(function (e) { var o = Object.assign({}, e); delete o._id; return o; });
    var text = (q.get("q") || "").trim().toLowerCase(), action = q.get("action") || "";
    var from = parseDateBound(q.get("from"), false), to = parseDateBound(q.get("to"), true);
    var rows = all.filter(function (e) {
      if (action && e.action !== action) return false;
      var t = Date.parse(e.ts);
      if (from !== null && !(t >= from)) return false;
      if (to !== null && !(t <= to)) return false;
      if (text && [e.action, e.target, e.ip, JSON.stringify(e.detail || {})].join(" ").toLowerCase().indexOf(text) === -1) return false;
      return true;
    });
    rows.sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); });
    var actions = {};
    all.forEach(function (e) { actions[e.action] = (actions[e.action] || 0) + 1; });
    var pg = paginate(rows, q, 50);
    sendJSON(res, 200, { entries: pg.rows, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages, facets: { actions: actions } });
  });
}

// ---- statistieken en systeemstatus ----
// Tokens en kosten uit de dagtellers: vandaag, deze maand, laatste 30 dagen, en wat een gerecht gemiddeld kost.
function aiCostSummary(docs, days14) {
  function zero() { return { n: 0, fail: 0, dishes: 0, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }; }
  function add(t, x) { Object.keys(t).forEach(function (k) { t[k] += x[k] || 0; }); }
  var today = todayKey(), month = monthKey(), from30 = new Date(Date.now() - 29 * DAY_MS).toISOString().slice(0, 10);
  var out = { today: zero(), month: zero(), last30: zero(), byAction30: {}, perDay: {}, perDish: null, callsPerRequest: {}, prices: { inPerM: PRICE_IN_PER_M, outPerM: PRICE_OUT_PER_M }, monthKey: month };
  var dishCost = 0, dishCount = 0, gen = zero();
  (docs || []).forEach(function (d) {
    var day = d.path.slice("tokenUsage/".length), by = d.value && d.value.byAction || {};
    Object.keys(by).forEach(function (a) {
      if (day === today) add(out.today, by[a]);
      if (day.slice(0, 7) === month) add(out.month, by[a]);
      if (day >= from30) {
        add(out.last30, by[a]);
        out.byAction30[a] = out.byAction30[a] || zero(); add(out.byAction30[a], by[a]);
        if (DISH_ACTIONS[a]) { dishCost += by[a].costUsd || 0; dishCount += by[a].dishes || 0; }
      }
      out.perDay[day] = round6((out.perDay[day] || 0) + (by[a].costUsd || 0));
    });
  });
  ["generate", "background", "variation", "prep", "price", "tips"].forEach(function (a) {
    var x = out.byAction30[a]; if (x && x.n) out.callsPerRequest[a] = Math.round(x.calls / x.n * 100) / 100;
  });
  out.perDish = dishCount ? round6(dishCost / dishCount) : null;
  out.perDay = days14.map(function (d) { return { day: d, costUsd: out.perDay[d] || 0 }; });
  [out.today, out.month, out.last30].forEach(function (t) { t.costUsd = round6(t.costUsd); });
  return out;
}
function handleAdminStats(req, res) {
  return Promise.all([loadUserSummaries(), getUsageToday(), getUsageHistory(14), getRecentLogs(LOG_CAP), dbListDocs("lists/"), getSettings(), dbListDocs("tokenUsage/")]).then(function (r) {
    var users = r[0], logs = r[3].map(cleanLogRow), now = Date.now();
    function within(ts, days) { var t = ts ? Date.parse(ts) : NaN; return isFinite(t) && now - t <= days * DAY_MS; }
    var accounts = users.filter(function (u) { return u.type === "account"; });
    var today = todayKey(), days = lastDayKeys(14);
    var ai = logs.filter(function (l) { return l.type === "generate" || l.type === "tips"; });
    var todays = ai.filter(function (l) { return l.ts && l.ts.slice(0, 10) === today; });
    var durations = todays.map(function (l) { return l.durationMs || 0; }).sort(function (a, b) { return a - b; });
    var byAction = {};
    todays.forEach(function (l) { var a = l.action || "onbekend"; byAction[a] = (byAction[a] || 0) + 1; });
    var perDay = days.map(function (d) {
      var rows = ai.filter(function (l) { return l.ts && l.ts.slice(0, 10) === d; });
      return { day: d, total: rows.length, errors: rows.filter(function (l) { return !l.ok; }).length };
    });
    var authToday = logs.filter(function (l) { return l.type === "auth" && l.ts && l.ts.slice(0, 10) === today; });
    var lists = r[4];
    sendJSON(res, 200, {
      generatedAt: new Date().toISOString(),
      users: {
        total: users.length, accounts: accounts.length, anon: users.length - accounts.length, disabled: users.filter(function (u) { return u.disabled; }).length,
        new7d: accounts.filter(function (u) { return within(u.createdAt, 7); }).length, new30d: accounts.filter(function (u) { return within(u.createdAt, 30); }).length,
        active24h: users.filter(function (u) { return within(u.lastSeenAt, 1); }).length, active7d: users.filter(function (u) { return within(u.lastSeenAt, 7); }).length, active30d: users.filter(function (u) { return within(u.lastSeenAt, 30); }).length
      },
      usage: { today: r[1], cap: liveLimits.dailyGenerateCap, history: r[2] },
      ai: aiCostSummary(r[6], days),
      requests: {
        today: todays.length, errorsToday: todays.filter(function (l) { return !l.ok; }).length,
        errorRate: todays.length ? Math.round(todays.filter(function (l) { return !l.ok; }).length / todays.length * 1000) / 10 : 0,
        avgDurationMs: durations.length ? Math.round(durations.reduce(function (s, d) { return s + d; }, 0) / durations.length) : 0,
        p95DurationMs: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0,
        byAction: byAction, perDay: perDay,
        recentErrors: ai.filter(function (l) { return !l.ok; }).sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); }).slice(0, 8)
      },
      auth: {
        loginsToday: authToday.filter(function (l) { return l.action === "login" && l.ok; }).length,
        failedLoginsToday: authToday.filter(function (l) { return l.action === "login" && !l.ok; }).length,
        registrationsToday: authToday.filter(function (l) { return (l.action === "register" || l.action === "upgrade") && l.ok; }).length
      },
      lists: { total: lists.length, active: lists.filter(function (d) { return !(d.value && d.value.expiresAt && d.value.expiresAt < now); }).length },
      logCapped: logs.length >= LOG_CAP,
      maintenance: r[5].maintenance.enabled
    });
  });
}

var SERVER_STARTED_AT = new Date().toISOString();
function handleAdminSystem(req, res) {
  var t0 = Date.now();
  return dbGetDoc("settings/app").then(function () { return { ok: true, ms: Date.now() - t0 }; }, function (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }).then(function (storage) {
    return Promise.all([getVapidKeys().then(function (k) { return { ok: true, source: k.source }; }, function (e) { return { ok: false, error: e.message }; }), getSettings()]).then(function (r) { return { storage: storage, push: r[0], settings: r[1] }; });
  }).then(function (both) {
    var storage = both.storage, pushInfo = both.push, billingEnabled = both.settings.billing.enabled, benv = billingEnvInfo();
    var mem = process.memoryUsage();
    var checks = [
      { key: "storage", label: "Opslag", ok: storage.ok && mongoConnected, detail: (mongoConnected ? "MongoDB (blijvend)" : "Lokaal bestand: data gaat verloren bij een herstart of nieuwe deploy") + (storage.ok ? ", antwoordtijd " + storage.ms + " ms" : ", FOUT: " + storage.error) },
      { key: "anthropic", label: "AI-sleutel (ANTHROPIC_API_KEY)", ok: !!ANTHROPIC_API_KEY, detail: ANTHROPIC_API_KEY ? "ingesteld" : "niet ingesteld: genereren werkt niet" },
      { key: "adminPassword", label: "Beheerderswachtwoord", ok: ADMIN_PASSWORD.length >= 12, detail: ADMIN_PASSWORD.length >= 12 ? "sterk genoeg" : "korter dan 12 tekens: kies een langer wachtwoord (ADMIN_PASSWORD)" },
      { key: "sessionSecret", label: "Sessiegeheim (SESSION_SECRET)", ok: !!process.env.SESSION_SECRET, detail: process.env.SESSION_SECRET ? "vast ingesteld" : "niet ingesteld: iedereen wordt uitgelogd bij een herstart" },
      { key: "unsplash", label: "Foto's (UNSPLASH_ACCESS_KEY)", ok: !!UNSPLASH_ACCESS_KEY, optional: true, detail: UNSPLASH_ACCESS_KEY ? "ingesteld" : "niet ingesteld: gerechten krijgen geen foto" },
      { key: "webPush", label: "Meldingen (Web Push)", ok: pushInfo.ok && (pushInfo.source === "env" || mongoConnected), optional: true, detail: !pushInfo.ok ? "niet beschikbaar: " + pushInfo.error : pushInfo.source === "env" ? "sleutels uit de omgeving (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)" : mongoConnected ? "sleutels bewaard in de database" : "sleutels staan alleen in het lokale bestand en verdwijnen bij een herstart: stel VAPID_PUBLIC_KEY en VAPID_PRIVATE_KEY in" },
      { key: "billing", label: "Betalingen (Mollie)", ok: benv.keyPresent && benv.baseOk, optional: !billingEnabled, detail: !benv.keyPresent ? "MOLLIE_API_KEY staat niet ingesteld" + (billingEnabled ? "" : " (abonnementen staan uit)") : !benv.baseOk ? "PUBLIC_BASE_URL ontbreekt of is ongeldig (verwacht https://jouw-adres, zonder slash); Mollie heeft dat nodig voor de webhook" : (benv.mode === "live" ? "LIVE-sleutel" : benv.mode === "test" ? "testsleutel: er wordt niet echt afgeschreven" : "sleutel met een onbekend formaat") + " · webhook: " + benv.webhookUrl + (billingEnabled ? " · abonnementen staan aan" : " · abonnementen staan uit") },
      { key: "oauthApple", label: "Inloggen met Apple (APPLE_CLIENT_ID)", ok: OAUTH_PROVIDERS.apple.enabled(), optional: true, detail: OAUTH_PROVIDERS.apple.enabled() ? "ingesteld · terugkeer-URL: " + (PUBLIC_BASE_URL || "<jouw adres>") + "/api/auth/oauth/apple/callback" : "niet ingesteld: de Apple-knop is verborgen" },
      { key: "oauthGoogle", label: "Inloggen met Google (GOOGLE_CLIENT_ID/SECRET)", ok: OAUTH_PROVIDERS.google.enabled(), optional: true, detail: OAUTH_PROVIDERS.google.enabled() ? "ingesteld · terugkeer-URL: " + (PUBLIC_BASE_URL || "<jouw adres>") + "/api/auth/oauth/google/callback" : "niet ingesteld: de Google-knop is verborgen" },
      { key: "resend", label: "E-mail (RESEND_API_KEY)", ok: !!RESEND_API_KEY, optional: true, detail: RESEND_API_KEY ? "ingesteld" : "niet ingesteld: geen wachtwoord-vergeten-mails of uitnodigingen per e-mail" },
      { key: "nevo", label: "Voedingswaarden (NEVO)", ok: nevoAvailable(), optional: true, detail: nevoAvailable() ? nevoLoad().list.length + " producten geladen · " + NEVO_VERSION : "nevo/nevo2025_macros.json ontbreekt of is leeg: macro's worden alleen nog door de AI geschat" }
    ];
    sendJSON(res, 200, {
      checks: checks,
      info: {
        node: process.version, startedAt: SERVER_STARTED_AT, uptimeSec: Math.round(process.uptime()), serverTime: new Date().toISOString(),
        memoryMb: Math.round(mem.rss / 1048576), storage: mongoConnected ? "mongodb" : "file", model: ANTHROPIC_MODEL, tipsModel: TIPS_MODEL,
        bringEndpoint: BRING_IMPORT_ENDPOINT, logCap: LOG_CAP, auditCap: AUDIT_CAP
      },
      limits: liveLimits
    });
  });
}

// ---- instellingen ----
function settingsPayload(s) {
  return { billingEnv: billingEnvInfo(), settings: s, effectiveModules: effectiveModules(s), moduleDefs: MODULE_DEFS, limitDefs: LIMIT_DEFS, maintenanceOffModules: MAINTENANCE_OFF_MODULES,
    planGateableModules: PLAN_GATEABLE_MODULES,
    prefOptions: { goals: Object.keys(GOAL_TARGETS), diets: TIP_DIETS, mealTypes: PREF_MEALTYPES } };
}
function diffSettings(cur, next) {
  var out = [];
  if (cur.authRequired !== next.authRequired) out.push({ sleutel: "authRequired", van: cur.authRequired, naar: next.authRequired });
  ["modules", "planOnly", "limits", "maintenance", "announcement", "billing"].forEach(function (k) {
    Object.keys(next[k]).forEach(function (kk) { if (cur[k][kk] !== next[k][kk]) out.push({ sleutel: k + "." + kk, van: cur[k][kk], naar: next[k][kk] }); });
  });
  return out;
}
function handleAdminSettingsSet(req, res) {
  return requireBody(req).then(function (body) {
    var v = validateSettingsPatch(body);
    if (v.error) throw HttpError(400, "bad_request", v.error);
    return getSettings().then(function (cur) {
      var merged = mergeSettings(cur, v.patch);
      if (merged.announcement.enabled && !merged.announcement.message) throw HttpError(400, "bad_request", "Vul een tekst in voor de mededeling voordat je hem aanzet.");
      if (merged.billing.enabled && !cur.billing.enabled) {   // alleen bij het aanzetten: wat er nog ontbreekt
        var env = billingEnvInfo();
        if (!env.keyPresent) throw HttpError(400, "bad_request", "Zet eerst MOLLIE_API_KEY in de omgeving (Render → Environment) voordat je abonnementen aanzet.");
        if (!env.baseOk) throw HttpError(400, "bad_request", "Zet eerst PUBLIC_BASE_URL in de omgeving, bijvoorbeeld https://jouw-app.onrender.com (zonder slash aan het eind). Mollie stuurt betalingen daarheen en gebruikers keren daar naar terug.");
        if (env.mode === "live" && !merged.billing.termsUrl) throw HttpError(400, "bad_request", "Vul eerst de link naar je algemene voorwaarden in: bij echte betalingen moeten klanten die kunnen lezen.");
        if (merged.billing.plusDishCap > 0 && merged.limits.monthlyDishCap > 0 && merged.billing.plusDishCap <= merged.limits.monthlyDishCap) throw HttpError(400, "bad_request", "De Plus-limiet moet hoger zijn dan de algemene limiet (" + merged.limits.monthlyDishCap + "), anders heeft Plus geen voordeel.");
      }
      return updateSettings(v.patch).then(function (next) {
        var diff = diffSettings(cur, next);
        if (diff.length) auditLog(req, "instellingen.wijzigen", null, { wijzigingen: diff });
        sendJSON(res, 200, settingsPayload(next));
      });
    });
  });
}

// ---- gedeelde lijsten ----
function handleAdminLists(req, res, url) {
  var q = url.searchParams;
  return Promise.all([dbListDocs("lists/"), loadUserSummaries()]).then(function (r) {
    var owners = {};
    r[1].forEach(function (u) { owners[u.uid] = u; });
    var text = (q.get("q") || "").trim().toLowerCase(), status = q.get("status") || "all";
    var rows = r[0].filter(function (d) { return d.value && Array.isArray(d.value.items); }).map(function (d) {
      var s = listSummary(d.path.slice("lists/".length), d.value);
      s.ownerEmail = owners[s.ownerUid] ? owners[s.ownerUid].email : null;
      s.ownerName = owners[s.ownerUid] ? owners[s.ownerUid].name : null;
      return s;
    }).filter(function (s) {
      if (status === "active" && s.expired) return false;
      if (status === "expired" && !s.expired) return false;
      if (text && [s.title, s.token, s.ownerUid, s.ownerEmail, s.ownerName].join(" ").toLowerCase().indexOf(text) === -1) return false;
      return true;
    });
    rows.sort(function (a, b) { return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0); });
    var pg = paginate(rows, q, 25);
    sendJSON(res, 200, { lists: pg.rows, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages, expiredCount: r[0].filter(function (d) { return d.value && d.value.expiresAt && d.value.expiresAt < Date.now(); }).length });
  });
}
function handleAdminListDetail(req, res, token) {
  return dbGetDoc("lists/" + token).then(function (r) {
    if (!r.exists || !r.value) throw HttpError(404, "not_found", "Lijst niet gevonden.");
    var doc = r.value;
    sendJSON(res, 200, { list: listSummary(token, doc), items: (doc.items || []).map(function (it) { return { id: it.id, cat: it.cat, text: it.text, state: (doc.state || {})[it.id] || null }; }) });
  });
}
function handleAdminListDelete(req, res, token) {
  return dbGetDoc("lists/" + token).then(function (r) {
    if (!r.exists || !r.value) throw HttpError(404, "not_found", "Lijst niet gevonden.");
    var owner = r.value.ownerUid;
    return dbDeleteDoc("lists/" + token).then(function () { return owner ? removeFromOwnerIndex(owner, token) : null; }).then(function () {
      auditLog(req, "lijst.verwijderen", token, { titel: r.value.title, eigenaar: owner });
      sendJSON(res, 200, { ok: true });
    });
  });
}
function handleAdminListCleanup(req, res) {
  return dbListDocs("lists/").then(function (docs) {
    var expired = docs.filter(function (d) { return d.value && d.value.expiresAt && d.value.expiresAt < Date.now(); });
    return mapLimit(expired, 5, function (d) {
      var token = d.path.slice("lists/".length);
      return dbDeleteDoc(d.path).then(function () { return d.value.ownerUid ? removeFromOwnerIndex(d.value.ownerUid, token) : null; });
    }).then(function () {
      auditLog(req, "lijsten.opruimen", null, { verwijderd: expired.length });
      sendJSON(res, 200, { ok: true, removed: expired.length });
    });
  });
}

// ---- verdeler ----
function handleAdminApi(req, res, url) {
  var p = url.pathname, m, method = req.method;
  if (method === "POST" && p === "/api/admin/login") return handleAdminLogin(req, res);
  if (!requireAdmin(req, res)) return;
  var run = null;
  if (method === "GET" && p === "/api/admin/me") run = function () { sendJSON(res, 200, { ok: true }); };
  else if (method === "POST" && p === "/api/admin/logout") run = function () {
    var auth = req.headers["authorization"] || "";
    adminTokens.delete(auth.slice(7));
    sendJSON(res, 200, { ok: true });
  };
  else if (p === "/api/admin/settings") {
    if (method === "GET") run = function () { return getSettings().then(function (s) { sendJSON(res, 200, settingsPayload(s)); }); };
    else if (method === "POST") run = function () { return handleAdminSettingsSet(req, res); };
  }
  else if (method === "GET" && p === "/api/admin/stats") run = function () { return handleAdminStats(req, res); };
  else if (method === "GET" && p === "/api/admin/system") run = function () { return handleAdminSystem(req, res); };
  else if (method === "GET" && p === "/api/admin/logs") run = function () { return handleAdminLogs(req, res, url); };
  else if (method === "GET" && p === "/api/admin/audit") run = function () { return handleAdminAudit(req, res, url); };
  else if (p === "/api/admin/users") {
    if (method === "GET") run = function () { return handleAdminUserList(req, res, url); };
    else if (method === "POST") run = function () { return handleAdminUserCreate(req, res); };
  }
  else if (method === "POST" && p === "/api/admin/users/bulk") run = function () { return handleAdminUserBulk(req, res); };
  else if ((m = p.match(/^\/api\/admin\/users\/([A-Za-z0-9_-]{3,80})(?:\/([a-z-]+))?$/))) {
    var uid = m[1], sub = m[2];
    if (!sub && method === "GET") run = function () { return handleAdminUserDetail(req, res, uid); };
    else if (!sub && method === "POST") run = function () { return handleAdminUserUpdate(req, res, uid); };
    else if (sub === "export" && method === "GET") run = function () { return handleAdminUserExport(req, res, uid); };
    else if (sub && method === "POST") run = function () { return handleAdminUserAction(req, res, uid, sub); };
  }
  else if (method === "GET" && p === "/api/admin/lists") run = function () { return handleAdminLists(req, res, url); };
  else if (method === "POST" && p === "/api/admin/lists/cleanup") run = function () { return handleAdminListCleanup(req, res); };
  else if ((m = p.match(/^\/api\/admin\/lists\/([A-Za-z0-9_-]{22})(?:\/(delete))?$/))) {
    var token = m[1];
    if (!m[2] && method === "GET") run = function () { return handleAdminListDetail(req, res, token); };
    else if (m[2] === "delete" && method === "POST") run = function () { return handleAdminListDelete(req, res, token); };
  }
  if (!run) return sendJSON(res, 404, { code: "not_found", message: "Onbekend admin-eindpunt." });
  Promise.resolve().then(run).catch(function (err) {
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    sendJSON(res, err && err.status ? err.status : 500, { code: err && err.code ? err.code : "error", message: err && err.status ? err.message : "Er ging iets mis: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

function handleConfig(req, res) {
  getSettings().then(function (s) {
    sendJSON(res, 200, {
      authRequired: s.authRequired,
      bringImportEndpoint: BRING_IMPORT_ENDPOINT,
      modules: effectiveModules(s),
      planOnly: s.planOnly,
      billing: billingLive(s),
      oauth: oauthConfig(),
      canonicalOrigin: canonicalOrigin(),
      legacyOrigins: canonicalOrigin() ? legacyOrigins() : [],
      maintenance: s.maintenance.enabled ? { enabled: true, message: s.maintenance.message || "De app is tijdelijk in onderhoud." } : { enabled: false },
      announcement: s.announcement.enabled && s.announcement.message ? { enabled: true, message: s.announcement.message, level: s.announcement.level } : { enabled: false }
    });
  });
}

// Eindpunten achter een schakelaar (zie MODULE_DEFS). Uit = een duidelijke melding, geen storing.
var guardedRegister = moduleGuard("registration", handleAuthRegister);
var guardedUpgrade = moduleGuard("registration", handleAuthUpgrade);
var guardedForgot = moduleGuard("passwordReset", handleForgotPassword, function (req, res) {
  sendJSON(res, 200, { message: "Als dit e-mailadres bekend is, ontvang je een link om je wachtwoord te resetten." });   // lekt niets en verstuurt niets
});
var guardedReset = moduleGuard("passwordReset", handleResetPassword);
var guardedImage = moduleGuard("images", handleImage, function (req, res) { sendJSON(res, 200, { url: null, credit: null, final: true }); });
var guardedPhoto = moduleGuard("images", handlePhoto);
var guardedListCreate = moduleGuard("sharing", handleListCreate);
var guardedBring = moduleGuard("bring", handleListBring, function (req, res, s) {
  res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(moduleOffBody("bring", s).message);
});

// Versie van de app: verandert alleen als de frontend echt verandert, zodat open apps na een deploy
// weten dat ze moeten verversen (een herstart zonder wijzigingen triggert geen verversing).
var APP_VERSION = (function () {
  try {
    var h = crypto.createHash("sha1");
    ["index.html", "sw.js"].forEach(function (f) {
      try { h.update(fs.readFileSync(path.join(PUBLIC_DIR, f))); } catch (e) {}
    });
    return h.digest("hex").slice(0, 12);
  } catch (e) {
    return String(process.env.RENDER_GIT_COMMIT || Date.now()).slice(0, 12);
  }
})();

// ---------- Verhuizing naar het eigen domein (PUBLIC_BASE_URL) ----------
// Komt iemand binnen via een ander adres van deze server (bijv. het onrender.com-adres), dan sturen we die door.
// De app zelf ("/") geeft een kleine overdrachtspagina: die neemt het anonieme profiel, de inlog en een paar
// instellingen uit de browser mee (via het #-deel van de URL, dat nooit naar een server gaat). Het nieuwe adres
// accepteert die overdracht alleen als de verwijzer één van onze eigen oude adressen is (zie legacyOrigins).
// Uitzetten kan met DOMAIN_REDIRECT=off. API-aanroepen, het service worker-bestand en iconen worden nooit doorgestuurd.
var HANDOFF_KEYS = ["weekmenu_anon", "weekmenu_token", "weekmenu_uid", "weekmenu_theme", "weekmenu_shares", "weekmenu_share_meta",
  "weekmenu_tips_seen", "weekmenu_skipped", "balanza_autofill_meals"];
function canonicalOrigin() {
  if (String(process.env.DOMAIN_REDIRECT || "").toLowerCase() === "off") return null;
  try { var u = new URL(PUBLIC_BASE_URL); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch (e) { return null; }
}
function legacyOrigins() {
  var hosts = String(process.env.LEGACY_HOSTS || "").split(",").map(function (h) { return h.trim(); }).filter(Boolean);
  if (process.env.RENDER_EXTERNAL_HOSTNAME) hosts.push(String(process.env.RENDER_EXTERNAL_HOSTNAME).trim());
  return hosts.map(function (h) { return /^https?:\/\//.test(h) ? h.replace(/\/+$/, "") : "https://" + h; });
}
function handoffPageHtml(target) {
  var t = JSON.stringify(target).replace(/</g, "\\u003c");
  var host = new URL(target).host;
  return '<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="origin"><meta name="theme-color" content="#F3F7F4"><title>Balanza verhuist</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F3F7F4;color:#0F2219;font-family:-apple-system,system-ui,"Segoe UI",sans-serif;text-align:center;padding:24px;box-sizing:border-box}' +
    '.c{max-width:420px}h1{font-size:24px;margin:0 0 10px}p{color:#55685D;line-height:1.55;margin:0 0 18px}' +
    'a.b{display:inline-block;background:#14543A;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:999px}' +
    'a.s{display:block;margin-top:14px;color:#55685D;font-size:14px}</style></head><body><div class="c">' +
    '<h1>Balanza heeft een nieuw adres</h1><p id="t">Je wordt doorgestuurd naar ' + host + '… Je gegevens gaan automatisch mee.</p>' +
    '<a class="b" id="go" href="' + target + '">Ga naar ' + host + '</a><a class="s" id="stay" href="/?stay=1" style="display:none">Voorlopig hier blijven</a></div>' +
    '<script>(function(){var T=' + t + ',K=' + JSON.stringify(HANDOFF_KEYS) + ',d={};' +
    'try{K.forEach(function(k){var v=localStorage.getItem(k);if(v!==null&&v.length<20000)d[k]=v;});}catch(e){}' +
    'var u=T.replace(/\\/$/,"")+"/"+location.search.replace(/[?&]stay=1/,"");' +
    'if(Object.keys(d).length){try{u+="#handoff="+encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(d)))));}catch(e){}}' +
    'document.getElementById("go").href=u;' +
    'var sa=window.navigator.standalone===true||(window.matchMedia&&matchMedia("(display-mode: standalone)").matches);' +
    'if(sa){document.getElementById("t").textContent="Je opent Balanza vanaf je beginscherm. Tik op de knop om ' + host + ' in je browser te openen en zet het daar opnieuw op je beginscherm. Je gegevens gaan automatisch mee.";' +
    'document.getElementById("go").target="_blank";document.getElementById("stay").style.display="block";}' +
    'else location.replace(u);})();</script></body></html>';
}
// Geeft true als het verzoek is afgehandeld (doorgestuurd).
function handleDomainMove(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  var canon = canonicalOrigin();
  if (!canon) return false;
  var host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase();
  var canonHost = new URL(canon).host.toLowerCase();
  if (!host || host === canonHost) return false;
  var p = url.pathname;
  if (p.indexOf("/api/") === 0) return false;
  if (host === "www." + canonHost) {
    res.writeHead(301, { "Location": canon + p + url.search, "Cache-Control": "public, max-age=3600" });
    res.end(); return true;
  }
  if ((p === "/" || p === "/index.html") && url.searchParams.get("stay") !== "1") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(handoffPageHtml(canon + "/")); return true;
  }
  if (p === "/welkom" || p.indexOf("/l/") === 0) {
    res.writeHead(301, { "Location": canon + p + url.search, "Cache-Control": "public, max-age=3600" });
    res.end(); return true;
  }
  return false;
}

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, "http://localhost");
  if (handleDomainMove(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/api/version") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, max-age=0" });
    return res.end(JSON.stringify({ version: APP_VERSION }));
  }

  if (req.method === "POST" && url.pathname === "/api/generate") return handleGenerate(req, res);
  var jobMatch = req.method === "GET" ? url.pathname.match(/^\/api\/generate\/job\/([a-f0-9]{32})$/) : null;
  if (jobMatch) return handleGenerateJobGet(req, res, jobMatch[1]);
  if (req.method === "GET" && url.pathname === "/api/usage") return handleUsageGet(req, res);
  if (req.method === "GET" && url.pathname === "/api/billing") return handleBillingGet(req, res);
  if (req.method === "POST" && url.pathname === "/api/billing/checkout") return handleBillingCheckout(req, res);
  if (req.method === "POST" && url.pathname === "/api/billing/cancel") return handleBillingCancel(req, res);
  if (req.method === "POST" && url.pathname === "/api/billing/webhook") return handleBillingWebhook(req, res);
  if (req.method === "GET" && url.pathname === "/api/push/key") return handlePushKey(req, res);
  if (req.method === "POST" && url.pathname === "/api/push/subscribe") return handlePushSubscribe(req, res);
  if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") return handlePushUnsubscribe(req, res);
  if (req.method === "POST" && url.pathname === "/api/tips") return handleTips(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/register") return guardedRegister(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/upgrade") return guardedUpgrade(req, res);
  if (req.method === "GET" && url.pathname === "/api/auth/anon-status") return handleAnonStatus(req, res);
  var oauthMatch = url.pathname.match(/^\/api\/auth\/oauth\/(apple|google)\/(start|callback)$/);
  if (oauthMatch) {
    if (oauthMatch[2] === "start" && req.method === "GET") return handleOAuthStart(req, res, oauthMatch[1], url);
    if (oauthMatch[2] === "callback" && (req.method === "GET" || req.method === "POST")) return handleOAuthCallback(req, res, oauthMatch[1], url);
  }
  if (req.method === "GET" && url.pathname === "/api/account") return handleAccountInfo(req, res);
  if (req.method === "GET" && url.pathname === "/api/account/export") return handleAccountExport(req, res);
  if (req.method === "POST" && url.pathname === "/api/account/change-password") return handleAccountChangePassword(req, res);
  if (req.method === "POST" && url.pathname === "/api/account/change-email") return handleAccountChangeEmail(req, res);
  if (req.method === "POST" && url.pathname === "/api/account/logout-others") return handleAccountLogoutOthers(req, res);
  if (req.method === "POST" && url.pathname === "/api/account/delete") return handleAccountDelete(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/login") return handleAuthLogin(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/forgot-password") return guardedForgot(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/reset-password") return guardedReset(req, res);
  if (req.method === "GET" && url.pathname === "/api/db") return handleDbGet(req, res, url.searchParams);
  if (req.method === "POST" && url.pathname === "/api/db") return handleDbSet(req, res);
  if (req.method === "GET" && url.pathname === "/api/image") return guardedImage(req, res, url.searchParams);
  if (req.method === "GET" && url.pathname === "/api/photo") return guardedPhoto(req, res, url.searchParams);
  if (req.method === "POST" && url.pathname === "/api/lists") return guardedListCreate(req, res);
  var listApi = url.pathname.match(/^\/api\/lists\/([A-Za-z0-9_-]{22})(?:\/(item|reset|delete))?$/);
  if (listApi) {
    if (req.method === "GET" && !listApi[2]) return handleListGet(req, res, listApi[1], url.searchParams);
    if (req.method === "POST" && listApi[2] === "item") return handleListItem(req, res, listApi[1]);
    if (req.method === "POST" && listApi[2] === "reset") return handleListReset(req, res, listApi[1]);
    if (req.method === "POST" && listApi[2] === "delete") return handleListDelete(req, res, listApi[1]);
  }
  var listBring = url.pathname.match(/^\/l\/([A-Za-z0-9_-]{22})\/(bring|bring\.json)$/);
  if ((req.method === "GET" || req.method === "HEAD") && listBring) return guardedBring(req, res, listBring[1], listBring[2] === "bring.json", url.searchParams);
  var listPage = url.pathname.match(/^\/l\/([A-Za-z0-9_-]{22})$/);
  if (req.method === "GET" && listPage) return handleListPage(req, res, listPage[1]);
  if (req.method === "GET" && url.pathname === "/manifest.json") return serveFile(req, res, "manifest.json");
  if (req.method === "GET" && url.pathname === "/sw.js") return serveFile(req, res, "sw.js");
  if (req.method === "GET" && url.pathname === "/favicon.png") return serveFile(req, res, "favicon.png");
  if (req.method === "GET" && url.pathname.indexOf("/icons/") === 0) return serveFile(req, res, url.pathname);
  if (req.method === "GET" && url.pathname === "/api/config") return handleConfig(req, res);
  if (url.pathname.indexOf("/api/admin/") === 0) return handleAdminApi(req, res, url);
  if (req.method === "GET" && url.pathname === "/admin") return serveFile(req, res, "admin.html");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return serveStatic(req, res);
  if (req.method === "GET" && url.pathname === "/welkom") return serveFile(req, res, "welkom.html");

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, function () {
  console.log("Weekmenu app draait op http://localhost:" + PORT);
  getSettings().catch(function () {});
  if (!ANTHROPIC_API_KEY) {
    console.warn("WAARSCHUWING: ANTHROPIC_API_KEY is niet ingesteld — genereren zal niet werken.");
  }
  if (!UNSPLASH_ACCESS_KEY) {
    console.log("Info: UNSPLASH_ACCESS_KEY niet ingesteld — de app werkt gewoon door, maar zonder gerechtfoto's.");
  }
  if (!MONGODB_URI) {
    console.warn("WAARSCHUWING: MONGODB_URI is niet ingesteld — data wordt lokaal opgeslagen en gaat verloren bij een herstart/redeploy (bijv. op Render's gratis laag).");
  }
});
