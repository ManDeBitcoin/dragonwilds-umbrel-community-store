import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { isIP, Socket } from "node:net";
import {
  readWorldRulesFromFile,
  updateWorldRulesInFile,
  GAME_MODE_LABELS,
  DIFFICULTY_LABELS,
  PVP_LABELS,
  CROSSPLAY_LABELS,
} from "./world-editor.js";
import { extractWorldStatsFromFile } from "./stats-extractor.js";
import { PlayerDatabase } from "./player-database.js";

const GAME_UID = Number(process.env.GAME_UID || 1000);
const GAME_GID = Number(process.env.GAME_GID || 1000);
const GAME_PORT = Number(process.env.GAME_PORT || 23409);
const BEACON_PORT = GAME_PORT + 1111;
const DATA_DIR = resolve(process.env.DATA_DIR || "/data/control");
const SERVER_DIR = resolve(process.env.SERVER_DIR || "/home/steam/rsdw-dedicated");
const BACKUP_DIR = resolve(process.env.BACKUP_DIR || "/data/backups");
const WG_DIR = resolve(process.env.WG_DIR || "/etc/wireguard");
const WORLD_DIR = join(SERVER_DIR, "RSDragonwilds", "Saved", "SaveGames");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const GAME_ENTRY = process.env.GAME_ENTRY || "/opt/dragonwilds/entrypoint-game.sh";

export async function resolveWorldDir() {
  const primary = join(SERVER_DIR, "RSDragonwilds", "Saved", "SaveGames");
  const fallback = join(SERVER_DIR, "RSDragonwilds", "Saved", "Savegames");
  if (await exists(primary)) return primary;
  if (await exists(fallback)) return fallback;
  return primary;
}

export const constants = {
  GAME_PORT,
  BEACON_PORT,
  DATA_DIR,
  SERVER_DIR,
  BACKUP_DIR,
  WG_DIR,
  WORLD_DIR,
};

export const defaultSettings = () => ({
  configured: false,
  ownerId: "00025be9182947128e2c6f899f51e1ba",
  serverName: "ChamapTV",
  worldName: "Chavito",
  worldPassword: "",
  adminPassword: "",
  administrators: "000293c9dc02469eb0959c6b74781ebd,000299e8be034a28a0e01be52fc967c8,0002d8eb1f3b4bf3bd3210b9dea9c490,0002d71d75c244468d4a7438ac03da03,0002bd4e6d3043d2b4c24f9b074a5d92",
  platformPolicy: "Crossplay",
  autoStart: false,
  autoUpdate: true,
  backupRetention: 10,
  backupSchedule: "disabled",
  networkMode: "wireguard",
  performance: {
    tickRate: 60,
  },
  vpn: {
    address: "10.8.0.2/24",
    listenPort: 51831,
    privateKey: "",
    peerPublicKey: "",
    presharedKey: "",
    endpoint: "152.53.54.0:51820",
    allowedIPs: "0.0.0.0/0",
    keepalive: 10,
    routeTable: 23409,
    dnsBypass: ["1.1.1.1", "9.9.9.9", "8.8.8.8"],
  },
});

const SECRET_KEYS = new Set(["worldPassword", "adminPassword"]);
const VPN_SECRET_KEYS = new Set(["privateKey", "presharedKey"]);

function cleanText(value, max = 128) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}

export function parseKnownPlayer(line) {
  const match = String(line || "").match(/KnownPlayerList=\(UserId=([^,]+),UserName="([^"]*)",Privileges=\(PrivilegeMask=(\d+)\),bIsBanned=(True|False)\)/i);
  if (!match) return null;
  const [, userId, userName, privilegeMask, bannedStr] = match;
  const privileges = Number(privilegeMask);
  const isBanned = bannedStr.toLowerCase() === "true";
  return {
    userId,
    userName,
    privileges,
    isAdmin: privileges === 14,
    isBanned,
  };
}

export function formatKnownPlayer(player) {
  const userId = cleanText(player.userId, 64);
  const userName = cleanText(player.userName, 64);
  const mask = player.isAdmin ? 14 : (Number(player.privileges) || 0);
  const banned = player.isBanned ? "True" : "False";
  return `KnownPlayerList=(UserId=${userId},UserName="${userName}",Privileges=(PrivilegeMask=${mask}),bIsBanned=${banned})`;
}

function validateIpCidr(value) {
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length || isIP(address) !== 4 || !/^\d{1,2}$/.test(prefix || "")) return false;
  return Number(prefix) >= 0 && Number(prefix) <= 32;
}

function validateEndpoint(value) {
  return /^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(value) || /^[a-zA-Z0-9.-]+:\d{1,5}$/.test(value);
}

function updateIniSection(content, section, updates) {
  const lines = content ? content.split(/\r?\n/) : [];
  let inSection = false;
  let sectionFound = false;
  const updatedKeys = new Set();
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (inSection) {
        for (const [k, v] of Object.entries(updates)) {
          if (!updatedKeys.has(k)) {
            result.push(`${k}=${v}`);
            updatedKeys.add(k);
          }
        }
      }
      inSection = trimmed.toLowerCase() === `[${section.toLowerCase()}]`;
      if (inSection) sectionFound = true;
      result.push(line);
      continue;
    }

    if (inSection) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        if (Object.hasOwn(updates, key)) {
          result.push(`${key}=${updates[key]}`);
          updatedKeys.add(key);
          continue;
        }
      }
    }

    result.push(line);
  }

  if (!sectionFound) {
    result.push(`[${section}]`);
    for (const [k, v] of Object.entries(updates)) {
      result.push(`${k}=${v}`);
    }
  } else if (inSection || updatedKeys.size < Object.keys(updates).length) {
    for (const [k, v] of Object.entries(updates)) {
      if (!updatedKeys.has(k)) {
        result.push(`${k}=${v}`);
        updatedKeys.add(k);
      }
    }
  }

  return result.join("\n") + "\n";
}

