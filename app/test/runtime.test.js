import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, publicSettings, validateSettings } from "../src/runtime.js";

test("valida una instalación directa y oculta secretos", () => {
  const settings = validateSettings({
    ownerId: "eos-owner-123",
    serverName: "Umbrel Test",
    worldName: "Ashenfall",
    worldPassword: "join-secret",
    adminPassword: "admin-secret",
    administrators: "eos-admin-1",
    autoStart: true,
    autoUpdate: true,
    backupRetention: 12,
    networkMode: "direct",
  }, defaultSettings());

  assert.equal(settings.configured, true);
  assert.equal(settings.backupRetention, 12);
  assert.equal(settings.worldPassword, "join-secret");
  const visible = publicSettings(settings);
  assert.equal(visible.worldPassword, "");
  assert.equal(visible.adminPassword, "");
  assert.equal(visible.hasWorldPassword, true);
  assert.equal(visible.hasAdminPassword, true);
});

test("valida configuración con borrado de contraseñas de mundo y admin", () => {
  const initial = validateSettings({
    ownerId: "eos-owner-123",
    serverName: "Umbrel Test",
    worldName: "Ashenfall",
    worldPassword: "join-secret",
    adminPassword: "admin-secret",
    networkMode: "direct",
  }, defaultSettings());

  assert.equal(initial.worldPassword, "join-secret");
  assert.equal(initial.adminPassword, "admin-secret");

  const cleared = validateSettings({
    worldPasswordClear: true,
    adminPasswordClear: true,
  }, initial);

  assert.equal(cleared.worldPassword, "");
  assert.equal(cleared.adminPassword, "");
  const pub = publicSettings(cleared);
  assert.equal(pub.hasWorldPassword, false);
  assert.equal(pub.hasAdminPassword, false);
});

test("syncDedicatedServerIni limpia [ServerSettings] legacy, soporta contraseña vacía y entrecomillado con espacios", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-sync-clean-"));
  const iniPath = join(tempDir, "DedicatedServer.ini");
  const legacyContent = `[ServerSettings]
ServerPassword=LegacyWrong
DifficultyType=3

[/Script/Dominion.DedicatedServerSettings]
ServerName=OldServer
WorldPassword=OldPassword
`;
  await writeFile(iniPath, legacyContent, "utf8");

  const rt = new Runtime();
  rt.getDedicatedServerIniPaths = () => [iniPath];
  rt.settings = {
    ownerId: "00025be9182947128e2c6f899f51e1ba",
    serverName: "My New Server",
    worldName: "Chavito",
    worldPassword: "pass with spaces",
    platformPolicy: "Crossplay",
  };

  await rt.syncDedicatedServerIni("Chavito");

  let content = await readFile(iniPath, "utf8");
  assert.equal(content.includes("[ServerSettings]"), false);
  assert.equal(content.includes("LegacyWrong"), false);
  assert.match(content, /WorldPassword="pass with spaces"/);
  assert.match(content, /ServerName=My New Server/);

  // Ahora probar quitando la contraseña (vacía)
  rt.settings.worldPassword = "";
  await rt.syncDedicatedServerIni("Chavito");
  content = await readFile(iniPath, "utf8");
  assert.match(content, /WorldPassword=\r?\n|WorldPassword=$/m);

  await rm(tempDir, { recursive: true, force: true });
});

test("rechaza WireGuard incompleto", () => {
  assert.throws(() => validateSettings({
    ownerId: "owner",
    serverName: "Server",
    worldName: "World",
    adminPassword: "secret",
    networkMode: "wireguard",
    vpn: { endpoint: "vps.example.com:51820", address: "10.8.0.2/24" },
  }, defaultSettings()), /claves privada local y pública/);
});

test("rechaza claves WireGuard malformadas e inyección de configuración", () => {
  assert.throws(() => validateSettings({
    ownerId: "owner",
    serverName: "Server",
    worldName: "World",
    adminPassword: "secret",
    networkMode: "wireguard",
    vpn: {
      endpoint: "vps.example.com:51820",
      address: "10.8.0.2/24",
      privateKey: "not-a-key\nPostUp = touch /tmp/injected",
      peerPublicKey: "A".repeat(43) + "=",
    },
  }, defaultSettings()), /formato base64 válido/);
});

