import { createServer } from "node:http";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHash,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Runtime, constants, publicSettings } from "./runtime.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.WEB_PORT || 8080);
const AUTH_FILE = join(constants.DATA_DIR, "auth.json");
const COOKIE_NAME = "dragonwilds_session";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const runtime = new Runtime();
const sessions = new Map();
const loginAttempts = new Map();
let localAuth = null;
const APP_VERSION = "0.1.11";
const BUILD_ID = `${APP_VERSION}-${Date.now().toString(36)}`;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
  });
  res.end(body);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionSignature(id) {
  const secret = SESSION_SECRET || localAuth?.sessionSecret || "temporary";
  return createHmac("sha256", secret).update(id).digest("base64url");
}

function createSession(res) {
  const id = randomBytes(32).toString("base64url");
  sessions.set(id, { expires: Date.now() + 12 * 60 * 60 * 1000 });
  const value = `${id}.${sessionSignature(id)}`;
  res.setHeader("set-cookie", `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
}

function clearSession(req, res) {
  const value = parseCookies(req)[COOKIE_NAME] || "";
  const id = value.split(".")[0];
  sessions.delete(id);
  res.setHeader("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function authenticated(req) {
  const value = parseCookies(req)[COOKIE_NAME] || "";
  const separator = value.lastIndexOf(".");
  if (separator < 1) return false;
  const id = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = sessionSignature(id);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  const session = sessions.get(id);
  if (!session || session.expires < Date.now()) {
    sessions.delete(id);
    return false;
  }
  session.expires = Date.now() + 12 * 60 * 60 * 1000;
  return true;
}

async function bodyJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Solicitud demasiado grande."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function canTryLogin(req) {
  const key = clientIp(req);
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 10 * 60 * 1000);
  if (recent.length >= 10) return false;
  recent.push(now);
  loginAttempts.set(key, recent);
  return true;
}

function recordLoginSuccess(req) {
  loginAttempts.delete(clientIp(req));
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return {
    salt,
    hash: pbkdf2Sync(password, salt, 210_000, 32, "sha256").toString("hex"),
  };
}

function passwordMatches(password) {
  if (ADMIN_PASSWORD) {
    const left = createHash("sha256").update(password).digest();
    const right = createHash("sha256").update(ADMIN_PASSWORD).digest();
    return timingSafeEqual(left, right);
  }
  if (!localAuth?.hash || !localAuth?.salt) return false;
  const candidate = hashPassword(password, localAuth.salt).hash;
  return candidate.length === localAuth.hash.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(localAuth.hash));
}

function mutationAllowed(req) {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  try {
    return new URL(origin).host === forwardedHost;
  } catch {
    return false;
  }
}

async function setupLocalAuth(password) {
  if (ADMIN_PASSWORD) throw new Error("Las credenciales son administradas por Umbrel.");
  if (localAuth?.hash) throw new Error("La contraseña inicial ya fue creada.");
  if (String(password).length < 12) throw new Error("Usa una contraseña de al menos 12 caracteres.");
  const result = hashPassword(String(password));
  localAuth = { ...result, sessionSecret: randomBytes(32).toString("hex") };
  await mkdir(dirname(AUTH_FILE), { recursive: true });
  await writeFile(AUTH_FILE, `${JSON.stringify(localAuth, null, 2)}\n`, { mode: 0o600 });
}

async function loadAuth() {
  if (ADMIN_PASSWORD) return;
  try {
    localAuth = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  } catch {
    localAuth = null;
  }
}

function requireAuth(req, res) {
  if (!authenticated(req)) {
    json(res, 401, { error: "Inicia sesión para continuar." });
    return false;
  }
  return true;
}

function requireMutation(req, res) {
  if (!mutationAllowed(req)) {
    json(res, 403, { error: "Origen de solicitud no permitido." });
    return false;
  }
  return true;
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    return json(res, 200, {
      authenticated: authenticated(req),
      needsLocalPassword: !ADMIN_PASSWORD && !localAuth?.hash,
      managedByUmbrel: Boolean(ADMIN_PASSWORD),
      configured: runtime.settings.configured,
      buildId: BUILD_ID,
      version: APP_VERSION,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/setup-password") {
    if (!requireMutation(req, res)) return;
    const input = await bodyJson(req);
    await setupLocalAuth(input.password);
    createSession(res);
    return json(res, 201, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    if (!requireMutation(req, res)) return;
    if (!canTryLogin(req)) return json(res, 429, { error: "Demasiados intentos. Espera unos minutos." });
    const input = await bodyJson(req);
    if (!passwordMatches(String(input.password || ""))) return json(res, 401, { error: "Contraseña incorrecta." });
    recordLoginSuccess(req);
    createSession(res);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    if (!requireMutation(req, res)) return;
    clearSession(req, res);
    return json(res, 200, { ok: true });
  }

  if (!requireAuth(req, res)) return;

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, await runtime.status());
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    return json(res, 200, publicSettings(runtime.settings));
  }
  if (req.method === "PUT" && url.pathname === "/api/settings") {
    if (!requireMutation(req, res)) return;
    const input = await bodyJson(req);
    const settings = await runtime.enqueue(async () => {
      const wasRunning = Boolean(runtime.child) || runtime.desiredRunning;
      if (wasRunning) await runtime.stop();
      const saved = await runtime.saveSettings(input);
      if (input.restart !== false && (wasRunning || runtime.settings.autoStart)) await runtime.start();
      else await runtime.applyVpn();
      return saved;
    });
    return json(res, 200, settings);
  }
  if (req.method === "GET" && url.pathname === "/api/backups") {
    return json(res, 200, await runtime.listBackups());
  }
  if (req.method === "GET" && url.pathname === "/api/vps-rules") {
    return json(res, 200, runtime.vpsRules());
  }
  if (req.method === "POST" && url.pathname === "/api/network/public-ip") {
    if (!requireMutation(req, res)) return;
    return json(res, 200, { ip: await runtime.publicIp() });
  }
  if (req.method === "POST" && url.pathname === "/api/vpn/apply") {
    if (!requireMutation(req, res)) return;
    await runtime.enqueue(() => runtime.applyVpn());
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/vpn/stop") {
    if (!requireMutation(req, res)) return;
    await runtime.enqueue(() => runtime.stopVpn());
    return json(res, 200, { ok: true });
  }

  const serverAction = url.pathname.match(/^\/api\/server\/(start|stop|restart|update|validate)$/);
  if (req.method === "POST" && serverAction) {
    if (!requireMutation(req, res)) return;
    const action = serverAction[1];
    await runtime.enqueue(async () => {
      if (action === "start") await runtime.start();
      if (action === "stop") await runtime.stop();
      if (action === "restart") await runtime.restart();
      if (action === "update") {
        await runtime.stop();
        if (await hasSavedData()) await runtime.createBackup("pre-update", { serverAlreadyStopped: true });
        await runtime.start();
      }
      if (action === "validate") {
        await runtime.stop();
        if (await hasSavedData()) await runtime.createBackup("pre-validate", { serverAlreadyStopped: true });
        await runtime.start({ validate: true });
      }
    });
    return json(res, 202, { ok: true, action });
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    if (!requireMutation(req, res)) return;
    const name = await runtime.enqueue(() => runtime.createBackup("manual"));
    return json(res, 201, { ok: true, name });
  }
  const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
  if (req.method === "POST" && restoreMatch) {
    if (!requireMutation(req, res)) return;
    await runtime.enqueue(() => runtime.restoreBackup(decodeURIComponent(restoreMatch[1])));
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/worlds/import") {
    if (!requireMutation(req, res)) return;
    const fileName = String(req.headers["x-file-name"] || "world.sav");
    const result = await runtime.enqueue(() => runtime.importWorld(req, fileName));
    return json(res, 201, result);
  }
  if (req.method === "GET" && url.pathname === "/api/worlds") {
    return json(res, 200, await runtime.listWorlds());
  }

  const worldRulesMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)\/rules$/);
  if (req.method === "GET" && worldRulesMatch) {
    const worldName = decodeURIComponent(worldRulesMatch[1]);
    const rules = await runtime.getWorldRules(worldName);
    return json(res, 200, rules);
  }
  if (req.method === "POST" && worldRulesMatch) {
    if (!requireMutation(req, res)) return;
    const worldName = decodeURIComponent(worldRulesMatch[1]);
    const input = await bodyJson(req);
    const result = await runtime.enqueue(() => runtime.updateWorldRules(worldName, input));
    return json(res, 200, { ok: true, ...result });
  }

  const worldStatsMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)\/stats$/);
  if (req.method === "GET" && worldStatsMatch) {
    const worldName = decodeURIComponent(worldStatsMatch[1]);
    try {
      const stats = await runtime.getWorldStats(worldName);
      return json(res, 200, stats);
    } catch (err) {
      return json(res, 404, { error: err.message });
    }
  }

  const worldStatsDownloadMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)\/stats\/download$/);
  if (req.method === "GET" && worldStatsDownloadMatch) {
    const worldName = decodeURIComponent(worldStatsDownloadMatch[1]);
    try {
      const stats = await runtime.getWorldStats(worldName);
      const content = Buffer.from(JSON.stringify(stats, null, 2), "utf8");
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": content.length,
        "content-disposition": `attachment; filename="dragonwilds-wrapped-${encodeURIComponent(stats.worldName)}.json"`,
        "cache-control": "no-store",
      });
      return res.end(content);
    } catch (err) {
      return json(res, 404, { error: err.message });
    }
  }


  const worldActivateMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)\/activate$/);
  if (req.method === "POST" && worldActivateMatch) {
    if (!requireMutation(req, res)) return;
    const worldName = decodeURIComponent(worldActivateMatch[1]);
    const result = await runtime.enqueue(() => runtime.activateWorld(worldName));
    return json(res, 200, result);
  }

  const worldDuplicateMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)\/duplicate$/);
  if (req.method === "POST" && worldDuplicateMatch) {
    if (!requireMutation(req, res)) return;
    const worldName = decodeURIComponent(worldDuplicateMatch[1]);
    const input = await bodyJson(req);
    const result = await runtime.enqueue(() => runtime.duplicateWorld(worldName, input.newName));
    return json(res, 201, result);
  }

  const worldDownloadMatch = url.pathname.match(/^\/api\/worlds\/([^/]+)\/download$/);
  if (req.method === "GET" && worldDownloadMatch) {
    const worldName = decodeURIComponent(worldDownloadMatch[1]);
    const filePath = await runtime.findWorldPath(worldName);
    const fileInfo = await stat(filePath);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": fileInfo.size,
      "content-disposition": `attachment; filename="${basename(filePath)}"`,
      "cache-control": "no-store",
    });
    return createReadStream(filePath).pipe(res);
  }

  const backupDownloadMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
  if (req.method === "GET" && backupDownloadMatch) {
    const name = decodeURIComponent(backupDownloadMatch[1]);
    const filePath = runtime.safeBackupPath(name);
    const fileInfo = await stat(filePath);
    res.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": fileInfo.size,
      "content-disposition": `attachment; filename="${basename(filePath)}"`,
      "cache-control": "no-store",
    });
    return createReadStream(filePath).pipe(res);
  }

  if (req.method === "GET" && url.pathname === "/api/players") {
    return json(res, 200, await runtime.listKnownPlayers());
  }

  if (req.method === "POST" && url.pathname === "/api/players") {
    if (!requireMutation(req, res)) return;
    const input = await bodyJson(req);
    const player = await runtime.enqueue(() => runtime.addKnownPlayer(input));
    return json(res, 201, player);
  }

  const playerMatch = url.pathname.match(/^\/api\/players\/([^/]+)$/);
  if (req.method === "PUT" && playerMatch) {
    if (!requireMutation(req, res)) return;
    const userId = decodeURIComponent(playerMatch[1]);
    const input = await bodyJson(req);
    const updated = await runtime.enqueue(() => runtime.updateKnownPlayer(userId, input));
    return json(res, 200, updated);
  }

  if (req.method === "DELETE" && playerMatch) {
    if (!requireMutation(req, res)) return;
    const userId = decodeURIComponent(playerMatch[1]);
    await runtime.enqueue(() => runtime.removeKnownPlayer(userId));
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/logs/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ type: "connected", buildId: BUILD_ID })}\n\n`);

    const onLog = (entry) => {
      try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch {}
    };
    const onState = (state) => {
      try { res.write(`data: ${JSON.stringify({ type: "state", ...state })}\n\n`); } catch {}
    };
    const onPlayers = (players) => {
      try { res.write(`data: ${JSON.stringify({ type: "players", ...players })}\n\n`); } catch {}
    };

    runtime.on("log", onLog);
    runtime.on("state", onState);
    runtime.on("players", onPlayers);

    const pingTimer = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 15_000);

    req.on("close", () => {
      clearInterval(pingTimer);
      runtime.off("log", onLog);
      runtime.off("state", onState);
      runtime.off("players", onPlayers);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const source = (url.searchParams.get("source") || "all").toLowerCase();
    const limit = url.searchParams.get("limit") || 200;
    return json(res, 200, {
      source,
      logs: runtime.getLogs(source, limit),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/logs/download") {
    const source = (url.searchParams.get("source") || "server").toLowerCase();
    if (source === "server") {
      const logPath = join(constants.SERVER_DIR, "RSDragonwilds", "Saved", "Logs", "RSDragonwilds.log");
      try {
        const fileInfo = await stat(logPath);
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": fileInfo.size,
          "content-disposition": 'attachment; filename="RSDragonwilds.log"',
          "cache-control": "no-store",
        });
        return createReadStream(logPath).pipe(res);
      } catch {}
    }
    const logs = runtime.getLogs(source, 2000);
    const text = logs.map((l) => `[${l.at}] [${(l.source || source).toUpperCase()}] ${l.line}`).join("\n");
    const downloadName = source === "server" ? "RSDragonwilds.log" : `dragonwilds-${source}.log`;
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "content-disposition": `attachment; filename="${downloadName}"`,
      "cache-control": "no-store",
    });
    return res.end(text);
  }

  if (req.method === "POST" && url.pathname === "/api/server/broadcast") {
    if (!requireMutation(req, res)) return;
    const body = await bodyJson(req);
    const message = (body?.message || "").trim();
    if (!message) return json(res, 400, { error: "El mensaje no puede estar vacío." });
    try {
      runtime.sendCommand(`Broadcast ${message}`);
      return json(res, 200, { ok: true, message: `Comando enviado al servidor: Broadcast ${message}` });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  return json(res, 404, { error: "Ruta API no encontrada." });
}

async function hasSavedData() {
  try {
    await stat(join(constants.SERVER_DIR, "RSDragonwilds", "Saved"));
    return true;
  } catch {
    return false;
  }
}

async function staticFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const normalized = normalize(pathname).replace(/^([/\\])+/, "");
  let path = resolve(PUBLIC_DIR, normalized);
  if (!path.startsWith(`${PUBLIC_DIR}${sep}`)) return json(res, 404, { error: "No encontrado." });
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not file");
  } catch {
    path = join(PUBLIC_DIR, "index.html");
  }
  // Interceptar index.html para inyección dinámica de versión anti-caché
  if (path.endsWith("index.html")) {
    let html = await readFile(path, "utf8");
    html = html
      .replace(/href="\/styles\.css(\?[^"]*)?"/g, `href="/styles.css?v=${BUILD_ID}"`)
      .replace(/src="\/app\.js(\?[^"]*)?"/g, `src="/app.js?v=${BUILD_ID}"`);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate, max-age=0",
      "pragma": "no-cache",
      "expires": "0",
      "etag": `"${BUILD_ID}"`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    return res.end(html);
  }

  const type = mimeTypes[extname(path)] || "application/octet-stream";
  const isCode = path.endsWith(".js") || path.endsWith(".css") || path.endsWith(".json");
  const headers = {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cache-control": isCode
      ? "no-cache, no-store, must-revalidate, max-age=0"
      : "public, max-age=86400",
    ...(isCode ? { pragma: "no-cache", expires: "0" } : {}),
  };
  res.writeHead(200, headers);
  createReadStream(path).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") json(res, 200, { status: "ok" });
    else if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    runtime.addLog("panel", `${req.method} ${url.pathname}: ${error.message}`);
    json(res, error.status || 500, { error: error.message || "Error interno." });
  }
});

async function shutdown(signal) {
  runtime.addLog("panel", `Panel recibió ${signal}.`);
  server.close();
  await runtime.enqueue(() => runtime.stop()).catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await loadAuth();
await runtime.init();
server.listen(PORT, "0.0.0.0", () => runtime.addLog("panel", `Panel disponible en 0.0.0.0:${PORT}`));
