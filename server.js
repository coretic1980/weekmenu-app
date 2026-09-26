// Weekmenu app — standalone backend
// Zero external dependencies: only Node's built-in http, fs, path, crypto modules.
// Requires Node.js 18+ (uses the built-in global fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");
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
      var uids = [];
      Object.keys(store.docs).forEach(function (key) {
        var m = key.match(/^data\/users\/([^\/]+)\/prefs$/);
        if (m) uids.push(m[1]);
      });
      return uids;
    }
    return db.collection("docs").find({ _id: { $regex: "^data/users/[^/]+/prefs$" } }).toArray().then(function (docs) {
      return docs.map(function (d) { return d._id.split("/")[2]; });
    });
  });
}

// ---------- Simple admin auth: one shared password, random session tokens kept in memory ----------
// Tokens are lost on server restart (fine for a small personal monitoring tool) and expire after 24h.

var adminTokens = new Map(); // token -> expiry timestamp
var ADMIN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function issueAdminToken() {
  var token = require("crypto").randomBytes(24).toString("hex");
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
    '"bereidingstijd_minuten": 30, "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ["ingredient 1", "ingredient 2"], ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + mealTypes.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
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
    '"bereidingstijd_minuten": 30, "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ["ingredient 1", "ingredient 2"], ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + types.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
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
    '"bereidingstijd_minuten": 30, "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ["ingredient 1", "ingredient 2"], ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}\n' +
    "\"bereidingstijd_minuten\" is de bijgewerkte, realistische totale bereidingstijd in hele minuten, passend bij de opdracht. " +
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

function buildPromptFromRequest(body) {
  var action = body && body.action;
  if (action === "generate") return buildGeneratePrompt(body.params || {});
  if (action === "background") return buildBackgroundGeneratePrompt(body.needed || {}, body.params || {});
  if (action === "variation") return buildVariationPromptServer(body.current || {}, body.kind, body.params || {});
  if (action === "prep") return buildPrepPromptServer(body.dishes || []);
  if (action === "price") return buildPriceEstimatePrompt(body.items || []);
  return null;
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

  if (!ANTHROPIC_API_KEY) {
    logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 500, error: "ANTHROPIC_API_KEY niet ingesteld", ip: ip });
    return sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ANTHROPIC_API_KEY ingesteld." });
  }

  getUsageToday().then(function (usedToday) {
    if (usedToday >= DAILY_GENERATE_CAP) {
      logRequest({ ts: new Date().toISOString(), action: "onbekend", durationMs: Date.now() - startTime, ok: false, status: 429, error: "Dagelijkse limiet bereikt", ip: ip });
      return sendJSON(res, 429, { code: "rate_limited", message: "De dagelijkse limiet voor het genereren van gerechten is bereikt. Probeer het morgen opnieuw." });
    }

    readBody(req).then(function (body) {
      var action = (body && body.action) || "onbekend";
      var prompt = buildPromptFromRequest(body);
      if (!prompt) {
        logRequest({ ts: new Date().toISOString(), action: action, durationMs: Date.now() - startTime, ok: false, status: 400, error: "Ongeldig verzoek", ip: ip });
        return sendJSON(res, 400, { code: "bad_request", message: "Ongeldig verzoek." });
      }
      var goalForValidation = (body.action === "generate" || body.action === "background" || body.action === "variation")
        ? ((body.params && body.params.goal) || null)
        : null;

      return generateWithBalansRetry(prompt, goalForValidation).then(function (parsed) {
        incrementUsageToday();
        logRequest({ ts: new Date().toISOString(), action: action, durationMs: Date.now() - startTime, ok: true, status: 200, ip: ip });
        sendJSON(res, 200, { result: parsed });
      }).catch(function (err) {
        logRequest({ ts: new Date().toISOString(), action: action, durationMs: Date.now() - startTime, ok: false, status: 502, error: err.message, ip: ip });
        sendJSON(res, 502, { code: "error", message: "Genereren mislukt: " + err.message });
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

function handleDbGet(req, res, query) {
  var p = query.get("path");
  if (!p) return sendJSON(res, 400, { message: "path ontbreekt" });
  dbGetDoc(p).then(function (result) {
    sendJSON(res, 200, result);
  }).catch(function (err) {
    sendJSON(res, 500, { message: "Opslag niet bereikbaar: " + err.message });
  });
}

function handleDbSet(req, res) {
  readBody(req).then(function (body) {
    if (!body || !body.path) return sendJSON(res, 400, { message: "path ontbreekt" });
    var ip = clientIp(req);
    var userMatch = body.path.match(/^data\/users\/([^\/]+)\//);
    var trackIp = userMatch
      ? dbSetDoc("data/users/" + userMatch[1] + "/meta", { lastIp: ip, lastSeenAt: new Date().toISOString() }).catch(function () {})
      : Promise.resolve();
    return Promise.all([dbSetDoc(body.path, body.value), trackIp]).then(function () {
      sendJSON(res, 200, { ok: true });
    });
  }).catch(function (err) {
    sendJSON(res, 400, { message: err && err.message ? err.message : "Ongeldige aanvraag." });
  });
}

// ---------- Image lookup (optional — only active if UNSPLASH_ACCESS_KEY is set) ----------

var imageCache = new Map(); // query (lowercased) -> { url, credit } | null, in-memory for this process

function handleImage(req, res, query) {
  var q = (query.get("query") || "").trim();
  if (!q) return sendJSON(res, 400, { message: "query ontbreekt" });

  if (!UNSPLASH_ACCESS_KEY) {
    return sendJSON(res, 200, { url: null, credit: null });
  }

  var cacheKey = q.toLowerCase();
  if (imageCache.has(cacheKey)) {
    return sendJSON(res, 200, imageCache.get(cacheKey));
  }

  var url = "https://api.unsplash.com/search/photos?per_page=1&orientation=landscape&query=" + encodeURIComponent(q + " food dish");
  fetch(url, { headers: { "Authorization": "Client-ID " + UNSPLASH_ACCESS_KEY } })
    .then(function (r) {
      if (!r.ok) throw new Error("Unsplash API error " + r.status);
      return r.json();
    })
    .then(function (data) {
      var photo = data.results && data.results[0];
      var result = photo
        ? {
            url: photo.urls && (photo.urls.small || photo.urls.regular),
            credit: photo.user ? { name: photo.user.name, profileUrl: photo.user.links && photo.user.links.html } : null
          }
        : { url: null, credit: null };
      imageCache.set(cacheKey, result);
      sendJSON(res, 200, result);
    })
    .catch(function () {
      sendJSON(res, 200, { url: null, credit: null });
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
  dbListUserIds().then(function (uids) {
    return Promise.all(uids.map(function (uid) {
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
  if (req.method === "GET" && url.pathname === "/api/db") return handleDbGet(req, res, url.searchParams);
  if (req.method === "POST" && url.pathname === "/api/db") return handleDbSet(req, res);
  if (req.method === "GET" && url.pathname === "/api/image") return handleImage(req, res, url.searchParams);
  if (req.method === "GET" && url.pathname === "/manifest.json") return serveFile(req, res, "manifest.json");
  if (req.method === "GET" && url.pathname === "/sw.js") return serveFile(req, res, "sw.js");
  if (req.method === "GET" && url.pathname === "/favicon.png") return serveFile(req, res, "favicon.png");
  if (req.method === "GET" && url.pathname.indexOf("/icons/") === 0) return serveFile(req, res, url.pathname);
  if (req.method === "POST" && url.pathname === "/api/admin/login") return handleAdminLogin(req, res);
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
