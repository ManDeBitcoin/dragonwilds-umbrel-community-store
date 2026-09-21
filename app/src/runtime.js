import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  chmod,
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
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";
import {
  readWorldRulesFromFile,
  updateWorldRulesInFile,
  DIFFICULTY_LABELS,
  PVP_LABELS,
} from "./world-editor.js";

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
const GAME_ENTRY = process.env.GAME_ENTRY || "/entry.sh";

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
  ownerId: "",
  serverName: "Dragonwilds en Umbrel",
  worldName: "Ashenfall",
  worldPassword: "",
  adminPassword: "",
  administrators: "",
  autoStart: true,
  autoUpdate: true,
  backupRetention: 10,
  networkMode: "wireguard",
  vpn: {
    address: "10.8.0.2/24",
    listenPort: 51831,
    privateKey: "",
    peerPublicKey: "",
    presharedKey: "",
    endpoint: "",
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

function validateIpCidr(value) {
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length || isIP(address) !== 4 || !/^\d{1,2}$/.test(prefix || "")) return false;
  return Number(prefix) >= 0 && Number(prefix) <= 32;
}

function validateEndpoint(value) {
  return /^\[[0-9a-fA-F:]+\]:\d{1,5}$/.test(value) || /^[a-zA-Z0-9.-]+:\d{1,5}$/.test(value);
}

export function validateSettings(input, current = defaultSettings()) {
  const next = structuredClone(current);
  next.ownerId = cleanText(input.ownerId, 128);
  next.serverName = cleanText(input.serverName, 80);
  next.worldName = cleanText(input.worldName, 80);
  next.administrators = cleanText(input.administrators, 2048);
  next.autoStart = Boolean(input.autoStart);
  next.autoUpdate = Boolean(input.autoUpdate);
  next.networkMode = input.networkMode === "direct" ? "direct" : "wireguard";
  next.backupRetention = Math.min(50, Math.max(1, Number(input.backupRetention) || 10));

  for (const key of SECRET_KEYS) {
    if (Object.hasOwn(input, key) && input[key] !== "") next[key] = cleanText(input[key], 256);
    if (input[`${key}Clear`] === true) next[key] = "";
  }

  if (!next.ownerId) throw new Error("El Player ID del propietario es obligatorio.");
  if (!next.serverName) throw new Error("El nombre del servidor es obligatorio.");
  if (!next.worldName) throw new Error("El nombre del mundo es obligatorio.");
  if (!next.adminPassword) throw new Error("La contraseña de administración del juego es obligatoria.");

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
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("error", rejectCommand);
    child.once("close", (code) => {
      const result = { code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() };
      if (result.code === 0 || options.allowFailure) resolveCommand(result);
      else rejectCommand(new Error(result.stderr || `${commandName} terminó con código ${result.code}`));
    });
  });
}

