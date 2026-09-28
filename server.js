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
  return signSessionToken({ uid: uid, email: email, exp: Date.now() + SESSION_TTL_MS });
}
// ---------- Login on/off (admin setting) ----------
// When login is required, only valid account sessions are accepted. When the
// admin switches it off, browsers may instead identify with an anonymous ID
// (prefix "anon_") — account IDs ("u_...") are never accepted that way, so
// existing accounts stay protected even while login is switched off.

// Default is "no login". Login is only required once the admin has explicitly
// switched it on. (If the setting can't be read because of a storage error,
// we fail closed and require login, since we can't tell what the admin chose.)
var authRequiredCache = { value: null, expiry: 0 };

function getAuthRequired() {
  if (authRequiredCache.value !== null && Date.now() < authRequiredCache.expiry) {
    return Promise.resolve(authRequiredCache.value);
  }
  return dbGetDoc("settings/app").then(function (r) {
    var value = !!(r.exists && r.value && r.value.authRequired === true);
    authRequiredCache = { value: value, expiry: Date.now() + 5000 };
    return value;
  }).catch(function () { return true; });
}

function setAuthRequired(value) {
  return dbSetDoc("settings/app", { authRequired: !!value }).then(function () {
    authRequiredCache = { value: !!value, expiry: Date.now() + 5000 };
  });
}

var ANON_ID_PATTERN = /^anon_[a-z0-9]{10,40}$/;

// Resolves to { uid, email } for a valid account session, or (only while login
// is switched off) for a well-formed anonymous ID. Resolves to null otherwise.
function resolveUser(req) {
  var auth = req.headers["authorization"] || "";
  var token = auth.indexOf("Bearer ") === 0 ? auth.slice(7) : "";
  var payload = verifySessionToken(token);
  if (payload && payload.uid) return Promise.resolve({ uid: payload.uid, email: payload.email });
  var anon = String(req.headers["x-anon-id"] || "");
  if (!ANON_ID_PATTERN.test(anon)) return Promise.resolve(null);
  return getAuthRequired().then(function (required) {
    return required ? null : { uid: anon, email: null };
  });
}
function sendUnauthorized(res) {
  sendJSON(res, 401, { code: "unauthorized", message: "Niet ingelogd of sessie verlopen." });
}

// ---------- Request logging (for the admin page) ----------
// Every /api/generate call logs its action, duration, and outcome. Capped at
// the most recent 1000 entries so it never grows unbounded.

var LOG_CAP = 1000;

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

