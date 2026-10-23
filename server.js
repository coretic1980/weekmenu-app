// Weekmenu app — standalone backend
// Zero external dependencies: only Node's built-in http, fs, path, crypto modules.
// Requires Node.js 18+ (uses the built-in global fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
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
  { key: "photo", label: "Gerecht van foto", desc: "Een gerecht laten maken op basis van een foto van een bord of een receptpagina (gebruikt de AI).", enforced: "server" },
  { key: "tips", label: "Tips tijdens het wachten", desc: "De weetjes en tips die getoond worden tijdens het genereren.", enforced: "server" },
  { key: "images", label: "Gerechtfoto's", desc: "Foto's bij gerechten (Unsplash) en de foto's in de PDF.", enforced: "server" },
  { key: "sharing", label: "Boodschappenlijst delen", desc: "Nieuwe lijsten delen en bijwerken (WhatsApp/link). Bestaande gedeelde lijsten blijven te lezen en af te vinken.", enforced: "server" },
  { key: "bring", label: "Importeren in Bring!", desc: "De Bring!-import en de pagina's die Bring! ophaalt.", enforced: "server" },
  { key: "pdf", label: "PDF-export", desc: "Het exporteren als PDF. Dit gebeurt in de app zelf: uitzetten verbergt de knoppen.", enforced: "app" },
  { key: "assistant", label: "Balanza-assistent (chat)", desc: "De chat waarin gebruikers vragen stellen en de app laten aanpassen (gebruikt de AI). Uit: de chatknop verdwijnt.", enforced: "server" },
  { key: "community", label: "Community", desc: "Recepten delen met andere gebruikers, bekijken, bewaren en melden.", enforced: "server" },
  { key: "registration", label: "Nieuwe accounts (registreren)", desc: "Zelf een account aanmaken. Uit: alleen jij maakt accounts aan; inloggen blijft werken.", enforced: "server" },
  { key: "passwordReset", label: "Wachtwoord vergeten", desc: "De wachtwoord-vergeten-mail en de resetlink.", enforced: "server" }
];
var MAINTENANCE_OFF_MODULES = ["generate", "photo", "prices", "tips", "sharing", "bring", "registration", "assistant"];
var LIMIT_DEFS = [
  { key: "dailyGenerateCap", label: "Generaties per dag (totaal)", def: DAILY_GENERATE_CAP, min: 0, max: 100000 },
  { key: "monthlyDishCap", label: "Nieuwe gerechten per gebruiker per maand (0 = onbeperkt)", def: MONTHLY_DISH_CAP, min: 0, max: 100000 },
  { key: "perIpHourlyCap", label: "Generaties per uur per IP-adres", def: PER_IP_HOURLY_CAP, min: 0, max: 10000 },
  { key: "dailyTipsCap", label: "Tip-verzoeken per dag (totaal)", def: DAILY_TIPS_CAP, min: 0, max: 100000 },
  { key: "tipsPerIpHourly", label: "Tip-verzoeken per uur per IP-adres", def: TIPS_PER_IP_HOURLY, min: 0, max: 10000 },
  { key: "assistantDailyPerUser", label: "Berichten aan de assistent per gebruiker per dag", def: Number(process.env.ASSISTANT_DAILY_PER_USER) || 40, min: 0, max: 1000 }
];
var liveLimits = {};
LIMIT_DEFS.forEach(function (d) { liveLimits[d.key] = d.def; });

function cleanText(v, max) { return String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, max); }
// Notities mogen regeleinden houden (maximaal één lege regel achter elkaar).
function cleanNote(v, max) {
  return String(v == null ? "" : v).replace(/\r\n?/g, "\n").split("\n").map(function (l) { return l.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim(); }).join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

// ---- Voedingsnieuws: koppen uit een paar betrouwbare bronnen, met link naar het artikel (geen eigen samenvatting) ----
var NEWS_SOURCES = [
  { key: "voedingscentrum", name: "Voedingscentrum", feeds: ["https://feeds.feedburner.com/voedingscentrum"], page: "https://www.voedingscentrum.nl/nl/nieuws.aspx",
    pageRe: /href="((?:https:\/\/www\.voedingscentrum\.nl)?\/nl\/nieuws\/[^"#?]+\.aspx)"[^>]*>([\s\S]*?)<\/a>/g, base: "https://www.voedingscentrum.nl", filter: false },
  { key: "rivm", name: "RIVM", feeds: ["https://www.rivm.nl/nieuws/rss.xml"], filter: true },
  { key: "wur", name: "Wageningen University & Research", feeds: ["https://www.wur.nl/nl/rss?contenttype=nieuws", "https://www.wur.nl/UK/rss?contenttype=nieuws"], filter: true }
];
// RIVM en WUR schrijven over veel meer dan eten: alleen berichten die over voeding gaan.
var NEWS_TOPIC_RE = /voeding|voedsel|\beten\b|\beet\b|maaltijd|dieet|schijf van vijf|\bzout|suiker|vezels|groente|fruit|\bvlees|\bvis\b|alcohol|overgewicht|obesitas|gewicht|vitamine|eiwit|koolhydra|\bvet(ten)?\b|keuken|recept|supermarkt|lunch|ontbijt|diabetes|cholesterol|bloeddruk|\bdarm/i;
var NEWS_TTL_MS = 6 * 3600 * 1000;
var newsCache = { items: [], fetchedAt: 0, status: {}, loading: null };
function cleanNewsUrl(v) {
  var u = String(v == null ? "" : v).trim();
  if (/^http:\/\//i.test(u)) u = "https://" + u.slice(7);
  return /^https:\/\/[^\s"<>]+$/i.test(u) && u.length <= 500 ? u : "";
}
function newsDecode(t) {
  return String(t || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function newsTag(block, tag) {
  var m = block.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + tag + ">", "i"));
  return m ? m[1] : "";
}
function parseNewsFeed(xml) {
  var out = [], blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  blocks.forEach(function (b) {
    var link = newsDecode(newsTag(b, "feedburner:origLink")) || newsDecode(newsTag(b, "link"));
    if (!link) { var lm = b.match(/<link[^>]+href="([^"]+)"/i); if (lm) link = lm[1]; }
    if (!link) link = newsDecode(newsTag(b, "guid"));
    var date = newsTag(b, "pubDate") || newsTag(b, "published") || newsTag(b, "updated") || newsTag(b, "dc:date");
    var d = date ? new Date(newsDecode(date)) : null;
    out.push({ title: newsDecode(newsTag(b, "title")), url: link, date: d && !isNaN(d) ? d.toISOString() : "", text: newsDecode(newsTag(b, "description") || newsTag(b, "summary")) });
  });
  return out;
}
function parseNewsPage(html, src) {
  var out = [], seen = {}, m;
  src.pageRe.lastIndex = 0;
  while ((m = src.pageRe.exec(html)) && out.length < 30) {
    var url = m[1].indexOf("http") === 0 ? m[1] : src.base + m[1];
    var title = newsDecode(m[2]);
    if (seen[url] || title.length < 12) continue;
    seen[url] = 1; out.push({ title: title, url: url, date: "", text: "" });
  }
  return out;
}
function newsFetchText(url) {
  var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 10000);
  if (process.env.NEWS_TEST_URL) url = process.env.NEWS_TEST_URL + "/" + encodeURIComponent(url);   // alleen voor tests
  return fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Balanza/1.0 (voedingsnieuws)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8" } })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .finally(function () { clearTimeout(t); });
}
// Labels waarmee de app berichten overslaat die niet bij iemand passen (bijv. vlees bij vegetariërs).
function newsTags(title, text) {
  var all = (title + " " + text).toLowerCase(), tags = [];
  if (/\bvlees|rundvlees|varkens|\bkip\b|worst|vleeswaren/.test(all)) tags.push("vlees");
  if (/\bvis\b|zalm|haring|makreel|tonijn/.test(all)) tags.push("vis");
  if (/alcohol|\bbier\b|\bwijn\b/.test(all)) tags.push("alcohol");
  if (/zwanger|moedermelk|borstvoeding|\bbaby/.test(all)) tags.push("zwanger");
  return tags;
}
// Alleen Nederlandstalige koppen: Engelse koppen (met typisch Engelse woorden en geen Nederlandse) vallen af.
function looksDutch(t) { return !/\b(the|and|of|with|for|how|why|what|new|study)\b/i.test(t) || /\b(de|het|een|en|van|voor|met|op|te|is|bij|niet|meer|minder)\b/i.test(t); }
function fetchNewsSource(src) {
  var tryFeed = function (i) {
    if (i >= src.feeds.length) return Promise.reject(new Error("geen werkende feed"));
    return newsFetchText(src.feeds[i]).then(function (xml) {
      var items = parseNewsFeed(xml);
      if (!items.length) throw new Error("lege feed");
      return items;
    }).catch(function (e) { if (i + 1 >= src.feeds.length) throw e; return tryFeed(i + 1); });
  };
  return tryFeed(0).catch(function (e) {
    if (!src.page) throw e;
    return newsFetchText(src.page).then(function (html) { var it = parseNewsPage(html, src); if (!it.length) throw new Error("geen berichten op de nieuwspagina"); return it; });
  }).then(function (items) {
    return items.filter(function (it) {
      if (!it.title || !cleanNewsUrl(it.url) || !looksDutch(it.title)) return false;
      return !src.filter || NEWS_TOPIC_RE.test(it.title + " " + it.text);
    }).slice(0, 15).map(function (it) {
      var url = cleanNewsUrl(it.url);
      return { id: crypto.createHash("sha1").update(url).digest("hex").slice(0, 12), src: src.key, srcName: src.name, title: it.title.slice(0, 200),
        url: url, date: it.date, text: it.text.slice(0, 240), tags: newsTags(it.title, it.text) };
    });
  });
}
function refreshNews(force) {
  if (newsCache.loading) return newsCache.loading;
  if (!force && Date.now() - newsCache.fetchedAt < NEWS_TTL_MS) return Promise.resolve(newsCache);
  newsCache.loading = getSettings().then(function (s) {
    var srcs = NEWS_SOURCES.filter(function (x) { return s.news["src_" + x.key]; });
    var prevById = {}; newsCache.items.forEach(function (it) { prevById[it.id] = it; });
    return Promise.all(srcs.map(function (src) {
      return fetchNewsSource(src).then(function (items) { newsCache.status[src.key] = { ok: true, n: items.length, at: new Date().toISOString() }; return items; },
        function (e) {
          newsCache.status[src.key] = { ok: false, error: String(e && e.message || e).slice(0, 120), at: new Date().toISOString() };
          return newsCache.items.filter(function (it) { return it.src === src.key; });   // bij een storing de vorige berichten houden
        });
    })).then(function (lists) {
      var now = new Date().toISOString(), items = [];
      // Zonder datum (nieuwspagina): de datum waarop Balanza het bericht voor het eerst zag.
      lists.forEach(function (l) { l.forEach(function (it) { if (!it.date) it.date = prevById[it.id] && prevById[it.id].date || now; items.push(it); }); });
      items.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      newsCache.items = items.slice(0, 60); newsCache.fetchedAt = Date.now();
      logEvent("news", "refresh", true, 200, { n: newsCache.items.length });
      return dbSetDoc("news/cache", { items: newsCache.items, fetchedAt: newsCache.fetchedAt, status: newsCache.status }).catch(function () {});
    });
  }).then(function () { newsCache.loading = null; return newsCache; }, function (e) { newsCache.loading = null; throw e; });
  return newsCache.loading;
}
var newsLoadedFromDb = false;
function loadNewsCache() {
  if (newsLoadedFromDb) return Promise.resolve();
  newsLoadedFromDb = true;
  return dbGetDoc("news/cache").then(function (r) {
    if (r.exists && r.value && Array.isArray(r.value.items) && !newsCache.fetchedAt) { newsCache.items = r.value.items; newsCache.fetchedAt = r.value.fetchedAt || 0; newsCache.status = r.value.status || {}; }
  }).catch(function () {});
}
function handleNews(req, res) {
  return Promise.all([getSettings(), loadNewsCache()]).then(function (r) {
    var s = r[0];
    if (!s.news.enabled) return sendJSON(res, 200, { enabled: false, items: [] });
    var stale = Date.now() - newsCache.fetchedAt >= NEWS_TTL_MS;
    var wait = Promise.resolve();
    if (stale && !newsCache.items.length) wait = refreshNews().catch(function () {});
    else if (stale) refreshNews().catch(function () {});   // op de achtergrond verversen; nu de bewaarde berichten geven
    return wait.then(function () {
      var on = {}; NEWS_SOURCES.forEach(function (x) { on[x.key] = s.news["src_" + x.key]; });
      var items = newsCache.items.filter(function (it) { return on[it.src]; }).slice(0, 30);
      var pin = s.news.pinTitle ? { id: "pin" + crypto.createHash("sha1").update(s.news.pinAt + s.news.pinTitle).digest("hex").slice(0, 8), src: "balanza", srcName: "Balanza",
        title: s.news.pinTitle, url: s.news.pinUrl, text: s.news.pinText, date: s.news.pinAt, tags: [], pinned: true } : null;
      sendJSON(res, 200, { enabled: true, items: items, pin: pin });
    });
  }).catch(function () { sendJSON(res, 200, { enabled: true, items: [] }); });
}
function handleAdminNews(req, res, refresh) {
  return loadNewsCache().then(function () { return refresh ? refreshNews(true).catch(function () {}) : null; }).then(function () {
    sendJSON(res, 200, { fetchedAt: newsCache.fetchedAt ? new Date(newsCache.fetchedAt).toISOString() : null, status: newsCache.status,
      sources: NEWS_SOURCES.map(function (x) { return { key: x.key, name: x.name }; }),
      items: newsCache.items.slice(0, 20).map(function (it) { return { src: it.srcName, title: it.title, url: it.url, date: it.date }; }) });
  });
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
    billing: { enabled: b.enabled === true, plusMonthlyCents: intIn(b.plusMonthlyCents, 100, 99900, 399), plusYearlyCents: intIn(b.plusYearlyCents, 100, 999900, 3499), plusDishCap: intIn(b.plusDishCap, 0, 100000, 150), termsUrl: cleanTermsUrl(b.termsUrl), trialEnabled: b.trialEnabled === true, trialDays: intIn(b.trialDays, 1, 60, 7) },
    maintenance: { enabled: m.enabled === true, message: cleanText(m.message, 300) },
    announcement: { enabled: a.enabled === true, message: cleanText(a.message, 300), level: a.level === "warning" ? "warning" : "info" },
    privacy: (function () {
      var pv = raw.privacy && typeof raw.privacy === "object" ? raw.privacy : {};
      return { company: cleanText(pv.company, 120), address: cleanText(pv.address, 200), kvk: cleanText(pv.kvk, 20), email: cleanText(pv.email, 120),
        version: intIn(pv.version, 1, 999, 1), updatedOn: /^\d{4}-\d{2}-\d{2}$/.test(pv.updatedOn || "") ? pv.updatedOn : "2026-10-20" };
    })(),
    news: (function () {
      var nw = raw.news && typeof raw.news === "object" ? raw.news : {};
      var o = { enabled: nw.enabled !== false };
      NEWS_SOURCES.forEach(function (src) { o["src_" + src.key] = nw["src_" + src.key] !== false; });
      o.pinTitle = cleanText(nw.pinTitle, 160); o.pinUrl = cleanNewsUrl(nw.pinUrl); o.pinText = cleanText(nw.pinText, 280);
      o.pinAt = /^\d{4}-\d{2}-\d{2}T/.test(nw.pinAt || "") ? nw.pinAt : "";
      return o;
    })()
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
  ["modules", "planOnly", "limits", "maintenance", "announcement", "billing", "privacy", "news"].forEach(function (k) {
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
      else if (bk === "trialEnabled") { if (typeof bl.trialEnabled !== "boolean") return { error: "billing.trialEnabled moet true of false zijn." }; patch.billing.trialEnabled = bl.trialEnabled; n++; }
      else if (bk === "trialDays") { if (typeof bl.trialDays !== "number" || Math.floor(bl.trialDays) !== bl.trialDays || bl.trialDays < 1 || bl.trialDays > 60) return { error: "De proefperiode moet tussen 1 en 60 dagen zijn." }; patch.billing.trialDays = bl.trialDays; n++; }
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
  if (body.privacy !== undefined) {
    var pv = body.privacy;
    if (!pv || typeof pv !== "object" || Array.isArray(pv)) return { error: "privacy moet een object zijn." };
    patch.privacy = {};
    var PV = { company: 120, address: 200, kvk: 20, email: 120 };
    for (var pk2 of Object.keys(pv)) {
      if (PV[pk2]) { if (typeof pv[pk2] !== "string") return { error: "Privacy: " + pk2 + " moet tekst zijn." }; patch.privacy[pk2] = cleanText(pv[pk2], PV[pk2]); n++; }
      else if (pk2 === "version") { if (typeof pv.version !== "number" || Math.floor(pv.version) !== pv.version || pv.version < 1 || pv.version > 999) return { error: "De versie van de privacyverklaring moet een geheel getal zijn." }; patch.privacy.version = pv.version; patch.privacy.updatedOn = todayKey(); n++; }
      else return { error: "Onbekende privacy-instelling: " + pk2 + "." };
    }
    if (patch.privacy.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.privacy.email)) return { error: "Het e-mailadres voor privacyvragen is ongeldig." };
  }
  if (body.news !== undefined) {
    var nw = body.news;
    if (!nw || typeof nw !== "object" || Array.isArray(nw)) return { error: "news moet een object zijn." };
    patch.news = {};
    for (var nk of Object.keys(nw)) {
      if (nk === "enabled" || /^src_/.test(nk)) {
        if (nk !== "enabled" && !NEWS_SOURCES.some(function (x) { return "src_" + x.key === nk; })) return { error: "Onbekende nieuwsbron: " + nk.slice(4) + "." };
        if (typeof nw[nk] !== "boolean") return { error: "Nieuws: " + nk + " moet true of false zijn." };
        patch.news[nk] = nw[nk]; n++;
      } else if (nk === "pinTitle" || nk === "pinText" || nk === "pinUrl") {
        if (typeof nw[nk] !== "string") return { error: "Nieuws: " + nk + " moet tekst zijn." };
        if (nk === "pinUrl") { var pu = cleanNewsUrl(nw.pinUrl); if (nw.pinUrl.trim() && !pu) return { error: "De link van het eigen bericht moet met https:// beginnen." }; patch.news.pinUrl = pu; }
        else patch.news[nk] = cleanText(nw[nk], nk === "pinTitle" ? 160 : 280);
        patch.news.pinAt = new Date().toISOString(); n++;
      } else return { error: "Onbekende nieuwsinstelling: " + nk + "." };
    }
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

// Met het proefmodel aan is een account altijd nodig: anoniem gebruik kan dan niet meer (alleen de welkomstpagina).
function authRequiredFor(s) { return !!(s.authRequired || (s.billing && s.billing.trialEnabled)); }
function getAuthRequired() { return getSettings().then(authRequiredFor); }
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

function issueAdminToken(uid, email) {
  var token = crypto.randomBytes(24).toString("hex");
  // Via de app (single sign-on) een kortere sessie, gekoppeld aan de gebruiker zodat intrekken hem meteen beëindigt.
  adminTokens.set(token, { exp: Date.now() + (uid ? ADMIN_SSO_TTL_MS : ADMIN_TOKEN_TTL_MS), uid: uid || null, email: email || null });
  return token;
}
function isValidAdminToken(token) {
  if (!token) return false;
  var t = adminTokens.get(token);
  if (!t) return false;
  if (Date.now() > t.exp) { adminTokens.delete(token); return false; }
  return true;
}
function adminTokenUid(token) { var t = adminTokens.get(token); return t ? t.uid : null; }
function dropAdminTokensOf(uid) { adminTokens.forEach(function (t, k) { if (t.uid === uid) adminTokens.delete(k); }); }

// ---------- Beheerders via de app (single sign-on) ----------
// De beheerder (met het wachtwoord) wijst gebruikers aan in settings/admins. Zo'n gebruiker opent het beheer vanuit
// Instellingen: de app vraagt met zijn eigen sessie een eenmalige code aan (60 s geldig), het beheer wisselt die in
// voor een beheersessie van 8 uur. Geen wachtwoord, en de code staat niet in de geschiedenis.
var ADMIN_SSO_TTL_MS = 8 * 60 * 60 * 1000;
var ssoCodes = new Map();   // code -> { uid, email, exp }
function getAdminUids() {
  return dbGetDoc("settings/admins").then(function (r) { var v = r.exists && r.value && r.value.uids && typeof r.value.uids === "object" ? r.value.uids : {}; return v; }).catch(function () { return {}; });
}
function isAppAdmin(user) {
  if (!user || !user.email) return Promise.resolve(false);
  return Promise.all([getAdminUids(), getBlocked()]).then(function (r) { return !!r[0][user.uid] && !r[1].uids[user.uid]; });
}
function setAppAdmin(uid, email, on) {
  return dbGetDoc("settings/admins").then(function (r) {
    var v = r.exists && r.value && r.value.uids ? r.value : { uids: {} };
    if (on) v.uids[uid] = { email: email || null, grantedAt: new Date().toISOString() }; else delete v.uids[uid];
    return dbSetDoc("settings/admins", v);
  }).then(function () { if (!on) dropAdminTokensOf(uid); });
}
// POST /api/admin/sso  (met de gewone sessie van de gebruiker) -> { code }
function handleAdminSsoStart(req, res) {
  var ip = clientIp(req), wait = adminLockedFor(ip);
  if (wait) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel pogingen. Probeer het over " + Math.ceil(wait / 60) + " min opnieuw." });
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return isAppAdmin(user).then(function (ok) {
      if (!ok) { adminRegisterFail(ip); auditLog(req, "admin.sso-geweigerd", user.uid, { email: user.email || null }); return sendJSON(res, 403, { code: "forbidden", message: "Je hebt geen toegang tot het beheer." }); }
      var code = crypto.randomBytes(18).toString("base64url");
      ssoCodes.set(code, { uid: user.uid, email: user.email, exp: Date.now() + 60000 });
      ssoCodes.forEach(function (v, k) { if (v.exp < Date.now()) ssoCodes.delete(k); });
      sendJSON(res, 200, { code: code });
    });
  }).catch(function () { sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." }); });
}
// POST /api/admin/sso/exchange { code } -> { token, email }
function handleAdminSsoExchange(req, res) {
  var ip = clientIp(req), wait = adminLockedFor(ip);
  if (wait) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel pogingen. Probeer het over " + Math.ceil(wait / 60) + " min opnieuw." });
  return readBody(req).then(function (body) {
    var code = body && typeof body.code === "string" ? body.code : "";
    var c = ssoCodes.get(code);
    ssoCodes.delete(code);   // eenmalig
    if (!c || c.exp < Date.now()) { adminRegisterFail(ip); return sendJSON(res, 401, { code: "unauthorized", message: "Deze inloglink is verlopen. Open het beheer opnieuw vanuit de app." }); }
    return isAppAdmin({ uid: c.uid, email: c.email }).then(function (ok) {   // nog steeds beheerder?
      if (!ok) return sendJSON(res, 403, { code: "forbidden", message: "Je hebt geen toegang (meer) tot het beheer." });
      adminFails.delete(ip);
      auditLog(req, "admin.login-via-app", c.uid, { email: c.email });
      sendJSON(res, 200, { token: issueAdminToken(c.uid, c.email), email: c.email });
    });
  }).catch(function () { sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." }); });
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

// "Wissel eiwitbron": bij vegetarisch/veganistisch een andere plantaardige vervanger, anders een andere soort vlees of vis.
function variationInstructionText(kind, p) {
  if (kind !== "wisseleiwit") return VARIATION_INSTRUCTIONS[kind] || "";
  p = p || {};
  var hl = healthWithExclude(p.health, p.exclude);
  var style = p.dietStyle, puur = hl.indexOf("puur") > -1, glutenvrij = hl.indexOf("glutenvrij") > -1, lactosevrij = hl.indexOf("lactosevrij") > -1;
  var keep = " Pas de rest van het gerecht (groente, kruiden, saus, bereiding) waar nodig aan zodat het goed bij de nieuwe eiwitbron past, " +
    "geef het gerecht een naam die bij de nieuwe eiwitbron hoort en behoud ongeveer dezelfde kcal en macroverdeling.";
  // De app geeft mee wat voor eiwitbron het gerecht nu heeft: dan wisselen we binnen die soort (geen vlees erbij in een vega gerecht).
  if (p.proteinKind === "vega" && style !== "Vegetarisch" && style !== "Veganistisch") {
    return "Vervang de huidige plantaardige hoofd-eiwitbron (vleesvervanger of peulvrucht) door een duidelijk ANDERE plantaardige eiwitbron " +
      "(bijv. " + (glutenvrij ? "" : "seitan, ") + "tofu, tempeh, vegetarisch gehakt, linzen, kikkererwten of bonen). Gebruik géén vlees of vis." + keep;
  }
  if (p.proteinKind === "anders") {
    return "Vervang de hoofd-eiwitbron (zoals ei, kwark, yoghurt of kaas) door een duidelijk ANDERE eiwitbron die bij dit soort gerecht past " +
      "(bijv. skyr in plaats van yoghurt, ei in plaats van kaas, cottage cheese, tofu of peulvruchten)" +
      (style === "Veganistisch" ? "; alles plantaardig" : "") + ". Voeg geen vlees of vis toe." + keep;
  }
  if (style === "Vegetarisch" || style === "Veganistisch") {
    var opties = puur
      ? "tofu, tempeh, peulvruchten (linzen, kikkererwten, bonen), edamame" + (style === "Vegetarisch" ? (lactosevrij ? ", eieren" : ", eieren of een naturel zuivelproduct") : "")
      : (glutenvrij ? "" : "seitan, ") + "tofu, tempeh, vegetarisch gehakt of vegetarische reepjes, mycoproteïne, lupine, peulvruchten" + (style === "Vegetarisch" ? (lactosevrij ? ", eieren" : ", eieren of halloumi") : "");
    return "Vervang de huidige vleesvervanger of plantaardige hoofd-eiwitbron door een duidelijk ANDERE " + style.toLowerCase() + "e eiwitbron (bijv. " + opties + "). " +
      "Gebruik géén vlees of vis." + keep;
  }
  return "Vervang het vlees of de vis (de hoofd-eiwitbron) door een duidelijk ANDERE soort dierlijk vlees, gevogelte of vis " +
    "(bijv. kip in plaats van rundvlees, zalm in plaats van kip, garnalen in plaats van varkenshaas). Is het gerecht nu zonder vlees of vis, " +
    "kies dan een passende vlees- of vissoort als hoofd-eiwitbron; bij ontbijt of snack mag dat ook ei" + (lactosevrij ? " of lactosevrije kwark" : ", magere kwark of skyr") + " zijn." +
    (puur ? " Kies onbewerkt vlees of vis, geen vleeswaren of worst." : "") + keep;
}

var FOTO_TERM_LINE = "\"foto_zoekterm\" is een korte Engelse zoekterm (2 tot 4 woorden) om een passende stockfoto van dit gerecht te vinden: " +
  "noem het hoofdingrediënt en het soort gerecht, zonder bijvoeglijke naamwoorden als pittig, gastronomisch of huisgemaakt " +
  "(bijv. \"grilled salmon asparagus\" of \"chicken curry rice\"). ";

var INGREDIENT_SPECIFICITY_LINE = "Elk ingrediënt moet specifiek en concreet benoemd zijn (bijv. \"1 tl oregano\" of \"2 tenen knoflook\"), " +
  "nooit een vaag verzamelwoord zoals \"kruiden\" of \"specerijen\" zonder te specificeren welke.\n";

function mealKcalRange(mealType, goal) {
  var g = MEALTYPE_GUIDE[mealType] || MEALTYPE_GUIDE["Diner"];
  var mult = GOAL_KCAL_MULTIPLIER[goal] || 1;
  var min = Math.max(80, Math.round(g.min * mult / 10) * 10);
  var max = Math.max(min + 40, Math.round(g.max * mult / 10) * 10);
  return { min: min, max: max };
}
function mealtypeGuideText(mealType, goal) {
  var g = MEALTYPE_GUIDE[mealType] || MEALTYPE_GUIDE["Diner"];
  var r = mealKcalRange(mealType, goal);
  return r.min + "-" + r.max + " kcal per portie (harde grens, nagerekend met NEVO); " + g.desc;
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

// ===== Gezondheidsfilters (combineerbaar met elke voedingsstijl) =====
// prefs.health = lijst sleutels; prefs.sugarMode = "natuurlijk" (honing e.d. met mate) of "strikt" (alleen fruit en dadels).
var HEALTH_KEYS = ["puur", "suikervrij", "glutenvrij", "lactosevrij", "volkoren", "zoutbewust"];
var HEALTH_LABELS = { puur: "onbewerkt", suikervrij: "zonder geraffineerde suiker", glutenvrij: "glutenvrij", lactosevrij: "lactosevrij", volkoren: "volkoren en vezelrijk", zoutbewust: "zoutbewust" };
// Uitsluitingen die we als harde gezondheidsfilter behandelen (ook voor oudere app-versies en community-matching).
var EXCLUDE_TO_HEALTH = { gluten: "glutenvrij", lactose: "lactosevrij" };
var NATURAL_SWEET_RE = /\b(honing\w*|ahornsiroop|maple\s?siroop|maplesiroop|kokosbloesemsuiker|dadelsiroop|dadelstroop)\b/i;
function cleanHealth(v) {
  return (Array.isArray(v) ? v : []).filter(function (k, i, a) { return HEALTH_KEYS.indexOf(k) > -1 && a.indexOf(k) === i; });
}
function cleanSugarMode(v) { return v === "strikt" ? "strikt" : "natuurlijk"; }
// prefs.cheeseMode: "hardekaas" (lang gerijpte, vrijwel lactosevrije kaas mag) of "geen" (helemaal geen gewone kaas).
function cleanCheeseMode(v) { return v === "geen" ? "geen" : "hardekaas"; }
function excludeTokensServer(v) {
  return String(v || "").toLowerCase().split(/[,;\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
}
function healthWithExclude(health, exclude) {
  var list = cleanHealth(health);
  excludeTokensServer(exclude).forEach(function (t) { var k = EXCLUDE_TO_HEALTH[t]; if (k && list.indexOf(k) === -1) list.push(k); });
  return list;
}
// ---- Vlees, gevogelte en vis die iemand niet eet (prefs.proteinOut). Standaard eet je alles; bij vegetarisch/veganistisch telt dit niet. ----
var PROTEIN_GROUPS = [
  ["Vlees", [["varken", "Varken"], ["rund", "Rund"], ["kalf", "Kalf"], ["lam", "Lam en geit"], ["wild", "Wild"]]],
  ["Gevogelte", [["kip", "Kip"], ["kalkoen", "Kalkoen"], ["eend", "Eend en gans"]]],
  ["Vis", [["witvis", "Witvis"], ["vettevis", "Vette vis"], ["schaal", "Schaal- en schelpdieren"]]]
];
var PROTEIN_KEYS = [].concat.apply([], PROTEIN_GROUPS.map(function (g) { return g[1].map(function (x) { return x[0]; }); }));
var PROTEIN_LABEL = {}; PROTEIN_GROUPS.forEach(function (g) { g[1].forEach(function (x) { PROTEIN_LABEL[x[0]] = x[1].toLowerCase(); }); });
var PROTEIN_TEXT = {
  varken: "varkensvlees en alles daarvan (spek, bacon, ham, parmaham, chorizo, salami, pancetta, worst van varkensvlees, half-om-half gehakt, karbonade, varkenshaas, spareribs)",
  rund: "rundvlees (biefstuk, ossenhaas, entrecote, rundergehakt, half-om-half gehakt, riblappen, rosbief, hamburgers van rund, carpaccio)",
  kalf: "kalfsvlees", lam: "lams-, schapen- en geitenvlees", wild: "wild (hert, ree, wildzwijn, haas, konijn, fazant, parelhoen)",
  kip: "kip (kipfilet, kippendij, kipgehakt, kippenbouillon)", kalkoen: "kalkoen (kalkoenfilet, kalkoengehakt, kalkoenfilet als beleg)", eend: "eend en gans",
  witvis: "witvis (kabeljauw, koolvis, schelvis, wijting, tilapia, pangasius, heek, schol, zeebaars, dorade, tarbot, lekkerbek, kibbeling)",
  vettevis: "vette vis (zalm, makreel, haring, sardines, ansjovis, forel, tonijn, paling, bokking)",
  schaal: "schaal- en schelpdieren (garnalen, gamba's, kreeft, krab, mosselen, oesters, sint-jakobsschelpen, inktvis, octopus, surimi)"
};
var PROTEIN_RE = {
  varken: /\b(varken\w*|\w*spek\w*|bacon|ham|hammen|\w+ham|chorizo|salami|pancetta|prosciutto|speklap\w*|karbonade\w*|procureur|spareribs?|ribbetjes|rookworst|braadworst|half[- ]om[- ]half|carnitas|pulled pork|mortadella|cervelaat|guanciale|lardon\w*)\b/i,
  rund: /\b(rund\w*|biefstuk\w*|ossenhaas|entrecote|rib-?eye|sukade|riblap\w*|kogelbiefstuk|rosbief|carpaccio|tartaar|bavette|hamburger\w*|half[- ]om[- ]half|ossenstaart|stoofvlees|runder\w*|kalfs?\w*|steak|t-bone|picanha)\b/i,
  kalf: /\b(kalf\w*|kalfs\w*|vitello\w*)\b/i,
  lam: /\b(lam|lams\w*|lamsvlees|schaap\w*|schapen\w*|geitenvlees|geitenbout|mutton)\b/i,
  wild: /\b(hert\w*|ree|reebout|reerug|wildzwijn\w*|everzwijn\w*|haas|hazen\w*|konijn\w*|fazant\w*|parelhoen\w*|wildstoof\w*)\b/i,
  kip: /\b(kip\w*|kippe\w*|haantje\w*|poulet\w*|chicken)\b/i,
  kalkoen: /\b(kalkoen\w*)\b/i,
  eend: /\b(eend\w*|eende\w*|gans|ganzen\w*)\b/i,
  witvis: /\b(kabeljauw\w*|koolvis\w*|schelvis\w*|wijting\w*|tilapia\w*|pangasius\w*|heek\w*|schol\w*|zeebaars\w*|zeebrasem\w*|dorade\w*|tarbot\w*|griet|witvis\w*|vissticks?|lekkerbek\w*|kibbeling\w*|pollak|vispakket\w*|visfilet\w*)\b/i,
  vettevis: /\b(zalm\w*|makreel\w*|haring\w*|sardien\w*|sardine\w*|ansjovis\w*|forel\w*|tonijn\w*|paling\w*|sprot\w*|bokking\w*|zwaardvis\w*|vissaus)\b/i,
  schaal: /\b(garnal\w*|gamba\w*|scampi|kreeft\w*|krab\w*|mossel\w*|oester\w*|sint[- ]jakobsschelp\w*|coquille\w*|inktvis\w*|calamari|octopus|kokkel\w*|langoustine\w*|surimi|rivierkreeft\w*|vongole)\b/i
};
// rund-regex vangt ook kalf (kalfsvlees is rund); dat is goed: wie geen rund eet, eet meestal ook geen kalf.
// Oude "wat wil je niet eten"-termen tellen ook mee (voor apps die nog niet zijn bijgewerkt).
var EXCLUDE_TO_PROTEIN = { "vis": ["witvis", "vettevis", "schaal"], "schaal- en schelpdieren": ["schaal"], "schaaldieren": ["schaal"], "schelpdieren": ["schaal"],
  "varkensvlees": ["varken"], "varken": ["varken"], "rundvlees": ["rund"], "kip": ["kip"], "kalkoen": ["kalkoen"], "lamsvlees": ["lam"],
  "gevogelte": ["kip", "kalkoen", "eend"], "vlees": ["varken", "rund", "kalf", "lam", "wild"] };
function cleanProteinOut(v, style, exclude) {
  if (style === "Vegetarisch" || style === "Veganistisch") return [];
  var list = (Array.isArray(v) ? v : []).slice();
  excludeTokensServer(exclude).forEach(function (t) { (EXCLUDE_TO_PROTEIN[t] || []).forEach(function (k) { list.push(k); }); });
  return list.filter(function (k, i, a) { return PROTEIN_KEYS.indexOf(k) > -1 && a.indexOf(k) === i; });
}
// Eén object met alle harde eetregels; generateWithBalansRetry accepteert ook nog een losse voedingsstijl (tekst).
function dietRulesFromParams(p) {
  p = p || {};
  var style = typeof p.dietStyle === "string" ? p.dietStyle : "";
  return { style: style, health: healthWithExclude(p.health, p.exclude), sugarMode: cleanSugarMode(p.sugarMode),
    cheeseMode: cleanCheeseMode(p.cheeseMode), exclude: typeof p.exclude === "string" ? p.exclude.trim().slice(0, 300) : "", proteinOut: cleanProteinOut(p.proteinOut, style, p.exclude) };
}
function asDietRules(v) {
  if (v && typeof v === "object") return { style: v.style || "", health: cleanHealth(v.health), sugarMode: cleanSugarMode(v.sugarMode), cheeseMode: cleanCheeseMode(v.cheeseMode), exclude: v.exclude || "", proteinOut: cleanProteinOut(v.proteinOut, v.style) };
  return { style: typeof v === "string" ? v : "", health: [], sugarMode: "natuurlijk", cheeseMode: "hardekaas", exclude: "", proteinOut: [] };
}
function hasHealth(rules, k) { return !!(rules && rules.health && rules.health.indexOf(k) > -1); }
function hasProteinOut(rules) { return !!(rules && rules.proteinOut && rules.proteinOut.length); }
function healthChecked(rules) { return hasHealth(rules, "puur") || hasHealth(rules, "suikervrij") || hasHealth(rules, "glutenvrij") || hasHealth(rules, "lactosevrij") || hasProteinOut(rules); }
function rulesActive(rules) { return !!(DIET_FORBIDDEN_TEXT[rules.style] || healthChecked(rules)); }

function healthHardRuleText(p) {
  var rules = p && p.style !== undefined ? asDietRules(p) : dietRulesFromParams(p);   // params of een regels-object
  if (!rules.health.length && !hasProteinOut(rules)) return "";
  var lines = [];
  if (hasProteinOut(rules)) lines.push("EET DIT NIET (harde eis): " + rules.proteinOut.map(function (k) { return PROTEIN_TEXT[k]; }).join("; ") +
    ". Ook niet als bouillon, saus of beleg. Kies een andere eiwitbron die de gebruiker wel eet" +
    (PROTEIN_KEYS.every(function (k) { return rules.proteinOut.indexOf(k) > -1; }) ? " (peulvruchten, tofu, tempeh, eieren, zuivel)" : "") + ".");
  if (hasHealth(rules, "glutenvrij")) lines.push("GLUTENVRIJ (harde eis): geen tarwe, spelt, rogge, gerst, kamut, bulgur, couscous, seitan, gewone pasta, noedels van tarwe, brood, wraps, " +
    "pita, paneermeel, bloem, gewone sojasaus of ketjap. Gebruik rijst, quinoa, boekweit, gierst, aardappel, zoete aardappel, maïs(tortilla), rijst- of glasnoedels, " +
    "glutenvrije pasta, tamari en glutenvrije havermout. Noem bij haver en pasta expliciet \"glutenvrij\".");
  if (hasHealth(rules, "lactosevrij")) lines.push("LACTOSEVRIJ (harde eis): geen melk, karnemelk, room, slagroom, kookroom, zure room, crème fraîche, yoghurt, kwark, skyr, " +
    "roomboter, roomkaas, verse of zachte kaas (mozzarella, burrata, feta, ricotta, mascarpone, hüttenkäse, geitenkaas, halloumi), melkchocolade, wei of melkpoeder. " +
    (rules.cheeseMode === "geen"
      ? "Ook geen gewone harde kaas: gebruik alleen lactosevrije kaas of een plantaardig alternatief. "
      : "Lang gerijpte harde kaas (parmezaan, pecorino, oude of belegen Goudse, gruyère, comté, emmentaler) mag met mate; die bevat vrijwel geen lactose. ") +
    "Gebruik lactosevrije zuivel (noem die expliciet \"lactosevrij\", bijv. \"150 g lactosevrije kwark\"), plantaardige varianten (sojadrink, havermelk, kokosmelk, sojayoghurt) of olijfolie/ghee in plaats van boter.");
  if (hasHealth(rules, "suikervrij")) lines.push("ZONDER GERAFFINEERDE SUIKER (harde eis): geen witte, bruine of rietsuiker, basterdsuiker, poedersuiker, glucose- of fructosestroop, " +
    "agavesiroop, jam, ketchup, zoete sauzen (sweet chili, teriyaki, hoisin, barbecue, ketjap), frisdrank of melkchocolade. " +
    (rules.sugarMode === "strikt"
      ? "Ook geen honing, ahornsiroop, kokosbloesemsuiker of dadelsiroop: zoet alleen met vers of gedroogd fruit (bijv. banaan, dadels, appel)."
      : "Zoeten mag met vers of gedroogd fruit en hoogstens 1 tl honing, ahornsiroop of kokosbloesemsuiker per portie."));
  if (hasHealth(rules, "puur")) lines.push("ONBEWERKT (harde eis): kook met verse, onbewerkte basisproducten. Geen kant-en-klare sauzen of pastasaus uit pot, mixen, pakjes of zakjes, " +
    "bouillonblokjes of -poeder (gebruik kruiden, specerijen, ui, knoflook of zelfgetrokken bouillon), geen vleeswaren (ham, spek, worst, chorizo, salami), " +
    "geen vleesvervangers, eiwitpoeder, margarine, mayonaise, smeerkaas of zoetstoffen. Tomaten uit blik, peulvruchten uit blik/glas, tofu, tempeh, naturel zuivel, eieren en volkoren producten mogen wel.");
  if (hasHealth(rules, "volkoren")) lines.push("VOLKOREN & VEZELRIJK: kies volkoren of zilvervlies in plaats van witte varianten en zorg voor veel groente, peulvruchten, noten of zaden (vezelrijk).");
  if (hasHealth(rules, "zoutbewust")) lines.push("ZOUTBEWUST: weinig zout (hoogstens een snuf), geen bouillonblokjes en zo min mogelijk zoute sauzen of kaas; geef smaak met kruiden, specerijen, citrus en knoflook.");
  return "GEZONDHEIDSVOORKEUREN van de gebruiker (gelden voor elk gerecht, naast de voedingsstijl):\n" + lines.map(function (l) { return "- " + l; }).join("\n") + "\n" +
    "Controleer vóór je antwoordt elk ingrediënt hierop.\n";
}

var GLUTEN_RE = /\b(tarwe\w*|\w*bloem|spelt\w*|rogge\w*|gerst\w*|kamut|bulgur|couscous|seitan|freekeh|farro|orzo|pasta\w*|spaghetti|penne|macaroni|fusilli|tagliatelle|lasagne\w*|linguine|farfalle|ravioli|tortellini|gnocchi|noedels?|mie|udon|ramen|\w*brood\w*|\w*broodje\w*|wraps?|tortilla\w*|pita\w*|naan|ciabatta|baguette|focaccia|croutons?|paneermeel|panko|beschuit\w*|cracker\w*|kn[aä]ckebr[oö]d|muesli|granola|havermout|haver\w*|bladerdeeg|filodeeg|pizzadeeg|deeg|sojasaus|saus soja-|ketjap|bier|teriyaki\w*|hoisin\w*)\b/i;
var GLUTEN_SAFE_RE = /\b(glutenvrij\w*|zonder gluten|rijstnoedels?|glasnoedels?|rijstvermicelli|ma[iï]stortilla\w*|tortilla\w* van ma[iï]s|tortillachips van ma[iï]s|ma[iï]szetmeel|maizena|rijstebloem|rijstbloem|ma[iï]sbloem|ma[iï]smeel|boekweit\w*|amandelmeel|kokosmeel|kikkererwtenmeel|kikkererwtenbloem|tapiocameel|aardappelzetmeel|bloemkool\w*|bloemen|tamari|rijstwafel\w*|quinoa\w*|linzenpasta|kikkererwtenpasta|rijstpasta|ma[iï]spasta)\b/gi;
var SUGAR_RE = /\b(\w*suiker\w*|\w*stroop|siroop|limonadesiroop|glucose\w*|fructose\w*|dextrose|agave\w*|jam|confituur|ketchup|frisdrank|cola|melkchocolade|witte chocolade|chocolade\w*|chocoladepasta|hagelslag|marshmallow\w*|koek\w*|cake|sweet chili\w*|zoetzure saus|teriyaki\w*|hoisin\w*|barbecuesaus|bbq-?saus|ketjap\w*|gecondenseerde melk|karamel\w*|nutella)\b/i;
var SUGAR_SAFE_RE = /\b(zonder (toegevoegde )?suiker|z suiker|suikervrij\w*|ongezoet\w*|suikermais|suikerma[iï]s|ma[iï]s suiker|suikerbonen?|suikerschot\w*|suikerpeul\w*|suikerbiet\w*|appelstroop zonder\w*|pure chocolade (8[5-9]|9\d|100)\s?%|cacao\w*|100\s?% (pure )?chocolade)\b/gi;
var PROCESSED_RE = /\b(kant-en-klaar\w*|kant en klaar\w*|uit (een )?(pot|potje|zakje|pakje)|\w+mix|bouillonblok\w*|bouillontablet\w*|bouillonpoeder|bouillon v blokje|maggi|aromat|vleeswaren|vleeswaar|\(vleeswaar\)|ham|achterham|spek\w*|bacon|\w*worst\w*|chorizo|salami|pancetta|frikandel\w*|kroket\w*|nuggets?|kipnuggets?|vissticks?|fishsticks?|surimi|vleesvervanger\w*|vegetarisch gehakt|vegetarische (reepjes|stukjes|burger\w*|kipstukjes|balletjes)|gehakt rul vegetarisch|reepjes\/stukjes vegetarisch|vegaburger\w*|mycoprote\w*|eiwitpoeder\w*|whey|wei-eiwit\w*|margarine|halvarine|mayonaise|sandwichspread|smeerkaas|zoetstof\w*|aspartaam|chips|instant\w*)\b/i;
var PROCESSED_SAFE_LINE_RE = /\b(zelfgemaakt\w*|huisgemaakt\w*|zelfgetrokken|zelf getrokken|vers gemaakte?)\b/i;   // expliciet zelf gemaakt: hele regel is goed
var PROCESSED_SAFE_RE = /\b(kokoschips|kruidenmix|specerijenmix|notenmix|zadenmix|pittenmix|slamix|groentemix|sla mix|kiemgroentemix|pitten- en zadenmix)\b/gi;

var LACTOSE_RE = /\b(melk|melkpoeder|karnemelk|volle melk|halfvolle melk|magere melk|chocolademelk|room|slagroom|kookroom|zure room|roomijs|ijs|cr[eè]me fra[iî]che|creme fraiche\w*|yoghurt\w*|kwark\w*|skyr|boter|roomboter|\w*kaas\w*|mozzarella|burrata|feta|ricotta|mascarpone|cottage cheese|h[uü]ttenk[aä]se|halloumi|parmezaan\w*|parmigiano|grana padano|pecorino|gruy[eè]re|comt[eé]|emmentaler|manchego|cheddar|brie|camembert|gorgonzola|paneer|labneh|wei|wei-eiwit\w*|whey|melkchocolade|witte chocolade|b[eé]chamel\w*|custard|vla|pudding|tzatziki|raita)\b/i;
var LACTOSE_SAFE_RE = /\b(lactosevrij\w*|zonder lactose|ghee|kokos\w*|pindakaas|pindaboter|notenboter|amandelboter|cashewboter|cacaoboter|sheaboter|sojamelk|havermelk|amandelmelk|rijstmelk|sojayoghurt|kokosyoghurt|haveryoghurt|plantaardig\w*( \w+)?|vegan\w*( \w+)?|edelgistvlokken|gistvlokken|kaasjeskruid)\b/gi;
var HARD_CHEESE_RE = /\b(parmezaan\w*|parmigiano( reggiano)?|grana padano|pecorino( romano)?|oude kaas|oude goudse|belegen kaas|extra belegen( kaas)?|belegen goudse|kaas goudse 48\+( gem)?|goudse kaas|gruy[eè]re|comt[eé]|emmentaler|manchego|cheddar|kaas parmezaanse)\b/gi;

// Welke ingrediënten in een gerecht botsen met de gezondheidsfilters? Geeft [{woord, regel}].
function dishHealthViolations(d, rules) {
  if (!d || !healthChecked(rules)) return [];
  // Alleen de ingrediënten tellen (wat de gebruiker ziet en koopt); de gerechtnaam niet.
  var parts = (Array.isArray(d.ingredienten) ? d.ingredienten : []).map(function (x) {
    return x && typeof x === "object" ? String(x.tekst || "") + " " + String(x.nevo || "") : String(x || "");
  });
  var hits = [];
  parts.forEach(function (t) {
    var txt = t.toLowerCase();
    if (hasProteinOut(rules)) {
      var plantTxt = txt.replace(/\b(vegetarisch\w*|vegan\w*|plantaardig\w*|vega)\s+\w+/g, " ");   // "vegetarische kipstuckjes" is geen kip
      rules.proteinOut.some(function (k) { var m = plantTxt.match(PROTEIN_RE[k]); if (m) { hits.push({ woord: m[0], regel: "p:" + k }); return true; } return false; });
    }
    if (hasHealth(rules, "glutenvrij") && !/\b(glutenvrij\w*|zonder gluten)\b/.test(txt)) {
      var gm = txt.replace(GLUTEN_SAFE_RE, " ").match(GLUTEN_RE);
      if (gm) hits.push({ woord: gm[0], regel: "glutenvrij" });
    }
    if (hasHealth(rules, "lactosevrij") && !/\b(lactosevrij\w*|zonder lactose)\b/.test(txt)) {
      var l = txt.replace(PLANT_DAIRY_RE, " ").replace(LACTOSE_SAFE_RE, " ");
      if (rules.cheeseMode !== "geen") l = l.replace(HARD_CHEESE_RE, " ");
      var lm = l.match(LACTOSE_RE);
      if (lm) hits.push({ woord: lm[0], regel: "lactosevrij" });
    }
    if (hasHealth(rules, "suikervrij")) {
      var s = txt.replace(SUGAR_SAFE_RE, " ");
      if (rules.sugarMode !== "strikt") s = s.replace(new RegExp(NATURAL_SWEET_RE.source, "gi"), " ");
      var sm = s.match(SUGAR_RE) || (rules.sugarMode === "strikt" ? s.match(NATURAL_SWEET_RE) : null);
      if (sm) hits.push({ woord: sm[0], regel: "suikervrij" });
    }
    if (hasHealth(rules, "puur") && !PROCESSED_SAFE_LINE_RE.test(txt)) {
      var pm = txt.replace(PROCESSED_SAFE_RE, " ").match(PROCESSED_RE);
      if (pm) hits.push({ woord: pm[0], regel: "puur" });
    }
  });
  return hits;
}
// Alle overtredingen (voedingsstijl en gezondheidsfilters) als korte tekst, bijv. "kip (niet vegetarisch)".
function dishRuleViolations(d, rules) {
  var out = dishDietViolations(d, rules.style).map(function (w) { return w + " (niet " + String(rules.style).toLowerCase() + ")"; });
  dishHealthViolations(d, rules).forEach(function (h) { out.push(h.woord + (h.regel.indexOf("p:") === 0 ? " (eet geen " + PROTEIN_LABEL[h.regel.slice(2)] + ")" : " (niet " + HEALTH_LABELS[h.regel] + ")")); });
  return out;
}
function ruleViolationCount(parsed, rules) {
  if (!rulesActive(rules)) return 0;
  var dishes = Array.isArray(parsed) ? parsed : [parsed];
  return dishes.reduce(function (n, d) { return n + (dishRuleViolations(d, rules).length ? 1 : 0); }, 0);
}
// Voorbeelden, eiwitstrategie en NEVO-lijst in de prompt afstemmen op de gezondheidsfilters.
function adaptPromptToRules(prompt, rules) {
  var out = adaptPromptToDiet(prompt, rules.style);
  if (!healthChecked(rules)) return out;
  if (hasHealth(rules, "glutenvrij")) out = out.split("seitan, ").join("");
  if (hasHealth(rules, "lactosevrij")) out = out.split(", magere kwark, skyr").join(", lactosevrije kwark").split("magere kwark of Griekse yoghurt 0% als sausbasis").join("lactosevrije kwark of sojayoghurt als sausbasis");
  if (hasHealth(rules, "puur")) {
    out = out.split(", vegetarisch gehakt of vegetarische reepjes op basis van soja, mycoproteïne").join("")
      .split(", vegetarisch gehakt of reepjes op basis van soja (vegan)").join("")
      .split(", of eiwitpoeder").join("").split(", of erwteneiwitpoeder").join("");
  }
  var fake = function (name) { return { name: "", ingredienten: [{ tekst: name, nevo: "" }] }; };
  // Zuivel blijft in de NEVO-lijst staan: lactosevrije varianten hebben dezelfde voedingswaarden en gebruiken die NEVO-naam.
  var listRules = Object.assign({}, rules, { health: rules.health.filter(function (k) { return k !== "lactosevrij"; }) });
  out = out.split("\n").filter(function (ln) {
    if (ln.indexOf(" | ") === -1 || !/kcal/.test(ln)) return true;   // alleen regels uit de NEVO-lijst filteren
    return !dishHealthViolations(fake(ln.split(" | ")[0]), listRules).length;
  }).join("\n");
  if (hasHealth(rules, "lactosevrij") && out.indexOf("NEVO 2025 per 100 g") > -1) {
    out = out.replace("NEVO 2025 per 100 g", "Lactosevrije zuivel: zet \"lactosevrij\" in \"tekst\" en gebruik bij \"nevo\" de gewone zuivelnaam uit de lijst (bijv. \"Kwark magere\").\nNEVO 2025 per 100 g");
  }
  return out;
}
function communityHealthOk(d, prefs) {
  return !dishHealthViolations(d, dietRulesFromParams(prefs)).length;
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
  return "- Lichaamsprofiel: " + bits.join(", ") + " — houd hier rekening mee bij de keuze van ingrediënten, maar blijf " +
    "binnen de kcal-grenzen per maaltijdmoment hierboven (het dagdoel is daarin al verwerkt)\n";
}

// ---------- Seizoen en momenten ----------
// Groente en fruit van het Nederlandse seizoen per maand, en momenten in het jaar waar mensen iets speciaals voor koken.
// Wordt gebruikt in de opdracht aan de AI (zachte voorkeur) en op het startscherm (inspiratie met één tik).
var MONTH_NAMES_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];
var SEASON_PRODUCE = [
  ["boerenkool", "spruitjes", "pastinaak", "knolselderij", "rode kool", "witlof", "prei", "stoofperen"],
  ["boerenkool", "spruitjes", "pastinaak", "witlof", "schorseneren", "rode kool", "prei", "appels"],
  ["prei", "witlof", "spinazie", "postelein", "rabarber", "knolselderij", "pastinaak"],
  ["asperges", "spinazie", "radijs", "rabarber", "lente-ui", "postelein", "veldsla"],
  ["asperges", "tuinbonen", "spinazie", "radijs", "rabarber", "aardbeien", "nieuwe aardappelen"],
  ["courgette", "tuinbonen", "doperwten", "aardbeien", "kersen", "sla", "nieuwe aardappelen", "komkommer"],
  ["courgette", "tomaten", "sperziebonen", "paprika", "bessen", "frambozen", "maïs", "komkommer"],
  ["tomaten", "courgette", "aubergine", "paprika", "maïs", "pruimen", "bramen", "sperziebonen"],
  ["pompoen", "bospaddenstoelen", "venkel", "appels", "peren", "pruimen", "rode biet", "druiven"],
  ["pompoen", "spruitjes", "rode biet", "paddenstoelen", "pastinaak", "appels", "peren", "knolselderij"],
  ["boerenkool", "spruitjes", "pompoen", "pastinaak", "knolselderij", "rode kool", "witlof", "stoofperen"],
  ["boerenkool", "spruitjes", "rode kool", "pastinaak", "witlof", "knolselderij", "stoofperen", "cranberry's"]
];
function easterDate(y) {   // Anonymous Gregorian algorithm
  var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
function nthSunday(y, month, n) { var d = new Date(Date.UTC(y, month, 1)); var first = (7 - d.getUTCDay()) % 7; return Date.UTC(y, month, 1 + first + 7 * (n - 1)); }
// [sleutel, naam, datum (ms, UTC-middag), dagen van tevoren tonen, wens voor de AI]
function seasonMoments(y) {
  var D = function (m, d) { return Date.UTC(y, m, d); };
  return [
    ["sinterklaas", "Sinterklaas", D(11, 5), 14, "gezellig Sinterklaasavond-eten, met een knipoog naar speculaas of pepernoten"],
    ["kerst", "Kerst", D(11, 25), 16, "feestelijk kerstdiner dat indruk maakt maar thuis goed te doen is"],
    ["oudennieuw", "Oud en nieuw", D(11, 31), 5, "hapjes en een makkelijk diner voor oudejaarsavond"],
    ["pasen", "Pasen", easterDate(y), 10, "uitgebreide paasbrunch en een lentediner"],
    ["koningsdag", "Koningsdag", D(3, 27), 6, "makkelijk eten voor buiten en onderweg, met iets oranjes"],
    ["moederdag", "Moederdag", nthSunday(y, 4, 2), 7, "een verwenontbijt of -brunch voor Moederdag"],
    ["vaderdag", "Vaderdag", nthSunday(y, 5, 3), 7, "stevig en lekker voor Vaderdag, bijvoorbeeld van de grill"],
    ["bbq", "Barbecueseizoen", D(6, 15), 45, "gerechten voor de barbecue, met frisse salades erbij"],
    ["halloween", "Halloween", D(9, 31), 7, "griezelig leuk eten waar kinderen ook van smullen"]
  ];
}
function seasonInfo(ms) {
  var loc = localNow(ms || Date.now()), y = Number(loc.date.slice(0, 4)), month = Number(loc.date.slice(5, 7)) - 1;
  var today = Date.UTC(y, month, Number(loc.date.slice(8, 10)));
  var moment = null;
  seasonMoments(y).concat(seasonMoments(y + 1)).forEach(function (m) {
    var days = Math.round((m[2] - today) / 86400000);
    if (days >= 0 && days <= m[3] && (!moment || days < moment.daysUntil)) moment = { key: m[0], label: m[1], daysUntil: days, wish: m[4] };
  });
  return { month: MONTH_NAMES_NL[month], produce: SEASON_PRODUCE[month].slice(), moment: moment };
}
// ---------- Jongeren en budgetmodus ----------
var MINOR_BLOCKED_GOALS = ["Vetverlies (spierbehoud)", "Cutting"];
function isMinorParams(p) { var a = Number(p && p.age); return !!p && (p.ageGroup === "16-17" || (a > 0 && a < 18)); }
// Onder de 18 nooit een afvaldoel of calorietekort, ook niet als een oudere app-versie dat meestuurt.
function applyAgeRules(p) {
  if (isMinorParams(p) && MINOR_BLOCKED_GOALS.indexOf(p.goal) > -1) p.goal = "Onderhoud";
  return p;
}
function youthInstructionText(p) {
  if (!isMinorParams(p)) return "";
  return "- JONGERE (16-17 jaar): het lichaam groeit nog. Zorg voor voldoende energie, eiwit, calcium en ijzer, geen calorietekort en geen dieetproducten of supplementen; " +
    "gewone, gevarieerde en vullende gerechten.\n";
}
var STUDENT_BUDGETS = [25, 35, 50, 75];
function studentInstructionText(p) {
  var s = p && p.student && typeof p.student === "object" ? p.student : null;
  if (!s || !s.on) return "";
  var budget = STUDENT_BUDGETS.indexOf(Number(s.budget)) > -1 ? Number(s.budget) : 35;
  var meals = (Array.isArray(p.mealTypes) && p.mealTypes.length ? p.mealTypes : ["Ontbijt", "Lunch", "Diner"]).filter(function (m) { return m !== "Snack"; }).length || 1;
  var perMeal = Math.max(1, Math.round(budget / (7 * meals) * 2) / 2);
  return "- BUDGETMODUS: weekbudget ca. \u20ac" + budget + " voor alle maaltijden (ongeveer \u20ac" + perMeal.toFixed(2).replace(".", ",") + " per portie bij een Nederlandse supermarkt). " +
    "Kies goedkope basisproducten (huismerk, peulvruchten, eieren, kip(dij), seizoensgroente, diepvriesgroente, rijst, pasta, aardappel, havermout), " +
    "geen dure specialiteiten, en ingrediënten die in meerdere gerechten terugkomen zodat er weinig overblijft." +
    (s.onePan !== false && s.onePan ? " Gebruik hoogstens één pan of één ovenschaal per gerecht." : "") +
    (s.quick === false ? "" : " Totale bereidingstijd hoogstens 25 minuten.") + "\n";
}
function seasonInstructionText() {
  var s = seasonInfo();
  return "- Seizoen (" + s.month + "): gebruik waar het past groente en fruit van het seizoen, zoals " + s.produce.slice(0, 6).join(", ") +
    " (zachte voorkeur; keuken, voedingsstijl en wensen gaan voor).\n";
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
    dietHardRuleText(p.dietStyle) + healthHardRuleText(p) +
    "- Maaltijdmomenten: " + mealGuideTxt + "\n" +
    mealInstruction + "\n" +
    "- Keukenstijl: " + cuisineTxt + "\n" +
    "- Smaakprofiel: " + flavorTxt + "\n" +
    "- Culinair niveau: " + (p.level || "Home-style") + "\n" +
dietStyleInstructionText(p.dietStyle) +
    familyModeInstructionText(p.familyMode) +
    "- Beschikbare apparatuur (mag je gebruiken, niet elk gerecht hoeft alles te gebruiken): " + equipTxt + "\n" +
    "- Uitgesloten ingrediënten: " + excludeTxt + "\n" +
    wishInstructionText(p) + existingInstructionText(p) + tasteInstructionText(p) + seasonInstructionText() + studentInstructionText(p) + youthInstructionText(p) +
    buildBodyProfileLine(p) +
    goalInstructionText(p.goal, p.dietStyle) +
    "Gebruik reële, haalbare porties en ingrediënten die passen " +
    "bij het gekozen maaltijdmoment van elk gerecht.\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef ALLEEN geldig JSON terug: een array van EXACT " + totalCount + " objecten (" + count +
    " per maaltijdmoment), exact dit schema, geen markdown-opmaak, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "mealType": "' + mealTypes[0] + '", "kcal": 0, "kh_g": 0, "eiwit_g": 0, "vet_g": 0, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ' + nevoIngredientSchema() + ', ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + mealTypes.join(", ") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd (voorbereiding + kooktijd samen) in hele minuten. " +
    FOTO_TERM_LINE +
    "timer_seconds alleen toevoegen bij stappen met wachttijd (koken, bakken, grillen, oven, sudderen); anders weglaten." +
    nevoPromptText();
}

// ---------- Gerecht van foto ----------
var PHOTO_MEALTYPES = ["Ontbijt", "Lunch", "Diner", "Snack"];
var PHOTO_MEDIA = ["image/jpeg", "image/png", "image/webp"];
// Koelkastfoto: herken wat er ligt en maak er één gerecht van dat bij het doel past.
function buildFridgePrompt(p, mealType) {
  var types = mealType && PHOTO_MEALTYPES.indexOf(mealType) > -1 ? [mealType] : ["Diner"];
  var equipTxt = (p.equipment && p.equipment.length) ? p.equipment.join(", ") : "standaard fornuis en oven";
  var excludeTxt = (p.exclude && String(p.exclude).trim()) ? String(p.exclude).trim() : "geen";
  return "Je bent een voedingskundige chef-kok. Op de foto staat de inhoud van een koelkast, voorraadkast of een aanrecht met ingrediënten.\n" +
    "Als er GEEN eten of ingrediënten op de foto staan, geef dan alleen dit terug: {\"error\": \"geen_ingredienten\"}\n\n" +
    "Anders: herken de bruikbare ingrediënten en maak er precies één lekker, zelf te bereiden recept van (per 1 persoon).\n" +
    "- Gebruik vooral wat je ziet. Je mag aanvullen met basisvoorraad die bijna iedereen heeft (olie, zout, peper, gedroogde kruiden, bouillon, ui, knoflook), en hooguit één ander ingrediënt; noem dat dan in \"benodigdheden\".\n" +
    "- Vermeld in \"herkend\" kort welke ingrediënten je op de foto zag (max 200 tekens).\n" +
    goalInstructionText(p.goal, p.dietStyle) + "\n" +
    "- Stem de portie af op het maaltijdmoment: " + types.map(function (mt) { return mt + " (" + mealtypeGuideText(mt, p.goal) + ")"; }).join("; ") + "\n" +
    buildBodyProfileLine(p) +
    dietHardRuleText(p.dietStyle) + healthHardRuleText(p) + dietStyleInstructionText(p.dietStyle) + familyModeInstructionText(p.familyMode) +
    "- Beschikbare apparatuur (gebruik bij de bereiding alleen wat er is): " + equipTxt + "\n" +
    "- Uitgesloten ingrediënten: " + excludeTxt + "\n" +
    "- Culinair niveau van de stappen: " + (p.level || "Home-style") + "\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef de naam in het Nederlands en beschrijvend. \"aanpassingen\" = een lege lijst []. " +
    "Geef ALLEEN geldig JSON terug: een array met EXACT 1 object, exact dit schema, geen markdown, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "herkend": "wat er op de foto ligt", "aanpassingen": [], "mealType": "' + types[0] + '", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ' + nevoIngredientSchema() + ', ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact zijn: ' + types[0] + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd in hele minuten. " + FOTO_TERM_LINE +
    "Houd het beknopt: hoogstens 6 bereidingsstappen van 1 tot 3 zinnen, \"benodigdheden\" in één korte regel. " +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten." +
    nevoPromptText(true);
}
function buildPhotoPrompt(p, mode, mealType) {
  var types = mealType && PHOTO_MEALTYPES.indexOf(mealType) > -1 ? [mealType] : PHOTO_MEALTYPES;
  var equipTxt = (p.equipment && p.equipment.length) ? p.equipment.join(", ") : "standaard fornuis en oven";
  var excludeTxt = (p.exclude && String(p.exclude).trim()) ? String(p.exclude).trim() : "geen";
  var balanza = mode !== "origineel";
  return "Je bent een voedingskundige chef-kok. Bekijk de foto. Er staat een gerecht op (bijv. een bord eten, een foto van een maaltijd) " +
    "of een recept (bijv. een kookboekpagina, een screenshot of een handgeschreven recept).\n" +
    "Als er GEEN gerecht en GEEN recept op de foto staat, geef dan alleen dit terug: {\"error\": \"geen_gerecht\"}\n\n" +
    "Anders: maak er precies één zelf te bereiden recept van (per 1 persoon).\n" +
    "- Staat er een recept op de foto: neem de ingrediënten en hoeveelheden daaruit over en reken ze om naar 1 persoon.\n" +
    "- Staat er een bord eten of een maaltijd op: herken het gerecht en alle onderdelen (ook als het fastfood of een restaurantgerecht is) " +
    "en schat realistische hoeveelheden in. Alles wat samen op de foto staat is één maaltijd: neem bijgerechten (bijv. friet, salade, rijst) mee " +
    "in hetzelfde recept. Calorievrije dranken (water, thee, light/zero frisdrank) laat je weg uit de ingrediënten.\n" +
    (balanza
      ? "- Maak een BALANZA-VERSIE die thuis te maken is. Belangrijkste regel: het moet voelen en eruitzien als HETZELFDE gerecht. Behoud de " +
        "kenmerkende onderdelen en smaken (bijv. bij een dubbele hamburger: twee dunne burgers, sesambroodje, speciale saus, augurk, sla, kaas en " +
        "de friet erbij; bij lasagne: lagen, tomatensaus en een gegratineerde bovenkant). Maak het gezonder met slimme ruil, niet met weglaten:\n" +
        "  * magere eiwitbronnen (bijv. rundergehakt 5% vet, kipfilet, kalkoenfilet in plaats van spek, magere kwark of Griekse yoghurt 0% als sausbasis);\n" +
        "  * bakken in de oven of airfryer in plaats van frituren (bijv. ovenfriet van verse aardappel met een theelepel olie);\n" +
        "  * minder of lichtere kaas, minder olie en boter, suikerhoudende dranken weglaten;\n" +
        "  * meer groente en vezels erbij of erin (bijv. extra sla, tomaat, rauwkost of een volkoren bol);\n" +
        "  * een verzadigende, volwaardige portie die wel binnen de calorierichtlijn hieronder past.\n" +
        "  Verzin geen ander gerecht en maak er geen salade of bowl van als het origineel dat niet is.\n" +
        goalInstructionText(p.goal, p.dietStyle) + "\n" +
        "- Stem de portie af op het maaltijdmoment: " + types.map(function (mt) { return mt + " (" + mealtypeGuideText(mt, p.goal) + ")"; }).join("; ") + "\n" +
        buildBodyProfileLine(p)
      : "- Blijf ZO DICHT MOGELIJK bij het origineel: dezelfde ingrediënten en een realistische portie zoals op de foto. Pas niets aan om het gezonder te maken.\n") +
    dietHardRuleText(p.dietStyle) + healthHardRuleText(p) +
    dietStyleInstructionText(p.dietStyle) +
    familyModeInstructionText(p.familyMode) +
    "- Beschikbare apparatuur (gebruik bij de bereiding alleen wat er is): " + equipTxt + "\n" +
    "- Uitgesloten ingrediënten (vervang ze door iets passends): " + excludeTxt + "\n" +
    "- Culinair niveau van de stappen: " + (p.level || "Home-style") + "\n" +
    INGREDIENT_SPECIFICITY_LINE +
    "Geef de naam in het Nederlands en beschrijvend, zonder merknamen (bijv. \"Dubbele burger met speciale saus en ovenfriet\"). " +
    "\"herkend\" = kort wat je op de foto ziet (mag merknamen bevatten, bijv. \"Big Mac met bacon, friet en Coca-Cola Zero\"). " +
    (balanza ? "\"aanpassingen\" = 2 tot 5 korte zinnen over wat je hebt veranderd ten opzichte van het origineel en waarom (bijv. \"Rundergehakt 5% vet in plaats van gewone burgers: meer eiwit, minder vet\"). "
             : "\"aanpassingen\" = een lege lijst []. ") +
    "Geef ALLEEN geldig JSON terug: een array met EXACT 1 object, exact dit schema, geen markdown, geen uitleg erbuiten:\n" +
    '[{"name": "gerechtnaam", "herkend": "wat er op de foto staat", "aanpassingen": ["wat er is veranderd"], "mealType": "' + types[0] + '", "kcal": 600, "kh_g": 50, "eiwit_g": 48, "vet_g": 22, ' +
    '"bereidingstijd_minuten": 30, "foto_zoekterm": "grilled salmon asparagus", "benodigdheden": "korte tekst met keukenapparatuur", "ingredienten": ' + nevoIngredientSchema() + ', ' +
    '"steps": [{"title": "korte staptitel", "content": "volledige instructie", "timer_seconds": 300}]}]\n' +
    '"mealType" moet exact één van deze waarden zijn: ' + types.join(", ") + (types.length > 1 ? " (kies het moment dat het best bij het gerecht past)" : "") + ". " +
    "\"bereidingstijd_minuten\" is de totale realistische bereidingstijd in hele minuten. " + FOTO_TERM_LINE +
    "Houd het beknopt: hoogstens 6 bereidingsstappen van 1 tot 3 zinnen, \"benodigdheden\" in één korte regel. " +
    "timer_seconds alleen toevoegen bij stappen met wachttijd; anders weglaten." +
    nevoPromptText(balanza);
}
function photoBadRequest(msg) { var e = new Error(msg); e.isBadRequest = true; return e; }
function runPhotoAction(body, params) {
  var img = body && body.image;
  var mediaType = img && typeof img.mediaType === "string" ? img.mediaType : "";
  var data = img && typeof img.data === "string" ? img.data : "";
  if (PHOTO_MEDIA.indexOf(mediaType) === -1 || !data) return Promise.reject(photoBadRequest("Kies een foto (JPG, PNG of WebP)."));
  if (data.length > 1400000 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 2000))) return Promise.reject(photoBadRequest("Deze foto is te groot of ongeldig. Probeer een andere."));
  var mode = body.mode === "origineel" ? "origineel" : body.mode === "koelkast" ? "koelkast" : "balanza";
  var mealType = PHOTO_MEALTYPES.indexOf(body.mealType) > -1 ? body.mealType : null;
  var post = function (parsed) {
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object" && parsed.error) {
      throw photoBadRequest(mode === "koelkast" ? "Op deze foto herkennen we geen ingrediënten. Probeer een foto waarop je koelkast of voorraad goed te zien is." : "Op deze foto herkennen we geen gerecht of recept. Probeer een duidelijkere foto van je bord of van het recept.");
    }
    var list = Array.isArray(parsed) ? parsed.slice(0, 1) : [parsed];
    list.forEach(function (d) { if (d && mealType) d.mealType = mealType; });
    return applyNevoToParsed(list);
  };
  // Eén bijstelronde en een kortere tijdslimiet: bij een foto telt snelheid zwaarder dan het laatste procentje Balans.
  return generateWithBalansRetry(mode === "koelkast" ? buildFridgePrompt(params, mealType) : buildPhotoPrompt(params, mode, mealType), mode !== "origineel" ? params.goal : null, post, dietRulesFromParams(params),
    { image: { mediaType: mediaType, data: data }, repairRounds: 1, timeBudgetMs: 45000 });
}

// ---------- Wens voor deze keer en smaakgeschiedenis ----------
function cleanShortList(v, maxItems, maxLen) {
  return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === "string" && x.trim(); })
    .slice(0, maxItems).map(function (x) { return x.replace(/[\r\n]+/g, " ").trim().slice(0, maxLen); });
}
var WISH_TEXTS = {
  snel: "snel klaar: totale bereidingstijd hoogstens 20 minuten",
  budget: "budgetvriendelijk: betaalbare, alledaagse ingrediënten uit een Nederlandse supermarkt, geen dure specialiteiten",
  prep: "geschikt voor meal prep: goed vooruit te koken, 3 tot 4 dagen houdbaar in de koelkast en goed op te warmen",
  nieuw: "iets nieuws: verrassende gerechten in plaats van de bekende klassiekers",
  huis: "gebruik zoveel mogelijk de ingrediënten die de gebruiker al in huis heeft",
  restjes: "maak op wat de gebruiker nog over heeft (restjes): verwerk die ingrediënten zo veel mogelijk, liefst in meerdere gerechten",
  seizoen: "seizoensgerechten: bouw elk gerecht rond groente of fruit van het seizoen"
};
function wishInstructionText(p) {
  var w = p && p.wish && typeof p.wish === "object" ? p.wish : null;
  if (!w) return "";
  var tags = cleanShortList(w.tags, 6, 20).filter(function (t) { return WISH_TEXTS[t]; });
  var text = typeof w.text === "string" ? w.text.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  if (!tags.length && !text) return "";
  var parts = tags.map(function (t) { return WISH_TEXTS[t]; });
  var out = "- WENS VAN DE GEBRUIKER VOOR DEZE KEER (volg dit zo goed mogelijk, binnen de voedingsstijl en het doel): " + parts.join("; ");
  if (text) out += (parts.length ? "; " : "") + (tags.indexOf("restjes") > -1 ? "dit moet op: " : tags.indexOf("huis") > -1 ? "dit heeft de gebruiker in huis: " : "toelichting van de gebruiker: ") + "\"" + text + "\"";
  out += ".\n";
  var avoid = cleanShortList(p.avoidNames, 30, 80);
  if (tags.indexOf("nieuw") > -1 && avoid.length) out += "- Maak andere gerechten dan deze recente: " + avoid.join("; ") + ".\n";
  return out;
}
// Wat de gebruiker al heeft: geen bijna-dubbele gerechten maken (vervuilt de lijst).
function existingInstructionText(p) {
  var names = cleanShortList(p && p.existingNames, 60, 70);
  if (!names.length) return "";
  return "- DEZE GERECHTEN HEEFT DE GEBRUIKER AL. Maak niets dat erop lijkt: niet dezelfde combinatie van hoofdingrediënt en bereiding, " +
    "en geen bijna-gelijke naam (bijv. \"Kip teriyaki met rijst\" en \"Teriyakikip met zilvervliesrijst\" zijn hetzelfde). Kies echt andere gerechten: " + names.join("; ") + ".\n";
}
function tasteInstructionText(p) {
  var likes = cleanShortList(p && p.likes, 15, 80), dislikes = cleanShortList(p && p.dislikes, 15, 80);
  if (!likes.length && !dislikes.length) return "";
  return "- SMAAK VAN DE GEBRUIKER (leer hiervan, maar kopieer geen gerechten letterlijk):" +
    (likes.length ? " lekker gevonden: " + likes.join("; ") + "." : "") +
    (dislikes.length ? " Niet lekker gevonden (vermijd vergelijkbare gerechten en smaken): " + dislikes.join("; ") + "." : "") + "\n";
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
    dietHardRuleText(p.dietStyle) + healthHardRuleText(p) +
    wishInstructionText(p) + existingInstructionText(p) + tasteInstructionText(p) + seasonInstructionText() + studentInstructionText(p) + youthInstructionText(p) +
    "- Uitgesloten ingrediënten: " + ((p.exclude && String(p.exclude).trim()) ? String(p.exclude).trim() : "geen") + "\n" +
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
    "Opdracht: " + variationInstructionText(kind, p) + "\n" +
    dietHardRuleText(p.dietStyle) + healthHardRuleText(p) +
    goalInstructionText(p.goal, p.dietStyle) + "\n" +
    (p.dietStyle ? dietStyleInstructionText(p.dietStyle) : "") +
    familyModeInstructionText(p.familyMode) +
    studentInstructionText(p) + youthInstructionText(p) +
    "- Uitgesloten ingrediënten (mogen er niet in, ook niet na de variatie): " + ((p.exclude && String(p.exclude).trim()) ? String(p.exclude).trim() : "geen") + "\n" +
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
  var params = applyAgeRules((body && body.params) || {});

  if (action === "generate") {
    var mealTypes = (params.mealTypes && params.mealTypes.length) ? params.mealTypes : ["Diner"];
    // Aantal per maaltijdmoment (nieuw): { Ontbijt: 2, Lunch: 3, ... }; anders hetzelfde aantal voor elk moment.
    var mc = params.mealCounts && typeof params.mealCounts === "object" ? params.mealCounts : null;
    if (mc) {
      var typed = PHOTO_MEALTYPES.filter(function (m) { var n = Number(mc[m]); return Number.isInteger(n) && n >= 1 && n <= 7; });
      if (!typed.length) { var noneErr = new Error("Kies minstens één gerecht."); noneErr.isBadRequest = true; return Promise.reject(noneErr); }
      mealTypes = typed;
    }
    if (mealTypes.length > 1 || mc) {
      return Promise.all(mealTypes.map(function (mt) {
        var subParams = Object.assign({}, params, { mealTypes: [mt] }, mc ? { count: Number(mc[mt]) } : {});
        return generateWithBalansRetry(buildGeneratePrompt(subParams), params.goal, applyNevoToParsed, dietRulesFromParams(params)).then(function (arr) {
          (Array.isArray(arr) ? arr : []).forEach(function (d) { if (d && typeof d === "object") d.mealType = mt; });   // elk deelverzoek is één moment
          return arr;
        });
      })).then(mergeDishArrays);
    }
    return generateWithBalansRetry(buildGeneratePrompt(params), params.goal, applyNevoToParsed, dietRulesFromParams(params));
  }

  if (action === "background") {
    var needed = (body && body.needed) || {};
    var types = Object.keys(needed);
    if (types.length > 1) {
      return Promise.all(types.map(function (mt) {
        var subNeeded = {};
        subNeeded[mt] = needed[mt];
        return generateWithBalansRetry(buildBackgroundGeneratePrompt(subNeeded, params), params.goal, applyNevoToParsed, dietRulesFromParams(params));
      })).then(mergeDishArrays);
    }
    return generateWithBalansRetry(buildBackgroundGeneratePrompt(needed, params), params.goal, applyNevoToParsed, dietRulesFromParams(params));
  }

  if (action === "photo") return runPhotoAction(body, params);

  if (action === "variation") {
    return generateWithBalansRetry(buildVariationPromptServer(body.current || {}, body.kind, params), params.goal, applyNevoToParsed, dietRulesFromParams(params));
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

var BALANS_MIN_THRESHOLD = 85;   // 85 = elke macro binnen 5 procentpunt van het doel
var BALANS_MAX_ATTEMPTS = 3;

function callAnthropicOnce(prompt, model, maxTokens, image) {
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
      messages: [{ role: "user", content: image ? [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }, { type: "text", text: prompt }] : prompt }]
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
var BALANS_REPAIR_ROUNDS = 2;          // hoeveel keer we alleen de afwijkende gerechten laten bijstellen
var BALANS_TIME_BUDGET_MS = 110000;    // daarna leveren we het beste resultaat tot nu toe

function dishMacroPcts(d) {
  var kcal = Number(d && d.kcal) || 0;
  if (!kcal) return null;
  return { kh: Math.round(Number(d.kh_g || 0) * 4 / kcal * 100), eiwit: Math.round(Number(d.eiwit_g || 0) * 4 / kcal * 100), vet: Math.round(Number(d.vet_g || 0) * 9 / kcal * 100) };
}
// Kcal na NEVO-herberekening buiten de grens van het maaltijdmoment? (iets speling: +8% boven, -15% onder)
function dishKcalOff(d, goal) {
  if (!goal || !d || !d.mealType || !MEALTYPE_GUIDE[d.mealType]) return null;
  var kcal = Number(d.kcal) || 0;
  if (!kcal) return null;
  var r = mealKcalRange(d.mealType, goal);
  if (kcal > r.max * 1.08) return { dir: "hoog", min: r.min, max: r.max, kcal: kcal };
  if (kcal < r.min * 0.85) return { dir: "laag", min: r.min, max: r.max, kcal: kcal };
  return null;
}
// Hoe ver een gerecht van de kcal-grens af zit (0 = binnen de grens); gebruikt om pogingen te vergelijken.
function dishKcalPenalty(d, goal) {
  var off = dishKcalOff(d, goal);
  return off ? (off.dir === "hoog" ? off.kcal - off.max : off.min - off.kcal) : 0;
}
function dishNeedsRepair(d, goal, rules) {
  rules = asDietRules(rules);
  if (dishRuleViolations(d, rules).length) return true;
  if (!goal) return false;
  return dishBalans(d, goal, rules.style) < BALANS_MIN_THRESHOLD || !!dishKcalOff(d, goal);
}
// Eén vergelijkbaar getal per gerecht: balans, met aftrek voor kcal buiten de grens (elke 10 kcal = 1 punt).
function dishQuality(d, goal, rules) {
  rules = asDietRules(rules);
  return (goal ? dishBalans(d, goal, rules.style) : 100) - dishKcalPenalty(d, goal) / 10;
}
// Alleen de gerechten die afwijken worden bijgesteld (kleine, snelle aanroep) in plaats van alles opnieuw te maken.
function buildRepairPrompt(dishes, goal, rules) {
  rules = asDietRules(rules);
  var t = goalTargetFor(goal, rules.style);
  var names = { kh: "koolhydraten", eiwit: "eiwit", vet: "vet" };
  var lines = dishes.map(function (d, i) {
    var pc = dishMacroPcts(d), bits = [];
    if (goal && pc) {
      ["kh", "eiwit", "vet"].forEach(function (k) {
        var diff = pc[k] - t[k];
        if (Math.abs(diff) > 3) bits.push((diff > 0 ? "te veel " : "te weinig ") + names[k] + " (" + (diff > 0 ? "+" : "") + diff + ")");
      });
    }
    var viol = dishRuleViolations(d, rules);
    var ko = dishKcalOff(d, goal);
    if (ko) bits.push("kcal te " + ko.dir + ": nu " + ko.kcal + " kcal, moet " + ko.min + "-" + ko.max + " kcal worden (porties " + (ko.dir === "hoog" ? "kleiner" : "groter") + ")");
    return (i + 1) + ". \"" + String(d.name || "gerecht") + "\"" + (pc ? ": nu " + pc.kh + "% koolhydraten, " + pc.eiwit + "% eiwit, " + pc.vet + "% vet" : "") +
      (bits.length ? " \u2014 " + bits.join(", ") : "") +
      (viol.length ? " \u2014 bevat ingrediënten die niet mogen: " + viol.slice(0, 5).join(", ") + "; vervang ze door een passend alternatief" : "");
  });
  var slim = dishes.map(function (d) {
    var o = {};
    ["name", "herkend", "aanpassingen", "mealType", "kcal", "kh_g", "eiwit_g", "vet_g", "bereidingstijd_minuten", "foto_zoekterm", "benodigdheden", "ingredienten", "steps"].forEach(function (k) { if (d[k] !== undefined) o[k] = d[k]; });
    return o;
  });
  return "Hieronder staan " + dishes.length + " gerechten in JSON. De macro's zijn nagerekend met het NEVO-bestand" +
    (goal ? " en passen nog niet goed bij het doel \"" + goal + "\" (streef: " + t.kh + "% koolhydraten, " + t.eiwit + "% eiwit, " + t.vet + "% vet)" : "") + ".\n" +
    lines.join("\n") + "\n\n" +
    "Stel elk gerecht bij zodat elke macro binnen 3 procentpunt van het doel komt: pas hoeveelheden aan, voeg een eiwitrijke bron toe of vervang een ingrediënt " +
    "(bijv. minder olie, kaas, noten, rijst, pasta of brood; meer van de eiwitbron). Behoud de naam (of een kleine aanpassing daarvan), het karakter, de keuken, " +
    "en het maaltijdmoment. Staat er bij een gerecht \"kcal te hoog\" of \"kcal te laag\", breng het dan binnen die grens " +
    "(schaal vooral olie, kaas, noten, rijst, pasta, brood en sauzen); anders houd je ongeveer hetzelfde aantal kcal. Werk ingrediënten, kcal, kh_g, eiwit_g, vet_g en de bereidingsstappen bij zodat alles klopt. " +
    "Heeft een gerecht de velden \"herkend\" en \"aanpassingen\", laat \"herkend\" dan staan en werk \"aanpassingen\" bij.\n" +
    dietHardRuleText(rules.style) + healthHardRuleText(rules) +
    (rules.exclude ? "- Uitgesloten ingrediënten (mogen er ook na het bijstellen niet in): " + rules.exclude + "\n" : "") +
    "Gerechten: " + JSON.stringify(slim) + "\n" +
    "Geef ALLEEN geldig JSON terug: een array van EXACT " + dishes.length + " objecten, in dezelfde volgorde en met exact hetzelfde schema als de invoer, " +
    "geen markdown, geen uitleg erbuiten." + nevoPromptText();
}

// Voortgang per deelopdracht (per maaltijdmoment loopt er één), zodat de app kan tonen wat er gebeurt.
function progressTrack() {
  var store = usageCtx.getStore();
  if (!store) return { stage: "generate", total: 0, ok: 0, fixing: 0, round: 0 };
  store.progress = store.progress || [];
  var t = { stage: "generate", total: 0, ok: 0, fixing: 0, round: 0 };
  store.progress.push(t);
  return t;
}
function summarizeProgress(usage) {
  var tracks = usage && Array.isArray(usage.progress) ? usage.progress : null;
  if (!tracks || !tracks.length) return null;
  var sum = { generating: 0, checking: 0, repairing: 0, total: 0, ok: 0, fixing: 0, round: 0 };
  tracks.forEach(function (t) {
    if (t.stage === "generate") sum.generating++; else if (t.stage === "check") sum.checking++; else if (t.stage === "repair") sum.repairing++;
    sum.total += t.total; sum.ok += t.ok; sum.fixing += t.fixing; sum.round = Math.max(sum.round, t.round);
  });
  sum.stage = sum.generating ? "generate" : sum.repairing ? "repair" : sum.checking ? "check" : "finishing";
  return sum;
}

function generateWithBalansRetry(prompt, goal, post, diet, opts) {
  var rules = asDietRules(diet);
  var image = opts && opts.image ? opts.image : null;   // alleen de eerste aanroep krijgt de foto; bijstellen werkt op de tekst
  var maxRounds = opts && opts.repairRounds !== undefined ? opts.repairRounds : BALANS_REPAIR_ROUNDS;
  var budgetMs = opts && opts.timeBudgetMs ? opts.timeBudgetMs : BALANS_TIME_BUDGET_MS;
  prompt = adaptPromptToRules(prompt, rules);
  if (!goal && !rulesActive(rules)) return callAnthropicOnce(prompt, null, null, image).then(function (parsed) { return post ? post(parsed) : parsed; });
  var t0 = Date.now();
  var track = progressTrack();
  function done(result) {
    var list = Array.isArray(result) ? result : [result];
    track.stage = "done"; track.total = list.length; track.fixing = 0;
    track.ok = list.filter(function (d) { return d && !dishNeedsRepair(d, goal, rules); }).length;
    return result;
  }

  // Een lijst gerechten: eerst één keer genereren, daarna alleen de afwijkers bijstellen.
  function repairRound(dishes, round) {
    var bad = [];
    dishes.forEach(function (d, i) { if (dishNeedsRepair(d, goal, rules)) bad.push(i); });
    track.total = dishes.length; track.ok = dishes.length - bad.length;
    if (!bad.length || round > maxRounds || Date.now() - t0 > budgetMs) return Promise.resolve(done(finalizeDiet(dishes, rules)));
    track.stage = "repair"; track.fixing = bad.length; track.round = round;
    var subset = bad.map(function (i) { return dishes[i]; });
    return callAnthropicOnce(adaptPromptToRules(buildRepairPrompt(subset, goal, rules), rules)).then(function (fixed) {
      if (post) fixed = post(fixed);
      if (!Array.isArray(fixed)) return done(finalizeDiet(dishes, rules));
      var next = dishes.slice(), improved = 0;
      bad.forEach(function (idx, j) {
        var nd = fixed[j], od = dishes[idx];
        if (!nd || typeof nd !== "object" || !Array.isArray(nd.ingredienten)) return;
        if (od.mealType) nd.mealType = od.mealType;
        var ov = dishRuleViolations(od, rules).length, nv = dishRuleViolations(nd, rules).length;
        var ob = dishQuality(od, goal, rules), nb = dishQuality(nd, goal, rules);
        if (nv < ov || (nv === ov && nb > ob)) { next[idx] = nd; improved++; }
      });
      console.log("Balans bijstellen ronde " + round + ": " + bad.length + " afwijkend, " + improved + " verbeterd (" + Math.round((Date.now() - t0) / 1000) + " s)");
      return repairRound(next, round + 1);
    }, function (err) {
      console.warn("Bijstellen mislukt, we leveren het beste resultaat tot nu toe: " + (err && err.message));
      return done(finalizeDiet(dishes, rules));
    });
  }

  // Eén los gerecht (bijv. een variatie): het oude gedrag, opnieuw proberen met de hele opdracht.
  var bestParsed = null, bestScore = -Infinity, attempt = 0, currentPrompt = prompt;
  function handleSingle(parsed) {
    var violations = ruleViolationCount(parsed, rules);
    var list = Array.isArray(parsed) ? parsed : [parsed];
    var quality = list.reduce(function (m, d) { return Math.min(m, dishQuality(d, goal, rules)); }, 100);
    var score = quality - violations * 1000;   // overtreding weegt zwaarder dan elke balans-score
    if (score > bestScore) { bestScore = score; bestParsed = parsed; }
    var allOk = list.every(function (d) { return !dishNeedsRepair(d, goal, rules); });
    if ((violations === 0 && allOk) || attempt >= BALANS_MAX_ATTEMPTS || Date.now() - t0 > BALANS_TIME_BUDGET_MS) {
      return done(finalizeDiet(bestParsed, rules));
    }
    track.stage = "repair"; track.total = 1; track.ok = 0; track.fixing = 1; track.round = attempt;
    if (violations) {
      var found = (Array.isArray(parsed) ? parsed : [parsed]).reduce(function (all, d) { return all.concat(dishRuleViolations(d, rules)); }, []);
      currentPrompt = prompt + "\nLET OP: een vorige poging bevatte ingrediënten die niet mogen (" +
        found.slice(0, 8).join(", ") + "). Dat is niet toegestaan; vervang ze door passende alternatieven.";
    }
    return next();
  }
  function next() {
    attempt++;
    return callAnthropicOnce(currentPrompt, null, null, image).then(function (parsed) {
      if (attempt === 1) track.stage = "check";
      if (post) parsed = post(parsed);
      if (attempt === 1 && Array.isArray(parsed)) return repairRound(parsed, 1);
      return handleSingle(parsed);
    });
  }
  return next();
}
// Blijft er na alle pogingen toch iets niet-passends over, dan laten we die gerechten weg (als er iets overblijft).
function finalizeDiet(parsed, rules) {
  rules = asDietRules(rules);
  if (!rulesActive(rules) || !Array.isArray(parsed)) return parsed;
  var ok = parsed.filter(function (d) { return !dishRuleViolations(d, rules).length; });
  if (ok.length && ok.length < parsed.length) console.warn("Eetregels " + [rules.style].concat(rules.health).filter(Boolean).join("+") + ": " + (parsed.length - ok.length) + " gerecht(en) weggelaten na herhaalde overtreding.");
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
        var gatedModule = { price: "prices", photo: "photo" }[action] || null;
        if (gatedModule && !mods[gatedModule]) {
          log(action, false, 503, "Module uitgeschakeld: " + gatedModule);
          return sendJSON(res, 503, moduleOffBody(gatedModule, settings));
        }
        return getUserPlan(uidForLog, settings).then(function (plan) {
          if (plan === "expired") {
            log(action, false, 402, "Proefperiode voorbij");
            return sendJSON(res, 402, planRequiredBody());
          }
          if (gatedModule && planBlocksModule(settings, gatedModule, plan)) {
            log(action, false, 503, "Alleen voor Plus: " + gatedModule);
            return sendJSON(res, 503, moduleOffBody(gatedModule, settings));
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
    dbGetDoc("data/users/" + anon + "/meta"), dbGetDoc("adminMeta/" + anon), dbGetDoc("listsIndex/" + anon), dbGetDoc("push/" + anon), dbGetDoc("quota/" + anon), dbGetDoc("notify/" + anon)
  ])).then(function (r) {
    var tokens = r[5].exists && r[5].value && Array.isArray(r[5].value.tokens) ? r[5].value.tokens : [];
    return { prefs: r[0], dishes: r[1], plannedWeeks: r[2], meta: r[3], adminMeta: r[4], tokens: tokens, push: r[6], quota: r[7], notify: r[8] };
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
  if (d.notify && d.notify.exists) writes.push(dbSetDoc("notify/" + uid, d.notify.value));
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
  var paths = UPGRADE_SUBPATHS.map(function (s) { return "data/users/" + uid + "/" + s; }).concat(["data/users/" + uid + "/meta", "adminMeta/" + uid, "listsIndex/" + uid, "push/" + uid, "quota/" + uid, "notify/" + uid]);
  return Promise.all(paths.map(dbDeleteDoc).concat((tokens || []).map(function (t) {
    return dbGetDoc("lists/" + t).then(function (r) { return r.exists && r.value ? dbSetDoc("lists/" + t, Object.assign({}, r.value, { ownerUid: anon })) : null; });
  }))).catch(function () {});
}
function cleanupAnon(anon) {
  var paths = UPGRADE_SUBPATHS.map(function (s) { return "data/users/" + anon + "/" + s; }).concat(["data/users/" + anon + "/meta", "adminMeta/" + anon, "listsIndex/" + anon, "push/" + anon, "quota/" + anon, "notify/" + anon]);
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
    return Promise.all([readAnonData(user.uid), user.email ? loadOwnAccount(user) : Promise.resolve(null), isAppAdmin(user)]).then(function (r) {
      var s = anonSummary(r[0]), acc = r[1];
      sendJSON(res, 200, { type: user.email ? "account" : "anon", uid: user.uid, email: user.email || null, admin: !!r[2],
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

// ---- Toestemming: privacyverklaring gelezen + uitdrukkelijke toestemming voor gezondheidsgegevens (AVG art. 9) ----
// consent/<uid> = { version, health: true, at, ip }. Wie een nieuwere versie nog niet zag, krijgt de vraag opnieuw.
// true = toestemming gegeven of nog niet gevraagd; false = bewust zonder gezondheidsgegevens.
function healthConsentOf(uid) {
  return dbGetDoc("consent/" + uid).then(function (r) { return !(r.exists && r.value && r.value.health === false); }, function () { return true; });
}
var HEALTH_PREF_FIELDS = ["heightCm", "weightKg", "age", "health", "water"];
function stripHealthData(subpath, value) {
  if (!value || typeof value !== "object") return value;
  var v = JSON.parse(JSON.stringify(value));
  if (subpath === "prefs") {
    HEALTH_PREF_FIELDS.forEach(function (k) { if (k in v) v[k] = k === "health" ? [] : k === "water" ? null : ""; });
    if (v.coach && typeof v.coach === "object") { v.coach.water = false; v.coach.daytools = false; }
    if (v.journey && Array.isArray(v.journey.log)) v.journey.log = v.journey.log.filter(function (x) { return x && ["gewicht", "middel", "nek", "heup", "borst", "arm", "been"].indexOf(x.m) === -1; });
    if (v.journey && v.journey.metric === "gewicht") v.journey.metric = "";
    delete v.weightGoal; delete v.cycle;
    if (v.journey) delete v.journey.checkins;
  } else if (subpath === "plannedWeeks") {
    var list = Array.isArray(v.list) ? v.list : Array.isArray(v) ? v : [];
    list.forEach(function (w) { if (w && w.extra) delete w.extra; });
  }
  return v;
}
function wipeHealthData(uid) {
  return Promise.all(["prefs", "plannedWeeks"].map(function (sp) {
    return dataOwnerUid(uid, sp).then(function (owner) {
      var path = "data/users/" + (sp === "prefs" ? uid : owner) + "/" + sp;
      return dbGetDoc(path).then(function (r) { if (r.exists && r.value) return dbSetDoc(path, stripHealthData(sp, r.value)); });
    });
  }));
}
function handleConsent(req, res) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (req.method === "GET") return dbGetDoc("consent/" + user.uid).then(function (r) { sendJSON(res, 200, { consent: r.exists ? r.value : null }); });
    return readBody(req).then(function (body) {
      return getSettings().then(function (s) {
        if (body && body.withdraw === true) {
          var wd = { version: s.privacy.version, health: false, at: new Date().toISOString(), ip: clientIp(req), withdrawn: true };
          return dbSetDoc("consent/" + user.uid, wd).then(function () { return wipeHealthData(user.uid); }).then(function () {
            logEvent("privacy", "consent-withdraw", true, 200, { uid: user.uid });
            sendJSON(res, 200, { consent: wd });
          });
        }
        if (!body || body.privacy !== true || typeof body.health !== "boolean") return sendJSON(res, 400, { code: "bad_request", message: "Bevestig dat je de privacyverklaring hebt gelezen." });
        var doc = { version: s.privacy.version, health: body.health, at: new Date().toISOString(), ip: clientIp(req) };
        return dbSetDoc("consent/" + user.uid, doc).then(function () { return body.health ? null : wipeHealthData(user.uid); }).then(function () {
          logEvent("privacy", body.health ? "consent" : "consent-no-health", true, 200, { uid: user.uid, version: doc.version });
          sendJSON(res, 200, { consent: doc });
        });
      });
    });
  }).catch(function () { sendJSON(res, 500, { code: "error", message: "Opslaan lukte niet. Probeer het opnieuw." }); });
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
var DISH_ACTIONS = { generate: true, background: true, variation: true, photo: true };
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
// Met het proefmodel (billing.trialEnabled) kent een account drie standen: "plus", "trial" (de eerste dagen, alles
// open, net als Plus) en "expired" (proef voorbij zonder Plus: alles wat je hebt blijft bruikbaar, maar nieuwe gerechten
// ontwerpen en de planning wijzigen kan niet meer). Zonder proefmodel: "plus" of "free", zoals voorheen.
// De proef start bij het eerste verzoek van het account na het aanzetten (nieuwe accounts: meteen bij aanmaken).
var DAY_MS = 24 * 60 * 60 * 1000;
function trialEndsAt(doc, s) { return doc && doc.trialStart ? doc.trialStart + s.billing.trialDays * DAY_MS : null; }
function ensureTrialStart(uid) {
  return withBillingLock(uid, function () {
    return getBillingDoc(uid).then(function (doc) {
      if (doc.trialStart) return doc;
      doc.trialStart = Date.now();
      return dbSetDoc("billing/" + uid, doc).then(function () { return doc; });
    });
  });
}
function getUserPlanInfo(uid, settings) {
  if (!uid) return Promise.resolve({ plan: settings.billing.trialEnabled ? "expired" : "free" });
  return dbGetDoc("billing/" + uid).then(function (r) {
    var doc = r.exists ? r.value : null, now = Date.now();
    var plusOk = plusActiveDoc(doc, now) && (billingLive(settings) || (settings.billing.trialEnabled && doc.grantUntil > now));
    if (plusOk) return { plan: "plus" };
    if (!settings.billing.trialEnabled) return { plan: "free" };
    if (!UID_RE.test(uid)) return { plan: "expired" };
    return (doc && doc.trialStart ? Promise.resolve(doc) : ensureTrialStart(uid)).then(function (d) {
      var end = trialEndsAt(d, settings);
      return { plan: end && now < end ? "trial" : "expired", trialEndsAt: end };
    });
  }).catch(function () { return { plan: settings.billing.trialEnabled ? "trial" : "free" }; });   // opslag haperde: niet blokkeren
}
function getUserPlan(uid, settings) { return getUserPlanInfo(uid, settings).then(function (i) { return i.plan; }); }
function hasPlusAccess(plan) { return plan === "plus" || plan === "trial"; }
function effectiveDishCap(uid) {
  return Promise.all([dbGetDoc("adminMeta/" + uid), getSettings()]).then(function (r) {
    var own = r[0].exists && r[0].value && typeof r[0].value.dishCap === "number" ? r[0].value.dishCap : null;
    var s = r[1];
    return getUserPlan(uid, s).then(function (plan) {
      return { cap: own !== null ? own : hasPlusAccess(plan) ? s.billing.plusDishCap : s.limits.monthlyDishCap, own: own, plan: plan };
    });
  });
}
// Onderdelen die je (naast algeheel aan/uit) ook per abonnement kunt vrijgeven: "iedereen" of "alleen Plus".
var PLAN_GATEABLE_MODULES = ["prices", "photo", "bring", "sharing", "pdf", "images", "assistant"];
// True als dit onderdeel voor deze gebruiker geblokkeerd is omdat het alleen voor Plus is vrijgegeven.
function planBlocksModule(s, key, plan) {
  return PLAN_GATEABLE_MODULES.indexOf(key) > -1 && !!(s.planOnly && s.planOnly[key]) && !hasPlusAccess(plan);
}
function quotaState(uid) {
  return Promise.all([getQuotaDoc(uid), effectiveDishCap(uid)]).then(function (r) {
    return { used: r[0].dishes, cap: r[1].cap, own: r[1].own, plan: r[1].plan, doc: r[0] };
  }).catch(function () { return null; });   // opslag haperde: liever doorlaten dan iedereen blokkeren
}
function planRequiredBody() {
  return { code: "plan_required", message: "Je gratis proefperiode is voorbij. Met Balanza Plus ontwerp je weer nieuwe gerechten en pas je je planning aan. Alles wat je al hebt, blijft gewoon bruikbaar." };
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
    return Promise.all([quotaState(user.uid), getSettings().then(function (s) { return getUserPlanInfo(user.uid, s).then(function (i) { i.trialDays = s.billing.trialDays; return i; }); })]).then(function (r) {
      var q = r[0] || { used: 0, cap: 0 }, pi = r[1] || {};
      sendJSON(res, 200, { plan: pi.plan || q.plan || "free", trialEndsAt: pi.trialEndsAt ? new Date(pi.trialEndsAt).toISOString() : null, trialDays: pi.trialDays || null, month: monthKey(), dishes: q.used, cap: q.cap, unlimited: !(q.cap > 0), remaining: q.cap > 0 ? Math.max(0, q.cap - q.used) : null, resetsOn: nextMonthStart() });
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
  job.usage = usage;   // alleen in het geheugen: voor de voortgang bij het peilen
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
      if (job.status === "running") return sendJSON(res, 200, { status: "running", elapsedMs: Date.now() - job.createdAt, progress: summarizeProgress(job.usage) });
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
    // Apple weigert meldingen als 'sub' geen echt adres is (bijv. een .invalid-mailadres): altijd een echte https-URL gebruiken.
    var h = host || notifyHost();
    var subject = process.env.VAPID_SUBJECT || (h ? "https://" + String(h).replace(/[^A-Za-z0-9.:-]/g, "") : "https://balanza.app");
    var jwt = signVapid(endpoint.origin, subject, keys);
    var body = encryptWebPush(sub.p256dh, sub.auth, Buffer.from(JSON.stringify(payload)));
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, 10000);
    return fetch(sub.endpoint, {
      method: "POST", redirect: "manual", signal: ctrl.signal, body: body,
      headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", "Content-Length": String(body.length), "TTL": "3600", "Urgency": "normal", "Authorization": "vapid t=" + jwt + ", k=" + keys.publicKey }
    }).then(function (r) {
      clearTimeout(t);
      return r.text().catch(function () { return ""; }).then(function (txt) { return { status: r.status, reason: r.status >= 300 ? pushReason(txt) : "" }; });
    }, function (e) { clearTimeout(t); throw e; });
  });
}
function pushReason(txt) {   // Apple/Google geven bij een weigering een korte reden terug, bijv. {"reason":"BadJwtToken"}
  var t = String(txt || "").slice(0, 300);
  try { var j = JSON.parse(t); if (j && (j.reason || j.message || j.error)) return String(j.reason || j.message || (j.error && j.error.message) || j.error).slice(0, 120); } catch (e) {}
  return t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
function pushServiceName(endpoint) {
  try { var h = new URL(endpoint).hostname; return /apple\.com$/.test(h) ? "Apple" : /googleapis\.com$/.test(h) ? "Google" : /mozilla\.com$/.test(h) ? "Firefox" : /windows\.com$/.test(h) ? "Windows" : h; } catch (e) { return "?"; }
}
function notifyUser(uid, payload, host, kind) {
  return dbGetDoc("push/" + uid).then(function (r) {
    var subs = r.exists && r.value && Array.isArray(r.value.subs) ? r.value.subs : [];
    if (!subs.length) return { sent: 0 };
    return Promise.all(subs.map(function (s) {
      return sendWebPush(s, payload, host).then(function (x) { return { s: s, status: x.status, reason: x.reason }; }, function (e) { return { s: s, status: 0, reason: e && e.message ? String(e.message).slice(0, 120) : "netwerkfout" }; });
    })).then(function (results) {
      var sent = results.filter(function (x) { return x.status >= 200 && x.status < 300; }).length;
      var dead = results.filter(function (x) { return [400, 401, 403, 404, 410].indexOf(x.status) > -1; }).map(function (x) { return x.s.endpoint; });
      logEvent("push", kind || "notify", sent > 0, sent > 0 ? 200 : (results[0] ? results[0].status : 0), { uid: uid, sent: sent, failed: results.length - sent, error: sent > 0 ? undefined : "Melding niet afgeleverd" + (results[0] && results[0].reason ? " (" + pushServiceName(results[0].s.endpoint) + ": " + results[0].reason + ")" : "") });
      var detail = results.map(function (x) { return { service: pushServiceName(x.s.endpoint), status: x.status, reason: x.reason || "" }; });
      if (!dead.length) return { sent: sent, removed: 0, results: detail };
      return dbSetDoc("push/" + uid, { subs: subs.filter(function (s) { return dead.indexOf(s.endpoint) === -1; }) }).then(function () { return { sent: sent, removed: dead.length, results: detail }; });
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

// ---------- Geplande meldingen: planherinneringen en nieuwe community-recepten ----------
// Per gebruiker één document notify/<uid>: { prefs: {...}, state: {...} }. Geen document = de standaardwaarden hieronder.
// Alles staat standaard aan, maar er gaat alleen iets naar wie meldingen op een toestel heeft aangezet (push/<uid>).
// Elke paar minuten kijkt de server (en/of een externe cron via /api/cron/notify) wie er nu een melding moet krijgen.
// Tijden zijn Nederlandse tijd; een melding gaat binnen 3 uur na het gekozen tijdstip de deur uit, anders slaan we hem over.
var NOTIFY_TZ = "Europe/Amsterdam";
var NOTIFY_DEFAULTS = { weighIn: true, planWeek: true, planWeekDay: 0, planWeekTime: "19:00", autoWeek: true, planToday: true, planTodayTime: "09:00", community: true, morning: true, morningTime: "08:00",
  cookedCheck: true, cookedTime: "20:30", recap: true };
var RECAP_TIME = "10:00", TRIAL_RECAP_TIME = "18:00";
var NOTIFY_WINDOW_MIN = 180;
var COMMUNITY_DIGEST_TIME = "17:00";
var COMMUNITY_MATCH_BALANS = 80;   // iets ruimer dan voor eigen gerechten: een recept van een ander is gemaakt voor zijn doel   // dan zoek je inspiratie voor het avondeten
var NOTIFY_TICK_MS = 5 * 60 * 1000;
var CRON_SECRET = process.env.CRON_SECRET || "";
var WEEKDAY_NAMES = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
var notifyStats = { lastTickAt: null, lastTickMs: 0, lastTickSent: 0, lastTickSource: null, running: false };

function validHHMM(v) { return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
function hhmmToMin(v) { return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5)); }
function cleanNotifyPrefs(p) {
  var out = Object.assign({}, NOTIFY_DEFAULTS);
  if (!p || typeof p !== "object") return out;
  ["planWeek", "autoWeek", "planToday", "community", "cookedCheck", "recap", "morning", "weighIn"].forEach(function (k) { if (typeof p[k] === "boolean") out[k] = p[k]; });
  if (validHHMM(p.morningTime)) out.morningTime = p.morningTime;
  if (validHHMM(p.cookedTime)) out.cookedTime = p.cookedTime;
  if (Number.isInteger(p.planWeekDay) && p.planWeekDay >= 0 && p.planWeekDay <= 6) out.planWeekDay = p.planWeekDay;
  if (validHHMM(p.planWeekTime)) out.planWeekTime = p.planWeekTime;
  if (validHHMM(p.planTodayTime)) out.planTodayTime = p.planTodayTime;
  return out;
}
// ---- Voorbereidingstip voor vanavond (zelfde regels als in de app) ----
function findDishIn(dishesDoc, id) {
  var found = null;
  if (dishesDoc && typeof dishesDoc === "object") Object.keys(dishesDoc).forEach(function (mt) {
    if (!found && Array.isArray(dishesDoc[mt])) found = dishesDoc[mt].filter(function (d) { return d && d.id === id; })[0] || null;
  });
  return found;
}
var PREP_FROZEN_RE = /\b(kipfilet|kippendij\w*|kippenpoot\w*|kip|gehakt|rundergehakt|kipgehakt|biefstuk|steak|varkenshaas|karbonade|zalm\w*|kabeljauw|koolvis|tilapia|pangasius|garnalen|scampi|kalkoen\w*|riblappen|stoofvlees|lamsvlees|shoarma)\b/i;
function prepTipFor(dish) {
  var ing = (Array.isArray(dish.ingredienten) ? dish.ingredienten : []).map(function (x) { return typeof x === "string" ? x : (x && x.tekst) || ""; }).join(" ; ");
  var steps = (Array.isArray(dish.steps) ? dish.steps : []).map(function (x) { return (x && (x.title + " " + x.content)) || ""; }).join(" ");
  var tips = [];
  var dried = /gedroogde (bonen|kikkererwten|linzen|witte bonen|kidneybonen)/i.exec(ing);
  if (dried) tips.push("Zet de gedroogde " + dried[1].toLowerCase() + " nu alvast in de week.");
  if (/marineer|marinade|laten marineren/i.test(steps)) tips.push("Maak de marinade vanochtend al, dan trekt de smaak goed in.");
  var fz = PREP_FROZEN_RE.exec(ing);
  if (fz) tips.push("Ligt de " + fz[1].toLowerCase() + " in de vriezer? Leg hem nu in de koelkast om te ontdooien.");
  var mins = Number(dish.bereidingstijd || dish.bereidingstijd_minuten) || 0;
  if (mins >= 60) tips.push("Reken op ongeveer " + mins + " minuten, dus begin op tijd.");
  return tips.slice(0, 2).join(" ");
}
// Datum en tijd zoals in Nederland, los van de tijdzone van de server.
var notifyFmt = new Intl.DateTimeFormat("en-GB", { timeZone: NOTIFY_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
function localNow(ms) {
  var parts = {};
  notifyFmt.formatToParts(new Date(ms)).forEach(function (x) { parts[x.type] = x.value; });
  var wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { date: parts.year + "-" + parts.month + "-" + parts.day, weekday: wd, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
function addDaysKey(key, n) { var d = new Date(key + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// De eerstvolgende maandag ná vandaag (op maandag zelf: volgende week; de herinnering gaat over de week die nog komt).
function nextMondayKey(today) { var wd = new Date(today + "T12:00:00Z").getUTCDay(); return addDaysKey(today, ((8 - wd) % 7) || 7); }
function mondayOfKey(today) { var wd = new Date(today + "T12:00:00Z").getUTCDay(); return addDaysKey(today, -((wd + 6) % 7)); }
function inWindow(nowMin, target) { var t = hhmmToMin(target); return nowMin >= t && nowMin < t + NOTIFY_WINDOW_MIN; }
var PLAN_DAY_NAMES = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"];
function weekList(doc) { return doc && Array.isArray(doc.list) ? doc.list : Array.isArray(doc) ? doc : []; }
function dinnersPlanned(weeks, mondayKey) {
  var w = weeks.filter(function (x) { return x && x.weekStart === mondayKey; })[0];
  var slots = w && w.slots && typeof w.slots === "object" ? w.slots : {};
  return PLAN_DAY_NAMES.filter(function (d) { return slots[d + "|Diner"]; }).length;
}
function fmtDayMonth(key) { var d = new Date(key + "T12:00:00Z"); return d.getUTCDate() + " " + ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"][d.getUTCMonth()]; }

// Past een community-recept bij deze gebruiker? Voedingsstijl, uitgesloten ingrediënten, maaltijdmoment en balans voor zijn doel.
function communityMatches(rec, prefs) {
  var d = rec.dish || {};
  prefs = prefs || {};
  if (Array.isArray(prefs.mealTypes) && prefs.mealTypes.length && prefs.mealTypes.indexOf(d.mealType) === -1) return false;
  if (prefs.dietStyle && dishDietViolations(d, prefs.dietStyle).length) return false;
  if (!communityHealthOk(d, prefs)) return false;
  var excl = String(prefs.exclude || "").toLowerCase().split(/[,;\n]+/).map(function (x) { return x.trim(); }).filter(function (x) { return x.length >= 3; });
  if (excl.length) {
    var hay = (d.name + " " + (d.ingredienten || []).join(" ")).toLowerCase();
    if (excl.some(function (x) { return hay.indexOf(x) > -1; })) return false;
  }
  if (prefs.goal && d.kcal) { if (computeBalanceServer(d.kh || 0, d.eiwit || 0, d.vet || 0, prefs.goal, prefs.dietStyle) < COMMUNITY_MATCH_BALANS) return false; }
  return true;
}

function notifyHost() {
  var base = process.env.PUBLIC_BASE_URL || "";
  try { if (base) return new URL(base).host; } catch (e) {}
  return process.env.RENDER_EXTERNAL_HOSTNAME || null;
}
// ---- Conceptweek: Balanza zet de week alvast klaar met je eigen gerechten (geen AI, dus geen kosten) ----
var DRAFT_MAIN = ["Ontbijt", "Lunch", "Diner"];
var LEFTOVER_MAX_DAYS = 10;
function activeLeftovers(prefs, today) {
  var list = prefs && Array.isArray(prefs.leftovers) ? prefs.leftovers : [];
  return list.filter(function (l) { return l && typeof l.t === "string" && l.t.trim() && (!l.at || !today || addDaysKey(String(l.at).slice(0, 10), LEFTOVER_MAX_DAYS) >= today); })
    .map(function (l) { return l.t.trim().toLowerCase(); });
}
function dishUsesTerms(d, terms) {
  if (!terms.length || !d) return 0;
  var hay = (String(d.name || "") + " " + (Array.isArray(d.ingredienten) ? d.ingredienten.join(" ") : "")).toLowerCase();
  return terms.filter(function (t) { return t.length >= 3 && hay.indexOf(t) > -1; }).length;
}
function dishTs(d) { var m = String(d && d.id || "").match(/(\d{12,14})/); return m ? Number(m[1]) : 0; }
// Vult de lege hoofdmaaltijden van één week. Geeft { week, added, keys } of null als er te weinig gerechten zijn.
function buildDraftWeek(weeksList, dishesDoc, prefs, mondayKey, today) {
  var meals = (Array.isArray(prefs.mealTypes) && prefs.mealTypes.length ? prefs.mealTypes : ["Diner"]).filter(function (m) { return DRAFT_MAIN.indexOf(m) > -1; });
  if (!meals.length) meals = ["Diner"];
  var terms = activeLeftovers(prefs, today);
  var pRules = { health: [], proteinOut: cleanProteinOut(prefs.proteinOut, prefs.dietStyle, prefs.exclude) };   // wat je niet (meer) eet, komt ook niet in je conceptweek
  var pools = {};
  meals.forEach(function (m) {
    var arr = dishesDoc && Array.isArray(dishesDoc[m]) ? dishesDoc[m] : [];
    var seen = {};
    pools[m] = arr.filter(function (d) { if (!d || !d.id || d.prep || d.qaHidden || d.rating === -1 || seen[d.id]) return false; if (pRules.proteinOut.length && dishHealthViolations(d, pRules).length) return false; seen[d.id] = 1; return true; })
      .map(function (d) { return { d: d, score: (d.rating === 1 ? 3 : 0) + dishUsesTerms(d, terms) * 2 + Math.random() * 1.5 + (dishTs(d) / 1e13) }; });
  });
  if (!pools.Diner && !meals.some(function (m) { return pools[m].length; })) return null;
  var week = weeksList.filter(function (w) { return w && w.weekStart === mondayKey; })[0];
  var isNew = !week;
  if (isNew) week = { id: "pw" + Date.now() + Math.floor(Math.random() * 1000), weekStart: mondayKey, slots: {}, dynamicPrep: null };
  week.slots = week.slots && typeof week.slots === "object" ? week.slots : {};
  var keys = [], prev = {};
  PLAN_DAY_NAMES.forEach(function (day) {
    var today2 = {};
    meals.forEach(function (m) {
      var key = day + "|" + m;
      if (week.slots[key]) { today2[week.slots[key].dayId] = 1; return; }
      var pool = pools[m];
      if (!pool || pool.length < 2) return;   // met één gerecht wordt het elke dag hetzelfde: dan liever niets
      pool.sort(function (a, b) { return b.score - a.score; });
      var pick = pool.filter(function (p) { return !prev[p.d.id] && !today2[p.d.id]; })[0];
      if (!pick) return;
      week.slots[key] = { name: pick.d.name, weekId: "cache", dayId: pick.d.id, balans: pick.d.balans };
      pick.score -= 2.5;   // rouleren: een gerecht komt pas na een paar dagen terug
      today2[pick.d.id] = 1; keys.push(key);
    });
    prev = today2;
  });
  if (keys.length < 3) return null;
  week.draft = { createdAt: new Date().toISOString(), createdOn: today, keys: keys };
  return { week: week, isNew: isNew, added: keys.length, keys: keys };
}
function slotsCount(w) { return w && w.slots ? Object.keys(w.slots).length : 0; }
function recapOf(w) {
  var slots = w && w.slots ? Object.keys(w.slots).map(function (k) { return w.slots[k]; }) : [];
  var bal = slots.map(function (x) { return Number(x && x.balans); }).filter(function (n) { return n > 0; });
  return { meals: slots.length, cooked: slots.filter(function (x) { return x && x.cooked === true; }).length,
    balans: bal.length ? Math.round(bal.reduce(function (a, b) { return a + b; }, 0) / bal.length) : null };
}

// Bepaalt voor één gebruiker welke melding(en) nu weg moeten en verstuurt ze. Geeft het aantal verstuurde meldingen.
// Zit de gebruiker in een huishouden, dan komen gerechten en planning van de eigenaar (die worden gedeeld).
function notifyTickUser(uid, ctx) {
  return householdOf(uid).catch(function () { return null; }).then(function (hh) {
  var dataUid = hh && hh.ownerUid ? hh.ownerUid : uid;
  return Promise.all([dbGetDoc("notify/" + uid), dbGetDoc("data/users/" + uid + "/prefs"), dbGetDoc("data/users/" + dataUid + "/plannedWeeks"), dbGetDoc("billing/" + uid), dbGetDoc("autoplan/" + uid)]).then(function (r) {
    var autoOn = r[4].exists && r[4].value && cleanAutoPlan(r[4].value.config).on;   // automatisch plannen doet de weekplanning al
    var doc = r[0].exists && r[0].value ? r[0].value : {};
    var np = cleanNotifyPrefs(doc.prefs), st = Object.assign({}, doc.state || {});
    var prefs = r[1].exists && r[1].value ? r[1].value : {};
    var weeksDoc = r[2].exists && r[2].value ? r[2].value : null;
    var weeks = weekList(weeksDoc);
    var ps = adminPlanState(r[3].exists ? r[3].value : null, ctx.settings, !!ctx.accounts[uid], ctx.now), plan = ps.plan;
    var canPlan = plan !== "expired";   // na de proef zonder Plus kan iemand niet plannen: dan ook niet aansporen
    var now = ctx.local, jobs = [], changed = false, extra = Promise.resolve();
    var mealTypes = Array.isArray(prefs.mealTypes) && prefs.mealTypes.length ? prefs.mealTypes : ["Diner"];

    // 1. Weekplanning: liefst zet Balanza de week alvast klaar (concept), anders een herinnering
    if (!autoOn && np.planWeek && canPlan && mealTypes.indexOf("Diner") > -1 && now.weekday === np.planWeekDay && inWindow(now.minutes, np.planWeekTime) && st.weekSentOn !== now.date) {
      var mon = nextMondayKey(now.date), planned = dinnersPlanned(weeks, mon);
      st.weekSentOn = now.date; changed = true;
      var wk = weeks.filter(function (x) { return x && x.weekStart === mon; })[0];
      var readyMsg = function (n) {
        jobs.push({ kind: "week-ready", payload: { title: "Je week staat klaar", tag: "balanza-week",
          body: n + " maaltijden staan ingepland voor de week vanaf maandag " + fmtDayMonth(mon) + ", met je eigen gerechten. Tik om te bekijken en te wisselen.",
          url: "/?open=plan&week=" + mon } });
      };
      if (wk && wk.draft && wk.draft.createdOn === now.date) readyMsg(slotsCount(wk));   // een huisgenoot heeft hem net klaargezet
      else if (planned <= 4) {
        extra = (np.autoWeek ? dbGetDoc("data/users/" + dataUid + "/dishes") : Promise.resolve(null)).then(function (dr) {
          var built = dr && dr.exists ? buildDraftWeek(weeks, dr.value, prefs, mon, now.date) : null;
          if (built) {
            if (built.isNew) weeks.push(built.week);
            readyMsg(slotsCount(built.week));
            return dbSetDoc("data/users/" + dataUid + "/plannedWeeks", Object.assign({}, weeksDoc && !Array.isArray(weeksDoc) ? weeksDoc : {}, { list: weeks }));
          }
          jobs.push({ kind: "remind-week", payload: { title: "Plan je week", tag: "balanza-week",
            body: planned === 0 ? "Je week vanaf maandag " + fmtDayMonth(mon) + " is nog leeg. Zullen we hem samen invullen?" : "Nog " + (7 - planned) + " avonden zonder diner in de week vanaf " + fmtDayMonth(mon) + ". Tik om ze in te vullen.",
            url: "/?open=plan&week=" + mon } });
        });
      }
    }
    // 2. Vandaag nog geen diner
    var monToday = mondayOfKey(now.date), dayName = PLAN_DAY_NAMES[(now.weekday + 6) % 7];
    var wToday = weeks.filter(function (x) { return x && x.weekStart === monToday; })[0];
    if (np.planToday && canPlan && mealTypes.indexOf("Diner") > -1 && inWindow(now.minutes, np.planTodayTime) && st.todaySentOn !== now.date) {
      st.todaySentOn = now.date; changed = true;
      if (!(wToday && wToday.slots && wToday.slots[dayName + "|Diner"])) jobs.push({ kind: "remind-today", payload: { title: "Wat eten we vanavond?", tag: "balanza-today",
        body: "Je hebt voor vanavond nog geen diner gepland. Tik voor een gerecht dat past bij je dag.", url: "/?open=plan&week=" + monToday + "&day=" + dayName } });
    }
    // 2b. Ochtend: vanavond eet je X, en dit kun je nu al doen (alleen als er echt iets voor te bereiden valt)
    if (np.morning && canPlan && inWindow(now.minutes, np.morningTime) && st.morningSentOn !== now.date) {
      var din = wToday && wToday.slots ? wToday.slots[dayName + "|Diner"] : null;
      if (din && din.dayId && !din.leftover) {
        st.morningSentOn = now.date; changed = true;
        var prevExtra = extra;
        extra = prevExtra.then(function () { return dbGetDoc("data/users/" + dataUid + "/dishes"); }).then(function (dr) {
          var dish = dr && dr.exists ? findDishIn(dr.value, din.dayId) : null;
          var tip = dish ? prepTipFor(dish) : "";
          if (tip) jobs.push({ kind: "morning-prep", payload: { title: "Vanavond: " + String(dish.name || din.name).slice(0, 60), tag: "balanza-morning",
            body: tip, url: "/?open=plan&week=" + monToday + "&day=" + dayName } });
        }).catch(function () {});
      }
    }
    // 3. Na het eten: gekookt, en was het lekker? (voedt de smaakgeschiedenis)
    if (np.cookedCheck && inWindow(now.minutes, np.cookedTime) && st.cookedSentOn !== now.date) {
      var dinner = wToday && wToday.slots ? wToday.slots[dayName + "|Diner"] : null;
      if (dinner && dinner.name && dinner.cooked === undefined) {
        st.cookedSentOn = now.date; changed = true;
        jobs.push({ kind: "cooked-check", payload: { title: "Hoe was " + String(dinner.name).slice(0, 60) + "?", tag: "balanza-cooked",
          body: "Gekookt en lekker? Eén tik, dan leert Balanza je smaak en worden je volgende weken nog beter.",
          url: "/?open=cooked&week=" + monToday + "&day=" + dayName } });
      }
    }
    // 4a. Op je eigen weegmoment (standaard maandag 07:30): alleen met een doelgewicht en als je deze week nog niet woog
    var wgoal = prefs.weightGoal && typeof prefs.weightGoal === "object" ? prefs.weightGoal : null;
    var wDay = wgoal && Number(wgoal.weighDay) >= 0 && Number(wgoal.weighDay) <= 6 && wgoal.weighDay !== null && wgoal.weighDay !== "" ? Number(wgoal.weighDay) : 1;
    var wTime = wgoal && validHHMM(wgoal.weighTime) ? wgoal.weighTime : "07:30";
    if (np.weighIn && wgoal && now.weekday === wDay && inWindow(now.minutes, wTime) && st.weighSentOn !== now.date) {
      var wlog = prefs.journey && Array.isArray(prefs.journey.log) ? prefs.journey.log : [];
      if (Number(wgoal.target) > 0 && !wgoal.reachedAt && !wlog.some(function (x) { return x && x.m === "gewicht" && x.w === monToday; })) {
        st.weighSentOn = now.date; changed = true;
        var mWeeks = wlog.filter(function (x) { return x && ["middel", "nek", "heup"].indexOf(x.m) > -1; }).map(function (x) { return x.w; }).sort();
        var measDue = !mWeeks.length || (Date.parse(monToday + "T12:00:00Z") - Date.parse(mWeeks[mWeeks.length - 1] + "T12:00:00Z")) / 86400000 >= 28;
        jobs.push({ kind: "weigh-in", payload: { title: measDue && mWeeks.length ? "Tijd om te wegen en te meten" : "Tijd om te wegen", tag: "balanza-weigh",
          body: "Nuchter en na het plassen, net als vorige week." + (measDue && mWeeks.length ? " Meet ook even je omtrekken; dat doe je eens per maand." : "") + " Eén keer per week wegen is genoeg: elke dag wegen laat vooral schommelingen zien en dat werkt niet motiverend.", url: "/?open=goal" } });
      }
    }
    // 4. Maandag: je week in cijfers
    if (np.recap && now.weekday === 1 && inWindow(now.minutes, RECAP_TIME) && st.recapSentOn !== now.date) {
      st.recapSentOn = now.date; changed = true;
      var lastMon = addDaysKey(monToday, -7);
      var rc = recapOf(weeks.filter(function (x) { return x && x.weekStart === lastMon; })[0]);
      if (rc.meals >= 3) jobs.push({ kind: "recap", payload: { title: "Je week in cijfers", tag: "balanza-recap",
        body: rc.meals + " maaltijden" + (rc.cooked ? ", " + rc.cooked + " gekookt" : "") + (rc.balans ? ", gemiddelde Balans " + rc.balans + "%" : "") + ". Tik voor je terugblik.",
        url: "/?open=recap&week=" + lastMon } });
    }
    // 5. Bijna aan het eind van de proef: laat zien wat je bereikt hebt
    if (plan === "trial" && ps.trialEndsAt && !st.trialRecapSent && inWindow(now.minutes, TRIAL_RECAP_TIME)) {
      var hoursLeft = (Date.parse(ps.trialEndsAt) - ctx.now) / 3600000;
      if (hoursLeft > 12 && hoursLeft <= 48) {
        st.trialRecapSent = now.date; changed = true;
        var all = weeks.reduce(function (acc, w) { var x = recapOf(w); acc.meals += x.meals; acc.cooked += x.cooked; return acc; }, { meals: 0, cooked: 0 });
        jobs.push({ kind: "trial-recap", payload: { title: "Je proefweek in cijfers", tag: "balanza-recap",
          body: all.meals ? all.meals + " maaltijden gepland" + (all.cooked ? " en " + all.cooked + " gekookt" : "") + ". Bekijk wat je bereikt hebt." : "Bekijk wat je deze week met Balanza hebt gedaan.",
          url: "/?open=recap&trial=1" } });
      }
    }
    // 6. Nieuwe community-recepten die passen (hooguit één bundel per dag)
    if (np.community && ctx.communityOn) {
      if (!st.communitySeenUntil) { st.communitySeenUntil = ctx.now; changed = true; }   // eerste keer: geen stapel oude recepten
      else if (inWindow(now.minutes, COMMUNITY_DIGEST_TIME) && st.communitySentOn !== now.date) {
        var fresh = ctx.community.filter(function (c) { return !c.hidden && c.ownerUid !== uid && c.createdAt > st.communitySeenUntil && c.createdAt <= ctx.now && communityMatches(c, prefs); })
          .sort(function (a, b) { return ((b.likeCount || 0) + (b.saveCount || 0)) - ((a.likeCount || 0) + (a.saveCount || 0)) || b.createdAt - a.createdAt; });
        st.communitySentOn = now.date; st.communitySeenUntil = ctx.now; changed = true;
        if (fresh.length) jobs.push({ kind: "community-digest", payload: { title: fresh.length === 1 ? "Nieuw recept dat bij je past" : fresh.length + " nieuwe recepten die bij je passen", tag: "balanza-community",
          body: fresh.length === 1 ? "“" + fresh[0].dish.name + "” staat in de community. Tik om het te bekijken." : "Waaronder “" + fresh[0].dish.name + "”. Tik om ze te bekijken in de community.",
          url: fresh.length === 1 ? "/?open=community&id=" + fresh[0].id : "/?open=community" } });
      }
    }
    var save = changed ? dbSetDoc("notify/" + uid, { prefs: doc.prefs || null, state: st }) : Promise.resolve();
    return Promise.all([save, extra]).then(function () {
      return Promise.all(jobs.map(function (j) { return notifyUser(uid, j.payload, ctx.host, j.kind).then(function (x) { return x.sent > 0 ? 1 : 0; }); }));
    }).then(function (n) { return n.reduce(function (a, b) { return a + b; }, 0); });
  });
  }).catch(function (e) { console.warn("Melding voor " + uid + " mislukt: " + (e && e.message)); return 0; });
}
// ---- Automatisch plannen: één keer instellen, elke week (bijv. zaterdag) zet Balanza de volgende week klaar ----
// Met je eigen gerechten (geen AI, geen kosten). Regels voor afwisseling:
// - een gerecht komt hooguit één keer per maand terug (28 dagen tussen twee keer);
// - favorieten (duimpje omhoog) mogen vaker, maar pas na 10 dagen en hooguit 40% van de maaltijden van een soort per week;
// - gerechten met een duimpje omlaag en wat je niet (meer) eet komen er niet in;
// - is er te weinig keus, dan neemt Balanza het gerecht dat het langst geleden is (minstens een week) en meldt dat.
// Het resultaat is een voorstel: de gebruiker bekijkt het één voor één en keurt het goed.
var AUTOPLAN_MEALS = ["Ontbijt", "Lunch", "Diner", "Snack"];
var AUTOPLAN_SLOT = { Ontbijt: "Ontbijt", Lunch: "Lunch", Diner: "Diner", Snack: "Snack na lunch" };
var AUTOPLAN_REPEAT_DAYS = 28, AUTOPLAN_FAV_GAP = 10, AUTOPLAN_FAV_SHARE = 0.4, AUTOPLAN_MIN_GAP = 7;
function cleanAutoPlan(p) {
  p = p && typeof p === "object" ? p : {};
  var meals = Array.isArray(p.meals) ? AUTOPLAN_MEALS.filter(function (m) { return p.meals.indexOf(m) > -1; }) : ["Diner"];
  var days = Array.isArray(p.days) ? PLAN_DAY_NAMES.filter(function (d) { return p.days.indexOf(d) > -1; }) : PLAN_DAY_NAMES.slice();
  return {
    on: p.on === true,
    meals: meals.length ? meals : ["Diner"],
    days: days.length ? days : PLAN_DAY_NAMES.slice(),
    weekday: Number.isInteger(p.weekday) && p.weekday >= 0 && p.weekday <= 6 ? p.weekday : 6,
    time: validHHMM(p.time) ? p.time : "09:00",
    generate: p.generate !== false   // te weinig gerechten? dan mag Balanza er nieuwe bij maken (telt mee voor de maandlimiet)
  };
}
function daysBetweenKeys(a, b) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000); }
// Wanneer stond elk gerecht voor het laatst gepland (niet-gegeten maaltijden tellen niet mee).
function dishLastUse(weeks, skipWeekKey) {
  var last = {};
  weeks.forEach(function (w) {
    if (!w || !w.slots || !/^\d{4}-\d{2}-\d{2}$/.test(w.weekStart || "") || w.weekStart === skipWeekKey) return;
    Object.keys(w.slots).forEach(function (k) {
      var s = w.slots[k], di = PLAN_DAY_NAMES.indexOf(k.split("|")[0]);
      if (!s || !s.dayId || di < 0 || s.cooked === false) return;
      var dk = addDaysKey(w.weekStart, di);
      if (!last[s.dayId] || last[s.dayId] < dk) last[s.dayId] = dk;
    });
  });
  return last;
}
function buildAutoPlanWeek(weeksList, dishesDoc, prefs, mondayKey, today, cfg) {
  var terms = activeLeftovers(prefs, today);
  var pRules = { health: [], proteinOut: cleanProteinOut(prefs.proteinOut, prefs.dietStyle, prefs.exclude) };
  var week = weeksList.filter(function (w) { return w && w.weekStart === mondayKey; })[0];
  var isNew = !week;
  if (isNew) week = { id: "pw" + Date.now() + Math.floor(Math.random() * 1000), weekStart: mondayKey, slots: {}, dynamicPrep: null };
  week.slots = week.slots && typeof week.slots === "object" ? week.slots : {};
  var last = dishLastUse(weeksList, mondayKey);
  var keys = [], relaxed = 0, empty = 0, noDishes = [], emptyBy = {};
  cfg.meals.forEach(function (m) {
    var slot = AUTOPLAN_SLOT[m], seen = {};
    var pool = (dishesDoc && Array.isArray(dishesDoc[m]) ? dishesDoc[m] : []).filter(function (d) {
      if (!d || !d.id || d.prep || d.qaHidden || d.rating === -1 || seen[d.id]) return false;
      if (pRules.proteinOut.length && dishHealthViolations(d, pRules).length) return false;
      seen[d.id] = 1; return true;
    });
    if (!pool.length) { noDishes.push(m); emptyBy[m] = cfg.days.filter(function (day) { return !week.slots[day + "|" + slot]; }).length; empty += emptyBy[m]; return; }
    var used = {}, favUsed = 0;
    var favCap = Math.max(1, Math.floor(cfg.days.length * AUTOPLAN_FAV_SHARE));
    PLAN_DAY_NAMES.forEach(function (day, di) {   // wat al in de week staat telt mee voor de afwisseling
      var s = week.slots[day + "|" + slot];
      if (s && s.dayId) { used[s.dayId] = 1; var d0 = pool.filter(function (d) { return d.id === s.dayId; })[0]; if (d0 && d0.rating === 1) favUsed++; }
    });
    cfg.days.forEach(function (day) {
      var key = day + "|" + slot;
      if (week.slots[key]) return;
      var date = addDaysKey(mondayKey, PLAN_DAY_NAMES.indexOf(day));
      var gapOf = function (d) { return last[d.id] ? daysBetweenKeys(last[d.id], date) : 999; };
      var cands = pool.filter(function (d) {
        if (used[d.id]) return false;
        var g = gapOf(d);
        return d.rating === 1 ? (g >= AUTOPLAN_FAV_GAP && favUsed < favCap) : g >= AUTOPLAN_REPEAT_DAYS;
      }).map(function (d) {
        return { d: d, score: (d.rating === 1 ? 2.5 : 0) + dishUsesTerms(d, terms) * 2 + Math.min(gapOf(d), 90) / 30 + Math.random() * 1.5 };
      }).sort(function (a, b) { return b.score - a.score; });
      var pick = cands[0] ? cands[0].d : null;
      if (!pick) {   // te weinig keus: het gerecht dat het langst geleden is, maar niet binnen een week
        var alt = pool.filter(function (d) { return !used[d.id] && gapOf(d) >= AUTOPLAN_MIN_GAP && !(d.rating === 1 && favUsed >= favCap); })
          .sort(function (a, b) { return gapOf(b) - gapOf(a) || Math.random() - 0.5; });
        pick = alt[0] || null;
        if (pick) relaxed++;
      }
      if (!pick) { empty++; emptyBy[m] = (emptyBy[m] || 0) + 1; return; }
      week.slots[key] = { name: pick.name, weekId: "cache", dayId: pick.id, balans: pick.balans };
      used[pick.id] = 1; if (pick.rating === 1) favUsed++;
      last[pick.id] = date;
      keys.push(key);
    });
  });
  if (!keys.length) return { added: 0, relaxed: relaxed, empty: empty, emptyBy: emptyBy, noDishes: noDishes, week: week, isNew: isNew };
  var oldKeys = week.draft && Array.isArray(week.draft.keys) ? week.draft.keys.filter(function (k) { return week.slots[k] && keys.indexOf(k) === -1; }) : [];
  week.draft = { createdAt: new Date().toISOString(), createdOn: today, keys: oldKeys.concat(keys), auto: true, relaxed: relaxed, empty: empty };
  return { week: week, isNew: isNew, added: keys.length, keys: keys, relaxed: relaxed, empty: empty, emptyBy: emptyBy, noDishes: noDishes };
}
// Nieuwe gerechten maken voor het automatisch plannen (alleen als er te weinig keus is en de gebruiker dat toestaat).
// Gebruikt dezelfde AI-opdracht als "aanvullen op de achtergrond" in de app, en telt mee voor de dag- en maandlimiet.
var AUTOPLAN_GEN_MAX = 7;
function serverGenParams(prefs, dishesDoc) {
  var all = [];
  if (dishesDoc && typeof dishesDoc === "object") Object.keys(dishesDoc).forEach(function (m) { if (Array.isArray(dishesDoc[m])) all = all.concat(dishesDoc[m]); });
  var names = function (f) { return all.filter(f).map(function (d) { return String(d.name || ""); }).filter(Boolean).slice(-30); };
  return {
    cuisines: prefs.cuisines, flavors: prefs.flavors, level: prefs.level, dietStyle: prefs.dietStyle, health: Array.isArray(prefs.health) ? prefs.health : [],
    proteinOut: Array.isArray(prefs.proteinOut) ? prefs.proteinOut : [], sugarMode: prefs.sugarMode || "natuurlijk", cheeseMode: prefs.cheeseMode || "hardekaas",
    familyMode: prefs.familyMode, ageGroup: prefs.ageGroup || "", student: prefs.student && prefs.student.on ? prefs.student : null,
    equipment: prefs.equipment, exclude: prefs.exclude, goal: prefs.goal, gender: prefs.gender, heightCm: prefs.heightCm, weightKg: prefs.weightKg, age: prefs.age, activityLevel: prefs.activityLevel,
    likes: names(function (d) { return d.rating === 1; }), dislikes: names(function (d) { return d.rating === -1; }),
    existingNames: all.map(function (d) { return String(d && d.name || ""); }).filter(Boolean).slice(-60)
  };
}
function aiDishToStored(d, idx, prefs) {
  var kcal = Number(d.kcal) || 0, khG = Number(d.kh_g) || 0, eiwitG = Number(d.eiwit_g) || 0, vetG = Number(d.vet_g) || 0;
  var kh = kcal ? Math.round(khG * 400 / kcal) : 0, eiwit = kcal ? Math.round(eiwitG * 400 / kcal) : 0, vet = kcal ? Math.round(vetG * 900 / kcal) : 0;
  var steps = Array.isArray(d.steps) ? d.steps.map(function (st) { var o = { title: String(st && st.title || "Stap"), content: String(st && st.content || "") }; if (st && st.timer_seconds) o.timer = Number(st.timer_seconds); return o; }) : [{ title: "Bereiding", content: "Geen bereidingsstappen ontvangen." }];
  return { id: "auto" + Date.now() + "_" + idx, label: "Gerecht " + (idx + 1), name: String(d.name || "Naamloos gerecht").slice(0, 120),
    kcal: kcal, kh: kh, eiwit: eiwit, vet: vet, balans: computeBalanceServer(kh, eiwit, vet, prefs.goal, prefs.dietStyle), khG: khG, eiwitG: eiwitG, vetG: vetG,
    bereidingstijd: Number(d.bereidingstijd_minuten) || 0, fotoZoekterm: String(d.foto_zoekterm || "").trim().slice(0, 80),
    mealType: AUTOPLAN_MEALS.indexOf(d.mealType) > -1 ? d.mealType : "Diner", benodigdheden: String(d.benodigdheden || ""),
    ingredienten: Array.isArray(d.ingredienten) ? d.ingredienten.map(String) : [], steps: steps,
    macroBron: d.macroBron === "nevo" ? "nevo" : "schatting", nevo: d.nevo || null, autoPlan: true };
}
// Geeft { dishes: [...] } of { dishes: [], skipped: "reden" }.
function generateForAutoPlan(uid, prefs, dishesDoc, needed) {
  var types = Object.keys(needed).filter(function (m) { return needed[m] > 0; });
  if (!types.length) return Promise.resolve({ dishes: [] });
  if (!ANTHROPIC_API_KEY) return Promise.resolve({ dishes: [], skipped: "geen AI" });
  return getSettings().then(function (settings) {
    if (!effectiveModules(settings).generate) return { dishes: [], skipped: "genereren staat uit" };
    return Promise.all([getUserPlan(uid, settings), getUsageToday(), quotaState(uid)]).then(function (r) {
      if (r[0] === "expired") return { dishes: [], skipped: "proef voorbij" };
      if (r[1] + runningJobCount() >= liveLimits.dailyGenerateCap) return { dishes: [], skipped: "daglimiet" };
      var q = r[2], total = types.reduce(function (a, m) { return a + needed[m]; }, 0);
      if (quotaBlocked(q, 0)) return { dishes: [], skipped: "maandlimiet" };
      if (q && q.cap > 0 && q.used + total > q.cap) {   // niet over de maandlimiet heen: schaal terug
        var room = q.cap - q.used;
        types.forEach(function (m) { var take = Math.min(needed[m], room); needed[m] = take; room -= take; });
        types = types.filter(function (m) { return needed[m] > 0; });
        if (!types.length) return { dishes: [], skipped: "maandlimiet" };
      }
      var body = { action: "background", needed: needed, params: serverGenParams(prefs, dishesDoc) };
      var usage = newUsage(), t0 = Date.now();
      return usageCtx.run(usage, function () { return runGenerateAction(body); }).then(function (parsed) {
        var arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? Object.keys(parsed).map(function (k) { return parsed[k]; }).filter(Array.isArray)[0] || [] : []);
        var have = {};
        Object.keys(dishesDoc || {}).forEach(function (m) { (Array.isArray(dishesDoc[m]) ? dishesDoc[m] : []).forEach(function (d) { if (d && d.name) have[String(d.name).trim().toLowerCase()] = 1; }); });
        var dishes = arr.filter(function (d) { return d && typeof d === "object" && d.name && !have[String(d.name).trim().toLowerCase()]; }).map(function (d, i) { return aiDishToStored(d, i, prefs); });
        incrementUsageToday();
        return recordAccounting(uid, "background", usage, dishes.length, true).then(function () {
          logRequest(Object.assign({ ts: new Date().toISOString(), type: "generate", action: "autoplan", durationMs: Date.now() - t0, ok: true, status: 200, uid: uid }, meterFields(usage, dishes.length)));
          return { dishes: dishes };
        });
      }).catch(function (e) {
        return recordAccounting(uid, "background", usage, 0, false).then(function () {
          logRequest({ ts: new Date().toISOString(), type: "generate", action: "autoplan", durationMs: Date.now() - t0, ok: false, status: 502, error: String(e && e.message || e).slice(0, 200), uid: uid });
          return { dishes: [], skipped: "genereren mislukt" };
        });
      });
    });
  }).catch(function () { return { dishes: [], skipped: "genereren mislukt" }; });
}
// Voegt nieuwe gerechten toe aan de lijst (max 40 per soort, zoals in de app; favorieten blijven altijd staan).
function addDishesToDoc(doc, dishes) {
  doc = doc && typeof doc === "object" ? doc : {};
  dishes.forEach(function (d) {
    var arr = Array.isArray(doc[d.mealType]) ? doc[d.mealType] : [];
    arr.push(d);
    while (arr.length > 40) { var i = arr.findIndex(function (x) { return !x || x.rating !== 1; }); if (i < 0) break; arr.splice(i, 1); }
    doc[d.mealType] = arr;
  });
  return doc;
}
// Voert het automatisch plannen uit voor één gebruiker (ook in een huishouden: de gedeelde planning van de eigenaar).
// Eerst met de bestaande gerechten; blijft er iets leeg en mag het, dan maakt Balanza er gerechten bij en vult opnieuw.
function runAutoPlanFor(uid, cfg, todayKey, mondayKey) {
  return householdOf(uid).catch(function () { return null; }).then(function (hh) {
    var dataUid = hh && hh.ownerUid ? hh.ownerUid : uid;
    return Promise.all([dbGetDoc("data/users/" + uid + "/prefs"), dbGetDoc("data/users/" + dataUid + "/plannedWeeks"), dbGetDoc("data/users/" + dataUid + "/dishes")]).then(function (r) {
      var prefs = r[0].exists && r[0].value ? r[0].value : {};
      var weeksDoc = r[1].exists && r[1].value ? r[1].value : null, weeks = weekList(weeksDoc);
      var dishes = r[2].exists && r[2].value ? r[2].value : {};
      var b1 = buildAutoPlanWeek(weeks, dishes, prefs, mondayKey, todayKey, cfg);
      if (b1.added && b1.isNew) weeks.push(b1.week);
      var needed = {};
      Object.keys(b1.emptyBy || {}).forEach(function (m) { if (b1.emptyBy[m] > 0) needed[m] = Math.min(AUTOPLAN_GEN_MAX, b1.emptyBy[m] + 1); });   // één extra voor wat speling
      var gen = cfg.generate && Object.keys(needed).length ? generateForAutoPlan(uid, prefs, dishes, needed) : Promise.resolve({ dishes: [] });
      return gen.then(function (g) {
        var res = b1, saveDishes = Promise.resolve();
        if (g.dishes.length) {
          dishes = addDishesToDoc(dishes, g.dishes);
          saveDishes = dbSetDoc("data/users/" + dataUid + "/dishes", dishes);
          var b2 = buildAutoPlanWeek(weeks, dishes, prefs, mondayKey, todayKey, cfg);
          if (b2.added && b2.isNew) weeks.push(b2.week);
          res = { week: b2.week, added: (b1.added || 0) + (b2.added || 0), relaxed: (b1.relaxed || 0) + (b2.relaxed || 0), empty: b2.empty, noDishes: b2.noDishes, generated: g.dishes.length };
          if (res.week.draft) { res.week.draft.relaxed = res.relaxed; res.week.draft.empty = res.empty; res.week.draft.generated = g.dishes.length; }
        } else if (g.skipped) res = Object.assign({}, b1, { genSkipped: g.skipped });
        if (!res.added) return saveDishes.then(function () { return res; });
        return Promise.all([saveDishes, dbSetDoc("data/users/" + dataUid + "/plannedWeeks", Object.assign({}, weeksDoc && !Array.isArray(weeksDoc) ? weeksDoc : {}, { list: weeks }))]).then(function () { return res; });
      });
    });
  });
}
function autoPlanSummary(b) {
  return { added: b.added || 0, relaxed: b.relaxed || 0, empty: b.empty || 0, noDishes: b.noDishes || [], generated: b.generated || 0, genSkipped: b.genSkipped || null };
}
function runAutoPlanTick(ctx) {
  var now = ctx.local;
  return dbListDocs("autoplan/").then(function (docs) {
    var due = docs.filter(function (d) {
      var v = d.value || {}, c = cleanAutoPlan(v.config);
      return c.on && now.weekday === c.weekday && inWindow(now.minutes, c.time) && v.lastRunOn !== now.date && !ctx.blocked[d.path.slice("autoplan/".length)];
    });
    return mapLimit(due, 5, function (d) {
      var uid = d.path.slice("autoplan/".length), v = d.value || {}, cfg = cleanAutoPlan(v.config);
      var mon = nextMondayKey(now.date);
      return dbGetDoc("billing/" + uid).then(function (br) {
        var ps = adminPlanState(br.exists ? br.value : null, ctx.settings, !!ctx.accounts[uid], ctx.now);
        if (ps.plan === "expired") return dbSetDoc("autoplan/" + uid, Object.assign({}, v, { lastRunOn: now.date, last: { week: mon, at: new Date().toISOString(), skipped: "expired" } })).then(function () { return 0; });
        return runAutoPlanFor(uid, cfg, now.date, mon).then(function (b) {
          var sum = autoPlanSummary(b);
          return dbSetDoc("autoplan/" + uid, Object.assign({}, v, { lastRunOn: now.date, last: Object.assign({ week: mon, at: new Date().toISOString() }, sum) })).then(function () {
            logEvent("autoplan", "week", sum.added > 0, 200, { uid: uid, added: sum.added, relaxed: sum.relaxed, empty: sum.empty, generated: sum.generated });
            if (!sum.added) return 0;
            return notifyUser(uid, { title: "Je week staat klaar", tag: "balanza-week",
              body: sum.added + (sum.added === 1 ? " maaltijd" : " maaltijden") + " voor de week vanaf maandag " + fmtDayMonth(mon) + (sum.generated ? ", waarvan " + sum.generated + (sum.generated === 1 ? " nieuw gerecht" : " nieuwe gerechten") : ", elke keer wat anders") + ". Tik om ze één voor één te bekijken en goed te keuren.",
              url: "/?open=review&week=" + mon }, ctx.host, "autoplan").then(function (x) { return x.sent > 0 ? 1 : 0; });
          });
        });
      }).catch(function (e) { console.warn("Automatisch plannen voor " + uid + " mislukt: " + (e && e.message)); return 0; });
    });
  }).then(function (n) { return (n || []).reduce(function (a, b) { return a + b; }, 0); }).catch(function () { return 0; });
}
function handleAutoPlan(req, res) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    var key = "autoplan/" + user.uid;
    return dbGetDoc(key).then(function (r) {
      var doc = r.exists && r.value ? r.value : {};
      var out = function (d) { var c = cleanAutoPlan(d.config); return { config: c, last: d.last || null, next: c.on ? nextAutoPlanRun(c, d.lastRunOn) : null }; };
      if (req.method === "GET") return sendJSON(res, 200, out(doc));
      return readBody(req).then(function (body) {
        body = body || {};
        if (body.run === true) {
          var today = localNow(Date.now()).date, mon = nextMondayKey(today), cfg = cleanAutoPlan(Object.assign({}, doc.config, body.config || {}));
          return runAutoPlanFor(user.uid, cfg, today, mon).then(function (b) {
            var sum = autoPlanSummary(b);
            var next = Object.assign({}, doc, { config: cleanAutoPlan(Object.assign({}, doc.config, body.config || {})), last: Object.assign({ week: mon, at: new Date().toISOString(), manual: true }, sum) });
            logEvent("autoplan", "week-now", sum.added > 0, 200, { uid: user.uid, added: sum.added, relaxed: sum.relaxed, empty: sum.empty });
            return dbSetDoc(key, next).then(function () { sendJSON(res, 200, Object.assign(out(next), { result: Object.assign({ week: mon }, sum) })); });
          });
        }
        var cfg2 = cleanAutoPlan(Object.assign({}, cleanAutoPlan(doc.config), body.config && typeof body.config === "object" ? body.config : {}));
        var next2 = Object.assign({}, doc, { config: cfg2 });
        return dbSetDoc(key, next2).then(function () { sendJSON(res, 200, out(next2)); });
      });
    });
  }).catch(function () { sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." }); });
}
// Eerstvolgende moment (Nederlandse tijd) waarop Balanza de week klaarzet.
function nextAutoPlanRun(c, lastRunOn) {
  var now = localNow(Date.now());
  var add = (c.weekday - now.weekday + 7) % 7;
  if (add === 0 && (lastRunOn === now.date || now.minutes >= hhmmToMin(c.time) + NOTIFY_WINDOW_MIN)) add = 7;
  var day = addDaysKey(now.date, add);
  return { date: day, time: c.time, week: nextMondayKey(day) };
}

function runNotifyTick(source, atMs) {
  if (notifyStats.running) return Promise.resolve({ skipped: true });
  notifyStats.running = true;
  var t0 = Date.now(), now = atMs || Date.now();
  return Promise.all([dbListDocs("push/"), dbListUserIds(), getBlocked(), getSettings(), communityAll().catch(function () { return []; })]).then(function (r) {
    var accounts = {}; r[1].forEach(function (a) { if (a && a.uid && a.email) accounts[a.uid] = true; });
    var ctx = { now: now, local: localNow(now), settings: r[3], accounts: accounts, community: r[4], communityOn: !!effectiveModules(r[3]).community, host: notifyHost(), blocked: r[2].uids || {} };
    var uids = r[0].filter(function (d) { return d.value && Array.isArray(d.value.subs) && d.value.subs.length; }).map(function (d) { return d.path.slice("push/".length); })
      .filter(function (uid) { return !r[2].uids[uid]; });
    return mapLimit(uids, 10, function (uid) { return notifyTickUser(uid, ctx); }).then(function (counts) {
      return runAutoPlanTick(ctx).then(function (n) { return counts.concat([n]); });
    }).then(function (counts) {
      var sent = counts.reduce(function (a, b) { return a + b; }, 0);
      notifyStats = { lastTickAt: new Date().toISOString(), lastTickMs: Date.now() - t0, lastTickSent: sent, lastTickSource: source, running: false, users: uids.length };
      if (sent) console.log("Meldingen: " + sent + " verstuurd (" + source + ", " + uids.length + " gebruikers met meldingen)");
      return { sent: sent, users: uids.length };
    });
  }).catch(function (e) { notifyStats.running = false; console.warn("Meldingsronde mislukt: " + (e && e.message)); return { error: true }; });
}
setTimeout(function () { runNotifyTick("server"); }, 30000);
var notifyTimer = setInterval(function () { runNotifyTick("server"); }, NOTIFY_TICK_MS);
if (notifyTimer.unref) notifyTimer.unref();

// Externe cron (bijv. cron-job.org of een Render Cron Job), voor als de server slaapt: POST met Authorization: Bearer <CRON_SECRET>.
function handleCronNotify(req, res) {
  var auth = String(req.headers["authorization"] || "");
  var given = auth.indexOf("Bearer ") === 0 ? auth.slice(7) : "";
  var ok = CRON_SECRET.length >= 16 && given.length === CRON_SECRET.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(CRON_SECRET));
  if (!ok) return sendJSON(res, 401, { code: "unauthorized", message: "Ongeldige of ontbrekende CRON_SECRET." });
  // Alleen voor tests (NOTIFY_TEST_CLOCK=1): de ronde draaien alsof het een ander tijdstip is.
  var at = null;
  if (process.env.NOTIFY_TEST_CLOCK === "1") { try { at = Number(new URL(req.url, "http://x").searchParams.get("at")) || null; } catch (e) { at = null; } }
  return runNotifyTick("cron", at).then(function (r) { sendJSON(res, 200, Object.assign({ ok: true }, r)); });
}
// De gebruiker leest en wijzigt zijn eigen meldingsvoorkeuren.
function handleNotifyPrefs(req, res) {
  if (!pushSubscribeAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." });
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    var key = "notify/" + user.uid;
    if (req.method === "GET") return dbGetDoc(key).then(function (r) { sendJSON(res, 200, { prefs: cleanNotifyPrefs(r.exists && r.value ? r.value.prefs : null) }); });
    return readBody(req).then(function (body) {
      return dbGetDoc(key).then(function (r) {
        var doc = r.exists && r.value ? r.value : {};
        var next = cleanNotifyPrefs(Object.assign({}, cleanNotifyPrefs(doc.prefs), body && body.prefs && typeof body.prefs === "object" ? body.prefs : {}));
        return dbSetDoc(key, { prefs: next, state: doc.state || {} }).then(function () { sendJSON(res, 200, { prefs: next }); });
      });
    });
  }).catch(function () { sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." }); });
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
// Testmelding: stuurt meteen een melding naar alle toestellen van de gebruiker en meldt per toestel wat de pushdienst zei.
var pushTestAllowed = makeHourlyLimiter(10);
function handlePushTest(req, res) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (!pushTestAllowed("t:" + user.uid)) return sendJSON(res, 429, { code: "rate_limited", message: "Je hebt al een paar testmeldingen gestuurd. Probeer het over een uur opnieuw." });
    return notifyUser(user.uid, { title: "Balanza", body: "Testmelding: je meldingen werken! \ud83c\udf89", url: "/", tag: "balanza-test", badge: 1 }, req.headers.host, "test").then(function (r) {
      sendJSON(res, 200, { sent: r.sent || 0, devices: (r.results || []).length, removed: r.removed || 0, results: r.results || [] });
    });
  }).catch(function () { sendJSON(res, 500, { code: "server_error", message: "De testmelding kon niet worden verstuurd." }); });
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

// ---------- Huishouden: samen plannen ----------
// Een huishouden deelt gerechten en weekplanning (en dus de boodschappenlijst). Voorkeuren, meldingen, abonnement en
// verbruik blijven per persoon. De gedeelde gegevens staan bij de eigenaar (data/users/<eigenaar>/...); leden lezen en
// schrijven die via de server. Hun eigen gerechten en planning blijven onaangeroerd bewaard en komen terug als ze vertrekken.
//   household/<hid>   { id, ownerUid, members: [uid], createdAt }
//   hhof/<uid>        { hid }
//   hhinvite/<token>  { hid, createdBy, expiresAt }
var HOUSEHOLD_SHARED = ["dishes", "plannedWeeks"];
var HOUSEHOLD_MAX = 6;
var HOUSEHOLD_INVITE_TTL = 7 * 24 * 3600 * 1000;
function householdOf(uid) {
  return dbGetDoc("hhof/" + uid).then(function (r) {
    var hid = r.exists && r.value && r.value.hid;
    if (!hid) return null;
    return dbGetDoc("household/" + hid).then(function (h) {
      var v = h.exists && h.value ? h.value : null;
      return v && Array.isArray(v.members) && v.members.indexOf(uid) > -1 ? v : null;
    });
  });
}
// Van wie zijn de gegevens voor dit onderdeel? Gedeelde onderdelen komen van de eigenaar van het huishouden.
function dataOwnerUid(uid, subpath) {
  if (HOUSEHOLD_SHARED.indexOf(subpath) === -1 || /^anon_/.test(uid)) return Promise.resolve(uid);
  return householdOf(uid).then(function (h) { return h && h.ownerUid ? h.ownerUid : uid; }, function () { return uid; });
}
function householdName(uid) {
  return Promise.all([dbGetDoc("data/users/" + uid + "/prefs"), dbGetDoc("data/users/" + uid + "/meta")]).then(function (r) {
    var p = r[0].exists && r[0].value ? r[0].value : {}, m = r[1].exists && r[1].value ? r[1].value : {};
    var n = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 40) : "";
    return n || (m.email ? String(m.email).split("@")[0] : "Lid");
  }).catch(function () { return "Lid"; });
}
function householdView(h, uid) {
  if (!h) return Promise.resolve(null);
  return Promise.all(h.members.map(householdName)).then(function (names) {
    return { id: h.id, owner: h.ownerUid === uid, max: HOUSEHOLD_MAX,
      members: h.members.map(function (m, i) { return { name: names[i], owner: m === h.ownerUid, me: m === uid }; }) };
  });
}
function handleHousehold(req, res, action) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (!user.email) return sendJSON(res, 403, { code: "account_required", message: "Samen plannen kan alleen met een account. Maak eerst een account aan." });
    var uid = user.uid;
    if (req.method === "POST" && !pushSubscribeAllowed(clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." });
    if (req.method === "GET") return householdOf(uid).then(function (h) { return householdView(h, uid); }).then(function (v) { sendJSON(res, 200, { household: v }); });
    return readBody(req).then(function (body) {
      body = body || {};
      if (action === "invite") {
        return householdOf(uid).then(function (h) {
          if (h && h.members.length >= HOUSEHOLD_MAX) throw HttpError(400, "full", "Je huishouden is vol (maximaal " + HOUSEHOLD_MAX + " personen).");
          var make = h ? Promise.resolve(h) : (function () {
            var nh = { id: crypto.randomBytes(9).toString("base64url"), ownerUid: uid, members: [uid], createdAt: new Date().toISOString() };
            return Promise.all([dbSetDoc("household/" + nh.id, nh), dbSetDoc("hhof/" + uid, { hid: nh.id })]).then(function () { return nh; });
          })();
          return make.then(function (hh) {
            var token = crypto.randomBytes(16).toString("base64url");
            return dbSetDoc("hhinvite/" + token, { hid: hh.id, createdBy: uid, expiresAt: Date.now() + HOUSEHOLD_INVITE_TTL }).then(function () {
              logEvent("household", "invite", true, 200, { uid: uid });
              var base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
              if (!base && req.headers.host && /^[A-Za-z0-9.:-]+$/.test(req.headers.host)) base = (String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "http" || /^localhost(:|$)/.test(req.headers.host) ? "http://" : "https://") + req.headers.host;   // altijd een volledige link
              sendJSON(res, 200, { token: token, link: (base || "") + "/?join=" + token, expiresInDays: 7 });
            });
          });
        });
      }
      if (action === "join") {
        var token = typeof body.token === "string" && /^[A-Za-z0-9_-]{16,40}$/.test(body.token) ? body.token : "";
        if (!token) throw HttpError(400, "bad_request", "Deze uitnodiging is ongeldig.");
        return Promise.all([dbGetDoc("hhinvite/" + token), householdOf(uid)]).then(function (r) {
          var inv = r[0].exists && r[0].value ? r[0].value : null;
          if (!inv || inv.expiresAt < Date.now()) throw HttpError(400, "expired", "Deze uitnodiging is verlopen of al gebruikt. Vraag een nieuwe link.");
          if (r[1] && r[1].id === inv.hid) return householdView(r[1], uid).then(function (v) { sendJSON(res, 200, { household: v, already: true }); });
          if (r[1]) throw HttpError(400, "in_household", "Je zit al in een huishouden. Verlaat dat eerst via Mijn profiel.");
          return dbGetDoc("household/" + inv.hid).then(function (hr) {
            var h = hr.exists && hr.value ? hr.value : null;
            if (!h) throw HttpError(400, "expired", "Dit huishouden bestaat niet meer.");
            if (h.members.length >= HOUSEHOLD_MAX) throw HttpError(400, "full", "Dit huishouden is vol.");
            h.members.push(uid);
            return Promise.all([dbSetDoc("household/" + h.id, h), dbSetDoc("hhof/" + uid, { hid: h.id }), dbDeleteDoc("hhinvite/" + token)]).then(function () {
              logEvent("household", "join", true, 200, { uid: uid });
              invalidateSummaries();
              return householdView(h, uid);
            }).then(function (v) { sendJSON(res, 200, { household: v }); });
          });
        });
      }
      if (action === "leave") {
        // Een lid vertrekt (met een kopie van de gedeelde gerechten en planning als het dat wil). Vertrekt de eigenaar,
        // dan wordt het huishouden opgeheven en krijgen alle leden een kopie, zodat niemand ineens met lege handen staat.
        var keepCopy = body.keepCopy !== false;
        return householdOf(uid).then(function (h) {
          if (!h) return sendJSON(res, 200, { household: null });
          var leaving = h.ownerUid === uid ? h.members.filter(function (m) { return m !== uid; }) : [uid];
          return Promise.all(HOUSEHOLD_SHARED.map(function (s) { return dbGetDoc("data/users/" + h.ownerUid + "/" + s); })).then(function (shared) {
            var copies = [];
            if (keepCopy || h.ownerUid === uid) leaving.forEach(function (m) {
              HOUSEHOLD_SHARED.forEach(function (s, i) { if (shared[i].exists) copies.push(dbSetDoc("data/users/" + m + "/" + s, shared[i].value)); });
            });
            var ops = copies.concat(leaving.map(function (m) { return dbDeleteDoc("hhof/" + m); }));
            if (h.ownerUid === uid) ops.push(dbDeleteDoc("household/" + h.id), dbDeleteDoc("hhof/" + uid));
            else { h.members = h.members.filter(function (m) { return m !== uid; }); ops.push(dbSetDoc("household/" + h.id, h)); }
            return Promise.all(ops);
          }).then(function () {
            logEvent("household", h.ownerUid === uid ? "disband" : "leave", true, 200, { uid: uid });
            invalidateSummaries();
            sendJSON(res, 200, { household: null });
          });
        });
      }
      throw HttpError(404, "not_found", "Onbekende actie.");
    });
  }).catch(function (e) {
    if (e && e.status) return sendJSON(res, e.status, { code: e.code, message: e.message });
    sendJSON(res, 500, { code: "error", message: "Er ging iets mis. Probeer het opnieuw." });
  });
}
// Bij het verwijderen van een account: uit het huishouden (en als eigenaar: opheffen, leden krijgen een kopie).
function removeFromHousehold(uid) {
  return householdOf(uid).then(function (h) {
    if (!h) return dbDeleteDoc("hhof/" + uid);
    if (h.ownerUid !== uid) {
      h.members = h.members.filter(function (m) { return m !== uid; });
      return Promise.all([dbSetDoc("household/" + h.id, h), dbDeleteDoc("hhof/" + uid)]);
    }
    var others = h.members.filter(function (m) { return m !== uid; });
    return Promise.all(HOUSEHOLD_SHARED.map(function (s) { return dbGetDoc("data/users/" + uid + "/" + s); })).then(function (shared) {
      var ops = [dbDeleteDoc("household/" + h.id), dbDeleteDoc("hhof/" + uid)];
      others.forEach(function (m) {
        ops.push(dbDeleteDoc("hhof/" + m));
        HOUSEHOLD_SHARED.forEach(function (s, i) { if (shared[i].exists) ops.push(dbSetDoc("data/users/" + m + "/" + s, shared[i].value)); });
      });
      return Promise.all(ops);
    });
  }).catch(function () {});
}

function handleDbGet(req, res, query) {
  var subpath = query.get("subpath");
  if (ALLOWED_SUBPATHS.indexOf(subpath) === -1) return sendJSON(res, 400, { message: "Ongeldig subpath." });
  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    return dataOwnerUid(user.uid, subpath).then(function (owner) { return dbGetDoc("data/users/" + owner + "/" + subpath); }).then(function (result) {
      sendJSON(res, 200, result);
    });
  }).catch(function (err) {
    sendJSON(res, 500, { message: "Opslag niet bereikbaar: " + err.message });
  });
}

function prefsLooksPopulated(p) {
  if (!p || typeof p !== "object") return false;
  var n = 0; ["name", "gender", "heightCm", "weightKg", "age"].forEach(function (k) { if (p[k]) n++; });
  if (p.intent || p.weightGoal || p.training || (Array.isArray(p.myFoods) && p.myFoods.length) || (p.journey && Array.isArray(p.journey.log) && p.journey.log.length)) n += 2;
  return n >= 2;
}
function prefsLooksDefault(p) {
  if (!p || typeof p !== "object") return true;
  return !p.name && !p.gender && !p.heightCm && !p.weightKg && !p.age && !p.intent && !p.weightGoal && !p.training && !(Array.isArray(p.myFoods) && p.myFoods.length) && !(p.journey && Array.isArray(p.journey.log) && p.journey.log.length);
}
// Eén reservekopie per dag van je voorkeuren (de stand van vóór de eerste wijziging die dag), de laatste 14 dagen
var prefsBackupDone = {};   // uid -> dag: per dag maar één keer de reservekopie lezen en schrijven (voorkeuren worden vaak opgeslagen)
function backupPrefs(uid, old) {
  if (!old || !prefsLooksPopulated(old)) return Promise.resolve();
  var key = "backups/prefs/" + uid, day = new Date().toISOString().slice(0, 10);
  if (prefsBackupDone[uid] === day) return Promise.resolve();
  prefsBackupDone[uid] = day;
  return dbGetDoc(key).then(function (r) {
    var b = r.exists && r.value && typeof r.value === "object" ? r.value : { days: {} };
    b.days = b.days || {};
    if (b.days[day]) return;
    b.days[day] = old;
    Object.keys(b.days).sort().slice(0, -14).forEach(function (d) { delete b.days[d]; });
    return dbSetDoc(key, b);
  }).catch(function () {});
}
function handleDbSet(req, res) {
  readBody(req).then(function (body) {
    return resolveUser(req).then(function (user) {
      if (!user) return sendUnauthorized(res);
      var subpath = body && body.subpath;
      if (ALLOWED_SUBPATHS.indexOf(subpath) === -1) return sendJSON(res, 400, { message: "Ongeldig subpath." });
      var ip = clientIp(req);
      var trackIp = dbSetDoc("data/users/" + user.uid + "/meta", { lastIp: ip, lastSeenAt: new Date().toISOString(), email: user.email }).catch(function () {});
      // Geen toestemming voor gezondheidsgegevens: die velden worden ook niet opgeslagen.
      var write = (subpath === "prefs" || subpath === "plannedWeeks" ? healthConsentOf(user.uid) : Promise.resolve(true)).then(function (ok) {
        var value = ok ? body.value : stripHealthData(subpath, body.value);
        return dataOwnerUid(user.uid, subpath).then(function (owner) {
          var path = "data/users/" + owner + "/" + subpath;
          if (subpath !== "prefs") return dbSetDoc(path, value);
          // Voorkeuren: vangnet tegen per ongeluk overschrijven met lege standaardwaarden, en een dagelijkse reservekopie
          return dbGetDoc(path).then(function (r) {
            var old = r.exists ? r.value : null;
            if (old && prefsLooksPopulated(old) && prefsLooksDefault(value) && !(value && value._reset)) {
              console.warn("[db] lege voorkeuren over gevulde voorkeuren geweigerd voor " + user.uid);
              var e = new Error("stale"); e.code = "stale_overwrite"; throw e;
            }
            if (value && value._reset) delete value._reset;
            return backupPrefs(user.uid, old).then(function () { return dbSetDoc(path, value); });
          });
        });
      });
      return Promise.all([write, trackIp]).then(function () {
        sendJSON(res, 200, { ok: true });
      }, function (e) {
        if (e && e.code === "stale_overwrite") return sendJSON(res, 409, { code: "stale_overwrite", message: "Je voorkeuren zijn niet overschreven: herlaad de app." });
        throw e;
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
  var healthTxt = healthWithExclude(p.health, p.exclude).map(function (k) { return HEALTH_LABELS[k]; }).join(", ");
  if (isMinorParams(p) && MINOR_BLOCKED_GOALS.indexOf(goal) > -1) goal = "Onderhoud";
  var youth = isMinorParams(p) ? " De lezer is 16 of 17: schrijf niets over afvallen, calorieën beperken of gewicht; wel over energie, sport, groeien en lekker eten." : "";
  var avoid = (Array.isArray(p.avoid) ? p.avoid : []).slice(0, 30)
    .map(function (s) { return String(s).replace(/[\r\n"]+/g, " ").trim().slice(0, 90); })
    .filter(Boolean);
  var topics = pickRandomItems(TIP_TOPICS, 3);
  return "Je schrijft korte, prettig leesbare weetjes en tips voor de wachtcarrousel van Balanza, een app die gebalanceerde " +
    "maaltijden ontwerpt op basis van macro's. De lezer wacht even op het genereren van gerechten en wil zich vermaken en iets leren.\n\n" +
    "Schrijf 8 NIEUWE items in het Nederlands. Verdeel ze over deze onderwerpen: " + topics.join(", ") + ". " +
    "Maak van hooguit 1 item een tip over Balanza zelf.\n" +
    "Context van de lezer: doel \"" + goal + "\"" + (diet ? ", voedingsstijl \"" + diet + "\"" : "") + (family ? ", kookt in gezinsmodus (kindvriendelijk)" : "") + (healthTxt ? ", eet " + healthTxt + " (noem in tips nooit producten die daar niet bij passen)" : "") + "." + youth + " " +
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
    "fine dining, andere koolhydraatbron, ander vlees/vis of andere vleesvervanger); gezondheidsfilters (onbewerkt, geen geraffineerde suiker, glutenvrij, lactosevrij, volkoren, zoutbewust); aantal personen per gerecht; kookmodus met timers; PDF-export; bereidingstijd per gerecht; " +
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
      // Ruime limiet: je betaalt alleen voor wat het model echt schrijft; 2000 was te krap en gaf afgekapte JSON.
      return usageCtx.run(usage, function () { return callAnthropicOnce(prompt, TIPS_MODEL, 4000); }).then(function (parsed) {
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


// ---------- Balanza-assistent (chat) ----------
// De gebruiker stelt vragen of geeft opdrachten. De AI antwoordt met tekst en een lijst voorgestelde acties uit een VASTE
// lijst. De server controleert elke actie (onbekend = weg, waarden buiten de kaders = weg) en de app voert ze pas uit
// als de gebruiker op "Doen" tikt. De kaders zelf (macroverdeling per doel, Balans-controle, NEVO, voedingsregels,
// veilige regels voor jongeren) zijn géén actie en dus niet via de chat te veranderen.
var ASSISTANT_MODEL = process.env.ANTHROPIC_ASSISTANT_MODEL || ANTHROPIC_MODEL;
var ASSISTANT_VIEWS = { weeks: "Start", plan: "Plannen", library: "Gerechten", shopping: "Boodschappenlijst", community: "Community", journey: "Jouw reis",
  settings: "Instellingen", myprefs: "Mijn voorkeuren", recap: "Weekterugblik", generate: "Gerechten ontwerpen", account: "Mijn profiel", guide: "Hoe werkt Balanza" };
var ASSISTANT_TILES = { vandaag: "Vandaag", reis: "Jouw reis", week: "Huidige week", seizoen: "Seizoen", foto: "Gerecht van foto", recent: "Recente gerechten",
  community: "Community", boodschappen: "Boodschappenlijst", uitleg: "Hoe werkt Balanza", genereren: "Snel genereren", volgendeweek: "Volgende week", tip: "Tip van de dag" };
var ASSISTANT_COACH = { draft: "Week alvast klaarzetten", cooked: "Na het eten: was het lekker?", recap: "Weekterugblik", leftovers: "Restjes opmaken",
  season: "Seizoen en feestdagen", journey: "Jouw reis", challenge: "Weekuitdaging", milestones: "Mijlpalen", progress: "Voortgang bijhouden", voice: "Inspreken (spraakinvoer)",
  morning: "Ochtendbericht met voorbereiding", daytools: "Ik at iets anders / Wat past nog?", water: "Water bijhouden" };
var ASSISTANT_NOTIFY = { planWeek: "Melding: plan je week", planToday: "Melding: diner van vandaag", community: "Melding: nieuwe recepten",
  cookedCheck: "Melding: na het eten", recap: "Melding: weekterugblik", autoWeek: "Week automatisch klaarzetten" };
var A_CUISINES = ["Italiaans", "Aziatisch", "Mediterraan", "Midden-Oosters", "Nederlands", "Mexicaans", "Indiaas", "Thais", "Japans", "Koreaans", "Frans", "Grieks", "Spaans", "Marokkaans", "Vietnamees", "Amerikaans"];
var A_FLAVORS = ["Fris", "Romig", "Pittig", "Kruidig", "Hartig", "Umami"];
var A_LEVELS = ["Basic", "Home-style", "Gastronomisch"];
var A_MEALS = ["Ontbijt", "Lunch", "Diner", "Snack"];
var A_DIETS = ["", "Omnivoor", "Flexitarisch", "Vegetarisch", "Veganistisch"];
var assistantIpHits = new Map();
var assistantUse = new Map();   // uid -> { day, n } (ook in de opslag, zodat een herstart het niet reset)

function assistantGuide() {
  return "OVER BALANZA (gebruik dit om vragen te beantwoorden; verzin geen functies):\n" +
    "- Balanza maakt met AI gebalanceerde gerechten en plant ze in een week. De kern: elke maaltijd past bij de macroverdeling van het doel van de gebruiker " +
    "(Onderhoud, Vetverlies, Cutting, Spieropbouw, Atleet). De Balans-score (0-100%) zegt hoe dicht een gerecht bij die verdeling zit. Macro's worden nagerekend met het NEVO-bestand van het RIVM.\n" +
    "- Doelen en streefverdeling: " + Object.keys(GOAL_TARGETS).map(function (g) { var t = GOAL_TARGETS[g]; return g + " (" + t.kh + "% koolhydraten, " + t.eiwit + "% eiwit, " + t.vet + "% vet)"; }).join("; ") + ".\n" +
    "- Voedingsstijl (harde regel), gezondheidsfilters (onbewerkt, geen geraffineerde suiker, glutenvrij, lactosevrij, volkoren, zoutbewust; ook harde regels), uitsluitingen (wat je niet eet).\n" +
    "- Plannen: week en dag, automatisch invullen, conceptweek die Balanza klaarzet, boodschappenlijst (delen via WhatsApp, Bring!, PDF, kostenschatting), prepdag.\n" +
    "- Varianten van een gerecht: pittiger, simpeler, fine dining, andere koolhydraatbron, ander vlees/vis of andere vleesvervanger. Gerecht van foto.\n" +
    "- Begeleiding (alles los aan/uit): week klaarzetten, na het eten (lekker of niet), weekterugblik, restjes, seizoen, Jouw reis (fases, weekuitdaging, mijlpalen, voortgang), budgetmodus.\n" +
    "- Inspreken: een microfoonknop in de chat en bij de wens voor deze keer (spraakherkenning van de browser, Nederlands); aan/uit onder Begeleiding.\n" +
    "- Samen plannen met huisgenoten (Mijn profiel), community met recepten van anderen, meldingen, licht of donker thema, Start-scherm indelen.\n" +
    "- Plus: na de proefperiode zijn ontwerpen en plannen voor Plus. Prijzen en abonnement staan bij Mijn profiel.\n" +
    "- Automatisch plannen: één keer instellen (maaltijden, dagen, dag en tijd, standaard zaterdag 09:00); Balanza zet dan elke week de volgende week klaar en de gebruiker keurt hem goed in een carrousel. Voedingsnieuws: één bericht per dag onder Voor jou.\n" +
    "- Trainingsschema: tegel \u201cTraining\u201d op Start (thuis of sportschool, 2 tot 5 dagen, beginner of gevorderd); vaste schema's die passen bij het doel en rustig opbouwen; trainingen staan in de planner en zijn af te vinken.\n" +
    "- Alle voedingswaarden: onder de macro's op Start (en bij een maaltijd of product) staat \u201cAlle voedingswaarden\u201d: vezels, suikers, verzadigd vet, zout, mineralen en vitamines, met wat je per dag nodig hebt (Voedingscentrum). Gegevens uit NEVO (RIVM) en van het etiket.\n" +
    "- Doel en gebruik: bij het begin (en voor bestaande gebruikers één keer) kiest de gebruiker wat hij wil bereiken en waarvoor hij Balanza gebruikt (inspiratie, week plannen, bijhouden, begeleiding, training). Alleen de vragen die daarbij horen komen daarna; het startscherm volgt de keuze. Zwanger of borstvoeding: geen afvallen, wel extra energie. Wijzigen via Mijn voorkeuren → Doel en gebruik.\n" +
    "- Groepslessen: in de tegel Training \u201c+ Groepsles\u201d (of in een training \u201cIk deed een groepsles\u201d): Les Mills (BODYPUMP, RPM, BODYCOMBAT, GRIT en meer), pilates reformer, pilates en yoga. BODYPUMP en TONE tellen als krachtdag, cardiolessen als cardiodag, reformer en pilates als aanvulling, yoga en BODYBALANCE als herstel. Met geschat verbruik; bij BODYPUMP je gewicht per nummer met de vorige keer ernaast.\n" +
    "- Jouw doel: tegel \u201cJouw doel\u201d op Start toont per doel de aanpak (voeding, macro's, sport, beweging) en voortgang die bij het doel past (afvallen: gewicht/middel/kracht; spieropbouw: kracht per oefening; atleet: trainingen; onderhoud: Balans en stabiel gewicht), plus beweegminuten per week. Doel wijzigen (Mijn voorkeuren \u2192 Jij & je doel) past alles mee aan; een doelgewicht dat niet meer past stopt.\n" +
    "- Doelgewicht: tegel \u201cJouw doel\u201d op Start, of Mijn voorkeuren \u2192 Lichaamsprofiel \u2192 Doelgewicht. Tempo rustig, normaal of stevig; het dagdoel past zich aan, binnen veilige grenzen. Eén keer per week wegen op een vast weegmoment (nuchter); eens per maand omtrekken meten, waarmee Balanza het vetpercentage schat (Navy-methode); \u201cCijfers verbergen\u201d toont alleen procenten. Niet onder een gezond gewicht en niet voor minderjarigen.\n" +
    "- Snel toevoegen (knop \u201c\uFF0B Toevoegen\u201d op Start en \u201c\uFF0B Snel iets toevoegen\u201d per dag in de planner; vervangt het oude \u201cAnders gegeten\u201d): zoeken in de NEVO-productenlijst, een foto van je bord, uit eten (restaurant inchecken), \u201cin plaats van\u201d een geplande maaltijd, een hele zin (\u201c2 eieren, 1 snee brood met kaas\u201d), streepjescode scannen (Open Food Facts) of een eigen product van het etiket. Macro's en Balans worden zelf berekend; als extra bij een dag of ingepland als maaltijd (dan bewaard als gerecht).\n" +
    "- WAAR VIND JE WAT: rechtsboven de avatar opent het menu met Mijn profiel, Mijn voorkeuren, Automatisch plannen, Samen plannen, Jouw reis, Instellingen, Donkere weergave, Hoe werkt Balanza en Uitloggen. " +
    "Instellingen is een overzicht met per onderdeel een knop: Weergave, Meldingen, Automatisch plannen, Begeleiding, Privacy, Bring!, Account en beveiliging (wachtwoord, e-mail, uitloggen, account verwijderen) " +
    "en Mijn gegevens en reset (gegevens downloaden en 'Reset app, begin opnieuw'). Vraagt iemand hoe hij de app reset of opnieuw begint: Instellingen → Mijn gegevens en reset → Reset app.\n";
}
function assistantActionSpec() {
  return "ACTIES die je mag voorstellen (alleen deze, exact dit formaat; de gebruiker bevestigt ze zelf):\n" +
    '- {"type":"set_goal","goal":"' + Object.keys(GOAL_TARGETS).join('|') + '"}\n' +
    '- {"type":"set_diet","dietStyle":"' + A_DIETS.join("|") + '"} (leeg = geen voorkeur)\n' +
    '- {"type":"set_health","add":[...],"remove":[...]} met sleutels: ' + HEALTH_KEYS.join(", ") + "\n" +
    '- {"type":"set_exclude","add":["ingrediënt"],"remove":["ingrediënt"]}\n' +
    '- {"type":"set_meals","mealTypes":[' + A_MEALS.map(function (m) { return '"' + m + '"'; }).join(",") + ']} en {"type":"set_count","count":1-7} (gerechten per moment)\n' +
    '- {"type":"set_cuisines","cuisines":[...]} uit: ' + A_CUISINES.join(", ") + '; {"type":"set_flavors","flavors":[...]} uit: ' + A_FLAVORS.join(", ") + '; {"type":"set_level","level":"' + A_LEVELS.join("|") + '"}\n' +
    '- {"type":"set_family","on":true|false} (kindvriendelijk)\n' +
    '- {"type":"set_student","on":true|false,"budget":25|35|50|75,"onePan":true|false,"quick":true|false} (budgetmodus)\n' +
    '- {"type":"set_coach","key":"' + Object.keys(ASSISTANT_COACH).join("|") + '","on":true|false}\n' +
    '- {"type":"set_journey","pace":"rustig|normaal|stevig","tone":"coach|zakelijk|luchtig","quiet":true|false} (velden optioneel)\n' +
    '- {"type":"set_notify","key":"' + Object.keys(ASSISTANT_NOTIFY).join("|") + '","on":true|false}\n' +
    '- {"type":"set_theme","theme":"light|dark"}\n' +
    '- {"type":"home_tiles","show":[...],"hide":[...],"top":"..."} met tegels: ' + Object.keys(ASSISTANT_TILES).join(", ") + "\n" +
    '- {"type":"navigate","view":"' + Object.keys(ASSISTANT_VIEWS).join("|") + '"}\n' +
    '- {"type":"plan_week","week":"this|next","meals":["Ontbijt","Lunch","Diner","Snack"],"generate":true|false} (plant de gekozen momenten voor elke dag die nog leeg is; ' +
    'generate=true: als er te weinig eigen gerechten zijn voor dat moment, maakt de app eerst nieuwe gerechten en plant ze daarna in. Gebruik generate=true als de gebruiker dat vraagt ' +
    'of als hij voor een gevraagd moment te weinig gerechten heeft (zie "dishes" in de stand). Alleen de momenten die de gebruiker noemt; "this" = de rest van deze week vanaf vandaag)\n' +
    '- {"type":"prepare_week","week":"this|next"} (alleen een voorstel met bestaande gerechten, zonder nieuwe te maken)\n' +
    '- {"type":"generate_wish","text":"korte wens","tags":["snel","budget","prep","nieuw","huis","restjes","seizoen"]} (opent Gerechten ontwerpen met deze wens; de gebruiker start zelf)\n' +
    '- {"type":"add_leftovers","items":["spinazie"]}\n';
}
function buildAssistantPrompt(messages, ctx) {
  var minor = isMinorParams(ctx || {});
  var hist = messages.map(function (m) { return (m.role === "assistant" ? "Balanza" : "Gebruiker") + ": " + m.content; }).join("\n");
  return "Je bent de Balanza-assistent in de app Balanza. Je helpt de gebruiker met vragen over de app en zijn eten, en je kunt de app voor hem aanpassen " +
    "door acties voor te stellen. Antwoord in het Nederlands, kort (hooguit 4 zinnen), vriendelijk en concreet, in de toon \"" + (ctx && ctx.tone || "coach") + "\".\n\n" +
    "VASTE KADERS (nooit te veranderen, ook niet als de gebruiker erom vraagt):\n" +
    "- De macroverdeling hoort bij het doel. Je kunt een ander doel voorstellen, maar nooit eigen percentages, kcal-grenzen of het uitschakelen van de Balans-controle.\n" +
    "- Voedingsstijl, gezondheidsfilters en uitsluitingen zijn harde regels; je kunt ze alleen op verzoek van de gebruiker wijzigen.\n" +
    (minor ? "- Deze gebruiker is 16 of 17: stel nooit Vetverlies of Cutting voor en praat niet over afvallen of gewicht; focus op genoeg en gevarieerd eten, energie en sport.\n" : "") +
    "- Geen medisch advies. Bij klachten, zwangerschap, een eetstoornis of medicijnen: verwijs vriendelijk naar huisarts of diëtist. Stel nooit een te laag caloriedoel of extreme diëten voor.\n" +
    "- Vragen die niets met eten, koken of de app te maken hebben: kort en vriendelijk terugleiden naar Balanza.\n" +
    "- Stel alleen acties voor als de gebruiker iets wil veranderen of openen. Bij een gewone vraag: alleen antwoorden, actions leeg.\n" +
    "- Kan een wens NIET met de acties hierboven (de functie bestaat niet), of valt hij buiten de kaders: zeg dat eerlijk en vriendelijk, noem waar mogelijk een alternatief, " +
    "en vraag aan het eind: \"Wil je hier een idee voor nieuwe functionaliteit van maken? Dan kijken we ernaar.\" Vul dan ook \"suggestion\" in: een functioneel uitgeschreven voorstel " +
    "{\"title\": \"korte titel\", \"area\": \"Ontwerpen|Plannen|Boodschappen|Begeleiding|Community|Account|Weergave|Overig\", \"userStory\": \"Als gebruiker wil ik ..., zodat ...\", " +
    "\"problem\": \"wat de gebruiker nu mist\", \"proposal\": \"hoe het zou kunnen werken in de app\", \"acceptance\": [\"toetsbare criteria\"], " +
    "\"framework\": \"hoe dit binnen de kaders blijft (macrobalans per doel, Balans-score, NEVO, voedingsregels) of waar het daarmee botst\", \"impact\": \"klein|middel|groot\"}. " +
    "Geen suggestion bij een gewone vraag of als het al kan.\n" +
    "- Zegt de gebruiker dat hij een idee heeft maar nog niet welk: vraag kort en enthousiast wat hij mist. Beschrijft hij een idee dat nog niet bestaat: bedank, vat het samen en vul \"suggestion\" in (vraag dan of je het mag insturen).\n" +
    "- Is het eerste bericht in het gesprek van Balanza zelf (een openingszin), sluit daar dan natuurlijk op aan.\n\n" +
    assistantGuide() + "\n" + assistantActionSpec() + "\n" +
    "HUIDIGE STAND VAN DE GEBRUIKER (JSON): " + JSON.stringify(ctx || {}).slice(0, 3000) + "\n\n" +
    "GESPREK:\n" + hist + "\n\n" +
    'Geef ALLEEN geldig JSON terug, exact dit schema, geen markdown: {"reply": "je antwoord", "actions": [ ... ], "suggestion": null of het voorstel}';
}
function aStrList(v, max, len) { return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === "string" && x.trim(); }).slice(0, max).map(function (x) { return cleanText(x, len); }); }
// Controleert en beschrijft de voorgestelde acties. Wat niet klopt valt weg; elke actie krijgt een leesbaar label.
function cleanAssistantActions(raw, ctx) {
  var out = [], minor = isMinorParams(ctx || {});
  (Array.isArray(raw) ? raw : []).slice(0, 8).forEach(function (a) {
    if (!a || typeof a !== "object") return;
    var t = a.type, x = null;
    if (t === "set_goal" && GOAL_TARGETS[a.goal] && !(minor && MINOR_BLOCKED_GOALS.indexOf(a.goal) > -1)) x = { type: t, goal: a.goal, label: "Doel: " + a.goal };
    else if (t === "set_diet" && A_DIETS.indexOf(a.dietStyle) > -1) x = { type: t, dietStyle: a.dietStyle, label: "Voedingsstijl: " + (a.dietStyle || "geen voorkeur") };
    else if (t === "set_health") {
      var add = cleanHealth(a.add), rem = cleanHealth(a.remove);
      if (add.length || rem.length) x = { type: t, add: add, remove: rem, label: [add.length ? "Aan: " + add.map(function (k) { return HEALTH_LABELS[k]; }).join(", ") : "", rem.length ? "Uit: " + rem.map(function (k) { return HEALTH_LABELS[k]; }).join(", ") : ""].filter(Boolean).join(" · ") };
    } else if (t === "set_exclude") {
      var ea = aStrList(a.add, 10, 40), er = aStrList(a.remove, 10, 40);
      if (ea.length || er.length) x = { type: t, add: ea, remove: er, label: [ea.length ? "Niet meer eten: " + ea.join(", ") : "", er.length ? "Weer toestaan: " + er.join(", ") : ""].filter(Boolean).join(" · ") };
    } else if (t === "set_meals") {
      var mt = (Array.isArray(a.mealTypes) ? a.mealTypes : []).filter(function (m) { return A_MEALS.indexOf(m) > -1; });
      if (mt.length) x = { type: t, mealTypes: mt, label: "Maaltijdmomenten: " + mt.join(", ") };
    } else if (t === "set_count" && Number.isInteger(Number(a.count)) && a.count >= 1 && a.count <= 7) x = { type: t, count: Number(a.count), label: a.count + " gerechten per moment" };
    else if (t === "set_cuisines") { var cu = (Array.isArray(a.cuisines) ? a.cuisines : []).filter(function (c) { return A_CUISINES.indexOf(c) > -1; }); x = { type: t, cuisines: cu, label: "Keukens: " + (cu.length ? cu.join(", ") : "alle") }; }
    else if (t === "set_flavors") { var fl = (Array.isArray(a.flavors) ? a.flavors : []).filter(function (c) { return A_FLAVORS.indexOf(c) > -1; }); x = { type: t, flavors: fl, label: "Smaken: " + (fl.length ? fl.join(", ") : "alle") }; }
    else if (t === "set_level" && A_LEVELS.indexOf(a.level) > -1) x = { type: t, level: a.level, label: "Culinair niveau: " + a.level };
    else if (t === "set_family" && typeof a.on === "boolean") x = { type: t, on: a.on, label: "Kindvriendelijk " + (a.on ? "aan" : "uit") };
    else if (t === "set_student" && typeof a.on === "boolean") {
      var b = STUDENT_BUDGETS.indexOf(Number(a.budget)) > -1 ? Number(a.budget) : null;
      x = { type: t, on: a.on, budget: b, onePan: typeof a.onePan === "boolean" ? a.onePan : null, quick: typeof a.quick === "boolean" ? a.quick : null,
        label: "Budgetmodus " + (a.on ? "aan" + (b ? " (€" + b + " per week)" : "") : "uit") };
    } else if (t === "set_coach" && ASSISTANT_COACH[a.key] && typeof a.on === "boolean") x = { type: t, key: a.key, on: a.on, label: ASSISTANT_COACH[a.key] + " " + (a.on ? "aan" : "uit") };
    else if (t === "set_journey") {
      var j = {}, bits = [];
      if (["rustig", "normaal", "stevig"].indexOf(a.pace) > -1) { j.pace = a.pace; bits.push("tempo " + a.pace); }
      if (["coach", "zakelijk", "luchtig"].indexOf(a.tone) > -1) { j.tone = a.tone; bits.push("toon " + (a.tone === "coach" ? "coachend" : a.tone)); }
      if (typeof a.quiet === "boolean") { j.quiet = a.quiet; bits.push("rustige modus " + (a.quiet ? "aan" : "uit")); }
      if (bits.length) x = Object.assign({ type: t, label: "Jouw reis: " + bits.join(", ") }, j);
    } else if (t === "set_notify" && ASSISTANT_NOTIFY[a.key] && typeof a.on === "boolean") x = { type: t, key: a.key, on: a.on, label: ASSISTANT_NOTIFY[a.key] + " " + (a.on ? "aan" : "uit") };
    else if (t === "set_theme" && (a.theme === "light" || a.theme === "dark")) x = { type: t, theme: a.theme, label: a.theme === "dark" ? "Donkere weergave" : "Lichte weergave" };
    else if (t === "home_tiles") {
      var sh = (Array.isArray(a.show) ? a.show : []).filter(function (k) { return ASSISTANT_TILES[k]; }), hi = (Array.isArray(a.hide) ? a.hide : []).filter(function (k) { return ASSISTANT_TILES[k]; });
      var top = ASSISTANT_TILES[a.top] ? a.top : null;
      if (sh.length || hi.length || top) x = { type: t, show: sh, hide: hi, top: top, label: "Start: " + [sh.length ? "tonen " + sh.map(function (k) { return ASSISTANT_TILES[k]; }).join(", ") : "", hi.length ? "verbergen " + hi.map(function (k) { return ASSISTANT_TILES[k]; }).join(", ") : "", top ? ASSISTANT_TILES[top] + " bovenaan" : ""].filter(Boolean).join(" · ") };
    } else if (t === "navigate" && ASSISTANT_VIEWS[a.view]) x = { type: t, view: a.view, label: "Open " + ASSISTANT_VIEWS[a.view] };
    else if (t === "plan_week" && (a.week === "this" || a.week === "next")) {
      var pm = (Array.isArray(a.meals) ? a.meals : []).filter(function (m, i, arr) { return A_MEALS.indexOf(m) > -1 && arr.indexOf(m) === i; });
      if (!pm.length) pm = ["Diner"];
      var gen = a.generate === true;
      x = { type: t, week: a.week, meals: pm, generate: gen, label: "Plan " + pm.map(function (m) { return m.toLowerCase(); }).join(" en ") + " voor elke dag van " + (a.week === "next" ? "volgende week" : "de rest van deze week") +
        (gen ? "; ontbreken er gerechten, dan maak ik er eerst nieuwe bij (telt mee voor je maandlimiet)" : " met je eigen gerechten") };
    }
    else if (t === "prepare_week" && (a.week === "this" || a.week === "next")) x = { type: t, week: a.week, label: "Zet " + (a.week === "next" ? "volgende" : "deze") + " week klaar met je eigen gerechten" };
    else if (t === "generate_wish") {
      var tags = (Array.isArray(a.tags) ? a.tags : []).filter(function (k) { return WISH_TEXTS[k]; }).slice(0, 4), txt = cleanText(a.text, 200);
      if (txt || tags.length) x = { type: t, text: txt, tags: tags, label: "Nieuwe gerechten ontwerpen" + (txt ? ": “" + txt + "”" : "") };
    } else if (t === "add_leftovers") { var it = aStrList(a.items, 10, 40); if (it.length) x = { type: t, items: it, label: "Op te maken: " + it.join(", ") }; }
    if (x) out.push(x);
  });
  return out;
}
function assistantAllowance(uid) {
  var day = todayKey(), cap = liveLimits.assistantDailyPerUser;
  var mem = assistantUse.get(uid);
  var p = mem && mem.day === day ? Promise.resolve(mem) : dbGetDoc("assistant/" + uid).then(function (r) { var v = r.exists && r.value && r.value.day === day ? r.value : { day: day, n: 0 }; return v; }).catch(function () { return { day: day, n: 0 }; });
  return p.then(function (u) { return { use: u, cap: cap, ok: cap > 0 && u.n < cap }; });
}
function handleAssistant(req, res) {
  var ip = clientIp(req), t0 = Date.now();
  var hit = assistantIpHits.get(ip), now = Date.now();
  if (!hit || now - hit.start > 3600000) hit = { start: now, n: 0 };
  hit.n++; assistantIpHits.set(ip, hit);
  if (hit.n > 120) return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan: probeer het over een paar minuten opnieuw." });
  var settingsRef = null;
  getSettings().then(function (s) {
    settingsRef = s;
    if (!effectiveModules(s).assistant) { sendJSON(res, 503, moduleOffBody("assistant", s)); return undefined; }
    return resolveUser(req);
  }).then(function (user) {
    if (user === undefined) return;
    if (!user) return sendUnauthorized(res);
    if (!ANTHROPIC_API_KEY) return sendJSON(res, 500, { code: "not_configured", message: "De assistent is op deze server nog niet ingesteld." });
    return getUserPlan(user.uid, settingsRef).then(function (plan) {
      if (planBlocksModule(settingsRef, "assistant", plan)) return sendJSON(res, 403, { code: "plan_required", message: "De assistent is onderdeel van Balanza Plus." });
      return assistantAllowance(user.uid).then(function (al) {
        if (!al.ok) return sendJSON(res, 429, { code: "assistant_limit", message: "Je hebt vandaag al " + al.use.n + " berichten gestuurd. Morgen kan het weer." });
        return readBody(req).then(function (body) {
          var msgs = (Array.isArray(body && body.messages) ? body.messages : []).slice(-12).map(function (m) {
            return { role: m && m.role === "assistant" ? "assistant" : "user", content: String(m && m.content || "").replace(/[\r\n]+/g, " ").slice(0, 600) };
          }).filter(function (m) { return m.content.trim(); });
          if (!msgs.length || msgs[msgs.length - 1].role !== "user") return sendJSON(res, 400, { code: "bad_request", message: "Stel een vraag." });
          var ctx = body.context && typeof body.context === "object" ? body.context : {};
          return dbGetDoc("data/users/" + user.uid + "/prefs").then(function (pr) {
          // Leeftijd komt uit de opgeslagen voorkeuren, niet alleen uit wat de app meestuurt.
          var stored = pr.exists && pr.value ? pr.value : {};
          if (isMinorParams(stored)) { ctx.ageGroup = "16-17"; ctx.age = stored.age || ctx.age; }
          var usage = newUsage();
          al.use.n++; assistantUse.set(user.uid, al.use); dbSetDoc("assistant/" + user.uid, al.use).catch(function () {});
          // Ruime limiet: een antwoord met acties plus een uitgeschreven "suggestion" paste niet altijd in 1500 tokens.
          return usageCtx.run(usage, function () { return callAnthropicOnce(buildAssistantPrompt(msgs, ctx), ASSISTANT_MODEL, 4000); }).then(function (parsed) {
            var reply = cleanText(parsed && parsed.reply, 1200) || "Sorry, dat begreep ik niet helemaal. Kun je het anders zeggen?";
            var actions = cleanAssistantActions(parsed && parsed.actions, ctx);
            var suggestion = actions.length ? null : cleanSuggestion(parsed && parsed.suggestion);
            return recordAccounting(user.uid, "assistant", usage, 0, true).then(function () {
              logRequest({ ts: new Date().toISOString(), type: "assistant", action: "chat", durationMs: Date.now() - t0, ok: true, status: 200, uid: user.uid, ip: ip, actions: actions.length });
              sendJSON(res, 200, { reply: reply, actions: actions, suggestion: suggestion, left: Math.max(0, al.cap - al.use.n) });
            });
          }, function (e) { return recordAccounting(user.uid, "assistant", usage, 0, false).then(function () { throw e; }); });
          });
        });
      });
    });
  }).catch(function (err) {
    logRequest({ ts: new Date().toISOString(), type: "assistant", action: "chat", durationMs: Date.now() - t0, ok: false, status: 502, error: err && err.message, ip: ip });
    sendJSON(res, 502, { code: "error", message: "De assistent is even niet bereikbaar. Probeer het zo opnieuw." });
  });
}


// ---------- "Ik at iets anders": voedingswaarde schatten van een foto of korte beschrijving ----------
var estimateLimiter = makeHourlyLimiter(30);
function buildEstimatePrompt(text, hasImage) {
  return "Je bent een voedingskundige. Schat de voedingswaarde van wat de gebruiker at" + (hasImage ? " (zie de foto)" : "") + ".\n" +
    (text ? "Beschrijving van de gebruiker: \"" + text + "\"\n" : "") +
    "- Ga uit van precies wat beschreven of zichtbaar is, met realistische Nederlandse porties. Dranken met calorieën tellen mee.\n" +
    "- Is het geen eten of drinken, geef dan alleen: {\"error\": \"geen_eten\"}\n" +
    "Geef ALLEEN JSON: {\"name\": korte Nederlandse naam (max 40 tekens), \"kcal\": getal, \"eiwit_g\": getal, \"kh_g\": getal, \"vet_g\": getal, " +
    "\"mealType\": \"Ontbijt\"|\"Lunch\"|\"Diner\"|\"Snack\", \"note\": één korte, vriendelijke zin zonder oordeel (bijv. wat je morgen kunt doen)}";
}
// POST /api/nevo/calc — rekent een (aangepast) gerecht door met NEVO (RIVM), zonder AI. Per regel: herkend product en grammen.
var nevoCalcLimiter = makeLimiterSafe(120);
function makeLimiterSafe(perHour) {
  var hits = {};
  return function (key) {
    var now = Date.now(), arr = (hits[key] || []).filter(function (t) { return now - t < 3600000; });
    if (arr.length >= perHour) { hits[key] = arr; return false; }
    arr.push(now); hits[key] = arr; return true;
  };
}
// Stuks omrekenen naar grammen (gemiddeld eetbaar gewicht), zodat "1 ui" of "2 teentjes knoflook" ook meetelt
var NEVO_PIECE_G = { "ui": 100, "uien": 100, "rode ui": 100, "sjalot": 30, "sjalotten": 30, "teen knoflook": 5, "teentje knoflook": 5, "teentjes knoflook": 5, "tenen knoflook": 5, "knoflook": 5,
  "tomaat": 120, "tomaten": 120, "paprika": 150, "paprika's": 150, "courgette": 250, "aubergine": 300, "wortel": 80, "wortels": 80, "winterpeen": 200, "prei": 200, "komkommer": 300,
  "avocado": 150, "banaan": 120, "bananen": 120, "appel": 150, "appels": 150, "peer": 160, "sinaasappel": 150, "citroen": 100, "limoen": 70, "kiwi": 75, "mango": 300,
  "ei": 50, "eieren": 50, "eidooier": 18, "aardappel": 150, "aardappelen": 150, "zoete aardappel": 250, "wrap": 60, "wraps": 60, "volkoren wrap": 60, "pita": 70, "pitabroodje": 70,
  "boterham": 35, "sneetje brood": 35, "snee brood": 35, "beschuit": 10, "rijstwafel": 8, "rijstwafels": 8, "kipfilet": 150, "zalmfilet": 125, "champignon": 15, "champignons": 15, "bosui": 15, "lente-ui": 15, "rode peper": 10, "spaanse peper": 10 };
function nevoPieceToGram(it) {
  if (it.gram > 0) return it;
  var m = String(it.tekst).toLowerCase().match(/^(\d+(?:[.,]\d+)?|½|1\/2|een|één|half|halve)\s*(?:stuks?\s+|x\s+)?(.*)$/);
  if (!m) return it;
  var q = /^(½|1\/2|half|halve)$/.test(m[1]) ? 0.5 : /^(een|één)$/.test(m[1]) ? 1 : Number(m[1].replace(",", "."));
  var name = m[2].replace(/\(.*?\)/g, "").replace(/[,;].*$/, "").trim(), clove = /^(teentjes?|tenen|teen)\s+/.test(name);
  if (clove) name = name.replace(/^(teentjes?|tenen|teen)\s+/, "");
  var g = clove ? 5 : NEVO_PIECE_G[name];
  if (!g) { var w = name.split(" "); g = NEVO_PIECE_G[w[w.length - 1]] || NEVO_PIECE_G[w[0]]; }
  if (!g || !(q > 0) || q > 50) return it;
  var base = /knoflook/.test(name) ? "knoflook" : name;
  return { tekst: it.tekst, gram: Math.round(q * g), nevo: it.nevo || base };
}
// ---- Alle voedingswaarden (vezels, suikers, verzadigd vet, zout, vitamines, mineralen) uit NEVO ----
var NEVO_NUTR = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "nevo", "nevo2025_nutrients.json"), "utf8")); } catch (e) { return null; }
})();
var nevoNutrGz = null;
function handleNutrientTable(req, res) {
  if (!NEVO_NUTR) return sendJSON(res, 200, { available: false });
  if (!nevoNutrGz) nevoNutrGz = zlib.gzipSync(Buffer.from(JSON.stringify(Object.assign({ available: true }, NEVO_NUTR))));
  var gz = /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  var h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400" };
  if (gz) { h["Content-Encoding"] = "gzip"; res.writeHead(200, h); return res.end(nevoNutrGz); }
  res.writeHead(200, h); res.end(zlib.gunzipSync(nevoNutrGz));
}
// Voedingsstoffen van een gerecht uit zijn ingrediëntregels (zelfde koppeling als de macro's)
var nutrLimiter = makeHourlyLimiter(300);
function handleNutrientsForIngredients(req, res) {
  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (!nutrLimiter("nu:" + user.uid)) return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan." });
    return readBody(req).then(function (body) {
      if (!NEVO_NUTR || !nevoAvailable()) return sendJSON(res, 200, { available: false });
      var lines = Array.isArray(body && body.ingredienten) ? body.ingredienten.slice(0, 40).map(function (x) { return String(x || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120); }).filter(Boolean) : [];
      var calc = nevoCalculate(nevoNormalizeIngredients(lines).map(nevoPieceToGram));
      var n = NEVO_NUTR.cols.length, tot = new Array(n).fill(0), known = new Array(n).fill(0), rel = 0;
      calc.detail.forEach(function (d) {
        if (nevoIsNegligible(d.tekst)) return;
        rel++;
        var r = d.code != null ? NEVO_NUTR.rows[String(d.code)] : null; if (!r || !(d.gram > 0)) return;
        for (var i = 0; i < n; i++) if (r[i] != null) { tot[i] += r[i] * d.gram / 100; known[i]++; }
      });
      sendJSON(res, 200, { available: true, cols: NEVO_NUTR.cols, totals: tot.map(function (v) { return Math.round(v * 100) / 100; }), known: known, total: rel });
    });
  }).catch(function () { sendJSON(res, 500, { code: "error", message: "Doorrekenen lukte niet." }); });
}
function handleNevoCalc(req, res) {
  resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (!nevoCalcLimiter("n:" + user.uid)) return sendJSON(res, 429, { code: "rate_limited", message: "Even rustig aan; probeer het zo opnieuw." });
    return readBody(req).then(function (body) {
      var lines = Array.isArray(body && body.ingredienten) ? body.ingredienten.slice(0, 40).map(function (x) { return String(x || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120); }).filter(Boolean) : [];
      if (!nevoAvailable()) return sendJSON(res, 200, { available: false });
      var items = nevoNormalizeIngredients(lines).map(nevoPieceToGram), calc = nevoCalculate(items);
      sendJSON(res, 200, { available: true, versie: NEVO_VERSION, bron: NEVO_REFERENCE, kcal: calc.kcal, eiwitG: calc.eiwitG, khG: calc.khG, vetG: calc.vetG,
        gedekt: calc.covered, totaal: calc.relevant, ontbreekt: calc.missing,
        regels: calc.detail.map(function (d) { return { tekst: d.tekst, gram: d.gram, naam: d.naam, verwaarloosbaar: nevoIsNegligible(d.tekst) }; }) });
    });
  }).catch(function (e) { sendJSON(res, 500, { code: "error", message: "Doorrekenen lukte niet." }); });
}
function handleEstimate(req, res) {
  var t0 = Date.now(), ip = clientIp(req), settingsRef = null;
  getSettings().then(function (s) {
    settingsRef = s;
    if (!effectiveModules(s).generate) { sendJSON(res, 503, moduleOffBody("generate", s)); return undefined; }
    return resolveUser(req);
  }).then(function (user) {
    if (user === undefined) return;
    if (!user) return sendUnauthorized(res);
    if (!ANTHROPIC_API_KEY) return sendJSON(res, 500, { code: "not_configured", message: "Schatten is op deze server nog niet ingesteld." });
    if (!estimateLimiter("e:" + user.uid)) return sendJSON(res, 429, { code: "rate_limited", message: "Je hebt al veel geschat dit uur. Probeer het straks opnieuw." });
    return readBody(req).then(function (body) {
      var text = String(body && body.text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
      var img = body && body.image, image = null;
      if (img && typeof img === "object") {
        if (PHOTO_MEDIA.indexOf(img.mediaType) === -1 || typeof img.data !== "string" || img.data.length > 1400000 || !/^[A-Za-z0-9+/=]+$/.test(img.data.slice(0, 2000))) return sendJSON(res, 400, { code: "bad_request", message: "Deze foto is te groot of ongeldig." });
        image = { mediaType: img.mediaType, data: img.data };
      }
      if (!text && !image) return sendJSON(res, 400, { code: "bad_request", message: "Beschrijf wat je at of maak een foto." });
      var usage = newUsage();
      return usageCtx.run(usage, function () { return callAnthropicOnce(buildEstimatePrompt(text, !!image), image ? ANTHROPIC_MODEL : ASSISTANT_MODEL, 1200, image); }).then(function (p) {
        return recordAccounting(user.uid, "estimate", usage, 0, true).then(function () {
          if (!p || p.error) return sendJSON(res, 422, { code: "not_food", message: "Hier herken ik geen eten in. Probeer een andere foto of beschrijf het kort." });
          var n = function (v, max) { v = Math.round(Number(v) || 0); return Math.max(0, Math.min(max, v)); };
          var out = { name: cleanText(p.name, 40) || cleanText(text, 40) || "Iets anders", kcal: n(p.kcal, 5000), eiwitG: n(p.eiwit_g, 400), khG: n(p.kh_g, 800), vetG: n(p.vet_g, 400),
            mealType: PHOTO_MEALTYPES.indexOf(p.mealType) > -1 ? p.mealType : null, note: cleanText(p.note, 160) };
          logRequest({ ts: new Date().toISOString(), type: "estimate", action: image ? "foto" : "tekst", durationMs: Date.now() - t0, ok: true, status: 200, uid: user.uid, ip: ip });
          sendJSON(res, 200, out);
        });
      }, function (e) { return recordAccounting(user.uid, "estimate", usage, 0, false).then(function () { throw e; }); });
    });
  }).catch(function (err) {
    logRequest({ ts: new Date().toISOString(), type: "estimate", action: "schatten", durationMs: Date.now() - t0, ok: false, status: 502, error: String(err && err.message || err).slice(0, 300), ip: ip });
    console.error("estimate failed:", err && err.message);
    sendJSON(res, 502, { code: "error", message: "Schatten lukte even niet. Probeer het zo opnieuw." });
  });
}

// ---------- Snel toevoegen: productenlijst (NEVO), standaardporties en streepjescodes ----------
// De app zoekt zelf in deze lijst (direct, ook zonder bereik). Alleen wat niet te vinden is, schat de AI (via /api/estimate).
// NEVO mag niet tegen betaling worden aangeboden (voorwaarden RIVM): deze lijst is voor iedereen, ook zonder Plus.
// Standaardporties zijn een Balanza-aanvulling (geen NEVO-gegevens): [patroon op de productnaam, omschrijving, gram].
var FOOD_PORTIONS = [
  ["^wafel stroop", "1 stroopwafel", 30], ["^koek gevulde|gevulde koek", "1 gevulde koek", 60], ["^wafel rijst", "1 rijstwafel", 8],
  ["^ei kippen|\\bei\\b", "1 ei", 55], ["eiwit kippenei|eiwit van kippenei", "1 eiwit", 33],
  ["^brood|brood volkoren|brood bruin|brood wit|brood meergranen|brood spelt|brood rogge|roggebrood", "1 snee", 35],
  ["krentenbol|^bol |bolletje|pistolet|kaiserbroodje|broodje", "1 broodje", 50], ["beschuit", "1 beschuit", 10], ["knackebrod|knäckebröd|cracker", "1 cracker", 10],
  ["rijstwafel", "1 rijstwafel", 8], ["croissant", "1 croissant", 45], ["pita|tortilla|wrap", "1 wrap", 60], ["ontbijtkoek", "1 plak", 25],
  ["havermout|muesli|cruesli|granola|cornflakes|ontbijtgranen", "1 portie", 45],
  ["^melk|melk halfvolle|melk magere|melk volle|karnemelk|chocolademelk|sojadrink|haverdrink|amandeldrink|drink soja|drink haver", "1 glas", 200],
  ["yoghurt|kwark|skyr|vla|pap", "1 schaaltje", 150], ["kwark magere|kwark halfvolle|kwark volle", "1 bakje", 250],
  ["kaas 48|kaas 30|kaas 20|kaas belegen|kaas jong|kaas oud|goudse|edammer|leerdammer|kaas gouda", "1 plak", 20],
  ["smeerkaas|zuivelspread|roomkaas|philadelphia|kaas smeer", "1 portie", 15], ["cottage cheese|huttenkase", "1 portie", 75], ["mozzarella", "1 bol", 125], ["feta", "1 portie", 50],
  ["^boter|roomboter|halvarine|margarine|bak  en braad|smeersel", "1 portie (besmeren)", 5], ["olie|olijfolie", "1 eetlepel", 10],
  ["pindakaas|notenpasta|hazelnootpasta|chocoladepasta", "1 portie", 15], ["jam|honing|stroop|appelstroop|hagelslag|vlokken chocolade|muisjes", "1 portie", 15],
  ["ham|kipfilet beleg|rookvlees|kalkoenfilet|filet american|salami|cervelaat|leverworst|boterhamworst|achterham|rosbief|fricandeau", "1 plak", 15],
  ["^appel|appel m schil|appel z schil", "1 appel", 135], ["^peer", "1 peer", 150], ["banaan", "1 banaan", 120], ["sinaasappel", "1 sinaasappel", 140],
  ["mandarijn|clementine", "1 mandarijn", 60], ["kiwi", "1 kiwi", 75], ["druiven", "1 handje", 80], ["aardbeien|frambozen|bosbessen|blauwe bessen|bessen", "1 bakje", 125],
  ["perzik|nectarine", "1 stuk", 120], ["pruim", "1 pruim", 40], ["mango", "½ mango", 150], ["ananas", "1 schijf", 80], ["meloen", "1 part", 150], ["avocado", "½ avocado", 70],
  ["dadel", "1 dadel", 8], ["rozijnen|krenten", "1 doosje", 15],
  ["noten|amandelen|walnoten|cashewnoten|hazelnoten|pinda|pistache|pecan|macadamia|studentenhaver", "1 handje", 25], ["zaden|pitten|lijnzaad|chiazaad", "1 eetlepel", 10],
  ["tomaat", "1 tomaat", 100], ["cherrytomaat|kerstomaat", "1 handje", 80], ["komkommer", "¼ komkommer", 100], ["paprika", "1 paprika", 150], ["wortel|winterpeen", "1 wortel", 80],
  ["ui$|ui gewone|uien", "1 ui", 80], ["knoflook", "1 teen", 5], ["courgette", "1 courgette", 250], ["broccoli|bloemkool|sperziebonen|spinazie|boerenkool|andijvie|spruitjes|witlof|prei|champignons|groente|sla|rucola|bietjes|erwten|doperwten|wokgroente", "1 portie", 150],
  ["aardappel", "1 portie", 200], ["zoete aardappel", "1 portie", 200], ["friet|patat", "1 portie", 150],
  ["rijst|couscous|bulgur|quinoa|gierst", "1 portie (droog)", 75], ["pasta|spaghetti|macaroni|penne|noedels|mie", "1 portie (droog)", 80],
  ["kipfilet|kippendij|kip ", "1 portie", 125], ["gehakt|rundvlees|varkensvlees|biefstuk|varkenshaas|karbonade|lamsvlees|kalfsvlees|schnitzel|slavink|hamburger|braadworst|rookworst", "1 portie", 120],
  ["zalm|kabeljauw|tonijn|makreel|haring|koolvis|pangasius|tilapia|forel|vis ", "1 portie", 125], ["garnalen", "1 portie", 100], ["tofu|tempeh|seitan|vegetarische|vleesvervanger|vegaburger|falafel", "1 portie", 100],
  ["bonen|kikkererwten|linzen", "1 portie (uitgelekt)", 120], ["hummus", "1 portie", 30],
  ["soep", "1 kom", 250], ["pizza", "1 pizza", 350], ["lasagne|stamppot|ovenschotel|nasi|bami|maaltijd", "1 bord", 400], ["salade ", "1 bakje", 200],
  ["koffie|thee|^water", "1 kop", 150], ["frisdrank|cola|sinas|limonade|sap|jus d orange|smoothie|sportdrank|energiedrank|ijsthee", "1 glas", 200],
  ["bier|pils", "1 glas", 250], ["wijn", "1 glas", 125], ["sterke drank|jenever|whisky|wodka|likeur", "1 glaasje", 35],
  ["chocolade|reep", "1 reepje", 25], ["koek|biscuit|speculaas|stroopwafel|bitterkoekje|mergpijp|gevulde koek|cake|brownie|muffin|taart|gebak", "1 stuk", 30],
  ["chips|zoutjes|popcorn|nacho", "1 schaaltje", 30], ["snoep|drop|winegum|zuurtjes", "1 handje", 25], ["ijs |roomijs|waterijs|sorbetijs", "1 bolletje", 50],
  ["eiwitreep|mueslireep|granenreep|notenreep|repen", "1 reep", 40], ["eiwitpoeder|whey", "1 schepje", 30],
  ["saus|mayonaise|ketchup|curry|dressing|pesto|mosterd|sambal|ketjap|sojasaus", "1 eetlepel", 15], ["suiker", "1 schepje", 5]
];
var FOOD_BARCODE_TTL_MS = 30 * 86400000, FOOD_BARCODE_MISS_MS = 86400000;
var barcodeLimiter = makeHourlyLimiter(60);
var foodsPayloadCache = null;
function foodsPayload() {
  if (foodsPayloadCache) return foodsPayloadCache;
  var idx = nevoLoad();
  var foods = idx.list.map(function (it) { return [it.code, it.naam, it.kcal, it.eiwit, it.kh, it.vet, idx.staple[it.code] ? 1 : 0]; });
  var aliases = {}; Object.keys(NEVO_ALIASES).forEach(function (k) { aliases[k] = String(NEVO_ALIASES[k]); });
  var body = JSON.stringify({ version: NEVO_VERSION, reference: "Gebaseerd op gegevens van NEVO-online versie 2025/9.0, RIVM, Bilthoven en andere gegevens",
    foods: foods, aliases: aliases, portions: FOOD_PORTIONS });
  foodsPayloadCache = { body: body, etag: '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"' };
  return foodsPayloadCache;
}
function handleFoods(req, res) {
  var p = foodsPayload();
  if (req.headers["if-none-match"] === p.etag) { res.writeHead(304, { ETag: p.etag }); return res.end(); }
  var headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400", ETag: p.etag };
  var ae = String(req.headers["accept-encoding"] || "");
  if (/\bgzip\b/.test(ae)) {
    headers["Content-Encoding"] = "gzip"; headers["Vary"] = "Accept-Encoding";
    if (!p.gz) p.gz = zlib.gzipSync(p.body);
    res.writeHead(200, headers); return res.end(p.gz);
  }
  res.writeHead(200, headers); res.end(p.body);
}
// Een product uit Open Food Facts omzetten naar Balanza: naam (met merk), merk, winkels, macro's per 100 g en portie
function offStores(raw) {
  if (Array.isArray(raw)) raw = raw.join(",");
  raw = String(raw || "").split(",").map(function (x) { return x.trim().replace(/^[a-z]{2}:/, "").replace(/-/g, " "); }).join(",");
  var known = { "albert heijn": "Albert Heijn", "ah": "Albert Heijn", "jumbo": "Jumbo", "lidl": "Lidl", "aldi": "Aldi", "plus": "Plus", "dirk": "Dirk", "dirk van den broek": "Dirk",
    "coop": "Coop", "spar": "Spar", "dekamarkt": "DekaMarkt", "hoogvliet": "Hoogvliet", "vomar": "Vomar", "poiesz": "Poiesz", "ekoplaza": "Ekoplaza", "picnic": "Picnic", "kruidvat": "Kruidvat", "action": "Action", "etos": "Etos", "jan linders": "Jan Linders", "boni": "Boni", "nettorama": "Nettorama", "crisp": "Crisp" };
  var out = [];
  String(raw || "").split(",").forEach(function (x) { var k = x.trim().toLowerCase(); var v = known[k] || (k && k.length <= 24 ? cleanText(x.trim(), 24) : ""); if (v && out.indexOf(v) === -1) out.push(v); });
  return out.slice(0, 3);
}
function offFood(pr, ean, kcal) {
  var n = pr.nutriments || {};
  var num = function (k) { var x = Number(n[k]); return isFinite(x) && x >= 0 ? Math.round(x * 10) / 10 : 0; };
  var b0 = Array.isArray(pr.brands) ? pr.brands[0] : pr.brands ? String(pr.brands).split(",")[0] : "";
  b0 = String(b0 || "").trim().replace(/^[a-z]{2}:/, "");
  if (Array.isArray(pr.brands) && /^[a-z0-9-]+$/.test(b0)) b0 = b0 === "ah" ? "AH" : b0.split("-").map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");   // tag ("albert-heijn") leesbaar maken
  var brand = b0 ? cleanText(b0, 40) : "";
  var pname = pr.product_name_nl || pr.product_name || "";
  var name = brand && pname.toLowerCase().indexOf(brand.toLowerCase()) === 0 ? pname : [brand, pname].filter(Boolean).join(" ");
  return { ean: ean, name: cleanText(name, 80), brand: brand, stores: offStores(pr.stores), quantity: cleanText(pr.quantity || "", 20),
    kcal: Math.round(kcal), eiwit: num("proteins_100g"), kh: num("carbohydrates_100g"), vet: num("fat_100g"),
    portion: Number(pr.serving_quantity) > 0 && Number(pr.serving_quantity) < 2000 ? { label: cleanText(pr.serving_size || "1 portie", 30), g: Math.round(Number(pr.serving_quantity)) } : null,
    img: offImgPath(pr.image_front_small_url || pr.image_small_url || pr.image_front_url || pr.image_url),
    n: offNutr(n) };
}
// Overige voedingswaarden van het etiket (per 100 g): vezel, suiker, verzadigd vet (g) en natrium (mg); onbekend = null
function offNutr(n) {
  var g = function (k) { var x = Number(n[k]); return n[k] !== undefined && n[k] !== "" && isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : null; };
  var na = g("sodium_100g"); na = na != null ? Math.round(na * 1000) : (g("salt_100g") != null ? Math.round(g("salt_100g") / 2.5 * 1000) : null);
  var out = { vezel: g("fiber_100g"), suiker: g("sugars_100g"), verzadigd: g("saturated-fat_100g"), natrium: na };
  return Object.keys(out).some(function (k) { return out[k] != null; }) ? out : null;
}
// Productfoto van Open Food Facts (CC BY-SA): we bewaren alleen het pad en serveren hem via onze eigen server,
// zodat je telefoon niet rechtstreeks met Open Food Facts praat. Kleine variant (200 px) is genoeg.
var OFF_IMG_RE = /^\/images\/products\/[0-9\/]{3,40}\/[a-z0-9_.-]{3,60}\.(jpg|png|webp)$/i;
function offImgPath(u) {
  var m = String(u || "").match(/^https?:\/\/(?:images|static)\.openfoodfacts\.org(\/images\/products\/.+)$/);
  if (!m) return "";
  var p = m[1].replace(/\.(400|full)\.(jpg|png)$/i, ".200.$2");
  return OFF_IMG_RE.test(p) ? p : "";
}
var offImgCache = new Map();   // klein geheugen-cachetje voor veelgebruikte foto's
function handleFoodImg(req, res, p, debug) {
  if (!OFF_IMG_RE.test(p)) { res.writeHead(404); return res.end(); }
  var hit = offImgCache.get(p);
  var send = function (buf, type) { res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=2592000, immutable", "Content-Length": buf.length }); res.end(buf); };
  if (hit && !debug) return send(hit.buf, hit.type);
  // Al eens opgehaald? Dan staat hij blijvend in de database (collectie offimg)
  return offImgStored(p).then(function (st) {
    if (st && !debug) { offImgCache.set(p, st); if (offImgCache.size > 400) offImgCache.delete(offImgCache.keys().next().value); return send(st.buf, st.type); }
    return offImgFetch(req, res, p, debug, send);
  });
}
var OFFIMG_MAX = 20000, offImgCount = null;   // ± 12 kB per foto: hooguit ± 250 MB
// MongoDB geeft een Binary terug (bij een gewone Buffer is .buffer het gedeelde geheugenblok: niet gebruiken)
function binToBuf(d) {
  if (!d) return Buffer.alloc(0);
  if (Buffer.isBuffer(d)) return d;
  if (typeof d.read === "function" && typeof d.length === "function") return Buffer.from(d.read(0, d.length()));
  if (d.buffer && d.buffer instanceof Uint8Array) return Buffer.from(d.buffer.buffer, d.buffer.byteOffset, typeof d.position === "number" ? d.position : d.buffer.byteLength);
  return Buffer.from(d);
}
function offImgStored(p) {
  return mongoReady.then(function (db) {
    if (!db) return null;
    return db.collection("offimg").findOne({ _id: p }).then(function (d) { return d ? { buf: binToBuf(d.data), type: d.type } : null; });
  }).catch(function () { return null; });
}
function offImgStore(p, r) {
  return mongoReady.then(function (db) {
    if (!db) return;
    var col = db.collection("offimg");
    var count = offImgCount !== null ? Promise.resolve(offImgCount) : col.estimatedDocumentCount();
    return count.then(function (n) {
      offImgCount = n; if (n >= OFFIMG_MAX) return;
      return col.updateOne({ _id: p }, { $setOnInsert: { data: r.buf, type: r.type, at: Date.now() } }, { upsert: true }).then(function (u) { if (u && u.upsertedCount) offImgCount++; });
    });
  }).catch(function () {});
}
function offImgFetch(req, res, p, debug, send) {
  // Eerst de gewone fotoserver, dan de oude; geeft die een HTML-pagina (botbescherming), dan proberen we de volgende
  var hosts = ["https://images.openfoodfacts.org", "https://static.openfoodfacts.org", "https://world.openfoodfacts.org"], tries = [];
  var attempt = function (i) {
    if (i >= hosts.length) return Promise.reject(new Error("geen"));
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 7000);
    return fetch(hosts[i] + p, { signal: ctl.signal, redirect: "follow", headers: { "User-Agent": "Balanza/1.0 (balanza voedingsapp; contact via balanza.nl)", Accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8" } }).then(function (x) {
      clearTimeout(t);
      var type = String(x.headers.get("content-type") || "");
      tries.push({ host: hosts[i], status: x.status, type: type.slice(0, 30) });
      if (!x.ok || type.indexOf("image/") !== 0) return attempt(i + 1);
      return x.arrayBuffer().then(function (ab) { var buf = Buffer.from(ab); if (buf.length > 600000) throw new Error("te groot"); return { buf: buf, type: type }; });
    }, function (e) { clearTimeout(t); tries.push({ host: hosts[i], error: String(e && e.message || e).slice(0, 60) }); return attempt(i + 1); });
  };
  attempt(0).then(function (r) {
    offImgCache.set(p, r); if (offImgCache.size > 400) offImgCache.delete(offImgCache.keys().next().value);
    offImgStore(p, r);
    if (debug) return sendJSON(res, 200, { ok: true, bytes: r.buf.length, tries: tries, stored: offImgCount });
    send(r.buf, r.type);
  }).catch(function () {
    console.warn("[foods/img] niet gelukt voor " + p + ": " + JSON.stringify(tries));
    if (debug) return sendJSON(res, 200, { ok: false, tries: tries });
    res.writeHead(404, { "Cache-Control": "no-store" }); res.end();
  });
}
// GET /api/foods/search?q=… — producten uit Nederlandse winkels zoeken in Open Food Facts (met merk en winkel), 7 dagen bewaard.
var offSearchLimiter = makeHourlyLimiter(120);
// Nederlandse enkelvoud/meervoud-vormen van een zoekwoord: "havermoutreep" vindt ook "havermoutrepen", "repen" ook "reep".
function nlWordForms(w) {
  var out = [w], add = function (x) { if (x && x.length >= 3 && out.indexOf(x) === -1) out.push(x); };
  if (!/^[a-z]{4,}$/.test(w)) return out;
  var m = w.match(/^(.*[^aeiou])(aa|ee|oo|uu)([^aeiouyj])$/);          // reep -> repen, boon -> bonen
  if (m) add(m[1] + m[2][0] + m[3] + "en");
  if (/en$/.test(w) && w.length > 5) {
    var st = w.slice(0, -2), m2 = st.match(/^(.*[^aeiou])([aeou])([^aeiouyj])$/);
    if (m2) add(m2[1] + m2[2] + m2[2] + m2[3]);                          // repen -> reep
    if (/(.)\1$/.test(st)) add(st.slice(0, -1));                          // appelen? nee; koekjes/bessen -> bes
    add(st);                                                              // tomaten -> tomat (stam), havermoutrepen -> havermoutrep
  } else if (/([^aeious]|je)s$/.test(w) && w.length > 4) add(w.slice(0, -1));   // crackers -> cracker, koekjes -> koekje
  else if (/je$/.test(w)) add(w + "s");                                   // bolletje -> bolletjes
  else if (!m && /[^aeious]$/.test(w)) { add(w + "en"); add(w + "s"); }   // cracker -> crackers
  return out;
}
// Losse woorden die samen één woord vormen: "havermout reep" -> "havermoutreep" (en "havermoutrepen")
function offWordVariants(q) {
  var w = q.split(" ").filter(Boolean), out = [w];
  for (var i = w.length - 2; i >= 0 && out.length < 4; i--) {   // van achteren: het laatste woordpaar is meestal het product
    if (w[i].length >= 3 && w[i + 1].length >= 3) out.push(w.slice(0, i).concat([w[i] + w[i + 1]], w.slice(i + 2)));
  }
  return out;
}
// ---------- Eigen kopie van de Nederlandse producten uit Open Food Facts (ODbL) ----------
// Eén keer per week haalt de server de volledige export (CSV, ± 0,9 GB gezipt) op, houdt alleen producten die in
// Nederland verkocht worden, en bewaart die compact in MongoDB (of lokaal in data/). Zoeken gebeurt daarna in het
// geheugen: snel, zonder storingen of blokkades van de zoekdienst, en met onze eigen rangschikking.
// Bron en licentie: Open Food Facts, Open Database License (ODbL); de inhoud valt onder de Database Contents License.
var OFFNL_DUMP_URL = process.env.OFF_DUMP_URL || "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz";
var OFFNL_MAX_AGE_MS = 7 * 86400000;
var OFFNL_VER = 3;   // ophogen als het formaat verandert (2: met productfoto): dan meteen opnieuw ophalen
var OFFNL_CHUNK = 6 * 1024 * 1024;   // ruim onder de 16 MB per MongoDB-document
var OFFNL_FILE = path.join(__dirname, "data", "offnl.json.gz");
var offnl = { items: null, byEan: null, at: 0, count: 0, status: { state: "leeg" } };
function offnlNorm(x) { return String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
// Compact record: [ean, naam, merk, winkels ("A|B"), inhoud, kcal, eiwit, kh, vet, portie-g, portie-label, scans, foto-pad]
function offnlIndex(rows, at) {
  // Alle teksten (naam + merk, genormaliseerd) achter elkaar in één lange string: kandidaten zoeken met één native
  // indexOf is veel sneller dan per product, en kost weinig geheugen. Woordgrenzen blijven als spatie bewaard.
  var byEan = new Map(), offs = new Uint32Array(rows.length + 1), parts = new Array(rows.length), pos = 0;
  rows.forEach(function (r, i) { var t = " " + offnlNorm(r[1] + " " + r[2]) + " "; offs[i] = pos; parts[i] = t; pos += t.length + 1; byEan.set(r[0], i); });
  offs[rows.length] = pos;
  offnl.blob = parts.join("\u0001"); offnl.offs = offs;
  offnl.items = rows; offnl.byEan = byEan; offnl.at = at; offnl.count = rows.length;
}
function offnlToFood(r) {
  return { ean: r[0], name: r[1], brand: r[2], stores: r[3] ? r[3].split("|") : [], quantity: r[4], kcal: r[5], eiwit: r[6], kh: r[7], vet: r[8],
    portion: r[9] ? { label: r[10] || "1 portie", g: r[9] } : null, img: r[12] || "", n: r[13] || null };
}
function offnlByEan(ean) { if (!offnl.byEan) return null; var i = offnl.byEan.get(ean); return i === undefined ? null : offnlToFood(offnl.items[i]); }
function offnlSearch(q, limit) {
  if (!offnl.items) return null;
  var words = offnlNorm(q).split(" ").filter(function (w) { return w.length >= 2; });
  if (!words.length) return [];
  var forms = words.map(function (w) { return nlWordForms(w); });
  var need = words.length <= 2 ? words.length : words.length - 0.5;   // bij 3+ woorden mag er één half ontbreken
  // Het langste woord eerst: dat filtert het snelst
  var order = words.map(function (w, i) { return i; }).sort(function (a, b) { return words[b].length - words[a].length; });
  // Kandidaten: producten waarin (een vorm van) het langste woord voorkomt; bij 3+ woorden ook het op één na langste
  var cand = new Set(), offs = offnl.offs, blob = offnl.blob;
  var idxAt = function (p) { var lo = 0, hi = offs.length - 2; while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (offs[mid] <= p) lo = mid; else hi = mid - 1; } return lo; };
  order.slice(0, words.length >= 3 ? 2 : 1).forEach(function (wi) {
    forms[wi].forEach(function (fw) { var p = blob.indexOf(fw); while (p > -1 && cand.size < 60000) { var k0 = idxAt(p); cand.add(k0); p = blob.indexOf(fw, offs[k0 + 1]); } });
  });
  var hits = [];
  cand.forEach(function (k) {
    var txt = blob.slice(offs[k], offs[k + 1] - 1), it = { txt: txt, glued: txt.replace(/ /g, "") }, sc = 0, missed = 0;
    for (var j = 0; j < order.length; j++) {
      var fs = forms[order[j]], v = 0;
      for (var f = 0; f < fs.length; f++) {
        var fw = fs[f];
        if (it.txt.indexOf(" " + fw + " ") > -1) { v = 1; break; }
        if (it.txt.indexOf(" " + fw) > -1) v = Math.max(v, 0.85);                       // begin van een woord (tijdens het typen)
        else if (fw.length >= 4 && it.glued.indexOf(fw) > -1) v = Math.max(v, 0.8);    // in een samenstelling: havermout(repen)
      }
      if (!v) { missed++; if (words.length < 3 || missed > 1) { sc = -1; break; } }
      sc += v;
    }
    if (sc >= need - 0.5 && sc > 0) hits.push({ k: k, s: sc });
  });
  hits.sort(function (a, b) {
    if (b.s !== a.s) return b.s - a.s;
    var ra = offnl.items[a.k], rb = offnl.items[b.k];
    return (rb[11] || 0) - (ra[11] || 0) || (rb[3] ? 1 : 0) - (ra[3] ? 1 : 0) || ra[1].length - rb[1].length;
  });
  return hits.slice(0, limit || 10).map(function (h) { return offnlToFood(offnl.items[h.k]); });
}
// ---- Opslaan en laden ----
function offnlSave(rows, at) {
  var gz = zlib.gzipSync(Buffer.from(JSON.stringify(rows)), { level: 6 });
  return mongoReady.then(function (db) {
    if (!db) { try { fs.mkdirSync(path.dirname(OFFNL_FILE), { recursive: true }); fs.writeFileSync(OFFNL_FILE, gz); } catch (e) {} return dbSetDoc("offnl/meta", { at: at, count: rows.length, file: true, ver: OFFNL_VER }); }
    var gen = "g" + at, col = db.collection("offnl"), parts = [];
    for (var i = 0; i * OFFNL_CHUNK < gz.length; i++) parts.push({ _id: gen + "-" + i, gen: gen, i: i, data: gz.subarray(i * OFFNL_CHUNK, (i + 1) * OFFNL_CHUNK) });
    return col.insertMany(parts).then(function () { return dbSetDoc("offnl/meta", { at: at, count: rows.length, gen: gen, chunks: parts.length, bytes: gz.length, ver: OFFNL_VER }); })
      .then(function () { return col.deleteMany({ gen: { $ne: gen } }); });
  });
}
function offnlLoad() {
  return dbGetDoc("offnl/meta").then(function (r) {
    var m = r.exists ? r.value : null; if (!m) return null;
    return mongoReady.then(function (db) {
      if (!db || m.file) { try { return { m: m, gz: fs.readFileSync(OFFNL_FILE) }; } catch (e) { return null; } }
      return db.collection("offnl").find({ gen: m.gen }).sort({ i: 1 }).toArray().then(function (docs) {
        if (docs.length !== m.chunks) return null;
        return { m: m, gz: Buffer.concat(docs.map(function (d) { return binToBuf(d.data); })) };
      });
    });
  }).then(function (x) {
    if (!x) return false;
    var rows = JSON.parse(zlib.gunzipSync(x.gz).toString("utf8"));
    offnlIndex(rows, x.m.at); offnl.ver = x.m.ver || 1; offnl.status = { state: "klaar", at: x.m.at, count: rows.length, ver: offnl.ver };
    console.log("[offnl] " + rows.length + " Nederlandse producten geladen (van " + new Date(x.m.at).toISOString().slice(0, 10) + ").");
    return true;
  }).catch(function (e) { console.warn("[offnl] laden mislukt: " + (e && e.message)); return false; });
}
// ---- De export ophalen en filteren (stream: geheugen blijft klein) ----
function offnlImport() {
  if (offnl.status.state === "bezig") return Promise.resolve(false);
  var st = offnl.status = { state: "bezig", startedAt: Date.now(), mb: 0, lines: 0, kept: 0 };
  var Readable = require("stream").Readable, readline = require("readline");
  var ctl = new AbortController(), idle = null, poke = function () { clearTimeout(idle); idle = setTimeout(function () { ctl.abort(); }, 120000); };
  poke();
  return fetch(OFFNL_DUMP_URL, { signal: ctl.signal, headers: { "User-Agent": "Balanza/1.0 (balanza voedingsapp; wekelijkse export)" } }).then(function (res) {
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    var src = Readable.fromWeb(res.body), gunzip = zlib.createGunzip(), bytes = 0;
    src.on("data", function (c) { bytes += c.length; st.mb = Math.round(bytes / 1048576); poke(); });
    src.on("error", function (e) { gunzip.destroy(e); });
    var rl = readline.createInterface({ input: src.pipe(gunzip), crlfDelay: Infinity });
    var col = null, rows = [], seen = new Set();
    return new Promise(function (resolve, reject) {
      gunzip.on("error", reject);
      rl.on("line", function (line) {
        st.lines++;
        if (!col) { col = {}; line.split("\t").forEach(function (h, i) { col[h] = i; }); if (col.code === undefined || col.countries_tags === undefined) { rl.close(); reject(new Error("onbekend formaat")); } return; }
        if (line.indexOf("en:netherlands") === -1) return;
        var c = line.split("\t");
        if (String(c[col.countries_tags] || "").split(",").indexOf("en:netherlands") === -1) return;
        var code = String(c[col.code] || "").trim(); if (!/^\d{8,14}$/.test(code) || seen.has(code)) return;
        var g = function (k) { return col[k] === undefined ? "" : c[col[k]] || ""; };
        var kcal = Number(g("energy-kcal_100g")); if (!(kcal >= 0) || g("energy-kcal_100g") === "") { var kj = Number(g("energy_100g")); kcal = g("energy_100g") !== "" && kj >= 0 ? kj / 4.184 : NaN; }
        if (!(kcal >= 0 && kcal <= 950)) return;
        var pname = g("product_name_nl") || g("product_name"); if (!pname.trim()) return;
        var pr = { product_name: pname, brands: g("brands"), stores: g("stores"), quantity: g("quantity"), serving_size: g("serving_size"), serving_quantity: g("serving_quantity"), image_small_url: g("image_small_url") || g("image_url"),
          nutriments: { proteins_100g: g("proteins_100g"), carbohydrates_100g: g("carbohydrates_100g"), fat_100g: g("fat_100g"), fiber_100g: g("fiber_100g"), sugars_100g: g("sugars_100g"), "saturated-fat_100g": g("saturated-fat_100g"), sodium_100g: g("sodium_100g"), salt_100g: g("salt_100g") } };
        var fd = offFood(pr, code, kcal);
        if (!fd.name) return;
        seen.add(code);
        rows.push([fd.ean, fd.name, fd.brand, fd.stores.join("|"), fd.quantity, fd.kcal, fd.eiwit, fd.kh, fd.vet, fd.portion ? fd.portion.g : 0, fd.portion ? fd.portion.label : "", Number(g("unique_scans_n")) || 0, fd.img || "", fd.n || null]);
        st.kept = rows.length;
      });
      rl.on("close", function () { resolve(rows); });
    });
  }).then(function (rows) {
    clearTimeout(idle);
    if (rows.length < 100) throw new Error("te weinig producten (" + rows.length + ")");
    var at = Date.now();
    return offnlSave(rows, at).then(function () {
      offnlIndex(rows, at); offnl.ver = OFFNL_VER;
      offnl.status = { state: "klaar", at: at, count: rows.length, took: Math.round((at - st.startedAt) / 1000), mb: st.mb, lines: st.lines };
      console.log("[offnl] export verwerkt: " + rows.length + " producten in " + offnl.status.took + " s.");
      return true;
    });
  }).catch(function (e) {
    clearTimeout(idle);
    offnl.status = { state: "fout", error: String(e && e.message || e).slice(0, 120), at: offnl.at, count: offnl.count, failedAt: Date.now() };
    console.warn("[offnl] export mislukt: " + offnl.status.error);
    return false;
  });
}
// Bij het opstarten laden; is de kopie ouder dan een week (of er is er nog geen), dan 's nachts of meteen verversen.
function offnlEnsure() {
  // Voorlopig alleen met OFFNL_ENABLE=1: het verwerken van de volledige export kan op een kleine server te veel geheugen kosten
  if (process.env.OFFNL_ENABLE !== "1" || process.env.OFFNL_DISABLE === "1" || offnl.status.state === "bezig") return;
  var p = offnl.items ? Promise.resolve(true) : offnlLoad();
  p.then(function () {
    var stale = !offnl.items || Date.now() - offnl.at > OFFNL_MAX_AGE_MS;
    var failedRecently = offnl.status.failedAt && Date.now() - offnl.status.failedAt < 6 * 3600000;
    var h = new Date().getUTCHours();
    var veryStale = offnl.items && (Date.now() - offnl.at > OFFNL_MAX_AGE_MS + 2 * 86400000 || offnl.ver !== OFFNL_VER);
    if (offnl.items && offnl.ver !== OFFNL_VER) stale = true;
    if (stale && !failedRecently && (!offnl.items || veryStale || h >= 1 && h <= 4)) offnlImport();
  });
}
function handleFoodSearch(req, res, url) {
  // Hoeveelheden ("pindakaas 100", "2 eieren") horen niet in de zoekterm
  var q = String(url.searchParams.get("q") || "").toLowerCase().replace(/\b\d+([.,]\d+)?\s*(g|gr|gram|ml|stuks?|x|el|tl)?\b(?!%)/g, " ")
    .replace(/[^a-z0-9à-ÿ\s'&%-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  var debug = url.searchParams.get("debug") === "1", tries = [];
  if (q.length < 3) return sendJSON(res, 200, { items: [] });
  if (!offSearchLimiter("s:" + clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Even te veel gezocht. Probeer het zo opnieuw." });
  // Eerst in onze eigen kopie; vindt die iets met al je woorden, dan hoeven we de zoekdienst niet te vragen
  var local = offnlSearch(q, 10);
  if (local && local.length && !debug) return sendJSON(res, 200, { items: local, source: "Open Food Facts" });
  var key = "foods/search9/" + crypto.createHash("sha1").update(q).digest("hex").slice(0, 20);
  var mapItems = function (list) {
    return (Array.isArray(list) ? list : []).map(function (pr) {
      var n = pr.nutriments || {}, kcal = Number(n["energy-kcal_100g"]); if (!isFinite(kcal) && isFinite(Number(n["energy_100g"]))) kcal = Number(n["energy_100g"]) / 4.184;
      if (!isFinite(kcal) || kcal < 0 || !(pr.product_name_nl || pr.product_name) || !/^\d{8,14}$/.test(String(pr.code || ""))) return null;
      return offFood(pr, String(pr.code), kcal);
    }).filter(Boolean).slice(0, 20);
  };
  var getJson = function (label, u, listKey) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 8000);
    return fetch(u, { signal: ctl.signal, headers: { "User-Agent": "Balanza/1.0 (balanza voedingsapp; contact via balanza.nl)", Accept: "application/json" } })
      .then(function (x) {
        clearTimeout(t);
        var ct = String(x.headers.get("content-type") || "");
        if (!x.ok || ct.indexOf("json") === -1) { return x.text().catch(function () { return ""; }).then(function (txt) { tries.push({ src: label, status: x.status, type: ct.slice(0, 30), body: String(txt).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) }); throw new Error("HTTP " + x.status); }); }
        return x.json();
      })
      .then(function (d) { var raw = d && d[listKey], items = mapItems(raw); tries.push({ src: label, status: 200, raw: Array.isArray(raw) ? raw.length : -1, items: items.length }); return items; })
      .catch(function (e) { clearTimeout(t); if (!tries.length || tries[tries.length - 1].src !== label) tries.push({ src: label, error: String(e && e.message || e).slice(0, 80) }); return []; });
  };
  var sBase = process.env.OFF_SEARCH_URL || "https://search.openfoodfacts.org";
  var oBase = process.env.OFF_BASE_URL || "https://world.openfoodfacts.org";
  var FIELDS = "code,product_name,product_name_nl,brands,stores,nutriments,serving_quantity,serving_size,quantity,image_front_small_url,image_small_url";
  // Zoekvarianten als gewone tekst (de zoekdienst geeft een fout op OR-constructies):
  // de zoekterm zelf, aaneengeschreven (havermout reep -> havermoutreep) en het laatste woord in de andere vorm (-> havermoutrepen)
  var variants = [];
  offWordVariants(q).forEach(function (words) {
    var last = words[words.length - 1], f = nlWordForms(last);
    [words.join(" "), f[1] ? words.slice(0, -1).concat([f[1]]).join(" ") : null].forEach(function (v) { if (v && variants.indexOf(v) === -1) variants.push(v); });
  });
  variants = variants.slice(0, 4);
  var sUrl = function (v, nl) { return sBase + "/search?q=" + encodeURIComponent(v + (nl ? ' countries_tags:"en:netherlands"' : "")) + "&langs=nl,en&page_size=20&fields=" + FIELDS; };
  var lUrl = function (v) { return oBase + "/cgi/search.pl?search_terms=" + encodeURIComponent(v) + "&search_simple=1&action=process&json=1&page_size=20&sort_by=unique_scans_n&tagtype_0=countries&tag_contains_0=contains&tag_0=netherlands&fields=" + FIELDS; };
  // Per groep tegelijk zoeken (snel), de eerste groep met resultaten wint
  // De zoekdienst geeft ook producten met maar één van je woorden. Daarom zelf rangschikken:
  // hoeveel van je woorden (of een vorm ervan, ook binnen een samenstelling) staan in naam + merk?
  var qWords = q.split(" ").filter(function (w) { return w.length >= 2; });
  var norm = function (x) { return String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " "); };
  var scoreOf = function (it) {
    var txt = " " + norm(it.name + " " + it.brand) + " ", glued = txt.replace(/ /g, ""), sc = 0;
    qWords.forEach(function (w) {
      var forms = nlWordForms(w);
      if (forms.some(function (f) { return txt.indexOf(" " + f + " ") > -1; })) sc += 1;
      else if (forms.some(function (f) { return f.length >= 4 && glued.indexOf(f) > -1; })) sc += 0.9;   // in een samenstelling: havermout(repen)
    });
    return sc;
  };
  var merge = function (lists) {
    var seen = {}, out = [];
    lists.forEach(function (l) { l.forEach(function (it) { if (!seen[it.ean]) { seen[it.ean] = 1; it._s = scoreOf(it); out.push(it); } }); });
    var need = qWords.length <= 2 ? qWords.length : Math.max(2, qWords.length - 1);   // bij 3+ woorden mag er één ontbreken
    var best = out.reduce(function (m, it) { return Math.max(m, it._s); }, 0);
    out = out.filter(function (it) { return it._s >= Math.min(need, best) - 0.01 && it._s > 0; });
    out.sort(function (a, b) { return b._s - a._s || (b.stores.length ? 1 : 0) - (a.stores.length ? 1 : 0); });
    var res = out.slice(0, 10).map(function (it) { delete it._s; return it; });
    res.full = best >= need - 0.01;   // alle (op één na) woorden gevonden?
    return res;
  };
  var groups = [
    function () { return Promise.all(variants.map(function (v) { return getJson("search-nl:" + v, sUrl(v, true), "hits"); })).then(merge); },
    function () { return Promise.all(variants.map(function (v) { return getJson("search:" + v, sUrl(v, false), "hits"); })).then(merge); },
    function () { return getJson("legacy:" + variants[0], lUrl(variants[0]), "products").then(function (l) { return merge([l]); }); },
    function () { return variants[1] ? getJson("legacy:" + variants[1], lUrl(variants[1]), "products").then(function (l) { return merge([l]); }) : Promise.resolve([]); }
  ];
  // Een groep die niet alle woorden vindt, bewaren we als reserve en we zoeken verder
  var fallback = [];
  function run(i) {
    if (i >= groups.length) return Promise.resolve(fallback);
    return groups[i]().then(function (items) {
      if (items.length && items.full) return items;
      if (items.length > fallback.length && !fallback.length) fallback = items;
      return run(i + 1);
    });
  }
  return dbGetDoc(key).then(function (r) {
    var v = r.exists ? r.value : null;
    if (!debug && v && Date.now() - v.at < (v.items && v.items.length ? 7 * 86400000 : 30 * 60000)) return v;   // niets gevonden: na een half uur opnieuw proberen
    return run(0).then(function (items) {
      if (!items.length) console.warn("[foods/search] geen resultaten voor '" + q + "': " + JSON.stringify(tries));
      var doc = { at: Date.now(), items: items };
      return dbSetDoc(key, doc).then(function () { return doc; });
    });
  }).then(function (doc) {
    var out = { items: local && local.length ? local : doc.items || [], source: "Open Food Facts" };
    if (debug) { out.q = q; out.tries = tries; out.local = { loaded: !!offnl.items, ver: offnl.ver || null, status: offnl.status, count: offnl.count, at: offnl.at ? new Date(offnl.at).toISOString() : null, hits: local ? local.length : null, state: offnl.status.state }; out.remote = doc.items || []; }
    sendJSON(res, 200, out);
  })
    .catch(function (e) { sendJSON(res, 200, { items: [], error: true, tries: debug ? tries : undefined }); });
}
// GET /api/foods/barcode/<ean> — productgegevens van Open Food Facts (open data, ODbL), 30 dagen bewaard.
function handleFoodBarcode(req, res, ean) {
  if (!/^\d{8,14}$/.test(ean)) return sendJSON(res, 400, { code: "bad_request", message: "Dit is geen geldige streepjescode." });
  if (!barcodeLimiter("b:" + clientIp(req))) return sendJSON(res, 429, { code: "rate_limited", message: "Even te veel gescand. Probeer het zo opnieuw." });
  var loc = offnlByEan(ean);
  if (loc && loc.img) return sendJSON(res, 200, { food: loc, source: "Open Food Facts" });   // zonder foto: live aanvullen hieronder
  var key = "foods/ean/" + ean;
  return dbGetDoc(key).then(function (r) {
    var v = r.exists ? r.value : null;
    if (v && (!v.found || v.v === 4) && Date.now() - v.at < (v.found ? FOOD_BARCODE_TTL_MS : FOOD_BARCODE_MISS_MS)) return v;
    var base = process.env.OFF_BASE_URL || "https://world.openfoodfacts.org";
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 8000);
    return fetch(base + "/api/v2/product/" + ean + ".json?fields=product_name,product_name_nl,generic_name_nl,brands,stores,nutriments,serving_quantity,serving_size,quantity,image_front_small_url,image_small_url",
      { signal: ctl.signal, headers: { "User-Agent": "Balanza/1.0 (balanza voedingsapp)" } })
      .then(function (x) { return x.ok || x.status === 404 ? x.json().catch(function () { return {}; }) : Promise.reject(new Error("HTTP " + x.status)); })
      .then(function (d) {
        clearTimeout(t);
        var pr = d && d.product, n = pr && pr.nutriments || {};
        var kcal = Number(n["energy-kcal_100g"]); if (!isFinite(kcal) && isFinite(Number(n["energy_100g"]))) kcal = Number(n["energy_100g"]) / 4.184;
        var found = !!(pr && isFinite(kcal) && kcal >= 0 && (pr.product_name_nl || pr.product_name));
        var doc = { at: Date.now(), found: found, v: 4 };
        if (found) doc.food = offFood(pr, ean, kcal);
        return dbSetDoc(key, doc).then(function () { return doc; });
      }, function (e) { clearTimeout(t); throw e; });
  }).then(function (doc) {
    logRequest({ ts: new Date().toISOString(), type: "estimate", action: "streepjescode", ok: !!doc.found, status: doc.found ? 200 : 404, ip: clientIp(req) });
    if (!doc.found && loc) return sendJSON(res, 200, { food: loc, source: "Open Food Facts" });
    if (doc.found && loc && !doc.food.img) doc.food = loc;
    if (!doc.found) return sendJSON(res, 404, { code: "not_found", message: "Dit product staat (nog) niet in Open Food Facts. Zoek het op naam of voeg het zelf toe." });
    sendJSON(res, 200, { food: doc.food, source: "Open Food Facts" });
  }).catch(function () { if (loc) return sendJSON(res, 200, { food: loc, source: "Open Food Facts" }); sendJSON(res, 502, { code: "error", message: "De productgegevens konden niet worden opgehaald. Probeer het zo opnieuw of zoek op naam." }); });
}

// ---------- Ideeën van gebruikers (uit de chat) en berichten terug ----------
//   suggestions/<id>  { id, uid, email, name, createdAt, status: new|accepted|rejected, title, area, userStory, problem, proposal,
//                       acceptance[], framework, impact, quote, decidedAt, decisionMessage }
//   inbox/<uid>       { items: [{ id, kind, title, text, at, read }] }  berichten aan de gebruiker (bijv. de reactie op een idee)
var SUGGEST_AREAS = ["Ontwerpen", "Plannen", "Boodschappen", "Begeleiding", "Community", "Account", "Weergave", "Overig"];
var suggestLimiter = makeHourlyLimiter(10);
function cleanSuggestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  var title = cleanText(raw.title, 90), proposal = cleanText(raw.proposal, 1200);
  if (!title || !proposal) return null;
  return { title: title, area: SUGGEST_AREAS.indexOf(raw.area) > -1 ? raw.area : "Overig", userStory: cleanText(raw.userStory, 400),
    problem: cleanText(raw.problem, 800), proposal: proposal, acceptance: aStrList(raw.acceptance, 8, 240),
    framework: cleanText(raw.framework, 600), impact: ["klein", "middel", "groot"].indexOf(raw.impact) > -1 ? raw.impact : "middel" };
}
function pushInbox(uid, item) {
  return dbGetDoc("inbox/" + uid).then(function (r) {
    var items = r.exists && r.value && Array.isArray(r.value.items) ? r.value.items : [];
    items.push(Object.assign({ id: crypto.randomBytes(8).toString("hex"), at: new Date().toISOString(), read: false }, item));
    return dbSetDoc("inbox/" + uid, { items: items.slice(-30) });
  });
}
function handleSuggestions(req, res) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (req.method === "GET") {
      return dbListDocs("suggestions/").then(function (docs) {
        var mine = docs.map(function (d) { return d.value; }).filter(function (v) { return v && v.uid === user.uid; })
          .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).slice(0, 20)
          .map(function (v) { return { id: v.id, title: v.title, status: v.status, createdAt: v.createdAt, decidedAt: v.decidedAt || null }; });
        sendJSON(res, 200, { suggestions: mine });
      });
    }
    if (!suggestLimiter(user.uid)) return sendJSON(res, 429, { code: "rate_limited", message: "Je hebt al veel ideeën ingestuurd dit uur. Dank je wel! Probeer het later nog eens." });
    return readBody(req).then(function (body) {
      var sug = cleanSuggestion(body && body.suggestion);
      if (!sug) return sendJSON(res, 400, { code: "bad_request", message: "Dit idee is niet compleet." });
      return Promise.all([dbGetDoc("data/users/" + user.uid + "/prefs"), dbListDocs("suggestions/")]).then(function (r) {
        var name = r[0].exists && r[0].value && r[0].value.name ? cleanText(r[0].value.name, 40) : "";
        var dup = r[1].map(function (d) { return d.value; }).filter(function (v) { return v && v.uid === user.uid && v.title.toLowerCase() === sug.title.toLowerCase() && v.status === "new"; })[0];
        if (dup) return sendJSON(res, 200, { ok: true, id: dup.id, duplicate: true });
        var doc = Object.assign({ id: crypto.randomBytes(8).toString("hex"), uid: user.uid, email: user.email || null, name: name,
          createdAt: new Date().toISOString(), status: "new", quote: cleanText(body.quote, 500) }, sug);
        return dbSetDoc("suggestions/" + doc.id, doc).then(function () {
          logEvent("suggestion", "submit", true, 200, { uid: user.uid });
          sendJSON(res, 200, { ok: true, id: doc.id });
          ghEnsureIssue(doc);   // op de achtergrond; de gebruiker hoeft er niet op te wachten
        });
      });
    });
  }).catch(function () { sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." }); });
}
function handleInbox(req, res, action) {
  return resolveUser(req).then(function (user) {
    if (!user) return sendUnauthorized(res);
    if (req.method === "GET") return dbGetDoc("inbox/" + user.uid).then(function (r) {
      var items = r.exists && r.value && Array.isArray(r.value.items) ? r.value.items : [];
      sendJSON(res, 200, { items: items.slice(-30).reverse() });
    });
    return readBody(req).then(function (body) {
      var ids = Array.isArray(body && body.ids) ? body.ids : [];
      return dbGetDoc("inbox/" + user.uid).then(function (r) {
        var items = r.exists && r.value && Array.isArray(r.value.items) ? r.value.items : [];
        items.forEach(function (it) { if (ids.indexOf(it.id) > -1 || body.all === true) it.read = true; });
        return dbSetDoc("inbox/" + user.uid, { items: items }).then(function () { sendJSON(res, 200, { ok: true }); });
      });
    });
  }).catch(function () { sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." }); });
}

// ---------- Ideeën als GitHub-issues ----------
// Met GITHUB_TOKEN (fine-grained token met alleen "Issues: read and write" op deze repo) wordt elk ingestuurd idee een issue
// met labels: idee-van-gebruiker + nieuw | geaccepteerd | afgewezen. Er staan nooit namen, e-mailadressen of de letterlijke
// vraag van de gebruiker in (de repo kan openbaar zijn). Wordt een geaccepteerd issue gesloten als "voltooid", dan krijgt de
// indiener bericht dat zijn idee live staat.
var GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
var GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPO || "") ? process.env.GITHUB_REPO : "coretic1980/weekmenu-app";
var GITHUB_API_URL = String(process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");   // alleen aanpassen bij testen
var GH_LABEL_BASE = "idee-van-gebruiker", GH_STATUS_LABEL = { "new": "nieuw", accepted: "geaccepteerd", rejected: "afgewezen", live: "live" };
function githubOn() { return GITHUB_TOKEN.length > 10; }
function ghApi(method, path, body) {
  return fetch(GITHUB_API_URL + "/repos/" + GITHUB_REPO + path, {
    method: method,
    headers: { "Authorization": "Bearer " + GITHUB_TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "balanza-app", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {} if (!r.ok) throw new Error("GitHub " + r.status + ": " + (j && j.message || t).slice(0, 200)); return j; });
  });
}
function ghMd(t) { return String(t || "").replace(/@/g, "@​").replace(/<\/?[a-z][^>]*>/gi, ""); }   // geen @-vermeldingen of HTML
function ghIssueBody(doc) {
  return [
    "> Idee van een Balanza-gebruiker, ingestuurd via de assistent in de app. Functioneel uitgeschreven door de assistent; beoordelen in Beheer → Voorstellen.",
    "",
    "**Onderdeel:** " + ghMd(doc.area) + " · **Geschatte impact:** " + ghMd(doc.impact),
    "",
    doc.userStory ? "### Gebruikersverhaal\n" + ghMd(doc.userStory) + "\n" : "",
    doc.problem ? "### Probleem\n" + ghMd(doc.problem) + "\n" : "",
    "### Voorstel\n" + ghMd(doc.proposal) + "\n",
    doc.acceptance && doc.acceptance.length ? "### Acceptatiecriteria\n" + doc.acceptance.map(function (a) { return "- [ ] " + ghMd(a); }).join("\n") + "\n" : "",
    doc.framework ? "### Kaders (macrobalans per doel)\n" + ghMd(doc.framework) + "\n" : "",
    "---",
    "<sub>Balanza-voorstel " + doc.id + "</sub>"
  ].filter(function (x) { return x !== ""; }).join("\n");
}
function ghLabels(status) { return [GH_LABEL_BASE, GH_STATUS_LABEL[status] || "nieuw"]; }
// Maakt het issue (als dat er nog niet is). Fouten houden niets tegen: de admin ziet ze en het wordt later opnieuw geprobeerd.
function ghEnsureIssue(doc) {
  if (!githubOn() || doc.issueNumber) return Promise.resolve(doc);
  return ghApi("POST", "/issues", { title: "Idee: " + ghMd(doc.title), body: ghIssueBody(doc), labels: ghLabels(doc.status) }).then(function (iss) {
    doc.issueNumber = iss.number; doc.issueUrl = iss.html_url; doc.issueError = null;
    return dbSetDoc("suggestions/" + doc.id, doc).then(function () { return doc; });
  }, function (e) {
    doc.issueError = e.message; console.warn("GitHub-issue maken mislukt: " + e.message);
    return dbSetDoc("suggestions/" + doc.id, doc).then(function () { return doc; });
  });
}
function ghSyncDecision(doc, comment) {
  if (!githubOn()) return Promise.resolve();
  return ghEnsureIssue(doc).then(function () {
    if (!doc.issueNumber) return;
    var patch = { labels: ghLabels(doc.status) };
    if (doc.status === "rejected") { patch.state = "closed"; patch.state_reason = "not_planned"; }
    if (doc.status === "new" || doc.status === "accepted") patch.state = "open";
    var note = comment ? ghApi("POST", "/issues/" + doc.issueNumber + "/comments", { body: comment }).catch(function () {}) : Promise.resolve();
    return note.then(function () { return ghApi("PATCH", "/issues/" + doc.issueNumber, patch); }).catch(function (e) { console.warn("GitHub-issue bijwerken mislukt: " + e.message); });
  });
}
// Geaccepteerd en het issue is gesloten als voltooid? Dan staat het live: de indiener krijgt bericht. Ook: ontbrekende issues alsnog maken.
var ghLiveCheckAt = 0;
function ghLiveCheck(force) {
  if (!githubOn() || (!force && Date.now() - ghLiveCheckAt < 20 * 60 * 1000)) return Promise.resolve();
  ghLiveCheckAt = Date.now();
  return dbListDocs("suggestions/").then(function (docs) {
    var all = docs.map(function (d) { return d.value; }).filter(Boolean);
    return mapLimit(all, 3, function (doc) {
      if (!doc.issueNumber) return ghEnsureIssue(doc);
      if (doc.status !== "accepted") return null;
      return ghApi("GET", "/issues/" + doc.issueNumber).then(function (iss) {
        if (!iss || iss.state !== "closed" || iss.state_reason !== "completed") return;
        doc.status = "live"; doc.liveAt = new Date().toISOString();
        return dbSetDoc("suggestions/" + doc.id, doc).then(function () {
          return pushInbox(doc.uid, { kind: "suggestion", status: "live", title: "Je idee staat live: " + doc.title,
            text: "Het is zover: “" + doc.title + "” zit nu in Balanza. Dank je wel dat je meedacht. Zo maken we de app samen beter. Heb je nog meer ideeën? De assistent hoort ze graag." });
        }).then(function () {
          return notifyUser(doc.uid, { title: "Je idee staat live!", body: "“" + doc.title + "” zit nu in Balanza. Tik om te kijken.", url: "/?open=chat", tag: "balanza-inbox" }, notifyHost(), "suggestion-live").catch(function () {});
        }).then(function () { ghApi("PATCH", "/issues/" + doc.issueNumber, { labels: ghLabels("live") }).catch(function () {}); });
      }).catch(function (e) { console.warn("GitHub-controle mislukt: " + e.message); });
    });
  }).catch(function () {});
}
var ghTimer = setInterval(function () { ghLiveCheck(false); }, 10 * 60 * 1000);
if (ghTimer.unref) ghTimer.unref();

// ---------- Fouten als GitHub-issue: met één knop vanuit Beheer ----------
// Gelijke fouten (zelfde soort, actie en melding, getallen weggelaten) delen één issue: nog een keer melden zet er een
// reactie bij (en heropent het als het al dicht was). Er gaan nooit e-mailadressen, IP-adressen, gebruikers-id's of
// sleutels mee: de repo kan openbaar zijn. Labels: fout + nieuw. Een geplande Claude-taak pakt nieuwe fout-issues op.
var GH_ERROR_LABEL = "fout";
function errScrub(t) {
  return String(t || "").replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[e-mail]").replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "[ip]")
    .replace(/\bu_[0-9a-f]{8,}\b/gi, "[gebruiker]").replace(/\b(Bearer\s+)?[A-Za-z0-9_\-]{28,}\b/g, "[sleutel]").slice(0, 600);
}
function errSignature(l) {
  var msg = errScrub(l.error || ("status " + (l.status || ""))).replace(/\d+/g, "#").trim().toLowerCase();
  return crypto.createHash("sha1").update((l.type || "") + "|" + (l.action || "") + "|" + msg).digest("hex").slice(0, 16);
}
function errFence(msg) { return "```\n" + String(msg).replace(/```/g, "` ` `") + "\n```"; }
function handleAdminErrorIssues(req, res) {
  return dbListDocs("errissues/").then(function (docs) {
    var by = {};
    docs.forEach(function (d) { if (d.value && d.value.issueNumber) by[d.value.sig] = { number: d.value.issueNumber, url: d.value.issueUrl, reportedAt: d.value.lastReportedAt }; });
    sendJSON(res, 200, { github: githubOn() ? { repo: GITHUB_REPO } : null, bySig: by });
  });
}
function handleAdminErrorToIssue(req, res) {
  if (!githubOn()) return Promise.resolve(sendJSON(res, 400, { code: "not_configured", message: "GitHub is nog niet gekoppeld: zet GITHUB_TOKEN in Render (fine-grained, alleen Issues: read and write)." }));
  return requireBody(req).then(function (body) {
    var l = { type: cleanText(body && body.type, 30), action: cleanText(body && body.action, 60), status: Number(body && body.status) || null,
      error: String(body && body.error || "").slice(0, 2000), ts: String(body && body.ts || "") };
    if (!l.error && !l.status) throw HttpError(400, "bad_request", "Geen fout meegegeven.");
    var sig = errSignature(l), key = "errissues/" + sig;
    var note = cleanNote(body && body.note, 1000);
    return Promise.all([dbGetDoc(key), getRecentLogs(LOG_CAP)]).then(function (r) {
      var doc = r[0].exists && r[0].value ? r[0].value : { sig: sig, createdAt: new Date().toISOString() };
      var since = Date.now() - 7 * 86400000;
      var same = r[1].map(cleanLogRow).filter(function (x) { return !x.ok && x.sig === sig && Date.parse(x.ts) >= since; });
      var users = {}; same.forEach(function (x) { if (x.uid) users[x.uid] = 1; });
      var first = null, last = null; same.forEach(function (x) { if (!first || x.ts < first) first = x.ts; if (!last || x.ts > last) last = x.ts; });
      var durs = same.map(function (x) { return x.durationMs; }).filter(function (d) { return d != null; });
      var stats = "**Hoe vaak (laatste 7 dagen):** " + Math.max(1, same.length) + " keer, bij " + Object.keys(users).length + " gebruiker(s)" +
        (first ? "  \n**Eerste / laatste keer:** " + first + " / " + last : "") +
        (durs.length ? "  \n**Duur:** " + Math.min.apply(null, durs) + "–" + Math.max.apply(null, durs) + " ms" : "");
      var msg = errScrub(l.error || ("status " + l.status));
      var shortMsg = msg.replace(/\s+/g, " ").slice(0, 80);
      if (doc.issueNumber) {
        var comment = "Opnieuw gemeld vanuit Beheer.\n\n" + stats + (note ? "\n\n**Toelichting:** " + ghMd(note) : "") + "\n\n**Melding:**\n" + errFence(msg);
        return ghApi("POST", "/issues/" + doc.issueNumber + "/comments", { body: comment }).then(function () {
          return ghApi("PATCH", "/issues/" + doc.issueNumber, { state: "open" }).catch(function () {});
        }).then(function () {
          doc.lastReportedAt = new Date().toISOString(); doc.count = (doc.count || 1) + 1;
          return dbSetDoc(key, doc);
        }).then(function () {
          auditLog(req, "fout-naar-github", "#" + doc.issueNumber, { actie: l.action, opnieuw: true });
          sendJSON(res, 200, { issueNumber: doc.issueNumber, issueUrl: doc.issueUrl, reused: true });
        });
      }
      var bodyMd = [
        "> Fout uit de Balanza-app, met één knop doorgestuurd vanuit Beheer. Er staan geen namen, e-mailadressen, IP-adressen of gebruikers-id's in.",
        "",
        "**Soort:** " + ghMd(l.type || "—") + " · **Actie:** " + ghMd(l.action || "—") + " · **Status:** " + (l.status || "—") + "  ",
        stats,
        note ? "\n### Toelichting van de beheerder\n" + ghMd(note) : "",
        "",
        "### Melding",
        errFence(msg),
        "",
        "### Te doen",
        "- [ ] Oorzaak gevonden",
        "- [ ] Oplossing beoordeeld en live",
        "",
        "---",
        "<sub>Balanza-fout " + sig + "</sub>"
      ].join("\n");
      return ghApi("POST", "/issues", { title: "Fout: " + ghMd(l.action || l.type || "onbekend") + " – " + ghMd(shortMsg), body: bodyMd, labels: [GH_ERROR_LABEL, "nieuw"] }).then(function (iss) {
        doc.issueNumber = iss.number; doc.issueUrl = iss.html_url; doc.lastReportedAt = new Date().toISOString(); doc.count = 1; doc.title = shortMsg; doc.action = l.action;
        return dbSetDoc(key, doc).then(function () {
          auditLog(req, "fout-naar-github", "#" + iss.number, { actie: l.action });
          sendJSON(res, 200, { issueNumber: iss.number, issueUrl: iss.html_url, reused: false });
        });
      });
    }).catch(function (e) {
      if (e && e.status) throw e;
      throw HttpError(502, "github_error", "Het issue kon niet worden gemaakt: " + String(e && e.message || e).slice(0, 200));
    });
  });
}

// Beheer: lijst, detail, besluit (met bericht en melding naar de indiener) en verwijderen.
function handleAdminSuggestions(req, res, url) {
  var status = url.searchParams.get("status") || "";
  return dbListDocs("suggestions/").then(function (docs) {
    var all = docs.map(function (d) { return d.value; }).filter(Boolean);
    var counts = { all: all.length, new: 0, accepted: 0, rejected: 0 };
    all.forEach(function (v) { counts[v.status] = (counts[v.status] || 0) + 1; });
    var list = all.filter(function (v) { return !status || v.status === status; }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    sendJSON(res, 200, { suggestions: list.slice(0, 200), counts: counts, github: githubOn() ? { repo: GITHUB_REPO } : null });
    ghLiveCheck(false);
  });
}
function handleAdminSuggestionAction(req, res, id, action) {
  return dbGetDoc("suggestions/" + id).then(function (r) {
    var doc = r.exists && r.value ? r.value : null;
    if (!doc) throw HttpError(404, "not_found", "Dit voorstel bestaat niet (meer).");
    if (action === "delete") return dbDeleteDoc("suggestions/" + id).then(function () {
      auditLog(req, "suggestion-delete", id, { title: doc.title });
      if (githubOn() && doc.issueNumber) ghApi("PATCH", "/issues/" + doc.issueNumber, { state: "closed", state_reason: "not_planned" }).catch(function () {});
      sendJSON(res, 200, { ok: true });
    });
    if (action !== "accept" && action !== "reject" && action !== "reopen") throw HttpError(404, "not_found", "Onbekende actie.");
    return requireBody(req).then(function (body) {
      if (action === "reopen") { doc.status = "new"; doc.decidedAt = null; return dbSetDoc("suggestions/" + id, doc).then(function () { ghSyncDecision(doc, "Opnieuw in beoordeling."); sendJSON(res, 200, { suggestion: doc }); }); }
      var msg = cleanNote(body && body.message, 1200);
      if (!msg) throw HttpError(400, "bad_request", "Schrijf een bericht voor de indiener.");
      doc.status = action === "accept" ? "accepted" : "rejected"; doc.decidedAt = new Date().toISOString(); doc.decisionMessage = msg;
      return dbSetDoc("suggestions/" + id, doc).then(function () {
        auditLog(req, "suggestion-" + action, id, { title: doc.title });
        ghSyncDecision(doc, action === "accept" ? "Geaccepteerd: dit gaan we bouwen. Sluit dit issue als *voltooid* zodra het live staat; de indiener krijgt dan automatisch bericht." : "Afgewezen na beoordeling.");
        var title = action === "accept" ? "Je idee komt erin: " + doc.title : "Bedankt voor je idee: " + doc.title;
        return pushInbox(doc.uid, { kind: "suggestion", status: doc.status, title: title, text: msg }).then(function () {
          return notifyUser(doc.uid, { title: action === "accept" ? "Goed nieuws over je idee" : "Je idee is bekeken", body: "Over “" + doc.title + "”. Tik om de reactie te lezen.", url: "/?open=chat", tag: "balanza-inbox" }, notifyHost(), "suggestion-reply").catch(function () {});
        }).then(function () { sendJSON(res, 200, { suggestion: doc }); });
      });
    });
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
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

// Filmpjes en plaatjes voor de welkomstpagina (/media/...): met Range-ondersteuning, want Safari speelt een video
// alleen af als de server stukjes kan leveren (206). Een week in de cache van de browser.
function serveMedia(req, res, relativePath) {
  var safePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, "");
  var filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(path.join(PUBLIC_DIR, "media"))) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    var type = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    var base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=604800" };
    var m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (m && (m[1] || m[2])) {
      var start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
      var end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); res.end(); return; }
      res.writeHead(206, Object.assign(base, { "Content-Range": "bytes " + start + "-" + end + "/" + st.size, "Content-Length": end - start + 1 }));
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(filePath, { start: start, end: end }).pipe(res);
    }
    res.writeHead(200, Object.assign(base, { "Content-Length": st.size }));
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

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
  // Wie deed het: bij een beheersessie via de app het e-mailadres van die beheerder, anders "wachtwoord".
  try {
    var au = req && req.headers ? String(req.headers["authorization"] || "") : "", tk = au.indexOf("Bearer ") === 0 ? adminTokens.get(au.slice(7)) : null;
    if (tk) entry.by = tk.email || "wachtwoord";
  } catch (e) {}
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
// Het abonnement van een gebruiker zoals de beheerder het wil zien. Alleen lezen: anders dan getUserPlanInfo start
// dit nooit een proef, zodat het openen van de beheerpagina niets aan de gebruikers verandert.
// plan: "plus" | "trial" | "trial-wait" (proefmodel aan, account nog niet actief geweest) | "expired" | "free" | "anon"
function adminPlanState(doc, s, isAccount, now) {
  doc = doc || null;
  var out = { plan: "free", plusSource: null, trialEndsAt: null, status: doc ? doc.status || "none" : "none",
    interval: doc && doc.interval || null, priceCents: doc && doc.priceCents || null,
    recurring: !!(doc && doc.status === "active" && doc.subscriptionId), pastDue: !!(doc && doc.status === "past_due"),
    canceled: !!(doc && doc.status === "canceled"), grantUntil: doc && doc.grantUntil > now ? new Date(doc.grantUntil).toISOString() : null };
  if (!isAccount) { out.plan = "anon"; return out; }
  var gift = !!(doc && doc.grantUntil > now);
  var plusOk = plusActiveDoc(doc, now) && (billingLive(s) || (s.billing.trialEnabled && gift));
  if (plusOk) { out.plan = "plus"; out.plusSource = ["active", "canceled", "past_due"].indexOf(out.status) > -1 && doc.currentPeriodEnd + BILLING_GRACE_MS > now ? "abonnement" : "cadeau"; return out; }
  if (!s.billing.trialEnabled) return out;
  if (!doc || !doc.trialStart) { out.plan = "trial-wait"; return out; }
  var end = trialEndsAt(doc, s);
  out.trialEndsAt = end ? new Date(end).toISOString() : null;
  out.plan = end && now < end ? "trial" : "expired";
  return out;
}

// Bouwt het overzicht van één gebruiker (leest de documenten van die gebruiker).
function buildSummary(account, blocked, noteDoc, settings) {
  var uid = account.uid;
  return Promise.all([
    dbGetDoc("data/users/" + uid + "/prefs"), adminDataDoc(uid, "dishes"),
    adminDataDoc(uid, "plannedWeeks"), dbGetDoc("data/users/" + uid + "/meta"),
    dbGetDoc("billing/" + uid), householdOf(uid).catch(function () { return null; })
  ]).then(function (res) {
    var hh = res[5];
    var billing = adminPlanState(res[4].exists ? res[4].value : null, settings, !!account.email, Date.now());
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
      health: prefs ? healthWithExclude(prefs.health, prefs.exclude) : [],
      household: hh && hh.members && hh.members.length > 1 ? { size: hh.members.length, owner: hh.ownerUid === uid } : null,
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
      note: noteDoc && noteDoc.note ? noteDoc.note : "",
      plan: billing.plan, plusSource: billing.plusSource, trialEndsAt: billing.trialEndsAt, billingStatus: billing.status,
      interval: billing.interval, priceCents: billing.priceCents, recurring: billing.recurring, pastDue: billing.pastDue,
      canceled: billing.canceled, grantUntil: billing.grantUntil
    };
  });
}
// Het overzicht van iedereen; wordt 15 seconden onthouden zodat zoeken en bladeren de opslag niet belast.
function loadUserSummaries() {
  if (summariesCache.value && Date.now() < summariesCache.expiry) return Promise.resolve(summariesCache.value);
  return Promise.all([dbListUserIds(), getBlocked(), dbListDocs("adminMeta/"), getSettings()]).then(function (r) {
    var blocked = r[1], notes = {}, settings = r[3];
    r[2].forEach(function (d) { notes[d.path.slice("adminMeta/".length)] = d.value; });
    var accounts = r[0].filter(function (a) { return a && a.uid; });
    return mapLimit(accounts, 20, function (account) { return buildSummary(account, blocked, notes[account.uid], settings); });
  }).then(function (list) {
    summariesCache = { value: list, expiry: Date.now() + 15000 };
    return list;
  });
}
// Eén gebruiker, altijd vers (voor detail, wijzigen en acties).
function loadSummaryFresh(uid) {
  return Promise.all([dbListUserIds(), getBlocked(), dbGetDoc("adminMeta/" + uid), getSettings()]).then(function (r) {
    var account = r[0].filter(function (a) { return a && a.uid === uid; })[0];
    return account ? buildSummary(account, r[1], r[2].exists ? r[2].value : null, r[3]) : null;
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
  var goal = q.get("goal") || "", diet = q.get("diet") || "", health = q.get("health") || "", active = q.get("active") || "", created = q.get("created") || "", plan = q.get("plan") || "";
  var now = Date.now();
  function within(ts, days) { var t = ts ? Date.parse(ts) : NaN; return isFinite(t) && now - t <= days * DAY_MS; }
  return list.filter(function (u) {
    if (type === "account" && u.type !== "account") return false;
    if (type === "anon" && u.type !== "anon") return false;
    if (status === "active" && u.disabled) return false;
    if (status === "disabled" && !u.disabled) return false;
    if (goal && u.goal !== goal) return false;
    if (diet && u.dietStyle !== diet) return false;
    if (health && (u.health || []).indexOf(health) === -1) return false;
    if (active === "24h" && !within(u.lastSeenAt, 1)) return false;
    if (active === "7d" && !within(u.lastSeenAt, 7)) return false;
    if (active === "30d" && !within(u.lastSeenAt, 30)) return false;
    if (active === "inactive30" && within(u.lastSeenAt, 30)) return false;
    if (created === "7d" && !within(u.createdAt, 7)) return false;
    if (created === "30d" && !within(u.createdAt, 30)) return false;
    if (plan) {
      if (plan === "trial" && u.plan !== "trial" && u.plan !== "trial-wait") return false;
      if (plan === "ending" && !(u.plan === "trial" && u.trialEndsAt && Date.parse(u.trialEndsAt) - now <= 2 * DAY_MS)) return false;
      if (plan === "pastdue" && !u.pastDue) return false;
      if (["plus", "expired", "free", "anon"].indexOf(plan) > -1 && u.plan !== plan) return false;
    }
    if (text) {
      var hay = [u.email, u.name, u.uid, u.note, u.lastIp, u.goal, u.dietStyle].concat((u.health || []).map(function (k) { return HEALTH_LABELS[k] || k; })).join(" ").toLowerCase();
      if (hay.indexOf(text) === -1) return false;
    }
    return true;
  });
}
function sortUsers(rows, q) {
  var sort = q.get("sort") || "lastSeen";
  var textCols = { name: "name", email: "email" };
  var numCols = { dishes: "dishCount", weeks: "plannedWeekCount", logins: "loginCount" };
  var dateCols = { lastSeen: "lastSeenAt", created: "createdAt", lastLogin: "lastLoginAt", trialEnd: "trialEndsAt" };
  var dir = q.get("dir") || (textCols[sort] || sort === "trialEnd" ? "asc" : "desc");
  var mul = dir === "asc" ? 1 : -1;
  rows.sort(function (a, b) {
    var x, y;
    if (textCols[sort]) { x = String(a[textCols[sort]] || "").toLowerCase(); y = String(b[textCols[sort]] || "").toLowerCase(); if (!x && y) return 1; if (x && !y) return -1; return x < y ? -mul : x > y ? mul : 0; }
    if (numCols[sort]) { x = a[numCols[sort]] || 0; y = b[numCols[sort]] || 0; return (x - y) * mul; }
    var col = dateCols[sort] || "lastSeenAt";
    x = a[col] ? Date.parse(a[col]) : 0; y = b[col] ? Date.parse(b[col]) : 0;
    if (sort === "trialEnd" && (!x || !y) && x !== y) return x ? -1 : 1;   // zonder proefdatum altijd onderaan
    return (x - y) * mul;
  });
  return rows;
}

function planCounts(list) {
  var c = { plus: 0, trial: 0, expired: 0, free: 0, anon: 0, ending: 0, pastdue: 0 }, now = Date.now();
  list.forEach(function (u) {
    if (u.plan === "trial" || u.plan === "trial-wait") c.trial++; else if (c[u.plan] !== undefined) c[u.plan]++;
    if (u.plan === "trial" && u.trialEndsAt && Date.parse(u.trialEndsAt) - now <= 2 * DAY_MS) c.ending++;
    if (u.pastDue) c.pastdue++;
  });
  return c;
}
// Bedrijfscijfers voor het overzicht: de trechter proef → Plus, terugkerende omzet en wat aandacht vraagt.
var USD_TO_EUR = Number(process.env.USD_TO_EUR) > 0 ? Number(process.env.USD_TO_EUR) : 0.92;
function businessSummary(list, s) {
  var now = Date.now(), accounts = list.filter(function (u) { return u.type === "account" && !u.disabled; });
  var c = planCounts(accounts);
  var paid = accounts.filter(function (u) { return u.plan === "plus" && u.plusSource === "abonnement"; });
  var gift = accounts.filter(function (u) { return u.plan === "plus" && u.plusSource === "cadeau"; });
  var mrr = 0, monthly = 0, yearly = 0;
  accounts.forEach(function (u) {
    if (!u.recurring || !u.priceCents) return;
    if (u.interval === "year") { yearly++; mrr += u.priceCents / 12; } else { monthly++; mrr += u.priceCents; }
  });
  var decided = paid.length + c.expired;   // accounts waarvan de proef voorbij is: werden ze Plus of niet
  function brief(u) { return { uid: u.uid, email: u.email, name: u.name, trialEndsAt: u.trialEndsAt, lastSeenAt: u.lastSeenAt }; }
  return {
    trialEnabled: !!s.billing.trialEnabled, billingEnabled: !!s.billing.enabled, billingLive: billingLive(s), usdToEur: USD_TO_EUR,
    funnel: { accounts: accounts.length, trialWait: accounts.filter(function (u) { return u.plan === "trial-wait"; }).length,
      trial: accounts.filter(function (u) { return u.plan === "trial"; }).length, expired: c.expired, free: c.free,
      plusPaid: paid.length, plusGift: gift.length, canceled: paid.filter(function (u) { return u.canceled; }).length,
      conversionPct: decided ? Math.round(paid.length / decided * 1000) / 10 : null },
    mrrCents: Math.round(mrr), subscriptions: { monthly: monthly, yearly: yearly },
    endingSoon: accounts.filter(function (u) { return u.plan === "trial" && u.trialEndsAt && Date.parse(u.trialEndsAt) - now <= 2 * DAY_MS; })
      .sort(function (a, b) { return Date.parse(a.trialEndsAt) - Date.parse(b.trialEndsAt); }).slice(0, 8).map(brief),
    pastDue: accounts.filter(function (u) { return u.pastDue; }).slice(0, 8).map(brief),
    pastDueCount: c.pastdue, endingCount: c.ending
  };
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
          disabled: list.filter(function (u) { return u.disabled; }).length,
          plans: planCounts(list)
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
      case "health":
        if (!Array.isArray(v) || v.some(function (x) { return HEALTH_KEYS.indexOf(x) === -1; })) errors.push("Onbekende gezondheidsvoorkeur."); else clean.health = cleanHealth(v);
        break;
      case "ageGroup":
        if (["", "16-17", "18-25", "26-40", "41+"].indexOf(v) === -1) errors.push("Onbekende leeftijdsgroep."); else clean.ageGroup = v;
        break;
      case "student":
        if (!v || typeof v !== "object" || Array.isArray(v)) errors.push("Budgetmodus moet een object zijn.");
        else clean.student = { on: v.on === true, budget: STUDENT_BUDGETS.indexOf(Number(v.budget)) > -1 ? Number(v.budget) : 35, onePan: v.onePan === true, quick: v.quick !== false };
        break;
      case "voiceName": case "voiceStyle": break;
      case "proteinOut":
        if (!Array.isArray(v) || v.some(function (x) { return PROTEIN_KEYS.indexOf(x) === -1; })) errors.push("Onbekende soort vlees, gevogelte of vis."); else clean.proteinOut = cleanProteinOut(v, "");
        break;   // voorlezen is verwijderd; oude waarden negeren
      case "coach":
        if (!v || typeof v !== "object" || Array.isArray(v)) errors.push("Begeleiding moet een object zijn.");
        else { clean.coach = {}; Object.keys(v).slice(0, 20).forEach(function (k) { if (/^[a-zA-Z]{2,20}$/.test(k) && typeof v[k] === "boolean") clean.coach[k] = v[k]; }); }
        break;
      case "leftovers":
        if (!Array.isArray(v) || v.length > 20) errors.push("Restjes moet een lijst van maximaal 20 items zijn.");
        else clean.leftovers = v.filter(function (x) { return x && typeof x.t === "string" && x.t.trim(); }).map(function (x) { return { t: cleanText(x.t, 40), at: /^\d{4}-\d{2}-\d{2}$/.test(x.at) ? x.at : todayKey() }; });
        break;
      case "cheeseMode":
        if (v !== "hardekaas" && v !== "geen") errors.push("Kaaskeuze moet hardekaas of geen zijn."); else clean.cheeseMode = v;
        break;
      case "sugarMode":
        if (v !== "natuurlijk" && v !== "strikt") errors.push("Suikerkeuze moet natuurlijk of strikt zijn."); else clean.sugarMode = v;
        break;
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

// Gerechten en planning van een huishouden staan bij degene die het huishouden startte; de admin leest ze daar.
function adminDataDoc(uid, sub) {
  return dataOwnerUid(uid, sub).then(function (owner) {
    return dbGetDoc("data/users/" + owner + "/" + sub).then(function (r) { r.owner = owner; return r; });
  });
}
function handleAdminUserDetail(req, res, uid) {
  return needSummary(uid).then(function (user) {
    return Promise.all([
      dbGetDoc("data/users/" + uid + "/prefs"), adminDataDoc(uid, "dishes"), adminDataDoc(uid, "plannedWeeks"),
      listsOfUser(uid), getRecentLogs(LOG_CAP), withLocation(user), quotaState(uid), getBillingDoc(uid), dbGetDoc("consent/" + uid), getAdminUids()
    ]).then(function (r) {
      var logs = r[4].filter(function (l) { return l.uid === uid; }).slice(0, 50).map(cleanLogRow);
      var q = r[6];
      sendJSON(res, 200, {
        billing: adminBillingView(r[7]),
        quota: q ? { plan: q.plan, month: q.doc.month, dishes: q.doc.dishes, calls: q.doc.calls, tokensIn: q.doc.tokensIn, tokensOut: q.doc.tokensOut, costUsd: q.doc.costUsd, cap: q.cap, own: q.own } : null,
        user: r[5],
        prefs: r[0].exists ? r[0].value : null,
        dishes: r[1].exists ? r[1].value : null,
        dishesOwner: r[1].owner !== uid ? r[1].owner : null,
        consent: r[8].exists && r[8].value ? { version: r[8].value.version, at: r[8].value.at, health: !!r[8].value.health } : null,
        appAdmin: !!(r[9] && r[9][uid]),   // gedeeld huishouden: de gerechten staan bij deze gebruiker
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
  }).then(function () { return removeFromHousehold(uid); }).then(function () { return deleteCommunityOf(uid); }).then(function () { return dbGetDoc("listsIndex/" + uid); }).then(function (r) {
    var tokens = r.exists && r.value && Array.isArray(r.value.tokens) ? r.value.tokens : [];
    return Promise.all(tokens.map(function (t) { return dbDeleteDoc("lists/" + t); }));
  }).then(function () {
    var paths = ["data/users/" + uid + "/prefs", "data/users/" + uid + "/dishes", "data/users/" + uid + "/plannedWeeks", "data/users/" + uid + "/meta", "listsIndex/" + uid, "adminMeta/" + uid, "push/" + uid, "quota/" + uid, "billing/" + uid, "notify/" + uid, "inbox/" + uid, "assistant/" + uid];
    if (user.email) paths.push("auth/users/" + user.email);
    paths.push("consent/" + uid, "autoplan/" + uid, "notify/" + uid, "inbox/" + uid, "assistant/" + uid);
    setAppAdmin(uid, null, false).catch(function () {});   // geen beheerder meer
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
        case "admin-grant":
          if (!user.email) throw HttpError(400, "bad_request", "Alleen gebruikers met een account (e-mailadres) kunnen beheerder worden.");
          return setAppAdmin(uid, user.email, true).then(function () {
            auditLog(req, "gebruiker.beheerder-maken", uid, { email: user.email });
            sendJSON(res, 200, { appAdmin: true });
          });
        case "admin-revoke":
          return setAppAdmin(uid, user.email, false).then(function () {
            auditLog(req, "gebruiker.beheerder-intrekken", uid, { email: user.email });
            sendJSON(res, 200, { appAdmin: false });
          });
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
          dropAdminTokensOf(uid);   // een geblokkeerde gebruiker heeft ook geen beheertoegang meer
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
  if (!o.ok) o.sig = errSignature(o);
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
  return Promise.all([loadUserSummaries(), getUsageToday(), getUsageHistory(14), getRecentLogs(LOG_CAP), dbListDocs("lists/"), getSettings(), dbListDocs("tokenUsage/"),
    communityAll().catch(function () { return []; }), dbListDocs("push/").catch(function () { return []; }), dbListDocs("suggestions/").catch(function () { return []; })]).then(function (r) {
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
        recentErrors: ai.filter(function (l) { return !l.ok; }).sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); }).slice(0, 8).map(cleanLogRow)
      },
      auth: {
        loginsToday: authToday.filter(function (l) { return l.action === "login" && l.ok; }).length,
        failedLoginsToday: authToday.filter(function (l) { return l.action === "login" && !l.ok; }).length,
        registrationsToday: authToday.filter(function (l) { return (l.action === "register" || l.action === "upgrade") && l.ok; }).length
      },
      lists: { total: lists.length, active: lists.filter(function (d) { return !(d.value && d.value.expiresAt && d.value.expiresAt < now); }).length },
      logCapped: logs.length >= LOG_CAP,
      maintenance: r[5].maintenance.enabled,
      business: businessSummary(users, r[5]),
      notify: (function () {
        var week = logs.filter(function (l) { return l.type === "push" && l.ts && now - Date.parse(l.ts) <= 7 * DAY_MS; });
        var by = {}; week.forEach(function (l) { var k = l.action || "notify"; by[k] = by[k] || { sent: 0, failed: 0 }; if (l.ok) by[k].sent++; else by[k].failed++; });
        return { usersWithPush: r[8].filter(function (d) { return d.value && Array.isArray(d.value.subs) && d.value.subs.length; }).length, last7d: by,
          lastTickAt: notifyStats.lastTickAt, lastTickSource: notifyStats.lastTickSource, cronConfigured: CRON_SECRET.length >= 16 };
      })(),
      community: { reported: r[7].filter(function (x) { return (x.reports || []).length && !x.hidden; }).length, hidden: r[7].filter(function (x) { return x.hidden; }).length },
      suggestions: { new: r[9].filter(function (d) { return d.value && d.value.status === "new"; }).length }
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
      { key: "privacy", label: "Privacyverklaring (bedrijfsnaam en e-mail)", ok: !!(both.settings.privacy.company && both.settings.privacy.email),
        detail: both.settings.privacy.company && both.settings.privacy.email ? "ingevuld · versie " + both.settings.privacy.version : "nog niet ingevuld: vul ze in bij Instellingen > Privacy, anders staat er een placeholder op /privacy" },
      { key: "anthropic", label: "AI-sleutel (ANTHROPIC_API_KEY)", ok: !!ANTHROPIC_API_KEY, detail: ANTHROPIC_API_KEY ? "ingesteld" : "niet ingesteld: genereren werkt niet" },
      { key: "adminPassword", label: "Beheerderswachtwoord", ok: ADMIN_PASSWORD.length >= 12, detail: ADMIN_PASSWORD.length >= 12 ? "sterk genoeg" : "korter dan 12 tekens: kies een langer wachtwoord (ADMIN_PASSWORD)" },
      { key: "sessionSecret", label: "Sessiegeheim (SESSION_SECRET)", ok: !!process.env.SESSION_SECRET, detail: process.env.SESSION_SECRET ? "vast ingesteld" : "niet ingesteld: iedereen wordt uitgelogd bij een herstart" },
      { key: "unsplash", label: "Foto's (UNSPLASH_ACCESS_KEY)", ok: !!UNSPLASH_ACCESS_KEY, optional: true, detail: UNSPLASH_ACCESS_KEY ? "ingesteld" : "niet ingesteld: gerechten krijgen geen foto" },
      { key: "notifyCron", label: "Externe cron voor meldingen", ok: CRON_SECRET.length >= 16, optional: true,
        detail: (CRON_SECRET.length >= 16 ? "CRON_SECRET is ingesteld: een cron kan POST /api/cron/notify aanroepen." : "niet ingesteld; alleen nodig als de server kan slapen (zet CRON_SECRET, minstens 16 tekens, en laat elke 5 à 15 minuten POST /api/cron/notify aanroepen).") +
          (notifyStats.lastTickAt ? " Laatste ronde: " + notifyStats.lastTickAt.replace("T", " ").slice(0, 16) + " UTC via " + (notifyStats.lastTickSource === "cron" ? "cron" : "de server") + "." : "") },
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
    prefOptions: { goals: Object.keys(GOAL_TARGETS), diets: TIP_DIETS, mealTypes: PREF_MEALTYPES,
      health: HEALTH_KEYS.map(function (k) { return [k, HEALTH_LABELS[k]]; }),
      proteins: PROTEIN_KEYS.map(function (k) { return [k, PROTEIN_LABEL[k]]; }),
      sugarModes: [["natuurlijk", "Natuurlijke zoetmiddelen met mate"], ["strikt", "Alleen fruit en dadels"]],
      cheeseModes: [["hardekaas", "Harde kaas mag met mate"], ["geen", "Helemaal geen kaas"]] } };
}
function diffSettings(cur, next) {
  var out = [];
  if (cur.authRequired !== next.authRequired) out.push({ sleutel: "authRequired", van: cur.authRequired, naar: next.authRequired });
  ["modules", "planOnly", "limits", "maintenance", "announcement", "billing", "privacy", "news"].forEach(function (k) {
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
  if (method === "POST" && p === "/api/admin/sso") return handleAdminSsoStart(req, res);
  if (method === "POST" && p === "/api/admin/sso/exchange") return handleAdminSsoExchange(req, res);
  if (!requireAdmin(req, res)) return;
  var run = null;
  if (method === "GET" && p === "/api/admin/me") run = function () {
    var tk = (req.headers["authorization"] || "").slice(7), au = adminTokenUid(tk);
    if (!au) return sendJSON(res, 200, { ok: true, via: "password" });
    return getAdminUids().then(function (a) { sendJSON(res, 200, { ok: true, via: "app", email: a[au] ? a[au].email : null }); });
  };
  else if (method === "GET" && p === "/api/admin/admins") run = function () {
    return getAdminUids().then(function (a) { sendJSON(res, 200, { admins: Object.keys(a).map(function (u) { return { uid: u, email: a[u].email, grantedAt: a[u].grantedAt }; }) }); });
  };
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
  else if (method === "GET" && p === "/api/admin/offnl") run = function () { sendJSON(res, 200, { status: offnl.status, count: offnl.count, at: offnl.at, source: OFFNL_DUMP_URL }); };
  else if (method === "POST" && p === "/api/admin/offnl") run = function () { var started = offnl.status.state !== "bezig"; if (started) offnlImport(); sendJSON(res, 202, { started: started, status: offnl.status }); };
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
  else if (method === "GET" && p === "/api/admin/community") run = function () { return handleAdminCommunity(req, res, url); };
  else if (method === "GET" && p === "/api/admin/news") run = function () { return handleAdminNews(req, res, false); };
  else if (method === "POST" && p === "/api/admin/news/refresh") run = function () { return handleAdminNews(req, res, true); };
  else if (method === "GET" && p === "/api/admin/dishes") run = function () { return handleAdminDishes(req, res, url); };
  else if (method === "GET" && p === "/api/admin/dish") run = function () { return handleAdminDishDetail(req, res, url); };
  else if ((m = p.match(/^\/api\/admin\/community\/([A-Za-z0-9_-]{6,30})(?:\/([a-z-]+))?$/))) {
    var cid = m[1], cact = m[2];
    if (!cact && method === "GET") run = function () { return handleAdminCommunityDetail(req, res, cid); };
    else if (cact && method === "POST") run = function () { return handleAdminCommunityAction(req, res, cid, cact); };
  }
  else if (method === "GET" && p === "/api/admin/suggestions") run = function () { return handleAdminSuggestions(req, res, url); };
  else if (method === "POST" && p === "/api/admin/suggestions/sync") run = function () { return ghLiveCheck(true).then(function () { sendJSON(res, 200, { ok: true }); }); };
  else if ((m = p.match(/^\/api\/admin\/suggestions\/([a-f0-9]{16})\/(accept|reject|reopen|delete)$/)) && method === "POST") { var sid = m[1], sact = m[2]; run = function () { return handleAdminSuggestionAction(req, res, sid, sact); }; }
  else if (method === "GET" && p === "/api/admin/lists") run = function () { return handleAdminLists(req, res, url); };
  else if (method === "GET" && p === "/api/admin/errors/issues") run = function () { return handleAdminErrorIssues(req, res); };
  else if (method === "POST" && p === "/api/admin/errors/issue") run = function () { return handleAdminErrorToIssue(req, res); };
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

// ---------- Community: recepten met elkaar delen ----------
// Een gepubliceerd recept is een kopie (community/r/<id>): de eigenaar kan zijn eigen gerecht daarna gewoon aanpassen
// of verwijderen zonder dat de community-versie meeverandert. Opnieuw delen werkt de community-versie bij.
// Moderatie: recepten staan direct online; iedereen kan melden. Bij COMMUNITY_HIDE_REPORTS meldingen van verschillende
// gebruikers verdwijnt een recept vanzelf tot de beheerder ernaar kijkt. De beheerder kan verbergen, verwijderen en
// iemand blokkeren voor publiceren.
var COMMUNITY_PREFIX = "community/r/";
var COMMUNITY_HIDE_REPORTS = 3;
var COMMUNITY_MEALTYPES = ["Ontbijt", "Lunch", "Diner", "Snack"];
var communityPublishLimiter = makeHourlyLimiter(20), communityActLimiter = makeHourlyLimiter(600);
var communityCache = { at: 0, rows: null };
var communityLocks = new Map();
function withCommunityLock(id, fn) {
  var prev = communityLocks.get(id) || Promise.resolve();
  var next = prev.then(fn, fn);
  var tail = next.then(function () {}, function () {});
  communityLocks.set(id, tail);
  tail.then(function () { if (communityLocks.get(id) === tail) communityLocks.delete(id); });
  return next;
}
function communityInvalidate() { communityCache = { at: 0, rows: null }; }
function communityAll() {
  if (communityCache.rows && Date.now() - communityCache.at < 15000) return Promise.resolve(communityCache.rows);
  return dbListDocs(COMMUNITY_PREFIX).then(function (docs) {
    var rows = docs.filter(function (d) { return d.value && d.value.dish; }).map(function (d) { return d.value; });
    communityCache = { at: Date.now(), rows: rows };
    return rows;
  });
}
function cleanCommunityDish(d) {
  if (!d || typeof d !== "object") return null;
  var name = cleanText(d.name, 120);
  var ingr = Array.isArray(d.ingredienten) ? d.ingredienten.map(function (x) { return cleanText(x, 200); }).filter(Boolean).slice(0, 40) : [];
  var steps = Array.isArray(d.steps) ? d.steps.map(function (s) {
    if (!s || typeof s !== "object") return null;
    var st = { title: cleanText(s.title, 80) || "Stap", content: cleanNote(s.content, 1500) };
    var t = Number(s.timer); if (isFinite(t) && t > 0 && t <= 6 * 3600) st.timer = Math.round(t);
    return st.content ? st : null;
  }).filter(Boolean).slice(0, 30) : [];
  if (!name || ingr.length < 2 || !steps.length) return null;
  function num(v, max) { var n = Number(v); return isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10) / 10 : 0; }
  var credit = d.imageCredit && typeof d.imageCredit === "object" ? { name: cleanText(d.imageCredit.name, 80), link: /^https:\/\//.test(String(d.imageCredit.link || "")) ? String(d.imageCredit.link).slice(0, 300) : "" } : null;
  return {
    name: name, mealType: COMMUNITY_MEALTYPES.indexOf(d.mealType) > -1 ? d.mealType : "Diner",
    kcal: num(d.kcal, 5000), kh: num(d.kh, 100), eiwit: num(d.eiwit, 100), vet: num(d.vet, 100),
    khG: num(d.khG, 1000), eiwitG: num(d.eiwitG, 1000), vetG: num(d.vetG, 1000), balans: num(d.balans, 100),
    bereidingstijd: num(d.bereidingstijd, 600), benodigdheden: cleanText(d.benodigdheden, 300),
    ingredienten: ingr, steps: steps, fotoZoekterm: cleanText(d.fotoZoekterm, 80),
    imageUrl: /^https:\/\/images\.unsplash\.com\//.test(String(d.imageUrl || "")) ? String(d.imageUrl).slice(0, 500) : "",
    imageCredit: credit && credit.name ? credit : null,
    macroBron: d.macroBron === "nevo" ? "nevo" : "schatting",
    goal: cleanText(d.goal, 60), dietStyle: cleanText(d.dietStyle, 40)
  };
}
function communitySummary(r, uid) {
  return {
    id: r.id, name: r.dish.name, mealType: r.dish.mealType, kcal: r.dish.kcal, eiwitG: r.dish.eiwitG, balans: r.dish.balans,
    bereidingstijd: r.dish.bereidingstijd, imageUrl: r.dish.imageUrl || "", fotoZoekterm: r.dish.fotoZoekterm || "",
    dietStyle: r.dish.dietStyle || "", goal: r.dish.goal || "", macroBron: r.dish.macroBron,
    authorName: r.authorName || "Balanza-kok", likes: r.likeCount || 0, saves: r.saveCount || 0,
    liked: !!(uid && r.likes && r.likes[uid]), mine: !!(uid && r.ownerUid === uid), createdAt: new Date(r.createdAt).toISOString()
  };
}
function communityContext(req, res, needAccount) {
  if (!communityActLimiter(clientIp(req))) { sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken. Probeer het later opnieuw." }); return Promise.resolve(null); }
  return getSettings().then(function (s) {
    if (!effectiveModules(s).community) { sendJSON(res, 503, moduleOffBody("community", s)); return null; }
    return resolveUser(req).then(function (user) {
      if (!user) { sendUnauthorized(res); return null; }
      if (needAccount && !user.email) { sendJSON(res, 403, { code: "account_required", message: "Maak eerst een account aan om recepten te delen." }); return null; }
      return { user: user, settings: s };
    });
  });
}
function handleCommunityList(req, res, url) {
  return communityContext(req, res, false).then(function (ctx) {
    if (!ctx) return;
    var q = url.searchParams, uid = ctx.user.uid;
    var text = cleanText(q.get("q"), 80).toLowerCase(), type = q.get("type") || "", sort = q.get("sort") === "popular" ? "popular" : "new";
    var mine = q.get("mine") === "1", diet = cleanText(q.get("diet"), 40);
    var offset = Math.max(0, Math.min(10000, parseInt(q.get("offset"), 10) || 0)), limit = 20;
    return communityAll().then(function (rows) {
      var list = rows.filter(function (r) {
        if (mine) return r.ownerUid === uid;
        if (r.hidden && r.ownerUid !== uid) return false;
        if (type && r.dish.mealType !== type) return false;
        if (diet && r.dish.dietStyle !== diet) return false;
        if (text && (r.dish.name + " " + r.dish.ingredienten.join(" ") + " " + (r.authorName || "")).toLowerCase().indexOf(text) === -1) return false;
        return true;
      });
      var now = Date.now();
      function score(r) { var ageDays = (now - r.createdAt) / DAY_MS; return ((r.likeCount || 0) * 2 + (r.saveCount || 0) * 3 + 1) / Math.pow(ageDays + 2, 0.8); }
      list.sort(sort === "popular" ? function (a, b) { return score(b) - score(a); } : function (a, b) { return b.createdAt - a.createdAt; });
      sendJSON(res, 200, { items: list.slice(offset, offset + limit).map(function (r) { var s = communitySummary(r, uid); s.hidden = !!r.hidden; return s; }), total: list.length, offset: offset, limit: limit });
    });
  }).catch(function () { sendJSON(res, 500, { code: "error", message: "De community kon niet worden geladen." }); });
}
function handleCommunityGet(req, res, id) {
  return communityContext(req, res, false).then(function (ctx) {
    if (!ctx) return;
    return dbGetDoc(COMMUNITY_PREFIX + id).then(function (r) {
      var rec = r.exists ? r.value : null;
      if (!rec || (rec.hidden && rec.ownerUid !== ctx.user.uid)) return sendJSON(res, 404, { code: "not_found", message: "Dit recept staat niet (meer) in de community." });
      var out = communitySummary(rec, ctx.user.uid);
      out.dish = rec.dish; out.hidden = !!rec.hidden;
      out.reported = !!(rec.reports || []).some(function (x) { return x.uid === ctx.user.uid; });
      sendJSON(res, 200, out);
    });
  }).catch(function () { sendJSON(res, 500, { code: "error", message: "Dit recept kon niet worden geladen." }); });
}
function handleCommunityPublish(req, res) {
  return communityContext(req, res, true).then(function (ctx) {
    if (!ctx) return;
    var uid = ctx.user.uid;
    if (!communityPublishLimiter(uid)) return sendJSON(res, 429, { code: "rate_limited", message: "Je hebt het afgelopen uur al veel recepten gedeeld. Probeer het later opnieuw." });
    return Promise.all([readBody(req), dbGetDoc("adminMeta/" + uid)]).then(function (r) {
      var body = r[0] || {}, meta = r[1].exists ? r[1].value : null;
      if (meta && meta.communityBlocked) return sendJSON(res, 403, { code: "blocked", message: "Je kunt op dit moment geen recepten delen in de community." });
      var dish = cleanCommunityDish(body.dish);
      if (!dish) return sendJSON(res, 400, { code: "bad_request", message: "Dit gerecht mist een naam, ingrediënten of bereiding en kan niet worden gedeeld." });
      var author = cleanText(body.authorName, 30) || "Balanza-kok";
      var sourceId = cleanText(body.sourceDishId, 80);
      return communityAll().then(function (rows) {
        var existing = sourceId ? rows.filter(function (x) { return x.ownerUid === uid && x.sourceDishId === sourceId; })[0] : null;
        var id = existing ? existing.id : crypto.randomBytes(9).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
        return withCommunityLock(id, function () {
          return dbGetDoc(COMMUNITY_PREFIX + id).then(function (cur) {
            var now = Date.now(), base = cur.exists && cur.value ? cur.value : { id: id, ownerUid: uid, createdAt: now, likes: {}, likeCount: 0, saves: {}, saveCount: 0, reports: [] };
            if (base.ownerUid !== uid) throw HttpError(403, "forbidden", "Dit is niet jouw recept.");
            base.dish = dish; base.authorName = author; base.sourceDishId = sourceId; base.updatedAt = now;
            return dbSetDoc(COMMUNITY_PREFIX + id, base).then(function () {
              communityInvalidate();
              logEvent("community", existing ? "update" : "publish", true, 200, { uid: uid, id: id, name: dish.name, ip: clientIp(req) });
              sendJSON(res, 200, { id: id, updated: !!existing });
            });
          });
        });
      });
    });
  }).catch(function (err) {
    if (res.headersSent) return;
    sendJSON(res, err && err.status ? err.status : 400, { code: err && err.code ? err.code : "bad_request", message: err && err.status ? err.message : "Delen is niet gelukt." });
  });
}
function handleCommunityAction(req, res, id, action) {
  return communityContext(req, res, action === "report" || action === "delete").then(function (ctx) {
    if (!ctx) return;
    var uid = ctx.user.uid;
    return readBody(req).catch(function () { return {}; }).then(function (body) {
      return withCommunityLock(id, function () {
        return dbGetDoc(COMMUNITY_PREFIX + id).then(function (r) {
          var rec = r.exists ? r.value : null;
          if (!rec) throw HttpError(404, "not_found", "Dit recept staat niet (meer) in de community.");
          if (action === "delete") {
            if (rec.ownerUid !== uid) throw HttpError(403, "forbidden", "Alleen wie het recept deelde, kan het verwijderen.");
            return dbDeleteDoc(COMMUNITY_PREFIX + id).then(function () { communityInvalidate(); sendJSON(res, 200, { ok: true }); });
          }
          if (rec.hidden && rec.ownerUid !== uid) throw HttpError(404, "not_found", "Dit recept staat niet (meer) in de community.");
          rec.likes = rec.likes || {}; rec.saves = rec.saves || {}; rec.reports = rec.reports || [];
          if (action === "like") {
            var on = body && typeof body.on === "boolean" ? body.on : !rec.likes[uid];
            if (on) rec.likes[uid] = 1; else delete rec.likes[uid];
            rec.likeCount = Object.keys(rec.likes).length;
          } else if (action === "saved") {
            rec.saves[uid] = 1; rec.saveCount = Object.keys(rec.saves).length;
          } else if (action === "report") {
            if (rec.ownerUid === uid) throw HttpError(400, "bad_request", "Je kunt je eigen recept niet melden.");
            if (!rec.reports.some(function (x) { return x.uid === uid; })) {
              rec.reports.push({ uid: uid, reason: cleanText(body && body.reason, 300), at: Date.now() });
              if (rec.reports.length >= COMMUNITY_HIDE_REPORTS && !rec.reviewedAt) rec.hidden = true;
              logEvent("community", "report", true, 200, { uid: uid, id: id, name: rec.dish.name, ip: clientIp(req) });
            }
          } else throw HttpError(404, "not_found", "Onbekende actie.");
          return dbSetDoc(COMMUNITY_PREFIX + id, rec).then(function () {
            communityInvalidate();
            sendJSON(res, 200, communitySummary(rec, uid));
          });
        });
      });
    });
  }).catch(function (err) {
    if (res.headersSent) return;
    sendJSON(res, err && err.status ? err.status : 500, { code: err && err.code ? err.code : "error", message: err && err.status ? err.message : "Er ging iets mis." });
  });
}
function deleteCommunityOf(uid) {
  return dbListDocs(COMMUNITY_PREFIX).then(function (docs) {
    return Promise.all(docs.filter(function (d) { return d.value && d.value.ownerUid === uid; }).map(function (d) { return dbDeleteDoc(d.path); }));
  }).then(communityInvalidate).catch(function () {});
}
// Beheer
function handleAdminCommunity(req, res, url) {
  var q = url.searchParams;
  return Promise.all([communityAll(), loadUserSummaries()]).then(function (r) {
    var owners = {};
    r[1].forEach(function (u) { owners[u.uid] = u; });
    var text = (q.get("q") || "").trim().toLowerCase(), status = q.get("status") || "";
    var rows = r[0].map(function (rec) {
      var o = owners[rec.ownerUid] || {};
      return { id: rec.id, name: rec.dish.name, mealType: rec.dish.mealType, kcal: rec.dish.kcal, authorName: rec.authorName, ownerUid: rec.ownerUid, ownerEmail: o.email || null,
        likes: rec.likeCount || 0, saves: rec.saveCount || 0, reports: (rec.reports || []).length, hidden: !!rec.hidden,
        createdAt: new Date(rec.createdAt).toISOString(), updatedAt: new Date(rec.updatedAt || rec.createdAt).toISOString() };
    }).filter(function (x) {
      if (status === "reported" && !x.reports) return false;
      if (status === "hidden" && !x.hidden) return false;
      if (text && [x.name, x.authorName, x.ownerEmail, x.ownerUid, x.id].join(" ").toLowerCase().indexOf(text) === -1) return false;
      return true;
    });
    rows.sort(function (a, b) { return (b.reports - a.reports) || (Date.parse(b.createdAt) - Date.parse(a.createdAt)); });
    var pg = paginate(rows, q, 25);
    sendJSON(res, 200, { recipes: pg.rows, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages,
      reportedCount: r[0].filter(function (x) { return (x.reports || []).length; }).length, hiddenCount: r[0].filter(function (x) { return x.hidden; }).length });
  });
}
// ---- Gerechten van alle gebruikers (alleen lezen) ----
function dishCreatedAt(d) {
  var m = /^gen(\d{12,14})_/.exec(String(d && d.id || ""));
  if (m) return new Date(Number(m[1])).toISOString();
  return d && d.createdAt ? String(d.createdAt) : null;
}
function dishSource(d) {
  if (d.vanFoto) return "foto";
  if (d.fromCommunity) return "community";
  if (/^gen/.test(String(d.id || ""))) return "gegenereerd";
  return "eigen";
}
function adminDishRow(d, mealType, owner) {
  return { id: String(d.id || ""), name: String(d.name || "Naamloos"), mealType: d.mealType || mealType, kcal: Math.round(Number(d.kcal) || 0),
    kh: Number(d.kh) || 0, eiwit: Number(d.eiwit) || 0, vet: Number(d.vet) || 0, balans: Number(d.balans) || 0,
    rating: d.rating === 1 ? 1 : d.rating === -1 ? -1 : 0, source: dishSource(d), createdAt: dishCreatedAt(d),
    ownerUid: owner.uid, ownerName: owner.name || null, ownerEmail: owner.email || null, members: owner.members || 1 };
}
function handleAdminDishes(req, res, url) {
  var q = url.searchParams;
  return loadUserSummaries().then(function (list) {
    var byUid = {};
    list.forEach(function (u) { byUid[u.uid] = u; });
    return mapLimit(list, 10, function (u) {
      return dbGetDoc("data/users/" + u.uid + "/dishes").then(function (r) { return { u: u, dishes: r.exists && r.value && typeof r.value === "object" ? r.value : null }; }, function () { return { u: u, dishes: null }; });
    }).then(function (docs) {
      var rows = [];
      docs.forEach(function (x) {
        if (!x.dishes) return;
        var owner = { uid: x.u.uid, name: x.u.name, email: x.u.email, members: x.u.household ? x.u.household.size : 1 };
        Object.keys(x.dishes).forEach(function (mt) {
          if (!Array.isArray(x.dishes[mt])) return;
          x.dishes[mt].forEach(function (d) { if (d && typeof d === "object") rows.push(adminDishRow(d, mt, owner)); });
        });
      });
      var weekAgo = Date.now() - 7 * DAY_MS;
      var totals = { all: rows.length, week: rows.filter(function (r) { return r.createdAt && Date.parse(r.createdAt) > weekAgo; }).length, byMeal: {}, bySource: {} };
      rows.forEach(function (r) { totals.byMeal[r.mealType] = (totals.byMeal[r.mealType] || 0) + 1; totals.bySource[r.source] = (totals.bySource[r.source] || 0) + 1; });
      var text = (q.get("q") || "").trim().toLowerCase(), meal = q.get("meal") || "", source = q.get("source") || "", sort = q.get("sort") || "new";
      rows = rows.filter(function (r) {
        if (meal && r.mealType !== meal) return false;
        if (source && r.source !== source) return false;
        if (text && [r.name, r.ownerName, r.ownerEmail, r.ownerUid].join(" ").toLowerCase().indexOf(text) === -1) return false;
        return true;
      });
      rows.sort(function (a, b) {
        if (sort === "balans") return b.balans - a.balans;
        if (sort === "balansLaag") return a.balans - b.balans;
        if (sort === "name") return a.name.localeCompare(b.name, "nl");
        return (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
      });
      var pg = paginate(rows, q, 25);
      sendJSON(res, 200, { dishes: pg.rows, total: pg.total, page: pg.page, pageSize: pg.pageSize, pages: pg.pages, totals: totals });
    });
  });
}
function handleAdminDishDetail(req, res, url) {
  var uid = url.searchParams.get("uid") || "", id = url.searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(uid) || !id) return sendJSON(res, 400, { code: "bad_request", message: "Onbekend gerecht." });
  return adminDataDoc(uid, "dishes").then(function (r) {
    var all = r.exists && r.value && typeof r.value === "object" ? r.value : {}, found = null;
    Object.keys(all).forEach(function (mt) { if (!found && Array.isArray(all[mt])) found = all[mt].filter(function (d) { return d && String(d.id) === id; })[0] || null; });
    if (!found) throw HttpError(404, "not_found", "Gerecht niet gevonden.");
    sendJSON(res, 200, { dish: found, ownerUid: r.owner });
  });
}
function handleAdminCommunityDetail(req, res, id) {
  return dbGetDoc(COMMUNITY_PREFIX + id).then(function (r) {
    if (!r.exists || !r.value) throw HttpError(404, "not_found", "Recept niet gevonden.");
    var rec = r.value;
    return dbGetDoc("adminMeta/" + rec.ownerUid).then(function (m) {
      sendJSON(res, 200, { id: rec.id, dish: rec.dish, authorName: rec.authorName, ownerUid: rec.ownerUid, hidden: !!rec.hidden, likes: rec.likeCount || 0, saves: rec.saveCount || 0,
        reports: (rec.reports || []).map(function (x) { return { uid: x.uid, reason: x.reason, at: new Date(x.at).toISOString() }; }),
        createdAt: new Date(rec.createdAt).toISOString(), authorBlocked: !!(m.exists && m.value && m.value.communityBlocked) });
    });
  });
}
function handleAdminCommunityAction(req, res, id, action) {
  return requireBody(req).then(function () {
    return withCommunityLock(id, function () {
      return dbGetDoc(COMMUNITY_PREFIX + id).then(function (r) {
        if (!r.exists || !r.value) throw HttpError(404, "not_found", "Recept niet gevonden.");
        var rec = r.value;
        if (action === "delete") return dbDeleteDoc(COMMUNITY_PREFIX + id).then(function () { auditLog(req, "community.verwijderen", rec.ownerUid, { id: id, naam: rec.dish.name }); return { ok: true }; });
        if (action === "hide" || action === "unhide") {
          rec.hidden = action === "hide"; rec.reviewedAt = Date.now();
          if (action === "unhide") rec.reports = [];
          return dbSetDoc(COMMUNITY_PREFIX + id, rec).then(function () { auditLog(req, "community." + (action === "hide" ? "verbergen" : "goedkeuren"), rec.ownerUid, { id: id, naam: rec.dish.name }); return { ok: true }; });
        }
        if (action === "block-author" || action === "unblock-author") {
          return dbGetDoc("adminMeta/" + rec.ownerUid).then(function (m) {
            var meta = m.exists && m.value ? m.value : {};
            meta.communityBlocked = action === "block-author";
            return dbSetDoc("adminMeta/" + rec.ownerUid, meta).then(function () { auditLog(req, "community." + (meta.communityBlocked ? "blokkeren" : "deblokkeren"), rec.ownerUid, { id: id }); return { ok: true }; });
          });
        }
        throw HttpError(404, "not_found", "Onbekende actie.");
      });
    });
  }).then(function (out) { communityInvalidate(); sendJSON(res, 200, out); });
}

function handleConfig(req, res) {
  getSettings().then(function (s) {
    sendJSON(res, 200, {
      authRequired: authRequiredFor(s),
      trial: s.billing.trialEnabled ? { days: s.billing.trialDays } : null,
      pricing: billingLive(s) ? { monthCents: s.billing.plusMonthlyCents, yearCents: s.billing.plusYearlyCents, plusDishCap: s.billing.plusDishCap, freeDishCap: s.limits.monthlyDishCap } : null,
      bringImportEndpoint: BRING_IMPORT_ENDPOINT,
      modules: effectiveModules(s),
      planOnly: s.planOnly,
      billing: billingLive(s),
      oauth: oauthConfig(),
      canonicalOrigin: canonicalOrigin(),
      legacyOrigins: canonicalOrigin() ? legacyOrigins() : [],
      maintenance: s.maintenance.enabled ? { enabled: true, message: s.maintenance.message || "De app is tijdelijk in onderhoud." } : { enabled: false },
      announcement: s.announcement.enabled && s.announcement.message ? { enabled: true, message: s.announcement.message, level: s.announcement.level } : { enabled: false },
      season: seasonInfo(),
      privacy: { version: s.privacy.version, updatedOn: s.privacy.updatedOn, company: s.privacy.company, address: s.privacy.address, kvk: s.privacy.kvk, email: s.privacy.email }
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
  if (url.pathname === "/api/community" && req.method === "GET") return handleCommunityList(req, res, url);
  if (url.pathname === "/api/community" && req.method === "POST") return handleCommunityPublish(req, res);
  var cm = url.pathname.match(/^\/api\/community\/([A-Za-z0-9_-]{6,30})(?:\/(like|saved|report|delete))?$/);
  if (cm && req.method === "GET" && !cm[2]) return handleCommunityGet(req, res, cm[1]);
  if (cm && req.method === "POST" && cm[2]) return handleCommunityAction(req, res, cm[1], cm[2]);
  if (req.method === "POST" && url.pathname === "/api/billing/checkout") return handleBillingCheckout(req, res);
  if (req.method === "POST" && url.pathname === "/api/billing/cancel") return handleBillingCancel(req, res);
  if (req.method === "POST" && url.pathname === "/api/billing/webhook") return handleBillingWebhook(req, res);
  if (req.method === "GET" && url.pathname === "/api/push/key") return handlePushKey(req, res);
  if (req.method === "POST" && url.pathname === "/api/push/subscribe") return handlePushSubscribe(req, res);
  if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") return handlePushUnsubscribe(req, res);
  if (req.method === "POST" && url.pathname === "/api/push/test") return handlePushTest(req, res);
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/notify/prefs") return handleNotifyPrefs(req, res);
  var hhMatch = url.pathname.match(/^\/api\/household(?:\/(invite|join|leave))?$/);
  if (hhMatch && ((req.method === "GET" && !hhMatch[1]) || (req.method === "POST" && hhMatch[1]))) return handleHousehold(req, res, hhMatch[1]);
  if (req.method === "POST" && url.pathname === "/api/cron/notify") return handleCronNotify(req, res);
  if (req.method === "POST" && url.pathname === "/api/tips") return handleTips(req, res);
  if (req.method === "POST" && url.pathname === "/api/assistant") return handleAssistant(req, res);
  if (req.method === "POST" && url.pathname === "/api/estimate") return handleEstimate(req, res);
  if (req.method === "POST" && url.pathname === "/api/nevo/calc") return handleNevoCalc(req, res);
  if (req.method === "GET" && url.pathname === "/api/foods/nutrients") return handleNutrientTable(req, res);
  if (req.method === "POST" && url.pathname === "/api/nutrients/ingredients") return handleNutrientsForIngredients(req, res);
  if (req.method === "GET" && url.pathname === "/api/news") return handleNews(req, res);
  if (req.method === "GET" && url.pathname === "/api/foods") return handleFoods(req, res);
  if (req.method === "GET" && url.pathname === "/api/foods/search") return handleFoodSearch(req, res, url);
  if (req.method === "GET" && url.pathname.indexOf("/api/foods/img/") === 0) return handleFoodImg(req, res, url.pathname.slice("/api/foods/img".length), url.searchParams.get("debug") === "1");
  var eanM = url.pathname.match(/^\/api\/foods\/barcode\/([0-9]{1,20})$/);
  if (req.method === "GET" && eanM) return handleFoodBarcode(req, res, eanM[1]);
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/autoplan") return handleAutoPlan(req, res);
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/suggestions") return handleSuggestions(req, res);
  if ((req.method === "GET" && url.pathname === "/api/inbox") || (req.method === "POST" && url.pathname === "/api/inbox/read")) return handleInbox(req, res);
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
  if (url.pathname === "/api/consent" && (req.method === "GET" || req.method === "POST")) return handleConsent(req, res);
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
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.indexOf("/media/") === 0) return serveMedia(req, res, url.pathname);
  if (req.method === "GET" && url.pathname === "/api/config") return handleConfig(req, res);
  if (url.pathname.indexOf("/api/admin/") === 0) return handleAdminApi(req, res, url);
  if (req.method === "GET" && url.pathname === "/admin") return serveFile(req, res, "admin.html");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return serveStatic(req, res);
  if (req.method === "GET" && url.pathname === "/welkom") return serveFile(req, res, "welkom.html");
  if (req.method === "GET" && (url.pathname === "/privacy" || url.pathname === "/privacy/")) return serveFile(req, res, "privacy.html");

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Vangnet: één fout in een verzoek mag niet de hele server laten crashen (dat gaf een 502 voor iedereen).
// De fout wordt gelogd met "[crash-vangnet]" zodat hij in de Render-logs te vinden is.
process.on("unhandledRejection", function (reason) {
  console.error("[crash-vangnet] onafgehandelde fout:", reason && reason.stack || reason);
});
process.on("uncaughtException", function (err) {
  console.error("[crash-vangnet] onverwachte fout:", err && err.stack || err);
});
setInterval(function () {
  var m = process.memoryUsage();
  if (m.rss > 380 * 1048576) console.warn("[geheugen] rss " + Math.round(m.rss / 1048576) + " MB, heap " + Math.round(m.heapUsed / 1048576) + " MB");
}, 60000).unref();
server.listen(PORT, function () {
  console.log("Weekmenu app draait op http://localhost:" + PORT);
  getSettings().catch(function () {});
  setTimeout(offnlEnsure, 20000); setInterval(offnlEnsure, 3600000);   // eigen kopie van de Nederlandse winkelproducten
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