async function atomicWrite(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, contents, { mode });
  await rename(temp, path);
  await chmod(path, mode);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class Runtime {
  constructor() {
    this.settings = defaultSettings();
    this.child = null;
    this.desiredRunning = false;
    this.serverState = "stopped";
    this.serverMessage = "Sin configurar";
    this.startedAt = null;
    this.logs = [];
    this.operation = Promise.resolve();
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
    }
    if (this.settings.configured && this.settings.autoStart) {
      setTimeout(() => this.enqueue(() => this.start()).catch(() => {}), 800);
    }
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
    this.logs.push({ at: new Date().toISOString(), source, line: safe.slice(0, 4000) });
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
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
    this.addLog("panel", "Configuración guardada.");
    return publicSettings(this.settings);
  }

  gameEnvironment(validate = false) {
    return {
      ...process.env,
      HOME: "/home/steam",
      RSDW_OWNER_ID: this.settings.ownerId,
      RSDW_SERVER_NAME: this.settings.serverName,
      RSDW_WORLD_NAME: this.settings.worldName,
      RSDW_PASSWORD: this.settings.worldPassword,
      RSDW_ADMIN_PASSWORD: this.settings.adminPassword,
      RSDW_ADMINS: this.settings.administrators,
      RSDW_PORT: String(GAME_PORT),
      RSDW_AUTO_STOP_ON_UPDATE: this.settings.autoUpdate ? "true" : "false",
      STEAMAPPVALIDATE: validate ? "1" : "0",
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
    this.serverMessage = options.validate ? "Validando archivos y arrancando" : "Actualizando y arrancando";
    await this.applyVpn();
    await mkdir(WORLD_DIR, { recursive: true });

    const executable = process.env.MOCK_GAME === "1" ? process.execPath : GAME_ENTRY;
    const args = process.env.MOCK_GAME === "1"
      ? ["-e", "console.log('Mock Dragonwilds online'); setInterval(()=>console.log('heartbeat'), 2000)"]
      : [];
    this.child = spawn(executable, args, {
      env: this.gameEnvironment(Boolean(options.validate)),
      cwd: process.env.MOCK_GAME === "1" ? process.cwd() : "/home/steam",
      uid: process.env.MOCK_GAME === "1" ? undefined : GAME_UID,
      gid: process.env.MOCK_GAME === "1" ? undefined : GAME_GID,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.startedAt = new Date().toISOString();
    this.child.stdout.on("data", (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((line) => this.addLog("server", line)));
    this.child.stderr.on("data", (chunk) => chunk.toString().split("\n").filter(Boolean).forEach((line) => this.addLog("server", line)));
    this.child.once("spawn", () => {
      this.serverState = "running";
      this.serverMessage = `Escuchando en UDP ${GAME_PORT} y ${BEACON_PORT}`;
      this.addLog("panel", "Proceso del servidor iniciado.");
    });
    this.child.once("error", (error) => {
      this.serverState = "error";
      this.serverMessage = error.message;
      this.addLog("panel", `No se pudo arrancar: ${error.message}`);
      this.child = null;
    });
    this.child.once("exit", (code, signal) => {
      this.addLog("panel", `Servidor detenido (código ${code ?? "-"}, señal ${signal ?? "-"}).`);
      this.child = null;
      this.startedAt = null;
      if (this.desiredRunning) {
        this.serverState = "starting";
        this.serverMessage = "Reinicio automático en 5 segundos";
        setTimeout(() => this.enqueue(() => this.start()).catch((error) => {
          this.serverState = "error";
          this.serverMessage = error.message;
        }), 5000);
      } else {
        this.serverState = "stopped";
        this.serverMessage = "Servidor detenido";
      }
    });
  }

  async stop() {
    this.desiredRunning = false;
    if (!this.child) {
      this.serverState = "stopped";
      this.serverMessage = "Servidor detenido";
      return;
    }
    this.serverState = "stopping";
    this.serverMessage = "Guardando y deteniendo";
    const child = this.child;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveStop) => child.once("exit", resolveStop)),
      new Promise((resolveStop) => setTimeout(resolveStop, 45_000)),
    ]);
    if (this.child === child) child.kill("SIGKILL");
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
    if (await exists(primary)) return primary;
    if (await exists(fallback)) return fallback;
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
            difficulty: 1,
            difficultyLabel: DIFFICULTY_LABELS[1],
            pvpEnabled: false,
            pvpLabel: PVP_LABELS[0],
          })),
        ]);
        worldsMap.set(entry.name, {
          name: entry.name,
          baseName: entry.name.replace(/\.sav$/i, ""),
          size: info.size,
          updatedAt: info.mtime.toISOString(),
          active: entry.name.replace(/\.sav$/i, "") === this.settings.worldName,
          rules: {
            difficulty: rules.difficulty ?? 1,
            difficultyLabel: rules.difficultyLabel ?? "Normal",
            pvpEnabled: Boolean(rules.pvpEnabled),
            pvpLabel: rules.pvpLabel ?? (rules.pvpEnabled ? "Activado (JcJ)" : "Desactivado (Coop)"),
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

  async updateWorldRules(worldName, rules) {
    const path = await this.findWorldPath(worldName);
    if (!(await exists(path))) throw new Error(`El mundo "${worldName}" no existe.`);
    return await this.withStoppedServer(async () => {
      await this.createBackup(`pre-rules-${worldName}`, { serverAlreadyStopped: true });
      const result = await updateWorldRulesInFile(path, rules);
      const diffLabel = DIFFICULTY_LABELS[rules.difficulty] ?? rules.difficulty;
      const pvpLabel = rules.pvpEnabled ? "Activado" : "Desactivado";
      this.addLog("world", `Reglas de [${worldName}] actualizadas: Dificultad=${diffLabel}, Fuego amigo/JcJ=${pvpLabel}`);
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

  async vpnStatus() {
    if (process.env.MOCK_GAME === "1") {
      return { active: this.settings.networkMode === "wireguard", handshakeAt: null, endpoint: this.settings.vpn.endpoint, transfer: "simulado" };
    }
    const result = await command("wg", ["show", "wg-vps", "dump"], { allowFailure: true });
    if (result.code !== 0) return { active: false, handshakeAt: null, endpoint: this.settings.vpn.endpoint, transfer: "0 B" };
    const lines = result.stdout.split("\n");
    const peer = lines[1]?.split("\t") || [];
    const handshake = Number(peer[4] || 0);
    return {
      active: true,
      endpoint: peer[2] || this.settings.vpn.endpoint,
      handshakeAt: handshake ? new Date(handshake * 1000).toISOString() : null,
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
    const [vpn, worlds, backups] = await Promise.all([this.vpnStatus(), this.listWorlds(), this.listBackups()]);
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
      logs: this.logs.slice(-120),
    };
  }
}
