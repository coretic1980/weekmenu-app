// Weekmenu app — standalone backend
// Zero external dependencies: only Node's built-in http, fs, path, crypto modules.
// Requires Node.js 18+ (uses the built-in global fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
const DAILY_GENERATE_CAP = parseInt(process.env.DAILY_GENERATE_CAP || "300", 10);
const PER_IP_HOURLY_CAP = parseInt(process.env.PER_IP_HOURLY_CAP || "20", 10);
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
  return {
    authRequired: raw.authRequired === true,
    modules: modules,
    limits: limits,
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
  ["modules", "limits", "maintenance", "announcement"].forEach(function (k) {
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

function goalInstructionText(goal) {
  var desc = GOAL_DESCRIPTIONS[goal] || GOAL_DESCRIPTIONS["Onderhoud"];
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
    "- Maaltijdmomenten: " + mealGuideTxt + "\n" +
    mealInstruction + "\n" +
    "- Keukenstijl: " + cuisineTxt + "\n" +
    "- Smaakprofiel: " + flavorTxt + "\n" +
    "- Culinair niveau: " + (p.level || "Home-style") + "\n" +
    dietStyleInstructionText(p.dietStyle) +
    "- Beschikbare apparatuur: " + equipTxt + "\n" +
    "- Uitgesloten ingrediënten: " + excludeTxt + "\n" +
    buildBodyProfileLine(p) +
    goalInstructionText(p.goal) +
    "Gebruik reële, haalbare porties en ingrediënten die passen " +
    "bij het gekozen maaltijdmoment van elk gerecht.\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug: een array van EXACT " + totalCount + " objecten (" + count +
    " per maaltijdmoment), exact dit schema, geen markdown-opmaak, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "mealType": "' + mealTypes[0] + '", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ["ingredient 1", "ingredient 2"], ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + mealTypes.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
    FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd (koken, bakken, grillen, oven, sudderen); anders weglaten.";
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
    "- Keukenstijl: " + cuisineTxt + "\n- Smaakprofiel: " + flavorTxt + "\n- Culinair niveau: " + (p.level || "Home-style") + "\n" +
    dietStyleInstructionText(p.dietStyle) +
    "- Beschikbare apparatuur: " + equipTxt + "\n" +
    buildBodyProfileLine(p) +
    goalInstructionText(p.goal) + "\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug: een array van EXACT " + totalCount + " objecten, exact dit schema, " +
    "geen markdown-opmaak, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "mealType": "' + types[0] + '", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ["ingredient 1", "ingredient 2"], ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + types.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
    FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten.";
}

function buildVariationPromptServer(current, kind, p) {
  return "Hier is een bestaand gerecht in JSON: " + JSON.stringify(current) + "\n\n" +
    "Opdracht: " + (VARIATION_INSTRUCTIONS[kind] || "") + "\n" +
    "Streef naar een macroverdeling passend bij het doel \"" + p.goal + "\": " + (GOAL_DESCRIPTIONS[p.goal] || "") + "\n" +
    (p.dietStyle ? dietStyleInstructionText(p.dietStyle) : "") +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug, exact dit schema, geen markdown, geen uitleg erbuiten:\n" +
    '{"name": "gerechtnaam", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ["ingredient 1", "ingredient 2"], ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}\n' +
    "\"bereidingstijd_minuten\" is de bijgewerkte, realistische totale bereidingstijd in hele minuten, passend bij de opdracht. " +
    "Werk ook \"foto_zoekterm\" bij als het hoofdingrediënt of het soort gerecht door de opdracht verandert. " + FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten.";
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
function runGenerateAction(body) {
  var action = body && body.action;
  var params = (body && body.params) || {};

  if (action === "generate") {
    var mealTypes = (params.mealTypes && params.mealTypes.length) ? params.mealTypes : ["Diner"];
    if (mealTypes.length > 1) {
      return Promise.all(mealTypes.map(function (mt) {
        var subParams = Object.assign({}, params, { mealTypes: [mt] });
        return generateWithBalansRetry(buildGeneratePrompt(subParams), params.goal);
      })).then(mergeDishArrays);
    }
    return generateWithBalansRetry(buildGeneratePrompt(params), params.goal);
  }

  if (action === "background") {
    var needed = (body && body.needed) || {};
    var types = Object.keys(needed);
    if (types.length > 1) {
      return Promise.all(types.map(function (mt) {
        var subNeeded = {};
        subNeeded[mt] = needed[mt];
        return generateWithBalansRetry(buildBackgroundGeneratePrompt(subNeeded, params), params.goal);
      })).then(mergeDishArrays);
    }
    return generateWithBalansRetry(buildBackgroundGeneratePrompt(needed, params), params.goal);
  }

  if (action === "variation") {
    return generateWithBalansRetry(buildVariationPromptServer(body.current || {}, body.kind, params), params.goal);
  }

  if (action === "prep") {
    return generateWithBalansRetry(buildPrepPromptServer(body.dishes || []), null);
  }

  if (action === "price") {
    return generateWithBalansRetry(buildPriceEstimatePrompt(body.items || []), null);
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
function computeBalanceServer(khPct, eiwitPct, vetPct, goal) {
  var t = GOAL_TARGETS[goal] || GOAL_TARGETS["Onderhoud"];
  var maxDev = Math.max(Math.abs(khPct - t.kh), Math.abs(eiwitPct - t.eiwit), Math.abs(vetPct - t.vet));
  return Math.max(0, Math.min(100, Math.round(100 - 3 * maxDev)));
}
function dishBalans(d, goal) {
  var kcal = Number(d && d.kcal) || 0;
  if (!kcal) return 0;
  var khPct = Math.round((Number(d.kh_g || 0) * 4 / kcal) * 100);
  var eiwitPct = Math.round((Number(d.eiwit_g || 0) * 4 / kcal) * 100);
  var vetPct = Math.round((Number(d.vet_g || 0) * 9 / kcal) * 100);
  return computeBalanceServer(khPct, eiwitPct, vetPct, goal);
}
function minBalans(parsed, goal) {
  var dishes = Array.isArray(parsed) ? parsed : [parsed];
  if (!dishes.length) return 0;
  return dishes.reduce(function (min, d) { return Math.min(min, dishBalans(d, goal)); }, 100);
}

var BALANS_MIN_THRESHOLD = 75;
var BALANS_MAX_ATTEMPTS = 3;

function callAnthropicOnce(prompt, model, maxTokens) {
  return fetch("https://api.anthropic.com/v1/messages", {
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
function generateWithBalansRetry(prompt, goal) {
  if (!goal) return callAnthropicOnce(prompt);

  var bestParsed = null;
  var bestScore = -1;
  var attempt = 0;

  function tryOnce() {
    attempt++;
    return callAnthropicOnce(prompt).then(function (parsed) {
      var score = minBalans(parsed, goal);
      if (score > bestScore) { bestScore = score; bestParsed = parsed; }
      if (score >= BALANS_MIN_THRESHOLD || attempt >= BALANS_MAX_ATTEMPTS) {
        return bestParsed;
      }
      return tryOnce();
    });
  }

  return tryOnce();
}

function logEvent(type, action, ok, status, extra) {
  logRequest(Object.assign({ ts: new Date().toISOString(), type: type, action: action, ok: ok, status: status }, extra || {}));
}

function handleGenerate(req, res) {
  var ip = clientIp(req);
  var startTime = Date.now();
  var uidForLog = null;
  function log(action, ok, status, error) {
    logRequest({ ts: new Date().toISOString(), type: "generate", action: action, durationMs: Date.now() - startTime, ok: ok, status: status, error: error || undefined, ip: ip, uid: uidForLog || undefined });
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
      if (usedToday >= liveLimits.dailyGenerateCap) {
        log("onbekend", false, 429, "Dagelijkse limiet bereikt");
        return sendJSON(res, 429, { code: "rate_limited", message: "De dagelijkse limiet voor het genereren van gerechten is bereikt. Probeer het morgen opnieuw." });
      }

      readBody(req).then(function (body) {
        var action = (body && body.action) || "onbekend";
        if (action === "price" && !mods.prices) {
          log(action, false, 503, "Module uitgeschakeld: prices");
          return sendJSON(res, 503, moduleOffBody("prices", settings));
        }

        return runGenerateAction(body).then(function (parsed) {
          incrementUsageToday();
          log(action, true, 200);
          sendJSON(res, 200, { result: parsed });
        }).catch(function (err) {
          var status = err && err.isBadRequest ? 400 : 502;
          var code = err && err.isBadRequest ? "bad_request" : "error";
          var message = err && err.isBadRequest ? "Ongeldig verzoek." : "Genereren mislukt: " + err.message;
          log(action, false, status, err.message);
          sendJSON(res, status, { code: code, message: message });
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
    dbGetDoc("data/users/" + anon + "/meta"), dbGetDoc("adminMeta/" + anon), dbGetDoc("listsIndex/" + anon)
  ])).then(function (r) {
    var tokens = r[5].exists && r[5].value && Array.isArray(r[5].value.tokens) ? r[5].value.tokens : [];
    return { prefs: r[0], dishes: r[1], plannedWeeks: r[2], meta: r[3], adminMeta: r[4], tokens: tokens };
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
  var paths = UPGRADE_SUBPATHS.map(function (s) { return "data/users/" + uid + "/" + s; }).concat(["data/users/" + uid + "/meta", "adminMeta/" + uid, "listsIndex/" + uid]);
  return Promise.all(paths.map(dbDeleteDoc).concat((tokens || []).map(function (t) {
    return dbGetDoc("lists/" + t).then(function (r) { return r.exists && r.value ? dbSetDoc("lists/" + t, Object.assign({}, r.value, { ownerUid: anon })) : null; });
  }))).catch(function () {});
}
function cleanupAnon(anon) {
  var paths = UPGRADE_SUBPATHS.map(function (s) { return "data/users/" + anon + "/" + s; }).concat(["data/users/" + anon + "/meta", "adminMeta/" + anon, "listsIndex/" + anon]);
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
      if (!cur) return sendJSON(res, 400, { code: "bad_request", message: "Vul je huidige wachtwoord in." });
      if (nw.length < 8) return sendJSON(res, 400, { code: "bad_request", message: "Het nieuwe wachtwoord moet minstens 8 tekens zijn." });
      if (nw.length > 200) return sendJSON(res, 400, { code: "bad_request", message: "Een wachtwoord mag hoogstens 200 tekens hebben." });
      return loadOwnAccount(user).then(function (acc) {
        if (!acc) return sendUnauthorized(res);
        if (!verifyPassword(cur, acc)) { logEvent("auth", "password-change", false, 403, { error: "Huidig wachtwoord onjuist", email: user.email, uid: user.uid, ip: clientIp(req) }); return forbiddenPassword(res); }
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
      if (!password) return sendJSON(res, 400, { code: "bad_request", message: "Vul je wachtwoord in om je account te verwijderen." });
      return loadOwnAccount(user).then(function (acc) {
        if (!acc) return sendUnauthorized(res);
        if (!verifyPassword(password, acc)) { logEvent("auth", "self-delete", false, 403, { error: "Wachtwoord onjuist", email: user.email, uid: user.uid, ip: clientIp(req) }); return forbiddenPassword(res); }
        return deleteUserEverywhere({ uid: user.uid, email: user.email }).then(function () {
          logEvent("auth", "self-delete", true, 200, { email: user.email, uid: user.uid, ip: clientIp(req) });
          sendJSON(res, 200, { ok: true });
        });
      });
    });
  });
}

function handleAuthLogin(req, res) {
  var ip = clientIp(req);
  readBody(req).then(function (body) {
    var email = normalizeEmail(body && body.email);
    var password = (body && body.password) || "";
    return dbGetDoc("auth/users/" + email).then(function (result) {
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
  var avoid = (Array.isArray(p.avoid) ? p.avoid : []).slice(0, 30)
    .map(function (s) { return String(s).replace(/[\r\n"]+/g, " ").trim().slice(0, 90); })
    .filter(Boolean);
  var topics = pickRandomItems(TIP_TOPICS, 3);
  return "Je schrijft korte, prettig leesbare weetjes en tips voor de wachtcarrousel van Balanza, een app die gebalanceerde " +
    "maaltijden ontwerpt op basis van macro's. De lezer wacht even op het genereren van gerechten en wil zich vermaken en iets leren.\n\n" +
    "Schrijf 8 NIEUWE items in het Nederlands. Verdeel ze over deze onderwerpen: " + topics.join(", ") + ". " +
    "Maak van hooguit 1 item een tip over Balanza zelf.\n" +
    "Context van de lezer: doel \"" + goal + "\"" + (diet ? ", voedingsstijl \"" + diet + "\"" : "") + ". " +
    "Laat minstens twee items aansluiten op dat doel" + (diet ? " of die voedingsstijl" : "") + ".\n\n" +
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
      return callAnthropicOnce(prompt, TIPS_MODEL, 2000).then(function (parsed) {
        var tips = cleanTipList(parsed);
        if (!tips.length) throw new Error("Geen bruikbare tips ontvangen");
        sendJSON(res, 200, { result: tips });
      });
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
        var token = crypto.randomBytes(16).toString("base64url");
        var doc = { title: title, ownerUid: user.uid, createdAt: now, updatedAt: now, expiresAt: now + LIST_TTL_MS, rev: 1,
          items: items, state: cleanListState(body.state, items) };
        return dbSetDoc("lists/" + token, doc).then(function () {
          return addToOwnerIndex(user.uid, token);
        }).then(function () { reply(token, doc); });
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
      return;
    }
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
function writeAdminNote(uid, note) {
  var text = cleanNote(note, 500);
  return text ? dbSetDoc("adminMeta/" + uid, { note: text }) : dbDeleteDoc("adminMeta/" + uid);
}
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
      if (body.note !== undefined && cleanNote(body.note, 500) !== user.note) { jobs.push(writeAdminNote(uid, body.note)); changes.push("notitie"); }
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
      listsOfUser(uid), getRecentLogs(LOG_CAP), withLocation(user)
    ]).then(function (r) {
      var logs = r[4].filter(function (l) { return l.uid === uid; }).slice(0, 50).map(cleanLogRow);
      sendJSON(res, 200, {
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
  return dbGetDoc("listsIndex/" + uid).then(function (r) {
    var tokens = r.exists && r.value && Array.isArray(r.value.tokens) ? r.value.tokens : [];
    return Promise.all(tokens.map(function (t) { return dbDeleteDoc("lists/" + t); }));
  }).then(function () {
    var paths = ["data/users/" + uid + "/prefs", "data/users/" + uid + "/dishes", "data/users/" + uid + "/plannedWeeks", "data/users/" + uid + "/meta", "listsIndex/" + uid, "adminMeta/" + uid];
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
function handleAdminStats(req, res) {
  return Promise.all([loadUserSummaries(), getUsageToday(), getUsageHistory(14), getRecentLogs(LOG_CAP), dbListDocs("lists/"), getSettings()]).then(function (r) {
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
    var mem = process.memoryUsage();
    var checks = [
      { key: "storage", label: "Opslag", ok: storage.ok && mongoConnected, detail: (mongoConnected ? "MongoDB (blijvend)" : "Lokaal bestand: data gaat verloren bij een herstart of nieuwe deploy") + (storage.ok ? ", antwoordtijd " + storage.ms + " ms" : ", FOUT: " + storage.error) },
      { key: "anthropic", label: "AI-sleutel (ANTHROPIC_API_KEY)", ok: !!ANTHROPIC_API_KEY, detail: ANTHROPIC_API_KEY ? "ingesteld" : "niet ingesteld: genereren werkt niet" },
      { key: "adminPassword", label: "Beheerderswachtwoord", ok: ADMIN_PASSWORD.length >= 12, detail: ADMIN_PASSWORD.length >= 12 ? "sterk genoeg" : "korter dan 12 tekens: kies een langer wachtwoord (ADMIN_PASSWORD)" },
      { key: "sessionSecret", label: "Sessiegeheim (SESSION_SECRET)", ok: !!process.env.SESSION_SECRET, detail: process.env.SESSION_SECRET ? "vast ingesteld" : "niet ingesteld: iedereen wordt uitgelogd bij een herstart" },
      { key: "unsplash", label: "Foto's (UNSPLASH_ACCESS_KEY)", ok: !!UNSPLASH_ACCESS_KEY, optional: true, detail: UNSPLASH_ACCESS_KEY ? "ingesteld" : "niet ingesteld: gerechten krijgen geen foto" },
      { key: "resend", label: "E-mail (RESEND_API_KEY)", ok: !!RESEND_API_KEY, optional: true, detail: RESEND_API_KEY ? "ingesteld" : "niet ingesteld: geen wachtwoord-vergeten-mails of uitnodigingen per e-mail" }
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
  return { settings: s, effectiveModules: effectiveModules(s), moduleDefs: MODULE_DEFS, limitDefs: LIMIT_DEFS, maintenanceOffModules: MAINTENANCE_OFF_MODULES,
    prefOptions: { goals: Object.keys(GOAL_TARGETS), diets: TIP_DIETS, mealTypes: PREF_MEALTYPES } };
}
function diffSettings(cur, next) {
  var out = [];
  if (cur.authRequired !== next.authRequired) out.push({ sleutel: "authRequired", van: cur.authRequired, naar: next.authRequired });
  ["modules", "limits", "maintenance", "announcement"].forEach(function (k) {
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

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/generate") return handleGenerate(req, res);
  if (req.method === "POST" && url.pathname === "/api/tips") return handleTips(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/register") return guardedRegister(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/upgrade") return guardedUpgrade(req, res);
  if (req.method === "GET" && url.pathname === "/api/auth/anon-status") return handleAnonStatus(req, res);
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
