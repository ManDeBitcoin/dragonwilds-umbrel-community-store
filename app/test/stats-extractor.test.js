import test from "node:test";
import assert from "node:assert/strict";
import {
  xpToLevel,
  calculateHighlights,
  processPlayerProfile,
  generateDiscordSummary,
  generatePlayerDiscordCard,
  extractWorldStatsFromBuffer,
} from "../src/stats-extractor.js";

test("xpToLevel: calcula correctamente los niveles de RuneScape", () => {
  assert.equal(xpToLevel(0), 1);
  assert.equal(xpToLevel(50), 1);
  assert.equal(xpToLevel(83), 2);
  assert.equal(xpToLevel(5000), 20);
  assert.equal(xpToLevel(14000), 30);
  assert.equal(xpToLevel(100000), 49);
  assert.equal(xpToLevel(14000000), 99);
});

test("calculateHighlights: determina correctamente los líderes de cada categoría", () => {
  const players = [
    {
      name: "Matty",
      totalXp: 137800,
      totalLevel: 310,
      playtimeHours: 27.2,
      uniqueKillsCount: 26,
      structuresBuilt: 67,
      shrinesCount: 5,
      journalCount: 330,
      spellsCount: 20,
    },
    {
      name: "Bogard",
      totalXp: 91467,
      totalLevel: 280,
      playtimeHours: 29.0,
      uniqueKillsCount: 23,
      structuresBuilt: 24,
      shrinesCount: 3,
      journalCount: 383,
      spellsCount: 20,
    },
    {
      name: "ZOILA qk",
      totalXp: 37588,
      totalLevel: 190,
      playtimeHours: 12.8,
      uniqueKillsCount: 20,
      structuresBuilt: 15,
      shrinesCount: 7,
      journalCount: 321,
      spellsCount: 11,
    },
  ];

  const hl = calculateHighlights(players);
  assert.equal(hl.topXp.player, "Matty");
  assert.equal(hl.topPlaytime.player, "Bogard");
  assert.equal(hl.topKills.player, "Matty");
  assert.equal(hl.topArchitect.player, "Matty");
  assert.equal(hl.topExplorer.player, "ZOILA qk");
  assert.equal(hl.topScholar.player, "Bogard");
});

test("processPlayerProfile: procesa correctamente el perfil crudo de un jugador", () => {
  const mockRaw = {
    SaveCount: 42,
    Hardcore: { IsHardcore: false },
    meta_data: {
      char_name: "HeroeDeGielinor",
      char_guid: "GUID12345",
    },
    GameProgress: {
      Character: {
        Playtime_wall: 7200,
        WalkedDistanceSinceXp: 500,
        Health: { CurrentValue: 150 },
        LastAccessibleLocation: { Position: "V(X=1, Y=2, Z=3)" },
      },
      Skills: {
        Skills: [
          { Id: "Skill1", Xp: 5000 },
          { Id: "Skill2", Xp: 14000 },
        ],
      },
      Progress: {
        KilledOnceAIs: ["AI_1", "AI_2", "AI_3"],
        ShrinesUnlocked: ["Shrine_1"],
        SpellsUnlocked: ["Spell_1", "Spell_2"],
        BuildingPiecesNew: ["Piece_1"],
      },
      Journal: {
        UnlockedEntries: ["Receta_1", "Receta_2"],
      },
      Inventory: {
        0: { Count: 1 },
        1: { Count: 5 },
      },
    },
  };

  const processed = processPlayerProfile(mockRaw, {
    HeroeDeGielinor: { structuresCount: 12, namedChests: ["Tesoros"] },
  });

  assert.equal(processed.name, "HeroeDeGielinor");
  assert.equal(processed.guid, "GUID12345");
  assert.equal(processed.playtimeHours, 2);
  assert.equal(processed.totalXp, 19000);
  assert.equal(processed.uniqueKillsCount, 3);
  assert.equal(processed.shrinesCount, 1);
  assert.equal(processed.spellsCount, 2);
  assert.equal(processed.journalCount, 2);
  assert.equal(processed.structuresBuilt, 12);
  assert.deepEqual(processed.namedChests, ["Tesoros"]);
  assert.equal(processed.inventorySlotsOccupied, 2);
});

test("generateDiscordSummary y generatePlayerDiscordCard: formatean correctamente el texto", () => {
  const stats = {
    worldName: "Chavito",
    players: [
      {
        name: "Matty",
        playtimeHours: 27.2,
        playtimeSeconds: 97920,
        totalXp: 137800,
        totalLevel: 310,
        uniqueKillsCount: 26,
        shrinesCount: 5,
        structuresBuilt: 67,
        journalCount: 330,
        spellsCount: 20,
        namedChests: ["Pociones"],
      },
    ],
    highlights: {
      topXp: { title: "Rey de la Experiencia", player: "Matty", metric: "137.800 XP" },
    },
  };

  const summary = generateDiscordSummary(stats);
  assert.ok(summary.includes("DRAGONWILDS WRAPPED"));
  assert.ok(summary.includes("Matty"));
  assert.ok(summary.includes("137800"));

  const card = generatePlayerDiscordCard(stats.players[0], "Chavito");
  assert.ok(card.includes("FICHA DE AVENTURERO: Matty"));
  assert.ok(card.includes("Pociones"));
});

test("extractWorldStatsFromBuffers: fusiona múltiples buffers y añade discordCard", () => {
  const p1 = {
    SaveCount: 10,
    meta_data: { char_name: "PlayerOne", char_guid: "G1" },
    GameProgress: {
      Character: { Playtime_wall: 3600 },
      Skills: { Skills: [{ Id: "S1", Xp: 5000 }] },
      Progress: { KilledOnceAIs: ["AI_A"] },
    },
  };
  const p2 = {
    SaveCount: 20,
    meta_data: { char_name: "PlayerTwo", char_guid: "G2" },
    GameProgress: {
      Character: { Playtime_wall: 7200 },
      Skills: { Skills: [{ Id: "S1", Xp: 15000 }] },
      Progress: { KilledOnceAIs: ["AI_A", "AI_B"] },
    },
  };

  const buf1 = Buffer.from(JSON.stringify(p1), "utf8");
  const buf2 = Buffer.from(JSON.stringify(p2), "utf8");

  const stats = extractWorldStatsFromBuffer(Buffer.concat([buf1, Buffer.from("   "), buf2]), "TestWorld");
  assert.equal(stats.worldName, "TestWorld");
  assert.equal(stats.totalPlayers, 2);
  assert.equal(stats.players[0].name, "PlayerTwo"); // higher XP
  assert.ok(stats.players[0].discordCard.includes("PlayerTwo"));
  assert.ok(stats.highlights.topXp.player === "PlayerTwo");
});

