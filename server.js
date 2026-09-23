// Weekmenu app — standalone backend
// Zero external dependencies: only Node's built-in http, fs, path, crypto modules.
// Requires Node.js 18+ (uses the built-in global fetch).

const http = require("http");
const fs = require("fs");
const path = require("path");

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

function extractJson(text) {
  var cleaned = text.replace(/```json/gi, "```").trim();
  var fenceMatch = cleaned.match(/```([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try { return JSON.parse(cleaned); } catch (e) {}
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
  return JSON.parse(candidate);
}

// ---------- Routes ----------

function handleGenerate(req, res) {
  var ip = clientIp(req);
  if (!checkIpRateLimit(ip)) {
    return sendJSON(res, 429, { code: "rate_limited", message: "Te veel verzoeken vanaf dit adres. Probeer later opnieuw." });
  }

  var store = loadStore();
  var today = todayKey();
  var usedToday = store.usage[today] || 0;
  if (usedToday >= DAILY_GENERATE_CAP) {
    return sendJSON(res, 429, { code: "rate_limited", message: "De dagelijkse limiet voor het genereren van gerechten is bereikt. Probeer het morgen opnieuw." });
  }

  if (!ANTHROPIC_API_KEY) {
    return sendJSON(res, 500, { code: "not_configured", message: "Server heeft nog geen ANTHROPIC_API_KEY ingesteld." });
  }

  readBody(req).then(function (body) {
    var prompt = body && body.prompt;
    if (!prompt || typeof prompt !== "string") {
      return sendJSON(res, 400, { code: "bad_request", message: "Geen prompt meegegeven." });
    }

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
      var parsed;
      try {
        parsed = extractJson(textBlock.text);
      } catch (parseErr) {
        if (data.stop_reason === "max_tokens") {
          throw new Error("Antwoord werd afgekapt (te lang voor de ingestelde limiet). Probeer minder gerechten tegelijk te genereren, of verhoog max_tokens in server.js.");
        }
        throw parseErr;
      }

      store.usage[today] = usedToday + 1;
      saveStore(store);

      sendJSON(res, 200, { result: parsed });
    }).catch(function (err) {
      sendJSON(res, 502, { code: "error", message: "Genereren mislukt: " + err.message });
    });
  }).catch(function () {
    sendJSON(res, 400, { code: "bad_request", message: "Ongeldige aanvraag." });
  });
}

function handleDbGet(req, res, query) {
  var p = query.get("path");
  if (!p) return sendJSON(res, 400, { message: "path ontbreekt" });
  var store = loadStore();
  var exists = Object.prototype.hasOwnProperty.call(store.docs, p);
  sendJSON(res, 200, { exists: exists, value: exists ? store.docs[p] : null });
}

function handleDbSet(req, res) {
  readBody(req).then(function (body) {
    if (!body || !body.path) return sendJSON(res, 400, { message: "path ontbreekt" });
    var store = loadStore();
    store.docs[body.path] = body.value;
    saveStore(store);
    sendJSON(res, 200, { ok: true });
  }).catch(function () {
    sendJSON(res, 400, { message: "Ongeldige aanvraag." });
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
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function serveStatic(req, res) {
  var filePath = path.join(PUBLIC_DIR, "index.html");
  fs.readFile(filePath, function (err, content) {
    if (err) { res.writeHead(500); res.end("Kan index.html niet laden"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
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
});
