import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayerDatabase } from "../src/player-database.js";
import { extractWorldStatsFromFile } from "../src/stats-extractor.js";

test("PlayerDatabase: guarda y carga atómicamente en disco", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-db-test-"));
  const dbFile = join(tempDir, "player-database.json");

  const db = new PlayerDatabase(dbFile);
  await db.load();

  db.recordAction("Chavito", "Matty", "Subió al nivel 50", "level_up");
  await db.save();

  const content = JSON.parse(await readFile(dbFile, "utf8"));
  assert.equal(content.version, 1);
  assert.ok(content.worlds.Chavito);
  assert.equal(content.worlds.Chavito.actionLog.length, 1);
  assert.equal(content.worlds.Chavito.actionLog[0].player, "Matty");

  // Recargar en una nueva instancia
  const db2 = new PlayerDatabase(dbFile);
  await db2.load();
  const log = db2.getActionLog("Chavito");
  assert.equal(log.length, 1);
  assert.equal(log[0].player, "Matty");

  await rm(tempDir, { recursive: true, force: true });
});

test("PlayerDatabase: preserva estadísticas históricas de jugadores desconectados y NO los pone en cero", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-db-offline-"));
  const dbFile = join(tempDir, "player-database.json");

  const db = new PlayerDatabase(dbFile);

  // 1. Simular sesión inicial donde el jugador 'Snaker' estuvo online y progresó
  const session1Players = [
    {
      name: "Snaker",
      guid: "000299e8be034a28a0e01be52fc967c8",
      platform: "PS5",
      isHardcore: false,
      totalXp: 85000,
      totalLevel: 45,
      playtimeSeconds: 36000,
      playtimeHours: 10.0,
      uniqueKillsCount: 15,
      uniqueKills: ["Goblin", "Dragon_Green", "Skeleton_Mage"],
      shrinesCount: 3,
      shrinesUnlocked: ["Shrine_Lumbridge", "Shrine_Varrock", "Shrine_Falador"],
      spellsCount: 5,
      spellsUnlocked: ["Fireball", "Teleport"],
      journalCount: 120,
      journalEntries: ["Recipe_IronSword", "Recipe_Bread"],
      structuresBuilt: 8,
      namedChests: ["Cofre Principal"],
      walkedDistanceMeters: 12500,
      skills: [
        { id: "Combat", xp: 50000, level: 35 },
        { id: "Mining", xp: 35000, level: 30 },
      ],
      registeredOnly: false,
    },
  ];

  await db.mergeWorldStats("Chavito", session1Players, new Set(["Snaker"]));

  // Verificar que se guardó correctamente
  const saved = db.getWorldData("Chavito").players["Snaker"];
  assert.equal(saved.totalXp, 85000);
  assert.equal(saved.totalLevel, 45);
  assert.equal(saved.isOnline, true);

  // 2. Simular sesión posterior donde Snaker está OFFLINE y el escáner del juego solo lo ve en GameState (ceros)
  const session2Players = [
    {
      name: "Snaker",
      guid: "000299e8be034a28a0e01be52fc967c8",
      platform: "PS5",
      totalXp: 0,
      totalLevel: 1,
      playtimeSeconds: 0,
      playtimeHours: 0,
      uniqueKillsCount: 0,
      uniqueKills: [],
      shrinesCount: 0,
      shrinesUnlocked: [],
      spellsCount: 0,
      spellsUnlocked: [],
      journalCount: 0,
      journalEntries: [],
      structuresBuilt: 8,
      namedChests: [],
      walkedDistanceMeters: 0,
      skills: [],
      registeredOnly: true, // ¡Offline!
    },
  ];

  // Ejecutar merge cuando nadie está online
  const result = await db.mergeWorldStats("Chavito", session2Players, new Set());
  const snakerMerged = result.players.find((p) => p.name === "Snaker");

  // ¡VERIFICACIÓN CRÍTICA!: No debe tener ceros, debe conservar sus estadísticas históricas
  assert.ok(snakerMerged, "Snaker debe estar en la lista resultante");
  assert.equal(snakerMerged.totalXp, 85000, "La experiencia no debe resetearse a 0");
  assert.equal(snakerMerged.totalLevel, 45, "El nivel no debe resetearse a 1");
  assert.equal(snakerMerged.playtimeHours, 10.0, "Las horas jugadas deben preservarse");
  assert.equal(snakerMerged.uniqueKillsCount, 15, "Las bajas únicas deben preservarse");
  assert.equal(snakerMerged.shrinesCount, 3, "Los santuarios deben preservarse");
  assert.equal(snakerMerged.isOnline, false, "Debe marcarse como desconectado");
  assert.equal(snakerMerged.registeredOnly, false, "No debe marcarse como cuenta vacía si tiene historial");

  await rm(tempDir, { recursive: true, force: true });
});