export function validateSettings(input, current = defaultSettings()) {
  const next = structuredClone(current);
  next.ownerId = cleanText(input.ownerId ?? current.ownerId, 128);
  next.serverName = cleanText(input.serverName ?? current.serverName, 80);
  next.worldName = cleanText(input.worldName ?? current.worldName, 80);
  next.administrators = cleanText(input.administrators ?? current.administrators, 2048);
  next.autoStart = Boolean(input.autoStart ?? current.autoStart);
  next.autoUpdate = Boolean(input.autoUpdate ?? current.autoUpdate);
  next.networkMode = (input.networkMode ?? current.networkMode) === "direct" ? "direct" : "wireguard";
  next.backupRetention = Math.min(50, Math.max(1, Number(input.backupRetention ?? current.backupRetention) || 10));
  next.backupSchedule = ["disabled", "6h", "12h", "24h"].includes(input.backupSchedule) ? input.backupSchedule : (current.backupSchedule || "disabled");
  const tickCandidate = Number(input.performance?.tickRate ?? current.performance?.tickRate);
  next.performance = {
    tickRate: [30, 60, 120].includes(tickCandidate) ? tickCandidate : 60,
  };

  const allowedPolicies = ["Crossplay", "PC", "PlayStation", "Xbox", "Nintendo"];
  next.platformPolicy = allowedPolicies.includes(input.platformPolicy) ? input.platformPolicy : (current.platformPolicy || "Crossplay");

  for (const key of SECRET_KEYS) {
    if (input[`${key}Clear`] === true || input[`${key}Clear`] === "true" || input[`${key}Clear`] === 1) {
      next[key] = "";
    } else if (Object.hasOwn(input, key) && input[key] !== "") {
      next[key] = cleanText(input[key], 256);
    }
  }

  if (!next.ownerId) throw new Error("El Player ID del propietario es obligatorio.");
  if (!next.serverName) throw new Error("El nombre del servidor es obligatorio.");
  if (!next.worldName) throw new Error("El nombre del mundo es obligatorio.");

  const vpnInput = input.vpn || {};
  const vpn = next.vpn;
  vpn.address = cleanText(vpnInput.address ?? vpn.address, 64);
  vpn.endpoint = cleanText(vpnInput.endpoint ?? vpn.endpoint, 255);
  vpn.peerPublicKey = cleanText(vpnInput.peerPublicKey ?? vpn.peerPublicKey, 128);
  vpn.allowedIPs = cleanText(vpnInput.allowedIPs ?? vpn.allowedIPs, 256) || "0.0.0.0/0";
  vpn.listenPort = Math.min(65535, Math.max(1, Number(vpnInput.listenPort) || 51831));
  vpn.keepalive = Math.min(120, Math.max(0, Number(vpnInput.keepalive) || 10));
  vpn.routeTable = Math.min(2_147_483_647, Math.max(1, Number(vpnInput.routeTable) || 23409));
  vpn.dnsBypass = Array.isArray(vpnInput.dnsBypass)
    ? vpnInput.dnsBypass.map((value) => cleanText(value, 45)).filter(Boolean).slice(0, 8)
    : vpn.dnsBypass;

  for (const key of VPN_SECRET_KEYS) {
    if (Object.hasOwn(vpnInput, key) && vpnInput[key] !== "") vpn[key] = cleanText(vpnInput[key], 256);
    if (vpnInput[`${key}Clear`] === true) vpn[key] = "";
  }

  if (next.networkMode === "wireguard") {
    if (!validateIpCidr(vpn.address)) throw new Error("La dirección WireGuard debe incluir CIDR, por ejemplo 10.8.0.2/24.");
    if (!validateEndpoint(vpn.endpoint)) throw new Error("El endpoint debe tener formato host:puerto.");
    if (!vpn.privateKey || !vpn.peerPublicKey) throw new Error("WireGuard necesita las claves privada local y pública del VPS.");
    const keyPattern = /^[A-Za-z0-9+/]{43}=$/;
    if (!keyPattern.test(vpn.privateKey) || !keyPattern.test(vpn.peerPublicKey)) throw new Error("Las claves WireGuard no tienen un formato base64 válido.");
    if (vpn.presharedKey && !keyPattern.test(vpn.presharedKey)) throw new Error("La PresharedKey no tiene un formato base64 válido.");
    const allowed = vpn.allowedIPs.split(",").map((value) => value.trim()).filter(Boolean);
    if (!allowed.length || allowed.some((value) => !validateIpCidr(value))) throw new Error("AllowedIPs debe contener redes IPv4 con CIDR.");
    if (vpn.dnsBypass.some((value) => isIP(value) !== 4)) throw new Error("La lista DNS sólo admite direcciones IPv4.");
  }

  next.configured = true;
  return next;
}

export function publicSettings(settings) {
  return {
    ...settings,
    worldPassword: "",
    adminPassword: "",
    hasWorldPassword: Boolean(settings.worldPassword),
    hasAdminPassword: Boolean(settings.adminPassword),
    platformPolicy: settings.platformPolicy || "Crossplay",
    performance: settings.performance || { tickRate: 60 },
    backupSchedule: settings.backupSchedule || "disabled",
    vpn: {
      ...settings.vpn,
      privateKey: "",
      presharedKey: "",
      hasPrivateKey: Boolean(settings.vpn.privateKey),
      hasPresharedKey: Boolean(settings.vpn.presharedKey),
    },
  };
}

