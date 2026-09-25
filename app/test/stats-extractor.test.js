import test from "node:test";
import assert from "node:assert/strict";
import {
  xpToLevel,
  calculateHighlights,
  processPlayerProfile,
  generateDiscordSummary,
  generatePlayerDiscordCard,
  buildPlayerAiCard,
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
  assert.equal(hl.topOverall.length, 3);
  assert.equal(hl.topOverall[0].player, "Matty");
  assert.equal(hl.topOverall[0].medal, "🥇");
  assert.equal(hl.topOverall[1].player, "Bogard");
  assert.equal(hl.topOverall[1].medal, "🥈");
  assert.equal(hl.topOverall[2].player, "ZOILA qk");
  assert.equal(hl.topOverall[2].medal, "🥉");
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
  assert.equal(stats.highlights.topXp.podium.length, 2);
  assert.equal(stats.highlights.topXp.podium[0].player, "PlayerTwo");
  assert.equal(stats.highlights.topXp.podium[1].player, "PlayerOne");
});

test("calculateHighlights y curiosidades: calcula 'lo bueno y lo malo' y podio con medallas", () => {
  const players = [
    {
      name: "Guerrero",
      totalXp: 100000,
      totalLevel: 250,
      playtimeHours: 20,
      uniqueKillsCount: 30,
      structuresBuilt: 10,
      shrinesCount: 2,
      journalCount: 100,
      spellsCount: 5,
      walkedDistanceMeters: 5000,
    },
    {
      name: "Pacifico",
      totalXp: 5000,
      totalLevel: 20,
      playtimeHours: 2,
      uniqueKillsCount: 0,
      structuresBuilt: 0,
      shrinesCount: 0,
      journalCount: 5,
      spellsCount: 0,
      walkedDistanceMeters: 200,
    },
    {
      name: "Arquitecto",
      totalXp: 40000,
      totalLevel: 120,
      playtimeHours: 15,
      uniqueKillsCount: 5,
      structuresBuilt: 80,
      shrinesCount: 4,
      journalCount: 50,
      spellsCount: 2,
      walkedDistanceMeters: 1200,
    },
  ];

  const hl = calculateHighlights(players);
  // Podio Top 3
  assert.equal(hl.topXp.podium[0].player, "Guerrero");
  assert.equal(hl.topXp.podium[0].medal, "🥇");
  assert.equal(hl.topXp.podium[1].player, "Arquitecto");
  assert.equal(hl.topXp.podium[1].medal, "🥈");
  assert.equal(hl.topXp.podium[2].player, "Pacifico");
  assert.equal(hl.topXp.podium[2].medal, "🥉");

  // Curiosidades
  assert.equal(hl.curiosities.pacifist.player, "Pacifico");
  assert.equal(hl.curiosities.nomad.player, "Pacifico");
  assert.equal(hl.curiosities.sleeper.player, "Pacifico");
  assert.equal(hl.curiosities.traveler.player, "Guerrero");
});