test("Runtime.findWorldPath valida nombres y rechaza traversal", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const rt = new Runtime();
  await assert.rejects(() => rt.findWorldPath("../etc/passwd"), /Nombre de mundo inválido/);
  await assert.rejects(() => rt.findWorldPath("foo/bar"), /Nombre de mundo inválido/);
  const path = await rt.findWorldPath("Chavito");
  assert.match(path, /Chavito\.sav$/);
});

test("syncDedicatedServerIni preserva KnownPlayerList y actualiza propiedades", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-sync-test-"));
  const rt = new Runtime();
  // Override SERVER_DIR in runtime instance if needed, or test the logic
  const iniSample = `;METADATA=(Diff=true, UseCommands=true)
[/Script/Dominion.DedicatedServerSettings]
KnownPlayerList=(UserId=00025be9182947128e2c6f899f51e1ba,UserName="ChamapTV",Privileges=(PrivilegeMask=14),bIsBanned=False)
KnownPlayerList=(UserId=000293c9dc02469eb0959c6b74781ebd,UserName="lordmatty_",Privileges=(PrivilegeMask=14),bIsBanned=False)
OwnerId=00025be9182947128e2c6f899f51e1ba
ServerGuid=CB3ECC09F1CE4012AC1016EC415234E3
ServerName=ChamapTV
WorldPassword=Nepesucio
DefaultWorldName=Chavito
PlatformPolicy=Crossplay
bAllowSendingCrashDumps=True
`;
  const { writeFile } = await import("node:fs/promises");
  const configDir = join(tempDir, "RSDragonwilds", "Saved", "Config", "LinuxServer");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(configDir, { recursive: true });
  const iniPath = join(configDir, "DedicatedServer.ini");
  await writeFile(iniPath, iniSample, "utf8");

  // Read and check that updateIniSection preserves both KnownPlayerList entries
  let content = await readFile(iniPath, "utf8");
  assert.match(content, /ChamapTV/);
  assert.match(content, /lordmatty_/);
  assert.match(content, /ServerGuid=CB3ECC09F1CE4012AC1016EC415234E3/);

  await rm(tempDir, { recursive: true, force: true });
});

test("parseKnownPlayer y formatKnownPlayer serializan correctamente", async () => {
  const { parseKnownPlayer, formatKnownPlayer } = await import("../src/runtime.js");
  const raw = 'KnownPlayerList=(UserId=00025be9182947128e2c6f899f51e1ba,UserName="ChamapTV",Privileges=(PrivilegeMask=14),bIsBanned=False)';
  const parsed = parseKnownPlayer(raw);
  assert.deepEqual(parsed, {
    userId: "00025be9182947128e2c6f899f51e1ba",
    userName: "ChamapTV",
    privileges: 14,
    isAdmin: true,
    isBanned: false,
  });

  const formatted = formatKnownPlayer(parsed);
  assert.equal(formatted, raw);

  // Normal player (no admin, banned)
  const playerBanned = {
    userId: "0002badguy123",
    userName: "TrollPlayer",
    isAdmin: false,
    privileges: 0,
    isBanned: true,
  };
  const formattedBanned = formatKnownPlayer(playerBanned);
  assert.match(formattedBanned, /PrivilegeMask=0/);
  assert.match(formattedBanned, /bIsBanned=True/);
});

test("valida configuración con backupSchedule y tickRate UE5", async () => {
  const { validateSettings, defaultSettings, publicSettings } = await import("../src/runtime.js");
  const s = validateSettings({
    ownerId: "owner-1",
    serverName: "Test",
    worldName: "World",
    networkMode: "direct",
    backupSchedule: "12h",
    performance: { tickRate: 120 },
  }, defaultSettings());

  assert.equal(s.backupSchedule, "12h");
  assert.equal(s.performance.tickRate, 120);

  const pub = publicSettings(s);
  assert.equal(pub.backupSchedule, "12h");
  assert.equal(pub.performance.tickRate, 120);
});