var mongoReady = MONGODB_URI
  ? new MongoClient(MONGODB_URI).connect().then(function (client) {
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
        if (m) { users.push({ uid: store.docs[key].uid, email: m[1] }); return; }
        var a = key.match(/^data\/users\/(anon_[^\/]+)\/meta$/);
        if (a) users.push({ uid: a[1], email: null });
      });
      return users;
    }
    return Promise.all([
      db.collection("docs").find({ _id: { $regex: "^auth/users/" } }).toArray(),
      db.collection("docs").find({ _id: { $regex: "^data/users/anon_[^/]+/meta$" } }).toArray()
    ]).then(function (results) {
      var accounts = results[0].map(function (d) { return { uid: d.value.uid, email: d._id.slice("auth/users/".length) }; });
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
  return entry.count <= PER_IP_HOURLY_CAP;
}

// ---------- HTTP helpers ----------

function sendJSON(res, status, body) {
  var data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data)
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

function callAnthropicOnce(prompt) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 64000,
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

function handleGenerate(req, res) {
  var ip = clientIp(req);
  var startTime = Date.now();
  if (!checkIpRateLimit(ip)) {
    logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 429, error: "Rate limit (IP)", ip: ip });
    return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken vanaf dit adres. Probeer later opnieuw." });
  }

  resolveUser(req).then(function (user) {
    if (!user) {
      logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 401, error: "Niet ingelogd", ip: ip });
      sendUnauthorized(res);
      return null;
    }
    if (!ANTHROPIC_API_KEY) {
      logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 500, error: "ANTHROPIC_API_KEY niet ingesteld", ip: ip });
      sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ANTHROPIC_API_KEY ingesteld." });
      return null;
    }
    return getUsageToday();
  }).then(function (usedToday) {
    if (usedToday === null) return; // already answered with 401
    if (usedToday >= DAILY_GENERATE_CAP) {
      logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 429, error: "Dagelijkse limiet bereikt", ip: ip });
      return sendJSON(res, 429, { code: "rate_limited", message: "De dagelijkse limiet voor het genereren van gerechten is bereikt. Probeer het morgen opnieuw." });
    }

    readBody(req).then(function (body) {
      var action = (body && body.action) || "onbekend";

      return runGenerateAction(body).then(function (parsed) {
        incrementUsageToday();
        logRequest({ ts: new Date().toISOString(), action: action, durationMs: Date.now() - startTime, ok: true, status: 200, ip: ip });
        sendJSON(res, 200, { result: parsed });
      }).catch(function (err) {
        var status = err && err.isBadRequest ? 400 : 502;
        var code = err && err.isBadRequest ? "bad_request" : "error";
        var message = err && err.isBadRequest ? "Ongeldig verzoek." : "Genereren mislukt: " + err.message;
        logRequest({ ts: new Date().toISOString(), action: action, durationMs: Date.now() - startTime, ok: false, status: status, error: err.message, ip: ip });
        sendJSON(res, status, { code: code, message: message });
      });
    }).catch(function () {
      logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 400, error: "Ongeldige aanvraag", ip: ip });
      sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
    });
  }).catch(function (err) {
    logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 502, error: "Opslag niet bereikbaar: " + (err && err.message ? err.message : "onbekende fout"), ip: ip });
    sendJSON(res, 502, { code: "error", message: "Opslag niet bereikbaar: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function handleAuthRegister(req, res) {
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
        return sendJSON(res, 409, { code: "conflict", message: "Er bestaat al een account met dit e-mailadres." });
      }
      var uid = "u_" + crypto.randomBytes(12).toString("hex");
      var record = makePasswordRecord(password);
      return dbSetDoc("auth/users/" + email, { uid: uid, salt: record.salt, hash: record.hash, createdAt: new Date().toISOString() }).then(function () {
        sendJSON(res, 200, { token: issueUserSession(uid, email), uid: uid });
      });
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Registreren mislukt: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

function handleAuthLogin(req, res) {
  readBody(req).then(function (body) {
    var email = normalizeEmail(body && body.email);
    var password = (body && body.password) || "";
    return dbGetDoc("auth/users/" + email).then(function (result) {
      if (!result.exists || !verifyPassword(password, result.value)) {
        return sendJSON(res, 401, { code: "unauthorized", message: "E-mailadres of wachtwoord onjuist." });
      }
      sendJSON(res, 200, { token: issueUserSession(result.value.uid, email), uid: result.value.uid });
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
      return dbSetDoc("auth/resets/" + token, { email: email, expiresAt: Date.now() + RESET_TOKEN_TTL_MS, used: false }).then(function () {
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
        var uid = userResult.value.uid;
        var record = makePasswordRecord(newPassword);
        return Promise.all([
          dbSetDoc("auth/users/" + email, { uid: uid, salt: record.salt, hash: record.hash, createdAt: userResult.value.createdAt }),
          dbSetDoc("auth/resets/" + token, { email: email, expiresAt: 0, used: true })
        ]).then(function () {
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

function handleAdminLogin(req, res) {
  if (!ADMIN_PASSWORD) {
    return sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ADMIN_PASSWORD ingesteld." });
  }
  readBody(req).then(function (body) {
    var password = body && body.password;
    if (password !== ADMIN_PASSWORD) {
      return sendJSON(res, 401, { code: "unauthorized", message: "Onjuist wachtwoord." });
    }
    sendJSON(res, 200, { token: issueAdminToken() });
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;
  dbListUserIds().then(function (accounts) {
    return Promise.all(accounts.map(function (account) {
      var uid = account.uid;
      return Promise.all([
        dbGetDoc("data/users/" + uid + "/prefs"),
        dbGetDoc("data/users/" + uid + "/dishes"),
        dbGetDoc("data/users/" + uid + "/plannedWeeks"),
        dbGetDoc("data/users/" + uid + "/meta")
      ]).then(function (results) {
        var prefs = results[0].exists ? results[0].value : null;
        var dishes = results[1].exists ? results[1].value : null;
        var plannedWeeks = results[2].exists ? results[2].value : null;
        var meta = results[3].exists ? results[3].value : null;
        var dishCount = 0;
        if (dishes && typeof dishes === "object") {
          Object.keys(dishes).forEach(function (mt) { dishCount += Array.isArray(dishes[mt]) ? dishes[mt].length : 0; });
        }
        var locationPromise = (meta && meta.lastIp) ? resolveIpLocation(meta.lastIp) : Promise.resolve(null);
        return locationPromise.then(function (location) {
          return {
            uid: uid,
            email: account.email,
            name: prefs && typeof prefs.name === "string" ? prefs.name.slice(0, 40) : null,
            goal: prefs ? prefs.goal : null,
            dietStyle: prefs ? prefs.dietStyle : null,
            level: prefs ? prefs.level : null,
            dishCount: dishCount,
            plannedWeekCount: Array.isArray(plannedWeeks) ? plannedWeeks.length : 0,
            lastSeenAt: meta ? meta.lastSeenAt : null,
            location: location
          };
        });
      });
    }));
  }).then(function (users) {
    sendJSON(res, 200, { users: users });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Kon gebruikers niet ophalen: " + err.message });
  });
}

function handleAdminUserDetail(req, res, uid) {
  if (!requireAdmin(req, res)) return;
  Promise.all([
    dbGetDoc("data/users/" + uid + "/prefs"),
    dbGetDoc("data/users/" + uid + "/dishes"),
    dbGetDoc("data/users/" + uid + "/plannedWeeks"),
    dbGetDoc("data/users/" + uid + "/meta")
  ]).then(function (results) {
    var meta = results[3].exists ? results[3].value : null;
    var locationPromise = (meta && meta.lastIp) ? resolveIpLocation(meta.lastIp) : Promise.resolve(null);
    return locationPromise.then(function (location) {
      sendJSON(res, 200, {
        prefs: results[0].exists ? results[0].value : null,
        dishes: results[1].exists ? results[1].value : null,
        plannedWeeks: results[2].exists ? results[2].value : null,
        lastSeenAt: meta ? meta.lastSeenAt : null,
        location: location
      });
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Kon gebruikersdetail niet ophalen: " + err.message });
  });
}

function handleConfig(req, res) {
  getAuthRequired().then(function (required) {
    sendJSON(res, 200, { authRequired: required });
  });
}

function handleAdminSettingsGet(req, res) {
  if (!requireAdmin(req, res)) return;
  getAuthRequired().then(function (required) {
    sendJSON(res, 200, { authRequired: required });
  });
}

function handleAdminSettingsSet(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req).then(function (body) {
    if (!body || typeof body.authRequired !== "boolean") {
      return sendJSON(res, 400, { code: "bad_request", message: "authRequired (true/false) ontbreekt." });
    }
    return setAuthRequired(body.authRequired).then(function () {
      sendJSON(res, 200, { authRequired: body.authRequired });
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Opslaan mislukt: " + (err && err.message ? err.message : "onbekende fout") });
  });
}

function handleAdminStats(req, res) {
  if (!requireAdmin(req, res)) return;
  Promise.all([dbListUserIds(), getUsageToday(), getRecentLogs(LOG_CAP)]).then(function (results) {
    var logStats = computeLogStats(results[2]);
    sendJSON(res, 200, {
      totalUsers: results[0].length,
      usageToday: results[1],
      dailyCap: DAILY_GENERATE_CAP,
      requestsToday: logStats.requestsToday,
      errorsToday: logStats.errorsToday,
      avgDurationMs: logStats.avgDurationMs,
      byAction: logStats.byAction
    });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Kon statistieken niet ophalen: " + err.message });
  });
}

function handleAdminLogs(req, res) {
  if (!requireAdmin(req, res)) return;
  getRecentLogs(100).then(function (logs) {
    sendJSON(res, 200, { logs: logs });
  }).catch(function (err) {
    sendJSON(res, 500, { code: "error", message: "Kon logs niet ophalen: " + err.message });
  });
}

var server = http.createServer(function (req, res) {
  var url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/generate") return handleGenerate(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/register") return handleAuthRegister(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/login") return handleAuthLogin(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/forgot-password") return handleForgotPassword(req, res);
  if (req.method === "POST" && url.pathname === "/api/auth/reset-password") return handleResetPassword(req, res);
  if (req.method === "GET" && url.pathname === "/api/db") return handleDbGet(req, res, url.searchParams);
  if (req.method === "POST" && url.pathname === "/api/db") return handleDbSet(req, res);
  if (req.method === "GET" && url.pathname === "/api/image") return handleImage(req, res, url.searchParams);
  if (req.method === "GET" && url.pathname === "/manifest.json") return serveFile(req, res, "manifest.json");
  if (req.method === "GET" && url.pathname === "/sw.js") return serveFile(req, res, "sw.js");
  if (req.method === "GET" && url.pathname === "/favicon.png") return serveFile(req, res, "favicon.png");
  if (req.method === "GET" && url.pathname.indexOf("/icons/") === 0) return serveFile(req, res, url.pathname);
  if (req.method === "POST" && url.pathname === "/api/admin/login") return handleAdminLogin(req, res);
  if (req.method === "GET" && url.pathname === "/api/config") return handleConfig(req, res);
  if (req.method === "GET" && url.pathname === "/api/admin/settings") return handleAdminSettingsGet(req, res);
  if (req.method === "POST" && url.pathname === "/api/admin/settings") return handleAdminSettingsSet(req, res);
  if (req.method === "GET" && url.pathname === "/api/admin/stats") return handleAdminStats(req, res);
  if (req.method === "GET" && url.pathname === "/api/admin/logs") return handleAdminLogs(req, res);
  if (req.method === "GET" && url.pathname === "/api/admin/users") return handleAdminUsers(req, res);
  if (req.method === "GET" && url.pathname.indexOf("/api/admin/users/") === 0) {
    return handleAdminUserDetail(req, res, decodeURIComponent(url.pathname.slice("/api/admin/users/".length)));
  }
  if (req.method === "GET" && url.pathname === "/admin") return serveFile(req, res, "admin.html");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return serveStatic(req, res);

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, function () {
  console.log("Weekmenu app draait op http://localhost:" + PORT);
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