test("buildPlayerAiCard: genera estructura enriquecida para reconstrucción IA sin campo de estado de conexión", () => {
  const mockPlayer = {
    name: "CazadorArcano",
    isHardcore: true,
    isOnline: true, // Debe ser ignorado por buildPlayerAiCard
    playtimeHours: 35.5,
    playtimeSeconds: 127800,
    totalLevel: 320,
    totalXp: 185000,
    platform: "PC / Steam",
    uniqueKillsCount: 22,
    uniqueKills: ["Boss_KBD", "Boss_Elvarg"],
    shrinesCount: 6,
    shrinesUnlocked: ["Shrine_Lumbridge", "Shrine_Varrock"],
    spellsCount: 8,
    spellsUnlocked: ["Spell_Firestrike", "Spell_Windwave", "Spell_Teleport"],
    journalCount: 150,
    structuresBuilt: 25,
    namedChests: ["Cofre de Runas"],
    walkedDistanceMeters: 45000,
    lastLocation: "V(X=55100.20, Y=142300.50, Z=-2500.00)",
    coordinates: { x: 55100.2, y: 142300.5, z: -2500.0 },
    customization: {
      bodyType: "male_A_01",
      head: "male_D_04",
      hairPreset: "Preset12",
      facialHairPreset: "M_D_Preset2",
      skinTone: "SkinTone5",
      hairColor: "Color2",
      eyeColor: "Color3",
      eyebrowColor: "Color2",
    },
    vitals: {
      health: 140,
      stamina: 120,
      specialCharge: 100,
      sustenance: 85,
      hydration: 90,
      endurance: 15,
      mount: "Kebbit_Mount",
    },
    activeStatusEffects: [
      { effect: "Cosiness", value: 100, active: true },
      { effect: "WellRested", value: 0, active: true },
    ],
    equippedLoadout: [
      { slot: 0, slotName: "Cabeza (Casco / Yelmo)", itemData: "Helm_Rune", durability: 800, upgradesApplied: 1, count: 1 },
      { slot: 1, slotName: "Torso (Pechera / Coraza)", itemData: "Platebody_Rune", durability: 950, upgradesApplied: 2, count: 1 },
      { slot: 2, slotName: "Piernas (Grebas / Pantalones)", itemData: "Platelegs_Rune", durability: 900, upgradesApplied: 1, count: 1 },
      { slot: 5, slotName: "Munición (Proyectiles / Flechas)", itemData: "Rune_Arrows", durability: null, upgradesApplied: 0, count: 250 },
      { slot: 7, slotName: "Mano Diestra (Arma Principal)", itemData: "Rune_Scimitar", durability: 650, upgradesApplied: 3, enchantment: "Enchant_Fire", count: 1 },
      { slot: 8, slotName: "Mano Siniestra (Escudo / Herramienta)", itemData: "Rune_Kiteshield", durability: 720, upgradesApplied: 1, count: 1 },
    ],
    equippedSpells: ["Spell_Firestrike", "Spell_Teleport"],
    discoveredLocations: ["WiseOldMan", "BloodblightRuin", "HighlandsArea"],
    activeQuests: [
      { questId: "Q1", state: "En progreso", objective: "Derrotar al dragon de Cathan" },
    ],
    skills: [
      { id: "Combat", level: 60, xp: 50000 },
      { id: "Magic", level: 55, xp: 40000 },
    ],
    rawProfile: { simulated: true },
  };

  const card = buildPlayerAiCard(mockPlayer, "Chavito");

  // 1. Verificar que NO contiene el estado de conexión volátil
  assert.equal(card.estado, undefined, "La carta no debe incluir el campo 'estado' (online/offline)");
  assert.equal(card.isOnline, undefined, "La carta no debe incluir 'isOnline'");

  // 2. Verificar datos de identidad y reino
  assert.equal(card.aventurero, "CazadorArcano");
  assert.equal(card.reino_o_mundo, "Chavito");
  assert.equal(card.modo_juego, "Hardcore (Ironman)");
  assert.equal(card.tiempo_jugado_horas, 35.5);

  // 3. Rasgos físicos y estética
  assert.ok(card.apariencia_fisica);
  assert.equal(card.apariencia_fisica.rostro, "male_D_04");
  assert.equal(card.apariencia_fisica.peinado, "Preset12");
  assert.equal(card.apariencia_fisica.tono_piel, "SkinTone5");
  assert.ok(card.apariencia_fisica.tipo_cuerpo.includes("Masculino"));

  // 4. Atributos vitales
  assert.ok(card.atributos_vitales);
  assert.equal(card.atributos_vitales.salud_actual, 140);
  assert.equal(card.atributos_vitales.energia_estamina, 120);
  assert.equal(card.atributos_vitales.carga_especial, 100);
  assert.equal(card.atributos_vitales.nutricion_saciedad_pct, 85);
  assert.equal(card.atributos_vitales.montura_equipada, "Kebbit_Mount");
  assert.ok(card.atributos_vitales.estados_activos.some((e) => e.includes("Cosiness")));

  // 5. Armadura y armamento
  assert.ok(card.equipamiento_y_armamento);
  assert.equal(card.equipamiento_y_armamento.armadura.cabeza_yelmo.identificador_item, "Helm_Rune");
  assert.equal(card.equipamiento_y_armamento.armadura.torso_pechera.identificador_item, "Platebody_Rune");
  assert.equal(card.equipamiento_y_armamento.armas_y_herramientas.mano_diestra_arma_principal.identificador_item, "Rune_Scimitar");
  assert.equal(card.equipamiento_y_armamento.armas_y_herramientas.mano_diestra_arma_principal.encantamiento_activo, "Enchant_Fire");
  assert.equal(card.equipamiento_y_armamento.armas_y_herramientas.municion_proyectiles.cantidad, 250);
  assert.equal(card.equipamiento_y_armamento.resumen_carga.piezas_equipadas, 6);

  // 6. Magia y hechizos
  assert.ok(card.magia_y_hechizos);
  assert.deepEqual(card.magia_y_hechizos.hechizos_equipados_en_barra, ["Spell_Firestrike", "Spell_Teleport"]);
  assert.equal(card.magia_y_hechizos.total_hechizos_equipados, 2);
  assert.equal(card.magia_y_hechizos.total_hechizos_desbloqueados, 8);

  // 7. Ubicación en Gielinor
  assert.ok(card.ubicacion_en_gielinor);
  assert.equal(card.ubicacion_en_gielinor.coordenadas.x, 55100.2);
  assert.equal(card.ubicacion_en_gielinor.coordenadas.y, 142300.5);
  assert.equal(card.ubicacion_en_gielinor.coordenadas.z, -2500.0);
  assert.ok(card.ubicacion_en_gielinor.zonas_y_hitos_descubiertos.includes("WiseOldMan"));

  // 8. Hazañas y misiones
  assert.ok(card.hazañas_y_legado);
  assert.equal(card.hazañas_y_legado.jefes_y_bestias_cazadas, 22);
  assert.equal(card.hazañas_y_legado.santuarios_sagrados_activados, 6);
  assert.equal(card.hazañas_y_legado.estructuras_construidas_en_mundo, 25);
  assert.equal(card.hazañas_y_legado.misiones_en_progreso.length, 1);

  // 9. Arquetipo y prompt narrativo
  assert.ok(card.arquetipo);
  assert.ok(card.arquetipo.clase_principal);
  assert.ok(card.descripcion_narrativa_para_ia.includes("CazadorArcano"));
  assert.ok(card.descripcion_narrativa_para_ia.includes("Chavito"));
});