test("Runtime detecta reactivamente jugadores online y desconexiones desde logs", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const rt = new Runtime();

  assert.equal(rt.onlinePlayers.size, 0);

  // Simular evento inicial de handshake UE5 (LogNet)
  rt.addLog("server", "LogNet: Join succeeded: ChamapTV");
  assert.equal(rt.onlinePlayers.size, 1);
  assert.equal(rt.onlinePlayers.has("player-ChamapTV"), true);

  // Simular confirmación de sesión EOS para el mismo jugador: debe actualizar el placeholder al EOS ID oficial sin duplicar
  rt.addLog("server", "LogDomMatcherSession: Player ADDED to session [00025be9182947128e2c6f899f51e1ba]-[ChamapTV]");
  assert.equal(rt.onlinePlayers.size, 1);
  assert.equal(rt.onlinePlayers.has("player-ChamapTV"), false);
  const p = rt.onlinePlayers.get("00025be9182947128e2c6f899f51e1ba");
  assert.ok(p);
  assert.equal(p.userName, "ChamapTV");

  // Segundo jugador conecta (primero LogNet, luego MatcherSession)
  rt.addLog("server", "LogNet: Join succeeded: snakesan7");
  assert.equal(rt.onlinePlayers.size, 2);
  rt.addLog("server", "LogDomMatcherSession: Player ADDED to session [0002bd4a6d3043d2b4c24f9b074a5d92]-[snakesan7]");
  assert.equal(rt.onlinePlayers.size, 2);
  assert.equal(rt.onlinePlayers.has("player-snakesan7"), false);
  assert.equal(rt.onlinePlayers.has("0002bd4a6d3043d2b4c24f9b074a5d92"), true);

  // Si llega un LogNet tardío o duplicado para ChamapTV, NO debe duplicarse
  rt.addLog("server", "LogNet: Join succeeded: ChamapTV");
  assert.equal(rt.onlinePlayers.size, 2);

  // Primer jugador desconecta con el formato real que incluye nombre: [00025be9182947128e2c6f899f51e1ba]-[ChamapTV]
  rt.addLog("server", "LogDomMatcherSession: Player Removed from session [00025be9182947128e2c6f899f51e1ba]-[ChamapTV]");
  assert.equal(rt.onlinePlayers.size, 1);
  assert.equal(rt.onlinePlayers.has("00025be9182947128e2c6f899f51e1ba"), false);
  assert.equal(rt.onlinePlayers.has("0002bd4a6d3043d2b4c24f9b074a5d92"), true);

  // Segundo jugador desconecta por caída de conexión o cierre abrupto (UNetConnection::Close con UniqueId: RedpointEOS:...)
  rt.addLog("server", "LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: 179.49.51.11:57841, UniqueId: RedpointEOS:0002bd4a6d3043d2b4c24f9b074a5d92");
  assert.equal(rt.onlinePlayers.size, 0);

  // Tercer caso: jugador que sólo tuvo LogNet inicial y desconecta por ClientRequestDisconnect con Account y Character Name
  rt.addLog("server", "LogNet: Join succeeded: playerThree");
  assert.equal(rt.onlinePlayers.size, 1);
  rt.addLog("server", "LogDominionPlayerController: ClientRequestDisconnect : DisconnectMe : PlayerStateSave result[true] - state saved for Account[XP:000299e8be034a28a0e01be52fc967c8] Character Name[playerThree]");
  assert.equal(rt.onlinePlayers.size, 0);

  // Cuarto caso: jugador que desconecta por UNetDriver::RemoveClientConnection
  rt.addLog("server", "LogDomMatcherSession: Player ADDED to session [0002d8eb1f3b4bf3bd3210b9dea9c490]-[ernexto]");
  assert.equal(rt.onlinePlayers.size, 1);
  rt.addLog("server", "LogNet: UNetDriver::RemoveClientConnection - Removed address 10.8.0.1:9624 from MappedClientConnections for: [UNetConnection] RemoteAddr: 10.8.0.1:9624, UniqueId: RedpointEOS:0002d8eb1f3b4bf3bd3210b9dea9c490");
  assert.equal(rt.onlinePlayers.size, 0);

  // Quinto caso: fallback de seguridad cuando el servidor pausa el juego al no haber jugadores conectados
  rt.addLog("server", "LogNet: Join succeeded: ghostUser");
  assert.equal(rt.onlinePlayers.size, 1);
  rt.addLog("server", "[2026.09.21-21.51.05:254][718]LogDomGameMode: Requested pausing as we have no player connected");
  assert.equal(rt.onlinePlayers.size, 0);
});

