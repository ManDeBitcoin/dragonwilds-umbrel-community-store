import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * Calcula el nivel estimado según la curva clásica de experiencia de RuneScape (1 a 99).
 * Puntos acumulados en el nivel L: sum_{i=1}^{L-1} floor(i + 300 * 2^(i/7)) / 4
 */
export function xpToLevel(xp) {
  if (!xp || xp <= 0) return 1;
  let points = 0;
  for (let lvl = 1; lvl < 99; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    const nextLvlXp = Math.floor(points / 4);
    if (xp < nextLvlXp) return lvl;
  }
  return 99;
}

/**
 * Extrae los jugadores registrados en GameState (EOS ID, nombre de personaje, GUID).
 */
export function extractGameStatePlayers(buffer) {
  const players = new Map();
  const target = Buffer.from("CharacterName\0");
  let idx = 0;

  while ((idx = buffer.indexOf(target, idx)) !== -1) {
    const strPropIdx = buffer.indexOf(Buffer.from("StrProperty\0"), idx);
    if (strPropIdx !== -1 && strPropIdx - idx < 20) {
      const valCursor = strPropIdx + 12 + 8 + 1;
      if (valCursor + 4 <= buffer.length) {
        const len = buffer.readInt32LE(valCursor);
        if (len > 1 && len < 40 && valCursor + 4 + len - 1 <= buffer.length) {
          const name = buffer.toString("utf8", valCursor + 4, valCursor + 4 + len - 1).trim();
          // AccountGuidSaveStr precede a CharacterName en GameState
          const window = buffer.subarray(Math.max(0, idx - 400), idx).toString("latin1");
          const eosMatch = window.match(/RedpointEOS:([a-f0-9]{32})/i);
          const ps5Match = window.match(/PS5:([0-9]{15,22})/i);
          const eosId = eosMatch ? eosMatch[1].toLowerCase() : null;
          const ps5Id = ps5Match ? ps5Match[1] : null;

          if (name && (eosId || ps5Id)) {
            if (!players.has(name) || (!players.get(name).eosId && eosId)) {
              players.set(name, {
                name,
                eosId,
                ps5Id,
              });
            }
          }
        }
      }
    }
    idx += target.length;
  }

  return Array.from(players.values());
}


/**
 * Cuenta estructuras y construcciones en el mundo asociadas al ID de cuenta de cada jugador.
 */
export function countWorldStructures(buffer, knownPlayers = []) {
  const counts = new Map();
  const chests = new Map();

  for (const player of knownPlayers) {
    if (!player.eosId) continue;
    const eosTarget = Buffer.from(player.eosId, "ascii");
    let count = 0;
    let idx = 0;

    while ((idx = buffer.indexOf(eosTarget, idx)) !== -1) {
      count++;
      // Verificar si hay un cofre nombrado cerca
      const windowStart = Math.max(0, idx - 100);
      const windowEnd = Math.min(buffer.length, idx + 100);
      const text = buffer.subarray(windowStart, windowEnd).toString("latin1");
      const chestMatch = text.match(/([A-ZÁÉÍÓÚa-záéíóú0-9_ -]{3,24})\.-/);
      if (chestMatch) {
        const chestName = chestMatch[1].trim();
        if (!chests.has(player.name)) chests.set(player.name, new Set());
        chests.get(player.name).add(chestName);
      }
      idx += eosTarget.length;
    }

    // Restar 1 por la mención de GameState si existe
    const netStructures = Math.max(0, count - 1);
    counts.set(player.name, {
      structuresCount: netStructures,
      namedChests: Array.from(chests.get(player.name) || []),
    });
  }

  return counts;
}

/**
 * Extrae y desduplica todos los perfiles de jugadores en formato JSON (SPUD / GameProgress).
 */