test("processPlayerProfile: extrae personalización, vitals, loadout y coordenadas del formato real", () => {
  const mockRaw = {
    SaveCount: 5,
    meta_data: { char_name: "GuerreroTest", char_guid: "G123" },
    Customization: {
      CustomizationData: {
        BodyType: { rowName: "female_A_01" },
        Head: { rowName: "female_B_02" },
      },
    },
    GameProgress: {
      Character: {
        Health: { CurrentValue: 130 },
        Stamina: { CurrentValue: 110 },
        SpecialCharge: { CurrentValue: 90 },
        Sustenance: { SustenanceValue: 88.5 },
        Hydration: { HydrationValue: 92.0 },
        LastAccessibleLocation: { Position: "V(X=123.45, Y=678.90, Z=-50.00)" },
      },
      Loadout: {
        0: { ItemData: "Helmet_Iron", Durability: 500 },
        7: { PlayerInventoryItemIndex: 12 },
        MaxSlotIndex: 8,
      },
      Inventory: {
        12: { ItemData: "Sword_Iron", Durability: 450, Count: 1 },
      },
      Spellcasting: {
        SelectedSpells: ["Spell_A", "", "Spell_B"],
      },
    },
  };

  const p = processPlayerProfile(mockRaw);
  assert.equal(p.customization.bodyType, "female_A_01");
  assert.equal(p.customization.head, "female_B_02");
  assert.equal(p.vitals.health, 130);
  assert.equal(p.vitals.sustenance, 89);
  assert.equal(p.vitals.hydration, 92);
  assert.equal(p.coordinates.x, 123.45);
  assert.equal(p.coordinates.y, 678.9);
  assert.equal(p.coordinates.z, -50.0);
  assert.equal(p.equippedLoadout.length, 2);
  assert.equal(p.equippedLoadout[0].itemData, "Helmet_Iron");
  assert.equal(p.equippedLoadout[1].itemData, "Sword_Iron"); // resuelto desde Inventory[12]
  assert.equal(p.equippedLoadout[1].fromInventory, true);
  assert.deepEqual(p.equippedSpells, ["Spell_A", "Spell_B"]);
});