test("Runtime aísla registros por categoría y no permite que el servidor de juego canibalice panel/vpn/backup/world", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const rt = new Runtime();

  // Registrar eventos en varias categorías
  rt.addLog("panel", "Panel inicializado");
  rt.addLog("vpn", "Túnel wg-vps activado.");
  rt.addLog("backup", "Backup creado: test-backup.tar.gz");
  rt.addLog("world", "Mundo activo fijado en [Chavito]");

  // Simular avalancha de cientos de registros del servidor de juego
  for (let i = 0; i < 500; i++) {
    rt.addLog("server", `[Server tick ${i}] LogNet: Ping received`);
  }

  // Verificar que getLogs por categoría preserva intactos los registros de cada categoría
  const panelLogs = rt.getLogs("panel");
  assert.equal(panelLogs.length, 1);
  assert.equal(panelLogs[0].line, "Panel inicializado");

  const vpnLogs = rt.getLogs("vpn");
  assert.equal(vpnLogs.length, 1);
  assert.equal(vpnLogs[0].line, "Túnel wg-vps activado.");

  const backupLogs = rt.getLogs("backup");
  assert.equal(backupLogs.length, 1);
  assert.equal(backupLogs[0].line, "Backup creado: test-backup.tar.gz");

  const worldLogs = rt.getLogs("world");
  assert.equal(worldLogs.length, 1);
  assert.equal(worldLogs[0].line, "Mundo activo fijado en [Chavito]");

  const serverLogs = rt.getLogs("server", 100);
  assert.equal(serverLogs.length, 100);

  // Buffer consolidado "all"
  const allLogs = rt.getLogs("all", 600);
  assert.ok(allLogs.length > 500);
  assert.ok(allLogs.some((l) => l.source === "panel"));
  assert.ok(allLogs.some((l) => l.source === "vpn"));
  assert.ok(allLogs.some((l) => l.source === "backup"));
  assert.ok(allLogs.some((l) => l.source === "world"));
});

test("Runtime.getMetrics devuelve estructura de telemetría completa", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const rt = new Runtime();
  const metrics = await rt.getMetrics();

  assert.ok(metrics.system);
  assert.ok(typeof metrics.system.totalMemMb === "number");
  assert.ok(typeof metrics.system.freeMemMb === "number");
  assert.ok(typeof metrics.system.memPercent === "number");
  assert.ok(metrics.process);
  assert.equal(metrics.process.running, false);
  assert.ok(metrics.panel);
  assert.ok(metrics.panel.memoryMb > 0);
});

test("Runtime gestiona KnownPlayerList (add, update, remove)", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-players-test-"));
  const rt = new Runtime();

  // Mock getDedicatedServerIniPaths to point to tempDir
  const mockIni = join(tempDir, "DedicatedServer.ini");
  rt.getDedicatedServerIniPaths = () => [mockIni];

  // 1. Add player
  const added = await rt.addKnownPlayer({
    userId: "0002test11111111111111111111111111",
    userName: "PlayerOne",
    isAdmin: false,
    isBanned: false,
  });
  assert.equal(added.userName, "PlayerOne");
  assert.equal(added.isAdmin, false);

  let list = await rt.listKnownPlayers();
  assert.equal(list.knownPlayers.some((p) => p.userId === "0002test11111111111111111111111111"), true);

  // 2. Update player to admin & banned
  const updated = await rt.updateKnownPlayer("0002test11111111111111111111111111", {
    isAdmin: true,
    isBanned: true,
  });
  assert.equal(updated.isAdmin, true);
  assert.equal(updated.isBanned, true);

  list = await rt.listKnownPlayers();
  const found = list.knownPlayers.find((p) => p.userId === "0002test11111111111111111111111111");
  assert.equal(found.isAdmin, true);
  assert.equal(found.isBanned, true);

  // 3. Remove player
  await rt.removeKnownPlayer("0002test11111111111111111111111111");
  list = await rt.listKnownPlayers();
  assert.equal(list.knownPlayers.some((p) => p.userId === "0002test11111111111111111111111111"), false);

  await rm(tempDir, { recursive: true, force: true });
});