export function extractPlayerProfiles(buffer) {
  const target = Buffer.from('"GameProgress"');
  let idx = 0;
  const rawProfiles = [];

  while ((idx = buffer.indexOf(target, idx)) !== -1) {
    // Retroceder para encontrar el '{' raíz que contiene "Version" o "meta_data"
    let startPos = -1;
    for (let p = idx - 1; p >= Math.max(0, idx - 10000); p--) {
      if (buffer[p] === 0x7b) {
        const prefix = buffer.subarray(p, p + 30).toString("utf8");
        if (prefix.includes('"Version"') || prefix.includes('"meta_data"')) {
          startPos = p;
          break;
        }
      }
    }

    if (startPos !== -1) {
      let depth = 0;
      let endPos = -1;
      for (let i = startPos; i < Math.min(buffer.length, startPos + 500000); i++) {
        if (buffer[i] === 0x7b) depth++;
        else if (buffer[i] === 0x7d) {
          depth--;
          if (depth === 0) {
            endPos = i + 1;
            break;
          }
        }
      }

      if (endPos !== -1) {
        try {
          const jsonStr = buffer.toString("utf8", startPos, endPos);
          const obj = JSON.parse(jsonStr);
          if (obj.meta_data?.char_name || obj.char_name) {
            rawProfiles.push(obj);
          }
        } catch {}
      }
    }
    idx += target.length;
  }

  // Desduplicar perfiles priorizando el mayor SaveCount
  const uniqueMap = new Map();
  for (const p of rawProfiles) {
    const name = p.meta_data?.char_name || p.char_name;
    const existing = uniqueMap.get(name);
    if (!existing || (p.SaveCount || 0) > (existing.SaveCount || 0)) {
      uniqueMap.set(name, p);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * Procesa un perfil crudo y genera métricas formateadas de alto nivel y el payload raw para IA.
 */
export function processPlayerProfile(raw, worldStructures = {}) {
  const name = raw.meta_data?.char_name || raw.char_name || "Desconocido";
  const guid = raw.meta_data?.char_guid || raw.char_guid || "";
  const gp = raw.GameProgress || {};
  const char = gp.Character || {};
  const prog = gp.Progress || {};
  const skillsList = gp.Skills?.Skills || [];
  const journal = gp.Journal || {};
  const inv = gp.Inventory || {};
  const loadout = gp.Loadout || {};

  const playtimeSeconds = Number(char.Playtime_wall || 0);
  const playtimeHours = Number((playtimeSeconds / 3600).toFixed(1));

  // Habilidades y niveles
  let totalXp = 0;
  let totalLevel = 0;
  let maxSkillXp = 0;
  const processedSkills = skillsList.map((s, index) => {
    const xp = Number(s.Xp || 0);
    totalXp += xp;
    const lvl = xpToLevel(xp);
    totalLevel += lvl;
    if (xp > maxSkillXp) maxSkillXp = xp;
    return {
      index,
      id: s.Id,
      xp,
      level: lvl,
    };
  });

  // Estructuras en el mundo
  const structuresInfo = worldStructures[name] || { structuresCount: 0, namedChests: [] };

  // Slots de inventario ocupados
  const inventorySlotsOccupied = Object.keys(inv).filter((k) => !isNaN(k)).length;
  const loadoutSlotsOccupied = Object.keys(loadout).filter((k) => !isNaN(k)).length;

  return {
    name,
    guid,
    saveCount: raw.SaveCount || 0,
    isHardcore: Boolean(raw.Hardcore?.IsHardcore),
    playtimeSeconds,
    playtimeHours,
    totalXp,
    totalLevel,
    skills: processedSkills,
    uniqueKillsCount: Array.isArray(prog.KilledOnceAIs) ? prog.KilledOnceAIs.length : 0,
    uniqueKills: prog.KilledOnceAIs || [],
    shrinesCount: Array.isArray(prog.ShrinesUnlocked) ? prog.ShrinesUnlocked.length : 0,
    spellsCount: Array.isArray(prog.SpellsUnlocked) ? prog.SpellsUnlocked.length : 0,
    journalCount: Array.isArray(journal.UnlockedEntries) ? journal.UnlockedEntries.length : 0,
    buildingPiecesCount: Array.isArray(prog.BuildingPiecesNew) ? prog.BuildingPiecesNew.length : 0,
    structuresBuilt: structuresInfo.structuresCount,
    namedChests: structuresInfo.namedChests,
    walkedDistanceMeters: char.WalkedDistanceSinceXp || 0,
    lastLocation: char.LastAccessibleLocation?.Position || "",
    inventorySlotsOccupied,
    loadoutSlotsOccupied,
    rawProfile: raw,
  };
}

/**
 * Determina los ganadores de cada categoría ("Dragonwilds Wrapped Highlights").
 */
export function calculateHighlights(players) {
  if (!players || players.length === 0) return {};

  const byXp = [...players].sort((a, b) => b.totalXp - a.totalXp);
  const byHours = [...players].sort((a, b) => b.playtimeHours - a.playtimeHours);
  const byKills = [...players].sort((a, b) => b.uniqueKillsCount - a.uniqueKillsCount);
  const byStructures = [...players].sort((a, b) => b.structuresBuilt - a.structuresBuilt);
  const byShrines = [...players].sort((a, b) => b.shrinesCount - a.shrinesCount);
  const byJournal = [...players].sort((a, b) => b.journalCount - a.journalCount);
  const bySpells = [...players].sort((a, b) => b.spellsCount - a.spellsCount);

  return {
    topXp: {
      title: "Rey de la Experiencia",
      icon: "crown",
      player: byXp[0]?.name || "Nadie",
      metric: `${byXp[0]?.totalXp.toLocaleString("es-ES")} XP (Nivel ${byXp[0]?.totalLevel})`,
      val: byXp[0]?.totalXp || 0,
    },
    topPlaytime: {
      title: "El Incombustible",
      icon: "clock",
      player: byHours[0]?.name || "Nadie",
      metric: `${byHours[0]?.playtimeHours} horas de juego`,
      val: byHours[0]?.playtimeHours || 0,
    },
    topKills: {
      title: "Asesino de Bestias",
      icon: "sword",
      player: byKills[0]?.name || "Nadie",
      metric: `${byKills[0]?.uniqueKillsCount} jefes y monstruos únicos`,
      val: byKills[0]?.uniqueKillsCount || 0,
    },
    topArchitect: {
      title: "Gran Arquitecto",
      icon: "home",
      player: byStructures[0]?.name || "Nadie",
      metric: `${byStructures[0]?.structuresBuilt} construcciones en el mapa`,
      val: byStructures[0]?.structuresBuilt || 0,
    },
    topExplorer: {
      title: "Gran Peregrino",
      icon: "sparkles",
      player: byShrines[0]?.name || "Nadie",
      metric: `${byShrines[0]?.shrinesCount} santuarios sagrados activados`,
      val: byShrines[0]?.shrinesCount || 0,
    },
    topScholar: {
      title: "Erudito del Saber",
      icon: "journal",
      player: byJournal[0]?.name || "Nadie",
      metric: `${byJournal[0]?.journalCount} recetas y descubrimientos`,
      val: byJournal[0]?.journalCount || 0,
    },
    topMage: {
      title: "Archimago",
      icon: "wand",
      player: bySpells[0]?.name || "Nadie",
      metric: `${bySpells[0]?.spellsCount} hechizos dominados`,
      val: bySpells[0]?.spellsCount || 0,
    },
  };
}

/**
 * Genera un resumen completo en formato Markdown listo para pegar en Discord o WhatsApp.
 */
export function generateDiscordSummary(stats) {
  const { worldName, players, highlights } = stats;
  let md = `🏆 **DRAGONWILDS WRAPPED — MUNDO "${worldName.toUpperCase()}"** 🏆\n\n`;

  md += `✨ **PODIO DE HONOR DEL SERVIDOR** ✨\n`;
  if (highlights.topXp) md += `👑 **${highlights.topXp.title}**: **${highlights.topXp.player}** (${highlights.topXp.metric})\n`;
  if (highlights.topPlaytime) md += `⏳ **${highlights.topPlaytime.title}**: **${highlights.topPlaytime.player}** (${highlights.topPlaytime.metric})\n`;
  if (highlights.topKills) md += `🗡️ **${highlights.topKills.title}**: **${highlights.topKills.player}** (${highlights.topKills.metric})\n`;
  if (highlights.topArchitect) md += `🏰 **${highlights.topArchitect.title}**: **${highlights.topArchitect.player}** (${highlights.topArchitect.metric})\n`;
  if (highlights.topExplorer) md += `🧭 **${highlights.topExplorer.title}**: **${highlights.topExplorer.player}** (${highlights.topExplorer.metric})\n`;
  if (highlights.topScholar) md += `📜 **${highlights.topScholar.title}**: **${highlights.topScholar.player}** (${highlights.topScholar.metric})\n`;

  md += `\n📊 **TABLA DE JUGADORES**\n`;
  md += `\`\`\`\n`;
  md += `Jugador         | Horas | Total XP | Nivel | Kills | Santuarios | Bases\n`;
  md += `----------------+-------+----------+-------+-------+------------+------\n`;

  for (const p of players) {
    const namePad = p.name.padEnd(15, " ");
    const hoursPad = String(p.playtimeHours).padStart(5, " ");
    const xpPad = String(p.totalXp).padStart(8, " ");
    const lvlPad = String(p.totalLevel).padStart(5, " ");
    const killsPad = String(p.uniqueKillsCount).padStart(5, " ");
    const shrinesPad = String(p.shrinesCount).padStart(10, " ");
    const structPad = String(p.structuresBuilt).padStart(5, " ");
    md += `${namePad} | ${hoursPad} | ${xpPad} | ${lvlPad} | ${killsPad} | ${shrinesPad} | ${structPad}\n`;
  }
  md += `\`\`\`\n`;
  md += `_Generado automáticamente por Dragonwilds Server Console._`;
  return md;
}

/**
 * Genera una tarjeta de jugador individual en Markdown para Discord.
 */
export function generatePlayerDiscordCard(player, worldName = "Dragonwilds") {
  let md = `🎴 **FICHA DE AVENTURERO: ${player.name}** [${worldName}]\n`;
  md += `• ⏳ **Tiempo jugado**: ${player.playtimeHours} horas (${(player.playtimeSeconds / 3600).toFixed(2)}h)\n`;
  md += `• ⭐ **Experiencia Total**: ${player.totalXp.toLocaleString("es-ES")} XP (Nivel general: ${player.totalLevel})\n`;
  md += `• 🗡️ **Jefes y monstruos cazados**: ${player.uniqueKillsCount} tipos únicos\n`;
  md += `• 🏰 **Construcciones en el mapa**: ${player.structuresBuilt} estructuras levantadas\n`;
  md += `• 🧭 **Santuarios sagrados**: ${player.shrinesCount} activados\n`;
  md += `• 📜 **Recetas y diario**: ${player.journalCount} descubrimientos\n`;
  md += `• 🪄 **Hechizos dominados**: ${player.spellsCount}\n`;
  if (player.namedChests && player.namedChests.length > 0) {
    md += `• 📦 **Cofres nombrados**: ${player.namedChests.join(", ")}\n`;
  }
  return md;
}

/**
 * Función principal para extraer estadísticas completas desde uno o varios buffers de guardado.
 */
export function extractWorldStatsFromBuffers(buffers, worldName = "Mundo") {
  const bufferList = Array.isArray(buffers) ? buffers : [buffers];
  const allGameStatePlayers = new Map();
  const rawProfilesList = [];
  const mergedStructures = new Map();

  // Paso 1: Recopilar todos los jugadores registrados y perfiles JSON
  for (const buf of bufferList) {
    if (!buf || buf.length === 0) continue;
    const gsPlayers = extractGameStatePlayers(buf);
    for (const p of gsPlayers) {
      if (!allGameStatePlayers.has(p.name) || (!allGameStatePlayers.get(p.name).eosId && p.eosId)) {
        allGameStatePlayers.set(p.name, p);
      }
    }
    const profiles = extractPlayerProfiles(buf);
    rawProfilesList.push(...profiles);
  }

  // Paso 2: Contabilizar estructuras en el mundo en todos los buffers usando todos los jugadores conocidos
  const playerList = Array.from(allGameStatePlayers.values());
  for (const buf of bufferList) {
    if (!buf || buf.length === 0) continue;
    const structMap = countWorldStructures(buf, playerList);
    for (const [name, info] of structMap.entries()) {
      const existing = mergedStructures.get(name) || { structuresCount: 0, namedChests: new Set() };
      existing.structuresCount = Math.max(existing.structuresCount, info.structuresCount);
      for (const c of info.namedChests) existing.namedChests.add(c);
      mergedStructures.set(name, existing);
    }
  }

  // Desduplicar perfiles priorizando el mayor SaveCount
  const uniqueProfiles = new Map();
  for (const p of rawProfilesList) {
    const name = p.meta_data?.char_name || p.char_name;
    const existing = uniqueProfiles.get(name);
    if (!existing || (p.SaveCount || 0) > (existing.SaveCount || 0)) {
      uniqueProfiles.set(name, p);
    }
  }

  const structuresObj = {};
  for (const [name, info] of mergedStructures.entries()) {
    structuresObj[name] = {
      structuresCount: info.structuresCount,
      namedChests: Array.from(info.namedChests),
    };
  }

  const cleanWorldName = basename(worldName).replace(/\.(sav|backup)$/i, "");

  const players = Array.from(uniqueProfiles.values())
    .map((raw) => {
      const p = processPlayerProfile(raw, structuresObj);
      p.discordCard = generatePlayerDiscordCard(p, cleanWorldName);
      return p;
    })
    .sort((a, b) => b.totalXp - a.totalXp);

  const highlights = calculateHighlights(players);


  return {
    worldName: cleanWorldName,
    generatedAt: new Date().toISOString(),
    totalPlayers: players.length,
    registeredAccounts: allGameStatePlayers.size,
    highlights,
    players,
    discordSummary: generateDiscordSummary({ worldName: cleanWorldName, players, highlights }),
  };
}

export function extractWorldStatsFromBuffer(buffer, worldName = "Mundo") {
  return extractWorldStatsFromBuffers([buffer], worldName);
}

/**
 * Lee un archivo .sav o .backup y busca posibles backups hermanos para extraer todas las estadísticas.
 */
export async function extractWorldStatsFromFile(filePath) {
  const buffers = [];
  try {
    buffers.push(await readFile(filePath));
  } catch (e) {
    throw new Error(`No se pudo leer la partida: ${e.message}`);
  }

  // Intentar cargar archivos complementarios en la misma carpeta (.backup o .sav.backup)
  const candidateSiblings = [
    filePath.replace(/\.sav$/i, ".backup"),
    filePath.replace(/\.sav$/i, ".sav.backup"),
    `${filePath}.backup`,
  ];

  for (const sibling of candidateSiblings) {
    if (sibling === filePath) continue;
    try {
      const sibBuf = await readFile(sibling);
      buffers.push(sibBuf);
    } catch {}
  }

  return extractWorldStatsFromBuffers(buffers, basename(filePath));
}