test("PlayerDatabase: deduplica listas y mantiene cota máxima de progresión", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-db-dedup-"));
  const dbFile = join(tempDir, "player-database.json");

  const db = new PlayerDatabase(dbFile);

  const initial = {
    name: "Hero",
    totalXp: 5000,
    totalLevel: 20,
    playtimeSeconds: 3600,
    uniqueKills: ["Wolf", "Spider"],
    shrinesUnlocked: ["Shrine1"],
    journalEntries: ["EntryA", "EntryB"],
    namedChests: ["Chest1"],
    structuresBuilt: 5,
    skills: [{ id: "Combat", xp: 5000, level: 20 }],
    registeredOnly: false,
  };

  await db.mergeWorldStats("Chavito", [initial]);

  // Nueva sesión con elementos repetidos y nuevos
  const update = {
    name: "Hero",
    totalXp: 9000,
    totalLevel: 25,
    playtimeSeconds: 5400,
    uniqueKills: ["Spider", "Dragon"], // Spider repetido, Dragon nuevo
    shrinesUnlocked: ["Shrine1", "Shrine2"], // Shrine1 repetido
    journalEntries: ["EntryB", "EntryC"], // EntryB repetido
    namedChests: ["Chest1", "Chest2"], // Chest1 repetido
    structuresBuilt: 10,
    skills: [{ id: "Combat", xp: 9000, level: 25 }],
    registeredOnly: false,
  };

  const { players } = await db.mergeWorldStats("Chavito", [update]);
  const hero = players.find((p) => p.name === "Hero");

  assert.equal(hero.totalXp, 9000);
  assert.equal(hero.totalLevel, 25);
  assert.equal(hero.structuresBuilt, 10);

  // Listas deduplicadas
  assert.deepEqual(hero.uniqueKills.sort(), ["Dragon", "Spider", "Wolf"]);
  assert.deepEqual(hero.shrinesUnlocked.sort(), ["Shrine1", "Shrine2"]);
  assert.deepEqual(hero.journalEntries.sort(), ["EntryA", "EntryB", "EntryC"]);
  assert.deepEqual(hero.namedChests.sort(), ["Chest1", "Chest2"]);

  await rm(tempDir, { recursive: true, force: true });
});

test("PlayerDatabase: registro de acciones evita duplicados idénticos consecutivos", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-db-actions-"));
  const dbFile = join(tempDir, "player-database.json");

  const db = new PlayerDatabase(dbFile);

  const e1 = db.recordAction("Chavito", "Matty", "Subió al nivel 50", "level_up");
  assert.ok(e1);

  // Intentar registrar exactamente la misma acción para el mismo jugador
  const e2 = db.recordAction("Chavito", "Matty", "Subió al nivel 50", "level_up");
  assert.equal(e2, null, "No debe duplicar la misma acción idéntica consecutiva");

  // Acción diferente sí debe registrarse
  const e3 = db.recordAction("Chavito", "Matty", "Subió al nivel 51", "level_up");
  assert.ok(e3);

  const actions = db.getActionLog("Chavito");
  assert.equal(actions.length, 2);

  await rm(tempDir, { recursive: true, force: true });
});

test("extractWorldStatsFromFile con PlayerDatabase: recupera datos reales de partida y los consolida", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "rsdw-db-integration-"));
  const dbFile = join(tempDir, "player-database.json");
  const db = new PlayerDatabase(dbFile);

  const savPath = join(process.cwd(), "seed-data", "server", "RSDragonwilds", "Saved", "SaveGames", "Chavito.sav");

  // Primera extracción: consolida jugadores de Chavito.sav y SpudCache/L_World.lvl
  const stats1 = await extractWorldStatsFromFile(savPath, {
    playerDatabase: db,
    onlinePlayers: new Set(["ChamapTV"]),
  });

  assert.ok(stats1.players.length >= 4);
  const chamap = stats1.players.find((p) => p.name === "ChamapTV");
  assert.ok(chamap);
  assert.equal(chamap.isOnline, true);
  assert.ok(chamap.totalXp > 0);

  // Ahora pre-cargamos en la base de datos un progreso histórico para 'Snaker' (que en Chavito.sav venía solo en GameState con ceros)
  const worldData = db.getWorldData("Chavito");
  worldData.players["Snaker"] = {
    name: "Snaker",
    guid: "000299e8be034a28a0e01be52fc967c8",
    platform: "PS5",
    totalXp: 99999,
    totalLevel: 55,
    playtimeSeconds: 40000,
    playtimeHours: 11.1,
    uniqueKillsCount: 18,
    uniqueKills: ["Boss1", "Boss2"],
    shrinesCount: 4,
    shrinesUnlocked: ["ShrineA"],
    structuresBuilt: 12,
    namedChests: [],
    skills: [],
    registeredOnly: false,
  };
  await db.save();

  // Segunda extracción simulada: debe recuperar a Snaker con sus 99,999 XP a pesar de que en el archivo físico está offline
  const stats2 = await extractWorldStatsFromFile(savPath, {
    playerDatabase: db,
    onlinePlayers: new Set(),
  });

  const snaker = stats2.players.find((p) => p.name === "Snaker");
  assert.ok(snaker);
  assert.equal(snaker.totalXp, 99999, "Snaker debe mantener su XP histórica y no aparecer en cero");
  assert.equal(snaker.totalLevel, 55, "Snaker debe mantener su nivel 55");
  assert.equal(snaker.isOnline, false, "Snaker debe figurar como desconectado");

  // El podio y ranking deben incluir a los jugadores consolidados
  assert.ok(stats2.highlights.topOverall.length >= 3);
  assert.ok(Array.isArray(stats2.actionLog));

  await rm(tempDir, { recursive: true, force: true });
});