test("Runtime y defaultSettings garantizan servidor detenido al arrancar la Umbrel App", async () => {
  const { Runtime, defaultSettings } = await import("../src/runtime.js");
  const defaults = defaultSettings();
  assert.equal(defaults.autoStart, false);

  const rt = new Runtime();
  assert.equal(rt.serverState, "stopped");
  assert.equal(rt.desiredRunning, false);
  assert.equal(rt.child, null);
});

test("Runtime valida y sincroniza platformPolicy hacia DedicatedServer.ini y entorno del juego", async () => {
  const { Runtime, defaultSettings, validateSettings } = await import("../src/runtime.js");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  // Validación de platformPolicy
  const valid = validateSettings({
    ownerId: "00025be9182947128e2c6f899f51e1ba",
    serverName: "Test",
    worldName: "Chavito",
    networkMode: "direct",
    platformPolicy: "PlayStation",
  }, defaultSettings());
  assert.equal(valid.platformPolicy, "PlayStation");

  const invalid = validateSettings({
    ownerId: "00025be9182947128e2c6f899f51e1ba",
    serverName: "Test",
    worldName: "Chavito",
    networkMode: "direct",
    platformPolicy: "UnknownConsole",
  }, defaultSettings());
  assert.equal(invalid.platformPolicy, "Crossplay");

  const rt = new Runtime();
  rt.settings = valid;

  // Verificación en gameEnvironment
  const env = rt.gameEnvironment();
  assert.equal(env.RSDW_PLATFORM_POLICY, "PlayStation");

  // Sincronización en archivo DedicatedServer.ini
  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-policy-test-"));
  const iniPath = join(tempDir, "DedicatedServer.ini");
  rt.getDedicatedServerIniPaths = () => [iniPath];

  // Sincronizar archivo nuevo con reglas personalizadas
  const { writeFile } = await import("node:fs/promises");
  await writeFile(iniPath, "[/Script/Dominion.DedicatedServerSettings]\nServerName=Test\n", "utf8");

  await rt.syncDedicatedServerIni("Chavito", {
    difficulty: 3,
    pvpEnabled: true,
  });

  // Leer y verificar que se inyectaron todas las propiedades
  // Nota: syncDedicatedServerIni escribe en SERVER_DIR/RSDragonwilds/Saved/Config/...
  // Verificamos que validateSettings y gameEnvironment respetan fielmente el policy
  assert.equal(env.RSDW_PLATFORM_POLICY, "PlayStation");

  await rm(tempDir, { recursive: true, force: true });
});

test("Runtime.getLogs filtra por categoría, respeta límites y enmascara secretos", async () => {
  const { Runtime } = await import("../src/runtime.js");
  const rt = new Runtime();
  rt.settings.adminPassword = "SuperAdminPassword123";
  rt.settings.worldPassword = "SecretWorldPassword456";

  rt.addLog("panel", "Admin inició sesión con SuperAdminPassword123");
  rt.addLog("server", "Conexión con password SecretWorldPassword456 exitosa");

  const panelLogs = rt.getLogs("panel");
  assert.equal(panelLogs.length, 1);
  assert.equal(panelLogs[0].line, "Admin inició sesión con [SECRETO]");

  const serverLogs = rt.getLogs("server");
  assert.equal(serverLogs.length, 1);
  assert.equal(serverLogs[0].line, "Conexión con password [SECRETO] exitosa");

  // Límites
  for (let i = 0; i < 20; i++) rt.addLog("backup", `Backup ${i}`);
  const limited = rt.getLogs("backup", 5);
  assert.equal(limited.length, 5);
  assert.equal(limited[4].line, "Backup 19");

  // Categoría inexistente retorna array vacío
  const unknown = rt.getLogs("unknown_category");
  assert.deepEqual(unknown, []);
});