async function command(commandName, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(commandName, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      uid: options.uid,
      gid: options.gid,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      if (options.allowFailure) resolveCommand({ code: 124, stdout, stderr: "Comando cancelado por tiempo de espera" });
      else rejectCommand(new Error(`Comando "${commandName}" agotó el tiempo de espera (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", (err) => {
      clearTimeout(timer);
      rejectCommand(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const result = { code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.code === 0 || options.allowFailure) resolveCommand(result);
      else rejectCommand(new Error(result.stderr || `${commandName} terminó con código ${result.code}`));
    });
  });
}

async function atomicWrite(path, contents, mode = 0o600, uid = GAME_UID, gid = GAME_GID) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await chown(dirname(path), uid, gid);
  } catch {}
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, contents, { mode });
  await rename(temp, path);
  await chmod(path, mode);
  try {
    await chown(path, uid, gid);
  } catch {}
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class Runtime extends EventEmitter {
  constructor() {
    super();
    this.settings = defaultSettings();
    this.child = null;
    this.desiredRunning = false;
    this.serverState = "stopped";
    this.serverMessage = "Sin configurar";
    this.startedAt = null;
    this.logs = [];
    this.categoryLogs = {
      server: [],
      panel: [],
      vpn: [],
      backup: [],
      world: [],
    };
    this.onlinePlayers = new Map();
    this.knownPlayerNames = new Map();
    this.playerDatabase = new PlayerDatabase(join(DATA_DIR, "player-database.json"));
    this.statsSyncTimer = null;
    this.operation = Promise.resolve();
    this.backupScheduleTimer = null;
    this.vpnWatchdogTimer = null;
    this.restartTimer = null;
    this.recentCrashes = [];
  }

  async init() {
    const saveGamesUpper = join(SERVER_DIR, "RSDragonwilds", "Saved", "SaveGames");
    const saveGamesLower = join(SERVER_DIR, "RSDragonwilds", "Saved", "Savegames");
    await Promise.all([
      mkdir(DATA_DIR, { recursive: true }),
      mkdir(SERVER_DIR, { recursive: true }),
      mkdir(BACKUP_DIR, { recursive: true }),
      mkdir(WG_DIR, { recursive: true }),
      mkdir(WORLD_DIR, { recursive: true }),
    ]);
    if ((await exists(saveGamesUpper)) && !(await exists(saveGamesLower))) {
      try {
        await symlink("SaveGames", saveGamesLower);
      } catch {}
    } else if ((await exists(saveGamesLower)) && !(await exists(saveGamesUpper))) {
      try {
        await symlink("Savegames", saveGamesUpper);
      } catch {}
    }
    if (await exists(SETTINGS_FILE)) {
      try {
        this.settings = { ...defaultSettings(), ...JSON.parse(await readFile(SETTINGS_FILE, "utf8")) };
        this.settings.vpn = { ...defaultSettings().vpn, ...(this.settings.vpn || {}) };
      } catch (error) {
        this.addLog("panel", `No se pudo leer settings.json: ${error.message}`);
      }
    } else {
      try {
        this.settings = defaultSettings();
        await atomicWrite(SETTINGS_FILE, `${JSON.stringify(this.settings, null, 2)}\n`);
      } catch {}
    }
    const panelActivityFile = join(DATA_DIR, "panel-activity.log");
    if (await exists(panelActivityFile)) {
      try {
        const content = await readFile(panelActivityFile, "utf8");
        const lines = content.split("\n").filter(Boolean).slice(-500);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry && entry.source && entry.line) {
              this.logs.push(entry);
              const cat = (entry.source || "panel").toLowerCase();
              if (!this.categoryLogs[cat]) this.categoryLogs[cat] = [];
              this.categoryLogs[cat].push(entry);
            }
          } catch {}
        }
        if (content.length > 2 * 1024 * 1024) {
          const keep = lines.join("\n") + "\n";
          await writeFile(panelActivityFile, keep, "utf8").catch(() => {});
        }
      } catch {}
    }
    if (this.settings.networkMode === "wireguard" && this.settings.vpn?.privateKey) {
      try {
        await this.writeWireGuardConfig();
      } catch {}
    }
    await this.syncEngineIni().catch(() => {});
    this.setupBackupSchedule();
    this.setupVpnWatchdog();
    this.desiredRunning = false;
    this.serverState = "stopped";
    this.serverMessage = this.settings.configured
      ? "Servidor detenido (listo para arrancar)"
      : "Sin configurar";
    await this.playerDatabase.load().catch(() => {});
    this.addLog("world", `Gestor de mundos listo. Mundo activo configurado: [${this.settings.worldName || "Chavito"}]`);
  }

  addLog(source, line) {
    const secretValues = [
      this.settings.worldPassword,
      this.settings.adminPassword,
      this.settings.vpn?.privateKey,
      this.settings.vpn?.presharedKey,
    ].filter(Boolean);
    let safe = String(line).replace(/[\r\n]+$/, "");
    for (const secret of secretValues) safe = safe.split(secret).join("[SECRETO]");
    const entry = { at: new Date().toISOString(), source, line: safe.slice(0, 4000) };

    // Buffer general consolidado
    this.logs.push(entry);
    if (this.logs.length > 3000) this.logs.splice(0, this.logs.length - 3000);

    // Buffer específico por categoría para garantizar que eventos de panel/vpn/backup/world no se pierdan
    const cat = (source || "panel").toLowerCase();
    if (!this.categoryLogs[cat]) {
      this.categoryLogs[cat] = [];
    }
    this.categoryLogs[cat].push(entry);
    const maxCat = cat === "server" ? 2000 : 500;
    if (this.categoryLogs[cat].length > maxCat) {
      this.categoryLogs[cat].splice(0, this.categoryLogs[cat].length - maxCat);
    }

    // Espejar automáticamente eventos de mundo que emite el servidor de juego (WorldPartition, guardados, mapas)
    const isWorldEvent = /LogWorldPartition|LogSaveGame|SaveToSlot|L_World|DominionDedicatedServer|WorldPartition|SaveGame|Bringing World/i.test(safe);
    if (isWorldEvent && cat !== "world") {
      const worldEntry = { at: entry.at, source: "world", line: safe.slice(0, 4000) };
      if (!this.categoryLogs["world"]) this.categoryLogs["world"] = [];
      this.categoryLogs["world"].push(worldEntry);
      if (this.categoryLogs["world"].length > 500) {
        this.categoryLogs["world"].splice(0, this.categoryLogs["world"].length - 500);
      }
    }

    // Persistir eventos no-servidor para que sobrevivan reinicios
    if (cat !== "server") {
      const panelActivityFile = join(DATA_DIR, "panel-activity.log");
      appendFile(panelActivityFile, `${JSON.stringify(entry)}\n`).catch(() => {});
    }

    // Detección reactiva de jugadores en línea (evita duplicar eventos de handshake y sesión)
    const matcherMatch = safe.match(/LogDomMatcherSession: Player ADDED to session \[([0-9a-fA-F]+)\]-\[?([^\]\r\n]+)\]?/i);
    const joinSucceededMatch = safe.match(/LogNet: Join succeeded:\s*([^\r\n]+)/i);

    if (matcherMatch) {
      const userId = matcherMatch[1];
      const userName = matcherMatch[2].replace(/"/g, "").trim();
      const lowerName = userName.toLowerCase();

      this.knownPlayerNames.set(userId.toLowerCase(), userName);

      // Limpiar cualquier entrada previa o temporal con el mismo nombre o placeholder
      for (const [existingId, p] of this.onlinePlayers.entries()) {
        if (p.userName.toLowerCase() === lowerName || existingId === userId || existingId.toLowerCase() === `player-${lowerName}`) {
          this.onlinePlayers.delete(existingId);
        }
      }

      this.onlinePlayers.set(userId, {
        userId,
        userName,
        joinedAt: new Date().toISOString(),
      });
      if (this.playerDatabase) {
        const worldName = this.settings.worldName || "Chavito";
        this.playerDatabase.updatePlayerConnection(worldName, userName, {
          userId,
          connected: true,
          timestamp: new Date().toISOString(),
        });
      }
      this.emit("players", {
        onlinePlayers: Array.from(this.onlinePlayers.values()),
        playerCount: this.onlinePlayers.size,
      });
    } else if (joinSucceededMatch) {
      const rawName = joinSucceededMatch[1].replace(/"/g, "").trim();
      const lowerName = rawName.toLowerCase();

      // Verificar si ya está registrado (por ejemplo si la sesión EOS ya fue procesada)
      let alreadyExists = false;
      for (const [, p] of this.onlinePlayers.entries()) {
        if (p.userName.toLowerCase() === lowerName) {
          alreadyExists = true;
          break;
        }
      }

      if (!alreadyExists) {
        const userId = `player-${rawName}`;
        this.onlinePlayers.set(userId, {
          userId,
          userName: rawName,
          joinedAt: new Date().toISOString(),
        });
        this.emit("players", {
          onlinePlayers: Array.from(this.onlinePlayers.values()),
          playerCount: this.onlinePlayers.size,
        });
      }
    }

    // Detección reactiva de desconexión de jugadores
    const noPlayerPause = /LogDomGameMode: Requested pausing as we have no player connected/i.test(safe);
    const matcherLeave = safe.match(/LogDomMatcherSession: Player Removed from session \[([0-9a-fA-F]+)\](?:-\[?([^\]\r\n]+)\]?)?/i);
    const netClose = safe.match(/LogNet: (?:UNetConnection::Close|UNetDriver::RemoveClientConnection):?.*UniqueId:\s*RedpointEOS:([0-9a-fA-F]+)/i);
    const clientDisconnect = safe.match(/ClientRequestDisconnect.*Account\[XP:([0-9a-fA-F]+)\].*Character Name\[([^\]]+)\]/i)
      || safe.match(/ClientRequestDisconnect.*Character Name\[([^\]]+)\]/i);

    if (noPlayerPause) {
      if (this.onlinePlayers.size > 0) {
        this.onlinePlayers.clear();
        this.emit("players", {
          onlinePlayers: [],
          playerCount: 0,
        });
      }
    } else if (matcherLeave || netClose || clientDisconnect) {
      const rawTargetId = matcherLeave?.[1] || netClose?.[1] || (clientDisconnect && clientDisconnect[2] ? clientDisconnect[1] : null);
      const rawTargetName = matcherLeave?.[2] || (clientDisconnect ? (clientDisconnect[2] || clientDisconnect[1]) : null);
      const cleanTargetId = rawTargetId ? rawTargetId.replace(/[\[\]"']/g, "").trim() : null;
      const cleanTargetName = rawTargetName ? rawTargetName.replace(/[\[\]"']/g, "").trim() : null;
      const resolvedName = cleanTargetName || (cleanTargetId ? this.knownPlayerNames.get(cleanTargetId.toLowerCase()) : null);

      let changed = false;
      for (const [uid, p] of this.onlinePlayers.entries()) {
        const uidLower = uid.toLowerCase();
        const pNameLower = (p.userName || "").toLowerCase();
        const matchId = cleanTargetId && (uidLower === cleanTargetId.toLowerCase() || uidLower === `player-${cleanTargetId.toLowerCase()}`);
        const matchName = resolvedName && (
          pNameLower === resolvedName.toLowerCase() ||
          uidLower === resolvedName.toLowerCase() ||
          uidLower === `player-${resolvedName.toLowerCase()}`
        );

        if (matchId || matchName) {
          this.onlinePlayers.delete(uid);
          changed = true;
        }
      }

      if (changed) {
        if (this.playerDatabase && resolvedName) {
          const worldName = this.settings.worldName || "Chavito";
          this.playerDatabase.updatePlayerConnection(worldName, resolvedName, {
            userId: cleanTargetId || "",
            connected: false,
            timestamp: new Date().toISOString(),
          });
        }
        this.emit("players", {
          onlinePlayers: Array.from(this.onlinePlayers.values()),
          playerCount: this.onlinePlayers.size,
        });
      }
    }

    // Detección reactiva de guardados del servidor o desconexiones para consolidar base de datos
    const isSaveOrDisconnect = /SaveGame\(\) : Starting save|PlayerStateSave result\[true\]|ClientRequestDisconnect/i.test(safe);
    if (isSaveOrDisconnect) {
      this.schedulePlayerStatsSync();
    }

    this.emit("log", entry);
  }

  schedulePlayerStatsSync() {
    if (this.statsSyncTimer) clearTimeout(this.statsSyncTimer);
    this.statsSyncTimer = setTimeout(async () => {
      try {
        const worldName = this.settings.worldName || "Chavito";
        const path = await this.findWorldPath(worldName).catch(() => null);
        if (path && (await exists(path))) {
          const onlineNames = new Set(
            Array.from(this.onlinePlayers.values()).map((p) => p.userName)
          );
          await extractWorldStatsFromFile(path, {
            playerDatabase: this.playerDatabase,
            onlinePlayers: onlineNames,
          });
          this.emit("stats-updated", { worldName });
        }
      } catch {}
    }, 2500);
  }

  getLogs(source = "all", limit = 200) {
    const lim = Math.max(1, Math.min(Number(limit) || 200, 2000));
    const safeSource = (source || "all").toLowerCase();
    if (safeSource !== "all") {
      const list = this.categoryLogs[safeSource] || [];
      return list.slice(-lim);
    }
    return this.logs.slice(-lim);
  }

  enqueue(fn) {
    const next = this.operation.then(fn, fn);
    this.operation = next.catch(() => {});
    return next;
  }

  async saveSettings(input) {
    const next = validateSettings(input, this.settings);
    await atomicWrite(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    this.settings = next;
    await this.syncEngineIni();
    this.setupBackupSchedule();
    this.setupVpnWatchdog();
    this.addLog("panel", "Configuración guardada.");
    return publicSettings(this.settings);
  }

  gameEnvironment(validate = false, update = false) {
    return {
      ...process.env,
      HOME: "/home/steam",
      RSDW_OWNER_ID: this.settings.ownerId,
      RSDW_SERVER_NAME: this.settings.serverName,
      RSDW_WORLD_NAME: this.settings.worldName,
      RSDW_PASSWORD: this.settings.worldPassword,
      RSDW_ADMIN_PASSWORD: this.settings.adminPassword,
      RSDW_ADMINS: this.settings.administrators,
      RSDW_PLATFORM_POLICY: this.settings.platformPolicy || "Crossplay",
      RSDW_PORT: String(GAME_PORT),
      RSDW_AUTO_STOP_ON_UPDATE: this.settings.autoUpdate ? "true" : "false",
      STEAMAPPVALIDATE: validate ? "1" : "0",
      STEAMAPPUPDATE: update ? "1" : "0",
    };
  }

  async writeWireGuardConfig() {
    const vpn = this.settings.vpn;
    const dnsRulesUp = vpn.dnsBypass
      .map((ip, index) => `PostUp = ip rule del priority ${1101 + index} 2>/dev/null || true; ip rule add priority ${1101 + index} uidrange ${GAME_UID}-${GAME_UID} to ${ip}/32 lookup main`)
      .join("\n");
    const dnsRulesDown = [...vpn.dnsBypass]
      .reverse()
      .map((_, reverseIndex) => {
        const index = vpn.dnsBypass.length - reverseIndex - 1;
        return `PostDown = ip rule del priority ${1101 + index} 2>/dev/null || true`;
      })
      .join("\n");
    const psk = vpn.presharedKey ? `PresharedKey = ${vpn.presharedKey}\n` : "";
    const config = `[Interface]\nPrivateKey = ${vpn.privateKey}\nAddress = ${vpn.address}\nListenPort = ${vpn.listenPort}\nTable = off\n${dnsRulesUp}\nPostUp = ip route replace default dev %i table ${vpn.routeTable}\nPostUp = ip rule del priority 1200 2>/dev/null || true; ip rule add priority 1200 uidrange ${GAME_UID}-${GAME_UID} lookup ${vpn.routeTable}\nPostDown = ip rule del priority 1200 2>/dev/null || true\nPostDown = ip route flush table ${vpn.routeTable}\n${dnsRulesDown}\n\n[Peer]\nPublicKey = ${vpn.peerPublicKey}\n${psk}AllowedIPs = ${vpn.allowedIPs}\nEndpoint = ${vpn.endpoint}\nPersistentKeepalive = ${vpn.keepalive}\n`;
    const path = join(WG_DIR, "wg-vps.conf");
    await atomicWrite(path, config);
    return path;
  }

  async applyVpn() {
    if (process.env.MOCK_GAME === "1") return;
    const active = await command("wg", ["show", "wg-vps"], { allowFailure: true });
    if (active.code === 0) await command("wg-quick", ["down", "wg-vps"], { allowFailure: true });
    if (this.settings.networkMode === "wireguard") {
      await this.writeWireGuardConfig();
      await command("wg-quick", ["up", "wg-vps"]);
      this.addLog("vpn", "Túnel wg-vps activado.");
    } else {
      this.addLog("vpn", "Modo directo: WireGuard desactivado.");
    }
  }

  async stopVpn() {
    if (process.env.MOCK_GAME === "1") return;
    await command("wg-quick", ["down", "wg-vps"], { allowFailure: true });
    this.addLog("vpn", "Túnel wg-vps desactivado.");
  }

  async start(options = {}) {
    if (this.child) return;
    if (!this.settings.configured) throw new Error("Completa el asistente inicial antes de arrancar.");
    this.desiredRunning = true;
    this.serverState = "starting";
    this.serverMessage = options.validate ? "Validando archivos y arrancando" : (options.update ? "Actualizando y arrancando" : "Arrancando servidor");
    this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
    await this.applyVpn();
    await mkdir(WORLD_DIR, { recursive: true });
    try {
      const activeRules = await this.getWorldRules(this.settings.worldName).catch(() => null);
      await this.syncDedicatedServerIni(this.settings.worldName, activeRules || {});
    } catch {}

    if (process.env.MOCK_GAME !== "1") {
      try {
        await command("pkill", ["-9", "-f", "RSDragonwilds"], { allowFailure: true, timeoutMs: 3000 });
        await new Promise((r) => setTimeout(r, 500));
      } catch {}
      try {
        const savedDir = join(SERVER_DIR, "RSDragonwilds", "Saved");
        if (await exists(savedDir)) {
          await command("chown", ["-R", `${GAME_UID}:${GAME_GID}`, savedDir], { allowFailure: true, timeoutMs: 5000 });
        }
      } catch {}
    }

    const executable = process.env.MOCK_GAME === "1" ? process.execPath : GAME_ENTRY;
    const args = process.env.MOCK_GAME === "1"
      ? ["-e", "console.log('Mock Dragonwilds online'); setInterval(()=>console.log('heartbeat'), 2000)"]
      : [];
    const spawnTimestamp = Date.now();
    this.child = spawn(executable, args, {
      env: this.gameEnvironment(Boolean(options.validate), Boolean(options.update)),
      cwd: process.env.MOCK_GAME === "1" ? process.cwd() : "/home/steam",
      uid: process.env.MOCK_GAME === "1" ? undefined : GAME_UID,
      gid: process.env.MOCK_GAME === "1" ? undefined : GAME_GID,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.startedAt = new Date().toISOString();
    this.addLog("world", `Servidor arrancando con el mundo: [${this.settings.worldName || "Chavito"}]`);
    this.child.stdout.on("data", (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((line) => this.addLog("server", line)));
    this.child.stderr.on("data", (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((line) => this.addLog("server", line)));
    this.child.once("spawn", () => {
      this.serverState = "running";
      this.serverMessage = `Escuchando en UDP ${GAME_PORT} y ${BEACON_PORT}`;
      this.addLog("panel", "Proceso del servidor iniciado.");
      this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: this.startedAt });
    });
    this.child.once("error", (error) => {
      this.serverState = "error";
      this.serverMessage = error.message;
      this.addLog("panel", `No se pudo arrancar: ${error.message}`);
      this.child = null;
      this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
    });
    this.child.once("exit", (code, signal) => {
      this.addLog("panel", `Servidor detenido (código ${code ?? "-"}, señal ${signal ?? "-"}).`);
      this.child = null;
      this.startedAt = null;
      this.onlinePlayers.clear();
      this.emit("players", { onlinePlayers: [], playerCount: 0 });

      // Protección contra bucle infinito de caídas (circuit breaker)
      const uptimeSec = (Date.now() - spawnTimestamp) / 1000;
      if (uptimeSec < 30) {
        this.recentCrashes.push(Date.now());
      }
      this.recentCrashes = this.recentCrashes.filter((ts) => Date.now() - ts < 90_000);

      if (this.recentCrashes.length >= 3) {
        this.desiredRunning = false;
        this.serverState = "error";
        this.serverMessage = "Reinicio automático detenido tras 3 caídas consecutivas";
        this.addLog("panel", "ADVERTENCIA: El servidor se cerró de forma imprevista 3 veces seguidas en menos de 90 segundos. Se detuvo el reinicio automático para proteger la base de datos y la partida. Revisa la pestaña de Registros o la configuración.");
        this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
        return;
      }

      if (this.desiredRunning) {
        this.serverState = "starting";
        this.serverMessage = "Reinicio automático en 5 segundos";
        this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.desiredRunning) {
            this.enqueue(() => this.start()).catch((error) => {
              this.serverState = "error";
              this.serverMessage = error.message;
              this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
            });
          }
        }, 5000);
      } else {
        this.serverState = "stopped";
        this.serverMessage = "Servidor detenido";
        this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
      }
    });
  }

  async stop() {
    this.desiredRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      if (process.env.MOCK_GAME !== "1") {
        try {
          await command("pkill", ["-9", "-f", "RSDragonwilds"], { allowFailure: true, timeoutMs: 3000 });
        } catch {}
      }
      this.child = null;
      this.startedAt = null;
      this.onlinePlayers.clear();
      this.serverState = "stopped";
      this.serverMessage = "Servidor detenido";
      this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
      this.emit("players", { onlinePlayers: [], playerCount: 0 });
      return;
    }
    this.serverState = "stopping";
    this.serverMessage = "Guardando y deteniendo";
    this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: this.startedAt });
    const child = this.child;
    try {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
      }
      try { child.kill("SIGTERM"); } catch {}
    } catch {}
    await Promise.race([
      new Promise((resolveStop) => child.once("exit", resolveStop)),
      new Promise((resolveStop) => setTimeout(resolveStop, 15_000)),
    ]);
    if (this.child === child && child.exitCode === null) {
      try {
        if (child.pid && process.platform !== "win32") {
          try { process.kill(-child.pid, "SIGKILL"); } catch {}
        }
        child.kill("SIGKILL");
      } catch {}
    }
    if (process.env.MOCK_GAME !== "1") {
      try {
        await command("pkill", ["-9", "-f", "RSDragonwilds"], { allowFailure: true, timeoutMs: 3000 });
      } catch {}
    }
    this.child = null;
    this.startedAt = null;
    this.onlinePlayers.clear();
    this.serverState = "stopped";
    this.serverMessage = "Servidor detenido";
    this.emit("state", { state: this.serverState, message: this.serverMessage, startedAt: null });
    this.emit("players", { onlinePlayers: [], playerCount: 0 });
  }

  async restart(options = {}) {
    await this.stop();
    await this.start(options);
  }


  async withStoppedServer(task, restart = true) {
    const wasRunning = Boolean(this.child) || this.desiredRunning;
    await this.stop();
    try {
      return await task();
    } finally {
      if (wasRunning && restart) await this.start();
    }
  }

  async createBackup(reason = "manual", options = {}) {
    const doBackup = async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeReason = cleanText(reason, 32).replace(/[^a-zA-Z0-9_-]+/g, "-") || "manual";
      const name = `Saved-${stamp}-${safeReason}.tar.gz`;
      const temp = join(BACKUP_DIR, `${name}.partial`);
      const target = join(BACKUP_DIR, name);
      await mkdir(BACKUP_DIR, { recursive: true });
      if (!(await exists(join(SERVER_DIR, "RSDragonwilds", "Saved")))) {
        throw new Error("Todavía no existe una carpeta Saved para respaldar.");
      }
      await command("tar", ["-C", SERVER_DIR, "-czf", temp, "RSDragonwilds/Saved"]);
      await rename(temp, target);
      this.addLog("backup", `Backup creado: ${name}`);
      await this.pruneBackups();
      return name;
    };
    if (options.serverAlreadyStopped) return await doBackup();
    return await this.withStoppedServer(doBackup, options.restart !== false);
  }

  async listBackups() {
    const entries = await readdir(BACKUP_DIR, { withFileTypes: true });
    const backups = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tar.gz")) continue;
      const info = await stat(join(BACKUP_DIR, entry.name));
      backups.push({ name: entry.name, size: info.size, createdAt: info.mtime.toISOString() });
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async pruneBackups() {
    const backups = await this.listBackups();
    for (const backup of backups.slice(this.settings.backupRetention)) {
      await rm(join(BACKUP_DIR, backup.name));
      this.addLog("backup", `Backup antiguo eliminado por retención: ${backup.name}`);
    }
  }

  safeBackupPath(name) {
    const clean = basename(name);
    if (clean !== name || !clean.endsWith(".tar.gz")) throw new Error("Nombre de backup inválido.");
    const path = resolve(BACKUP_DIR, clean);
    if (!path.startsWith(`${BACKUP_DIR}${sep}`)) throw new Error("Ruta de backup inválida.");
    return path;
  }

  async restoreBackup(name) {
    const source = this.safeBackupPath(name);
    if (!(await exists(source))) throw new Error("El backup seleccionado no existe.");
    return await this.withStoppedServer(async () => {
      if (await exists(join(SERVER_DIR, "RSDragonwilds", "Saved"))) {
        await this.createBackup("pre-restore", { serverAlreadyStopped: true });
      }
      const listing = await command("tar", ["-tzf", source]);
      const unsafe = listing.stdout.split("\n").some((item) => item.startsWith("/") || item.split("/").includes(".."));
      if (unsafe) throw new Error("El backup contiene rutas inseguras.");
      await rm(join(SERVER_DIR, "RSDragonwilds", "Saved"), { recursive: true, force: true });
      await command("tar", ["-C", SERVER_DIR, "-xzf", source]);
      this.addLog("backup", `Backup restaurado: ${name}`);
    });
  }

  async importWorld(readable, originalName) {
    const clean = basename(originalName || "world.sav").replace(/[^a-zA-Z0-9._-]+/g, "-");
    if (!clean.toLowerCase().endsWith(".sav")) throw new Error("El mundo debe ser un archivo .sav.");
    return await this.withStoppedServer(async () => {
      if (await exists(join(SERVER_DIR, "RSDragonwilds", "Saved"))) {
        await this.createBackup("pre-import", { serverAlreadyStopped: true });
      }
      const worldDir = await resolveWorldDir();
      await mkdir(worldDir, { recursive: true });
      const temp = join(worldDir, `.${clean}.${randomBytes(4).toString("hex")}.partial`);
      const target = join(worldDir, clean);
      let bytes = 0;
      readable.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024 * 1024) readable.destroy(new Error("El mundo supera el límite de 2 GB."));
      });
      try {
        await pipeline(readable, createWriteStream(temp, { mode: 0o600 }));
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      this.addLog("world", `Mundo importado: ${clean}`);
      return { name: clean, size: bytes };
    });
  }

  async findWorldPath(name) {
    if (!name || typeof name !== "string" || name !== basename(name) || name.includes("/") || name.includes("\\") || name.includes("..")) {
      throw new Error("Nombre de mundo inválido.");
    }
    const clean = basename(name).replace(/\.sav$/i, "");
    if (!clean) throw new Error("Nombre de mundo inválido.");
    const primary = join(SERVER_DIR, "RSDragonwilds", "Saved", "SaveGames", `${clean}.sav`);
    const fallback = join(SERVER_DIR, "RSDragonwilds", "Saved", "Savegames", `${clean}.sav`);
    const primaryBackup = join(SERVER_DIR, "RSDragonwilds", "Saved", "SaveGames", `${clean}.backup`);
    const fallbackBackup = join(SERVER_DIR, "RSDragonwilds", "Saved", "Savegames", `${clean}.backup`);
    if (await exists(primary)) return primary;
    if (await exists(fallback)) return fallback;
    if (await exists(primaryBackup)) return primaryBackup;
    if (await exists(fallbackBackup)) return fallbackBackup;
    return primary;
  }

  async listWorlds() {
    const primary = join(SERVER_DIR, "RSDragonwilds", "Saved", "SaveGames");
    const fallback = join(SERVER_DIR, "RSDragonwilds", "Saved", "Savegames");
    const dirs = [primary, fallback];
    const worldsMap = new Map();

    for (const dir of dirs) {
      if (!(await exists(dir))) continue;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".sav")) continue;
        if (worldsMap.has(entry.name)) continue;
        const filePath = join(dir, entry.name);
        const [info, rules] = await Promise.all([
          stat(filePath),
          readWorldRulesFromFile(filePath).catch(() => ({
            detected: false,
            gameMode: 1,
            gameModeLabel: GAME_MODE_LABELS[1],
            difficulty: 0,
            difficultyLabel: DIFFICULTY_LABELS[0],
            pvpEnabled: false,
            pvpLabel: PVP_LABELS[0],
            crossplayEnabled: true,
            crossplayLabel: CROSSPLAY_LABELS[1],
          })),
        ]);
        worldsMap.set(entry.name, {
          name: entry.name,
          baseName: entry.name.replace(/\.sav$/i, ""),
          size: info.size,
          updatedAt: info.mtime.toISOString(),
          active: entry.name.replace(/\.sav$/i, "") === this.settings.worldName,
          rules: {
            gameMode: rules.gameMode ?? 1,
            gameModeLabel: rules.gameModeLabel ?? (GAME_MODE_LABELS[rules.gameMode ?? 1] || "Estándar"),
            difficulty: rules.difficulty ?? 1,
            difficultyLabel: rules.difficultyLabel ?? "Normal",
            pvpEnabled: Boolean(rules.pvpEnabled),
            pvpLabel: rules.pvpLabel ?? (rules.pvpEnabled ? "Activado (JcJ)" : "Desactivado (Coop)"),
            crossplayEnabled: rules.crossplayEnabled !== undefined ? Boolean(rules.crossplayEnabled) : true,
            crossplayLabel: rules.crossplayLabel ?? ((rules.crossplayEnabled ?? true) ? "Habilitado" : "Deshabilitado"),
            detected: Boolean(rules.detected),
          },
        });
      }
    }
    return Array.from(worldsMap.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getWorldRules(worldName) {
    const path = await this.findWorldPath(worldName);
    if (!(await exists(path))) throw new Error(`El mundo "${worldName}" no existe.`);
    return await readWorldRulesFromFile(path);
  }

  async getWorldStats(worldName) {
    const clean = basename(worldName || this.settings.worldName || "Chavito").replace(/\.(sav|backup)$/i, "");
    const path = await this.findWorldPath(clean);
    if (!(await exists(path))) throw new Error(`El mundo "${clean}" no existe.`);
    const onlineNames = new Set(
      Array.from(this.onlinePlayers.values()).map((p) => p.userName)
    );
    return await extractWorldStatsFromFile(path, {
      playerDatabase: this.playerDatabase,
      onlinePlayers: onlineNames,
    });
  }


  async syncDedicatedServerIni(worldName, rules = {}) {
    const iniPaths = this.getDedicatedServerIniPaths();
    for (const iniPath of iniPaths) {
      const dir = dirname(iniPath);
      try {
        await mkdir(dir, { recursive: true });
        try {
          await chown(dir, GAME_UID, GAME_GID);
        } catch {}
        let content = (await exists(iniPath)) ? await readFile(iniPath, "utf8") : "";
        const updates = {};
        if (worldName) updates.DefaultWorldName = worldName;
        if (this.settings.serverName) updates.ServerName = this.settings.serverName;
        if (this.settings.ownerId) updates.OwnerId = this.settings.ownerId;
        const rawPwd = this.settings.worldPassword ?? "";
        updates.WorldPassword = rawPwd.includes(" ") && !rawPwd.startsWith('"') ? `"${rawPwd}"` : rawPwd;
        updates.PlatformPolicy = this.settings.platformPolicy || "Crossplay";
        if (!content) {
          content = ";METADATA=(Diff=true, UseCommands=true)\n";
          updates.bAllowSendingCrashDumps = "True";
        }
        // Limpiar cualquier bloque legacy [ServerSettings] si existía previamente
        if (content.includes("[ServerSettings]")) {
          content = content.replace(/\[ServerSettings\][\s\S]*?(?=\r?\n\[|$)/i, "").trim() + "\n";
        }
        content = updateIniSection(content, "/Script/Dominion.DedicatedServerSettings", updates);
        await atomicWrite(iniPath, content, 0o666, GAME_UID, GAME_GID);
        try {
          await chown(iniPath, GAME_UID, GAME_GID);
          await chmod(iniPath, 0o666);
        } catch {}
      } catch (err) {
        this.addLog("world", `Aviso al sincronizar DedicatedServer.ini: ${err.message}`);
      }
    }
    this.addLog("world", `Configuración de mundo sincronizada para [${worldName || this.settings.worldName || "Chavito"}] en DedicatedServer.ini`);
  }

  async updateWorldRules(worldName, rules) {
    const clean = basename(worldName).replace(/\.sav$/i, "");
    const path = await this.findWorldPath(clean);
    if (!(await exists(path))) throw new Error(`El mundo "${clean}" no existe.`);
    return await this.withStoppedServer(async () => {
      await this.createBackup(`pre-rules-${clean}`, { serverAlreadyStopped: true });
      const result = await updateWorldRulesInFile(path, rules);
      try {
        await chown(path, GAME_UID, GAME_GID);
        await chmod(path, 0o666);
      } catch {}
      this.settings.worldName = clean;
      await atomicWrite(SETTINGS_FILE, `${JSON.stringify(this.settings, null, 2)}\n`);
      await this.syncDedicatedServerIni(clean, rules);
      const modeLabel = GAME_MODE_LABELS[rules.gameMode] ?? `Modo ${rules.gameMode}`;
      const diffLabel = DIFFICULTY_LABELS[rules.difficulty] ?? rules.difficulty;
      const pvpLabel = rules.pvpEnabled ? "Activado" : "Desactivado";
      const crossplayLabel = rules.crossplayEnabled ? "Habilitado" : "Deshabilitado";
      this.addLog("world", `Mundo activo fijado en [${clean}] con reglas: Modo=${modeLabel}, Dificultad=${diffLabel}, Fuego amigo/JcJ=${pvpLabel}, Crossplay=${crossplayLabel}`);
      return result;
    });
  }

  async activateWorld(worldName) {
    const clean = basename(worldName).replace(/\.sav$/i, "");
    const path = await this.findWorldPath(clean);
    if (!(await exists(path))) throw new Error(`El archivo de mundo para "${clean}" no existe.`);
    return await this.withStoppedServer(async () => {
      this.settings.worldName = clean;
      await atomicWrite(SETTINGS_FILE, `${JSON.stringify(this.settings, null, 2)}\n`);
      const rules = await readWorldRulesFromFile(path).catch(() => null);
      await this.syncDedicatedServerIni(clean, rules || {});
      this.addLog("world", `Mundo activo cambiado a: ${clean}`);
      return { ok: true, worldName: clean };
    });
  }

  async duplicateWorld(worldName, targetName) {
    const sourcePath = await this.findWorldPath(worldName);
    if (!(await exists(sourcePath))) throw new Error(`El mundo "${worldName}" no existe.`);
    const cleanTarget = basename(targetName).replace(/\.sav$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
    if (!cleanTarget) throw new Error("Nombre de destino inválido.");
    const worldDir = await resolveWorldDir();
    const destPath = join(worldDir, `${cleanTarget}.sav`);
    if (await exists(destPath)) throw new Error(`Ya existe un mundo con el nombre "${cleanTarget}".`);
    await copyFile(sourcePath, destPath);
    this.addLog("world", `Mundo duplicado: ${worldName} -> ${cleanTarget}.sav`);
    return { name: `${cleanTarget}.sav`, baseName: cleanTarget };
  }

  getDedicatedServerIniPaths() {
    return [
      join(SERVER_DIR, "RSDragonwilds", "Saved", "Config", "LinuxServer", "DedicatedServer.ini"),
      join(SERVER_DIR, "RSDragonwilds", "Saved", "Config", "WindowsServer", "DedicatedServer.ini"),
    ];
  }

  async listKnownPlayers() {
    const paths = this.getDedicatedServerIniPaths();
    let content = "";
    for (const p of paths) {
      if (await exists(p)) {
        content = await readFile(p, "utf8");
        break;
      }
    }
    const playersMap = new Map();
    if (content) {
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim().startsWith("KnownPlayerList=")) {
          const parsed = parseKnownPlayer(line.trim());
          if (parsed) {
            playersMap.set(parsed.userId, parsed);
          }
        }
      }
    }

    if (this.settings.ownerId && !playersMap.has(this.settings.ownerId)) {
      playersMap.set(this.settings.ownerId, {
        userId: this.settings.ownerId,
        userName: "Owner",
        privileges: 14,
        isAdmin: true,
        isBanned: false,
        isOwner: true,
      });
    }

    for (const p of playersMap.values()) {
      if (p.userId && p.userName) {
        this.knownPlayerNames.set(p.userId.toLowerCase(), p.userName);
      }
    }

    const knownPlayers = Array.from(playersMap.values()).map((p) => {
      const isOnline = this.onlinePlayers.has(p.userId) ||
        [...this.onlinePlayers.values()].some((op) => op.userName.toLowerCase() === p.userName.toLowerCase());
      return {
        ...p,
        isOwner: p.userId === this.settings.ownerId,
        isOnline,
      };
    });

    // Deduplicar onlinePlayers por nombre asegurando que si existe el EOS ID oficial (32 hex) prevalezca
    const dedupedOnlineMap = new Map();
    for (const op of this.onlinePlayers.values()) {
      const key = (op.userName || op.userId || "").toLowerCase();
      const existing = dedupedOnlineMap.get(key);
      if (!existing) {
        dedupedOnlineMap.set(key, op);
      } else if (!/^[0-9a-fA-F]{32}$/.test(existing.userId) && /^[0-9a-fA-F]{32}$/.test(op.userId)) {
        dedupedOnlineMap.set(key, op);
      }
    }

    const onlinePlayers = Array.from(dedupedOnlineMap.values()).map((op) => {
      const known = playersMap.get(op.userId) ||
        [...playersMap.values()].find((kp) => kp.userName.toLowerCase() === op.userName.toLowerCase());
      return {
        ...op,
        isAdmin: Boolean(known?.isAdmin),
        isBanned: Boolean(known?.isBanned),
        isOwner: op.userId === this.settings.ownerId,
      };
    });

    return {
      knownPlayers,
      onlinePlayers,
    };
  }

  async addKnownPlayer(input) {
    const cleanId = cleanText(input.userId, 64).replace(/[^a-zA-Z0-9_-]/g, "");
    const cleanName = cleanText(input.userName, 64);
    if (!cleanId) throw new Error("El Player ID es obligatorio y debe ser alfanumérico.");
    if (!cleanName) throw new Error("El nombre de usuario es obligatorio.");
    const isAdmin = Boolean(input.isAdmin);
    const isBanned = Boolean(input.isBanned);

    const paths = this.getDedicatedServerIniPaths();
    for (const iniPath of paths) {
      await mkdir(dirname(iniPath), { recursive: true });
      let content = (await exists(iniPath)) ? await readFile(iniPath, "utf8") : "";
      const lines = content ? content.split(/\r?\n/) : [];
      let inSection = false;
      let foundExisting = false;
      const newLines = [];
      const formatted = formatKnownPlayer({ userId: cleanId, userName: cleanName, isAdmin, isBanned });

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          if (inSection && !foundExisting) {
            newLines.push(formatted);
            foundExisting = true;
          }
          inSection = trimmed.toLowerCase() === "[/script/dominion.dedicatedserversettings]";
          newLines.push(line);
          continue;
        }
        if (inSection && trimmed.startsWith("KnownPlayerList=")) {
          const parsed = parseKnownPlayer(trimmed);
          if (parsed && parsed.userId === cleanId) {
            newLines.push(formatted);
            foundExisting = true;
            continue;
          }
        }
        newLines.push(line);
      }

      if (!foundExisting) {
        const secIdx = newLines.findIndex((l) => l.trim().toLowerCase() === "[/script/dominion.dedicatedserversettings]");
        if (secIdx >= 0) {
          newLines.splice(secIdx + 1, 0, formatted);
        } else {
          newLines.push("[/Script/Dominion.DedicatedServerSettings]");
          newLines.push(formatted);
        }
      }

      await atomicWrite(iniPath, newLines.join("\n") + "\n", 0o666, GAME_UID, GAME_GID);
      try {
        await chown(iniPath, GAME_UID, GAME_GID);
        await chmod(iniPath, 0o666);
      } catch {}
    }

    this.addLog("panel", `Jugador registrado/actualizado: ${cleanName} (${cleanId}) - Admin=${isAdmin}, Banned=${isBanned}`);
    return {
      userId: cleanId,
      userName: cleanName,
      privileges: isAdmin ? 14 : 0,
      isAdmin,
      isBanned,
      isOwner: cleanId === this.settings.ownerId,
    };
  }

  async updateKnownPlayer(userId, updates = {}) {
    const cleanId = cleanText(userId, 64);
    if (!cleanId) throw new Error("Player ID inválido.");
    const paths = this.getDedicatedServerIniPaths();
    let updatedPlayer = null;

    for (const iniPath of paths) {
      if (!(await exists(iniPath))) continue;
      const content = await readFile(iniPath, "utf8");
      const lines = content.split(/\r?\n/);
      const newLines = [];
      let modified = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("KnownPlayerList=")) {
          const parsed = parseKnownPlayer(trimmed);
          if (parsed && parsed.userId === cleanId) {
            const userName = updates.userName !== undefined ? cleanText(updates.userName, 64) : parsed.userName;
            const isAdmin = updates.isAdmin !== undefined ? Boolean(updates.isAdmin) : parsed.isAdmin;
            const isBanned = updates.isBanned !== undefined ? Boolean(updates.isBanned) : parsed.isBanned;
            updatedPlayer = {
              userId: cleanId,
              userName,
              privileges: isAdmin ? 14 : 0,
              isAdmin,
              isBanned,
              isOwner: cleanId === this.settings.ownerId,
            };
            newLines.push(formatKnownPlayer(updatedPlayer));
            modified = true;
            continue;
          }
        }
        newLines.push(line);
      }

      if (modified) {
        await atomicWrite(iniPath, newLines.join("\n") + "\n", 0o666, GAME_UID, GAME_GID);
        try {
          await chown(iniPath, GAME_UID, GAME_GID);
          await chmod(iniPath, 0o666);
        } catch {}
      }
    }

    if (!updatedPlayer) {
      const userName = updates.userName ? cleanText(updates.userName, 64) : (cleanId === this.settings.ownerId ? "Owner" : cleanId);
      return await this.addKnownPlayer({
        userId: cleanId,
        userName,
        isAdmin: updates.isAdmin !== undefined ? Boolean(updates.isAdmin) : (cleanId === this.settings.ownerId),
        isBanned: Boolean(updates.isBanned),
      });
    }

    if (updatedPlayer.isBanned) {
      this.onlinePlayers.delete(cleanId);
    }
    this.addLog("panel", `Permisos de jugador actualizados: ${updatedPlayer.userName} (${cleanId}) - Admin=${updatedPlayer.isAdmin}, Banned=${updatedPlayer.isBanned}`);
    return updatedPlayer;
  }

  async removeKnownPlayer(userId) {
    const cleanId = cleanText(userId, 64);
    if (!cleanId) throw new Error("Player ID inválido.");
    if (cleanId === this.settings.ownerId) throw new Error("No se puede eliminar al propietario del servidor.");
    const paths = this.getDedicatedServerIniPaths();

    for (const iniPath of paths) {
      if (!(await exists(iniPath))) continue;
      const content = await readFile(iniPath, "utf8");
      const lines = content.split(/\r?\n/);
      const newLines = lines.filter((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("KnownPlayerList=")) {
          const parsed = parseKnownPlayer(trimmed);
          return parsed?.userId !== cleanId;
        }
        return true;
      });
      await atomicWrite(iniPath, newLines.join("\n") + "\n", 0o666, GAME_UID, GAME_GID);
      try {
        await chown(iniPath, GAME_UID, GAME_GID);
        await chmod(iniPath, 0o666);
      } catch {}
    }
    this.onlinePlayers.delete(cleanId);
    this.addLog("panel", `Jugador eliminado de KnownPlayerList: ${cleanId}`);
    return { ok: true };
  }

  async syncEngineIni() {
    const tickRate = Number(this.settings.performance?.tickRate) || 60;
    const enginePaths = [
      join(SERVER_DIR, "RSDragonwilds", "Saved", "Config", "LinuxServer", "Engine.ini"),
      join(SERVER_DIR, "RSDragonwilds", "Saved", "Config", "WindowsServer", "Engine.ini"),
    ];

    for (const iniPath of enginePaths) {
      try {
        await mkdir(dirname(iniPath), { recursive: true });
        let content = (await exists(iniPath)) ? await readFile(iniPath, "utf8") : "";
        content = updateIniSection(content, "/Script/OnlineSubsystemUtils.IpNetDriver", {
          NetServerMaxTickRate: String(tickRate),
          LanServerMaxTickRate: String(tickRate),
          MaxClientRate: "150000",
          MaxInternetClientRate: "150000",
        });
        content = updateIniSection(content, "/Script/Engine.Engine", {
          NetClientTicksPerSecond: String(tickRate),
        });
        content = updateIniSection(content, "Core.Log", {
          LogScript: "Error",
          LogNetPlayerMovement: "Error",
        });
        content = updateIniSection(content, "/Script/Engine.GameNetworkManager", {
          TotalNetBandwidth: "600000",
          MaxDynamicBandwidth: "150000",
          MinDynamicBandwidth: "20000",
        });
        await atomicWrite(iniPath, content, 0o666, GAME_UID, GAME_GID);
        try {
          await chown(iniPath, GAME_UID, GAME_GID);
          await chmod(iniPath, 0o666);
        } catch {}
      } catch (err) {
        this.addLog("panel", `Aviso al sincronizar Engine.ini: ${err.message}`);
      }
    }
  }

  setupBackupSchedule() {
    if (this.backupScheduleTimer) {
      clearInterval(this.backupScheduleTimer);
      this.backupScheduleTimer = null;
    }
    const schedule = this.settings.backupSchedule || "disabled";
    if (schedule === "disabled") return;

    const hours = schedule === "6h" ? 6 : schedule === "12h" ? 12 : 24;
    const ms = hours * 3600 * 1000;
    this.backupScheduleTimer = setInterval(() => {
      this.enqueue(() => this.createBackup(`scheduled-${schedule}`)).catch((err) => {
        this.addLog("backup", `Error en backup programado (${schedule}): ${err.message}`);
      });
    }, ms);
    this.backupScheduleTimer.unref?.();
    this.addLog("backup", `Programación de backups activa: cada ${hours} horas.`);
  }

  setupVpnWatchdog() {
    if (this.vpnWatchdogTimer) {
      clearInterval(this.vpnWatchdogTimer);
      this.vpnWatchdogTimer = null;
    }
    if (this.settings.networkMode !== "wireguard") return;

    this.vpnWatchdogTimer = setInterval(async () => {
      try {
        if (this.settings.networkMode !== "wireguard") return;
        const vpn = await this.vpnStatus();
        if (!vpn.active) return;
        if (vpn.handshakeAgeSec !== null && vpn.handshakeAgeSec > 180) {
          if (this.serverState === "running" || this.desiredRunning) {
            this.addLog("vpn", `Watchdog: WireGuard handshake inactivo por ${vpn.handshakeAgeSec}s (>180s). Reconectando interfaz...`);
            await this.applyVpn();
          }
        }
      } catch {}
    }, 30_000);
    this.vpnWatchdogTimer.unref?.();
  }

  async getMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
    const nodeRss = process.memoryUsage().rss;

    let gameCpu = 0;
    let gameMemMb = 0;
    if (this.child?.pid) {
      try {
        const res = await command("ps", ["-p", String(this.child.pid), "-o", "%cpu,rss", "--no-headers"], { allowFailure: true });
        if (res.code === 0 && res.stdout) {
          const parts = res.stdout.trim().split(/\s+/);
          gameCpu = parseFloat(parts[0]) || 0;
          gameMemMb = Math.round((parseInt(parts[1], 10) || 0) / 1024);
        }
      } catch {}
    }

    return {
      system: {
        totalMemMb: Math.round(totalMem / (1024 * 1024)),
        usedMemMb: Math.round(usedMem / (1024 * 1024)),
        freeMemMb: Math.round(freeMem / (1024 * 1024)),
        memPercent,
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg(),
      },
      process: {
        pid: this.child?.pid || null,
        running: Boolean(this.child),
        cpuPercent: gameCpu,
        memoryMb: gameMemMb,
      },
      panel: {
        memoryMb: Math.round(nodeRss / (1024 * 1024)),
      },
    };
  }

  async vpnStatus() {
    if (process.env.MOCK_GAME === "1") {
      return {
        active: this.settings.networkMode === "wireguard",
        handshakeAt: null,
        handshakeAgeSec: null,
        healthy: this.settings.networkMode === "wireguard",
        endpoint: this.settings.vpn.endpoint,
        transfer: "simulado",
      };
    }
    const result = await command("wg", ["show", "wg-vps", "dump"], { allowFailure: true });
    if (result.code !== 0) {
      return {
        active: false,
        handshakeAt: null,
        handshakeAgeSec: null,
        healthy: false,
        endpoint: this.settings.vpn.endpoint,
        transfer: "0 B",
      };
    }
    const lines = result.stdout.split("\n");
    const peer = lines[1]?.split("\t") || [];
    const handshake = Number(peer[4] || 0);
    const handshakeAgeSec = handshake ? Math.max(0, Math.floor((Date.now() - handshake * 1000) / 1000)) : null;
    const healthy = handshakeAgeSec === null || handshakeAgeSec < 180;
    return {
      active: true,
      endpoint: peer[2] || this.settings.vpn.endpoint,
      handshakeAt: handshake ? new Date(handshake * 1000).toISOString() : null,
      handshakeAgeSec,
      healthy,
      received: Number(peer[5] || 0),
      sent: Number(peer[6] || 0),
    };
  }

  async publicIp() {
    if (process.env.MOCK_GAME === "1") return "203.0.113.10";
    const result = await command("setpriv", [
      `--reuid=${GAME_UID}`,
      `--regid=${GAME_GID}`,
      "--clear-groups",
      "curl",
      "-4fsS",
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      "https://icanhazip.com",
    ], { allowFailure: true });
    return result.code === 0 ? result.stdout : null;
  }

  vpsRules() {
    const address = this.settings.vpn.address.split("/")[0];
    const ports = [GAME_PORT, BEACON_PORT];
    const up = ports.flatMap((port) => [
      `iptables -t nat -A PREROUTING -i eth0 -p udp --dport ${port} -j DNAT --to-destination ${address}:${port}`,
      `iptables -t nat -A POSTROUTING -o wg0 -d ${address} -p udp --dport ${port} -j MASQUERADE`,
    ]);
    const down = up.map((line) => line.replace(" -A ", " -D "));
    return {
      ports,
      postUp: [
        "iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE",
        "iptables -A FORWARD -i wg0 -j ACCEPT",
        "iptables -A FORWARD -o wg0 -j ACCEPT",
        ...up,
      ].join("; "),
      postDown: [
        ...down.reverse(),
        "iptables -D FORWARD -o wg0 -j ACCEPT",
        "iptables -D FORWARD -i wg0 -j ACCEPT",
        "iptables -t nat -D POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE",
      ].join("; "),
    };
  }

  async status() {
    const [vpn, worlds, backups, metrics, knownData] = await Promise.all([
      this.vpnStatus(),
      this.listWorlds(),
      this.listBackups(),
      this.getMetrics(),
      this.listKnownPlayers().catch(() => ({ knownPlayers: [], onlinePlayers: [] })),
    ]);
    return {
      configured: this.settings.configured,
      server: {
        state: this.serverState,
        message: this.serverMessage,
        startedAt: this.startedAt,
        gamePort: GAME_PORT,
        beaconPort: BEACON_PORT,
      },
      vpn,
      worlds,
      backupCount: backups.length,
      latestBackup: backups[0] || null,
      backupSchedule: this.settings.backupSchedule || "disabled",
      performance: this.settings.performance || { tickRate: 60 },
      onlinePlayers: knownData.onlinePlayers || Array.from(this.onlinePlayers.values()),
      playerCount: (knownData.onlinePlayers || Array.from(this.onlinePlayers.values())).length,
      maxPlayers: 6,
      metrics,
      logs: this.getLogs("all", 150),
    };
  }
}
