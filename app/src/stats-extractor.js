import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
          // AccountGuidSaveStr precede a CharacterName en GameState (tomar la última coincidencia antes del nombre)
          const window = buffer.subarray(Math.max(0, idx - 400), idx).toString("latin1");
          const eosMatches = [...window.matchAll(/RedpointEOS:([a-f0-9]{32})/gi)];
          const ps5Matches = [...window.matchAll(/PS5:([0-9]{15,22})/gi)];
          const eosId = eosMatches.length > 0 ? eosMatches[eosMatches.length - 1][1].toLowerCase() : null;
          const ps5Id = ps5Matches.length > 0 ? ps5Matches[ps5Matches.length - 1][1] : null;

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

  // Desduplicar perfiles priorizando el mayor progreso (XP acumulada, tiempo de juego o SaveCount)
  const uniqueMap = new Map();
  for (const p of rawProfiles) {
    const name = p.meta_data?.char_name || p.char_name;
    const existing = uniqueMap.get(name);
    const existingXp = existing?.GameProgress?.Skills?.Skills?.reduce((a, s) => a + Number(s.Xp || 0), 0) || 0;
    const currentXp = p.GameProgress?.Skills?.Skills?.reduce((a, s) => a + Number(s.Xp || 0), 0) || 0;
    const currentPlaytime = Number(p.GameProgress?.Character?.Playtime_wall || 0);
    const existingPlaytime = Number(existing?.GameProgress?.Character?.Playtime_wall || 0);

    if (
      !existing ||
      currentXp > existingXp ||
      (currentXp === existingXp && currentPlaytime > existingPlaytime) ||
      (p.SaveCount || 0) > (existing.SaveCount || 0)
    ) {
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
 * Determina los ganadores de cada categoría ("Dragonwilds Wrapped Highlights"),
 * incluyendo podio Top 3 y menciones curiosas ("lo bueno y lo malo").
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
  const byDistance = [...players].sort((a, b) => (b.walkedDistanceMeters || 0) - (a.walkedDistanceMeters || 0));

  // Rankings inversos o curiosos ("lo malo o curioso")
  const byKillsAsc = [...players].sort((a, b) => a.uniqueKillsCount - b.uniqueKillsCount);
  const byStructuresAsc = [...players].sort((a, b) => a.structuresBuilt - b.structuresBuilt);
  const byHoursAsc = [...players].sort((a, b) => a.playtimeHours - b.playtimeHours);
  const byJournalAsc = [...players].sort((a, b) => a.journalCount - b.journalCount);
  const byDistanceAsc = [...players].sort((a, b) => (a.walkedDistanceMeters || 0) - (b.walkedDistanceMeters || 0));
  const byXpAsc = [...players].sort((a, b) => a.totalXp - b.totalXp);

  const makePodium = (arr, metricFn, valKey) =>
    arr.slice(0, 3).map((p, idx) => ({
      rank: idx + 1,
      medal: idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉",
      player: p.name,
      metric: metricFn(p),
      val: valKey ? p[valKey] : p.totalXp,
    }));

  return {
    topOverall: byXp.slice(0, 3).map((p, idx) => ({
      rank: idx + 1,
      medal: idx === 0 ? "🥇" : idx === 1 ? "🥈" : "🥉",
      roleTitle: idx === 0 ? "Campeón Supremo" : idx === 1 ? "Gran Héroe" : "Aventurero Ilustre",
      player: p.name,
      totalXp: p.totalXp,
      totalLevel: p.totalLevel,
      playtimeHours: p.playtimeHours,
      kills: p.uniqueKillsCount,
      structures: p.structuresBuilt,
      guid: p.guid,
      registeredOnly: Boolean(p.registeredOnly),
    })),
    topXp: {
      title: "Rey de la Experiencia",
      icon: "crown",
      player: byXp[0]?.name || "Nadie",
      metric: `${byXp[0]?.totalXp.toLocaleString("es-ES")} XP (Nivel ${byXp[0]?.totalLevel})`,
      val: byXp[0]?.totalXp || 0,
      podium: makePodium(byXp, (p) => `${p.totalXp.toLocaleString("es-ES")} XP (Niv. ${p.totalLevel})`, "totalXp"),
    },
    topPlaytime: {
      title: "El Incombustible",
      icon: "clock",
      player: byHours[0]?.name || "Nadie",
      metric: `${byHours[0]?.playtimeHours} horas de juego`,
      val: byHours[0]?.playtimeHours || 0,
      podium: makePodium(byHours, (p) => `${p.playtimeHours}h`, "playtimeHours"),
    },
    topKills: {
      title: "Asesino de Bestias",
      icon: "sword",
      player: byKills[0]?.name || "Nadie",
      metric: `${byKills[0]?.uniqueKillsCount} jefes y monstruos únicos`,
      val: byKills[0]?.uniqueKillsCount || 0,
      podium: makePodium(byKills, (p) => `${p.uniqueKillsCount} jefes`, "uniqueKillsCount"),
    },
    topArchitect: {
      title: "Gran Arquitecto",
      icon: "home",
      player: byStructures[0]?.name || "Nadie",
      metric: `${byStructures[0]?.structuresBuilt} construcciones en el mapa`,
      val: byStructures[0]?.structuresBuilt || 0,
      podium: makePodium(byStructures, (p) => `${p.structuresBuilt} bases`, "structuresBuilt"),
    },
    topExplorer: {
      title: "Gran Peregrino",
      icon: "sparkles",
      player: byShrines[0]?.name || "Nadie",
      metric: `${byShrines[0]?.shrinesCount} santuarios sagrados activados`,
      val: byShrines[0]?.shrinesCount || 0,
      podium: makePodium(byShrines, (p) => `${p.shrinesCount} santuarios`, "shrinesCount"),
    },
    topScholar: {
      title: "Erudito del Saber",
      icon: "journal",
      player: byJournal[0]?.name || "Nadie",
      metric: `${byJournal[0]?.journalCount} recetas y descubrimientos`,
      val: byJournal[0]?.journalCount || 0,
      podium: makePodium(byJournal, (p) => `${p.journalCount} recetas`, "journalCount"),
    },
    topTraveler: {
      title: "El Trotamundos",
      icon: "compass",
      player: byDistance[0]?.name || "Nadie",
      metric: `${(byDistance[0]?.walkedDistanceMeters || 0).toLocaleString("es-ES")} m a pie`,
      val: byDistance[0]?.walkedDistanceMeters || 0,
      podium: makePodium(byDistance, (p) => `${(p.walkedDistanceMeters || 0).toLocaleString("es-ES")}m`, "walkedDistanceMeters"),
    },
    topMage: {
      title: "Archimago",
      icon: "wand",
      player: bySpells[0]?.name || "Nadie",
      metric: `${bySpells[0]?.spellsCount} hechizos dominados`,
      val: bySpells[0]?.spellsCount || 0,
      podium: makePodium(bySpells, (p) => `${p.spellsCount} hechizos`, "spellsCount"),
    },

    // Curiosidades y Menciones Especiales ("Lo Bueno, lo Malo y lo Curioso")
    curiosities: {
      pacifist: {
        title: "El Gran Pacifista",
        icon: "🕊️",
        player: byKillsAsc[0]?.name || "Nadie",
        metric: `${byKillsAsc[0]?.uniqueKillsCount || 0} monstruos eliminados`,
        tag: "Amante de la paz",
        desc: "No lastimaría ni a una mosca salvaje",
      },
      nomad: {
        title: "El Nómada Errante",
        icon: "⛺",
        player: byStructuresAsc[0]?.name || "Nadie",
        metric: `${byStructuresAsc[0]?.structuresBuilt || 0} construcciones`,
        tag: "Sin techo",
        desc: "Prefiere dormir bajo la luz de las estrellas",
      },
      sleeper: {
        title: "El Visitante Exprés",
        icon: "🛋️",
        player: byHoursAsc[0]?.name || "Nadie",
        metric: `${byHoursAsc[0]?.playtimeHours || 0} horas acumuladas`,
        tag: "El dormilón",
        desc: "Entró, saludó y se fue a descansar",
      },
      minimalist: {
        title: "El Minimalista",
        icon: "🎒",
        player: byJournalAsc[0]?.name || "Nadie",
        metric: `${byJournalAsc[0]?.journalCount || 0} recetas en el diario`,
        tag: "Viaja ligero",
        desc: "Sin complicaciones de fórmulas complejas",
      },
      traveler: {
        title: "El Maratonista",
        icon: "🏃",
        player: byDistance[0]?.name || "Nadie",
        metric: `${(byDistance[0]?.walkedDistanceMeters || 0).toLocaleString("es-ES")} metros caminados`,
        tag: "Pies incansables",
        desc: "Ha recorrido las tierras de palmo a palmo",
      },
      rookie: {
        title: "El Novato Promesa",
        icon: "🐣",
        player: byXpAsc[0]?.name || "Nadie",
        metric: `Nivel ${byXpAsc[0]?.totalLevel || 1} (${byXpAsc[0]?.totalXp || 0} XP)`,
        tag: "Futuro héroe",
        desc: "Apenas comienza su gran odisea",
      },
    },
  };
}

/**
 * Asigna a cada jugador un título distintivo y medallas secundarias según sus hazañas o peculiaridades.
 */
export function assignPlayerHonorificTitle(player, highlights) {
  const name = player.name;
  const hl = highlights;
  const cur = highlights.curiosities || {};
  const tags = [];

  let primary = null;

  // 1. Títulos de Campeón Absoluto (Oro)
  if (hl.topXp?.player === name) {
    primary = { title: "Rey de la Experiencia", icon: "👑", badgeClass: "gold" };
  } else if (hl.topPlaytime?.player === name) {
    primary = { title: "El Incombustible", icon: "⏳", badgeClass: "gold" };
  } else if (hl.topExplorer?.player === name) {
    primary = { title: "Gran Peregrino", icon: "🧭", badgeClass: "accent" };
  } else if (hl.topArchitect?.player === name) {
    primary = { title: "Gran Arquitecto", icon: "🏰", badgeClass: "accent" };
  } else if (hl.topTraveler?.player === name) {
    primary = { title: "El Trotamundos", icon: "🏃", badgeClass: "accent" };
  } else if (hl.topKills?.player === name) {
    primary = { title: "Asesino de Bestias", icon: "🗡️", badgeClass: "accent" };
  } else if (hl.topScholar?.player === name) {
    primary = { title: "Erudito del Saber", icon: "📜", badgeClass: "accent" };
  }

  // Tags secundarios para logros destacados
  if (hl.topArchitect?.player === name && primary?.title !== "Gran Arquitecto") tags.push("🏰 Gran Arquitecto");
  if (hl.topKills?.player === name && primary?.title !== "Asesino de Bestias") tags.push("🗡️ Asesino de Bestias");
  if (hl.topScholar?.player === name && primary?.title !== "Erudito del Saber") tags.push("📜 Erudito del Saber");
  if (hl.topMage?.player === name && primary?.title !== "Archimago") tags.push("🪄 Archimago");
  if (hl.topTraveler?.player === name && primary?.title !== "El Trotamundos") tags.push("🏃 El Maratonista");

  // 2. Si no es #1 de nada, evaluar curiosidades o roles peculiares ("sea bueno o malo")
  if (!primary) {
    if (cur.pacifist?.player === name && player.uniqueKillsCount === 0) {
      primary = { title: "El Gran Pacifista", icon: "🕊️", badgeClass: "fun" };
      tags.push("🕊️ Amante de la paz");
    } else if (cur.sleeper?.player === name && player.playtimeHours < 1) {
      primary = { title: "El Visitante Exprés", icon: "🛋️", badgeClass: "fun" };
      tags.push("🛋️ El Dormilón");
    } else if (cur.nomad?.player === name && player.structuresBuilt === 0) {
      primary = { title: "El Nómada Errante", icon: "⛺", badgeClass: "fun" };
      tags.push("⛺ Sin techo");
    } else if (player.registeredOnly) {
      primary = { title: "Recluta en Entrenamiento", icon: "🐣", badgeClass: "muted" };
      tags.push("🐣 Novato Promesa");
    } else if (player.uniqueKillsCount >= 10) {
      primary = { title: "Cazador Veterano", icon: "⚔️", badgeClass: "info" };
    } else if (player.totalLevel >= 50) {
      primary = { title: "Aventurero Curtido", icon: "🛡️", badgeClass: "info" };
    } else {
      primary = { title: "Aventurero Valiente", icon: "🧭", badgeClass: "info" };
    }
  }

  // Tags adicionales de curiosidades si aplican
  if (player.uniqueKillsCount === 0 && !tags.some(t => t.includes("Pacifista") || t.includes("Bajas"))) tags.push("🕊️ 0 Bajas");
  if (player.structuresBuilt === 0 && !tags.some(t => t.includes("Nómada") || t.includes("Bases"))) tags.push("⛺ Sin Bases");

  return {
    ...primary,
    tags: Array.from(new Set(tags)),
  };
}

/**
 * Genera un resumen completo en formato Markdown listo para pegar en Discord o WhatsApp.
 */
export function generateDiscordSummary(stats) {
  const { worldName, players, highlights } = stats;
  let md = `🏆 **DRAGONWILDS WRAPPED — MUNDO "${worldName.toUpperCase()}"** 🏆\n\n`;

  md += `✨ **PODIO DE HONOR DEL SERVIDOR** ✨\n`;
  const formatPodiumRow = (item) => {
    if (!item) return "";
    let line = `${item.icon} **${item.title}**: 🥇 **${item.player}** (${item.metric})`;
    if (Array.isArray(item.podium) && item.podium.length > 1) {
      const runners = item.podium.slice(1).map(r => `${r.medal} ${r.player} (${r.metric})`).join(" • ");
      line += `\n   ↳ ${runners}`;
    }
    return line + "\n";
  };

  if (highlights.topXp) md += formatPodiumRow(highlights.topXp);
  if (highlights.topPlaytime) md += formatPodiumRow(highlights.topPlaytime);
  if (highlights.topKills) md += formatPodiumRow(highlights.topKills);
  if (highlights.topArchitect) md += formatPodiumRow(highlights.topArchitect);
  if (highlights.topExplorer) md += formatPodiumRow(highlights.topExplorer);
  if (highlights.topScholar) md += formatPodiumRow(highlights.topScholar);
  if (highlights.topTraveler) md += formatPodiumRow(highlights.topTraveler);

  const cur = highlights.curiosities;
  if (cur) {
    md += `\n🎭 **LO BUENO, LO MALO Y LO CURIOSO** 🎭\n`;
    if (cur.pacifist) md += `🕊️ **${cur.pacifist.title}**: **${cur.pacifist.player}** (${cur.pacifist.metric}) — _${cur.pacifist.desc}_\n`;
    if (cur.nomad) md += `⛺ **${cur.nomad.title}**: **${cur.nomad.player}** (${cur.nomad.metric}) — _${cur.nomad.desc}_\n`;
    if (cur.sleeper) md += `🛋️ **${cur.sleeper.title}**: **${cur.sleeper.player}** (${cur.sleeper.metric}) — _${cur.sleeper.desc}_\n`;
    if (cur.minimalist) md += `🎒 **${cur.minimalist.title}**: **${cur.minimalist.player}** (${cur.minimalist.metric}) — _${cur.minimalist.desc}_\n`;
    if (cur.traveler) md += `🏃 **${cur.traveler.title}**: **${cur.traveler.player}** (${cur.traveler.metric}) — _${cur.traveler.desc}_\n`;
  }

  md += `\n📊 **TABLA DE AVENTUREROS**\n`;
  md += `\`\`\`\n`;
  md += `Jugador         | Título               | Horas | Total XP | Nivel | Kills | Bases\n`;
  md += `----------------+----------------------+-------+----------+-------+-------+------\n`;

  for (const p of players) {
    const namePad = p.name.padEnd(15, " ");
    const titlePad = (p.titleBadge?.title || "Aventurero").slice(0, 20).padEnd(20, " ");
    const hoursPad = String(p.playtimeHours).padStart(5, " ");
    const xpPad = String(p.totalXp).padStart(8, " ");
    const lvlPad = String(p.totalLevel).padStart(5, " ");
    const killsPad = String(p.uniqueKillsCount).padStart(5, " ");
    const structPad = String(p.structuresBuilt).padStart(5, " ");
    md += `${namePad} | ${titlePad} | ${hoursPad} | ${xpPad} | ${lvlPad} | ${killsPad} | ${structPad}\n`;
  }
  md += `\`\`\`\n`;
  md += `_Generado automáticamente por Dragonwilds Server Console._`;
  return md;
}

/**
 * Genera una tarjeta de jugador individual en Markdown para Discord.
 */
export function generatePlayerDiscordCard(player, worldName = "Dragonwilds") {
  const badgeTitle = player.titleBadge?.title ? ` [${player.titleBadge.icon} ${player.titleBadge.title}]` : "";
  let md = `🎴 **FICHA DE AVENTURERO: ${player.name}**${badgeTitle} [${worldName}]\n`;
  if (player.titleBadge?.tags && player.titleBadge.tags.length > 0) {
    md += `• 🏷️ **Distinciones**: ${player.titleBadge.tags.join(", ")}\n`;
  }
  md += `• ⏳ **Tiempo jugado**: ${player.playtimeHours} horas (${(player.playtimeSeconds / 3600).toFixed(2)}h)\n`;
  md += `• ⭐ **Experiencia Total**: ${player.totalXp.toLocaleString("es-ES")} XP (Nivel general: ${player.totalLevel})\n`;
  md += `• 🗡️ **Jefes y monstruos cazados**: ${player.uniqueKillsCount} tipos únicos\n`;
  md += `• 🏰 **Construcciones en el mapa**: ${player.structuresBuilt} estructuras levantadas\n`;
  md += `• 🧭 **Santuarios sagrados**: ${player.shrinesCount} activados\n`;
  md += `• 📜 **Recetas y diario**: ${player.journalCount} descubrimientos\n`;
  md += `• 🪄 **Hechizos dominados**: ${player.spellsCount}\n`;
  if (player.walkedDistanceMeters) {
    md += `• 🏃 **Distancia a pie**: ${player.walkedDistanceMeters.toLocaleString("es-ES")} metros\n`;
  }
  if (player.namedChests && player.namedChests.length > 0) {
    md += `• 📦 **Cofres nombrados**: ${player.namedChests.join(", ")}\n`;
  }
  if (player.platform) {
    md += `• 🎮 **Plataforma**: ${player.platform}\n`;
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

  // Desduplicar perfiles priorizando el mayor progreso (XP acumulada, tiempo de juego o SaveCount)
  const uniqueProfiles = new Map();
  for (const p of rawProfilesList) {
    const name = p.meta_data?.char_name || p.char_name;
    const existing = uniqueProfiles.get(name);
    const existingXp = existing?.GameProgress?.Skills?.Skills?.reduce((a, s) => a + Number(s.Xp || 0), 0) || 0;
    const currentXp = p.GameProgress?.Skills?.Skills?.reduce((a, s) => a + Number(s.Xp || 0), 0) || 0;
    const currentPlaytime = Number(p.GameProgress?.Character?.Playtime_wall || 0);
    const existingPlaytime = Number(existing?.GameProgress?.Character?.Playtime_wall || 0);

    if (
      !existing ||
      currentXp > existingXp ||
      (currentXp === existingXp && currentPlaytime > existingPlaytime) ||
      (p.SaveCount || 0) > (existing.SaveCount || 0)
    ) {
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

  const cleanWorldName = basename(worldName).replace(/(\.sav|\.backup)+$/i, "");

  // Procesar perfiles con datos completos de SPUD
  const players = Array.from(uniqueProfiles.values())
    .map((raw) => processPlayerProfile(raw, structuresObj));

  // Añadir jugadores registrados en GameState que aún no tienen SPUD activo
  for (const [name, gs] of allGameStatePlayers.entries()) {
    if (!uniqueProfiles.has(name)) {
      const structInfo = structuresObj[name] || { structuresCount: 0, namedChests: [] };
      players.push({
        name,
        guid: gs.eosId || gs.ps5Id || "",
        platform: gs.ps5Id ? "PS5" : (gs.eosId ? "PC / Epic" : "Desconocida"),
        saveCount: 1,
        isHardcore: false,
        playtimeSeconds: 0,
        playtimeHours: 0,
        totalXp: 0,
        totalLevel: 1,
        skills: [],
        uniqueKillsCount: 0,
        uniqueKills: [],
        shrinesCount: 0,
        spellsCount: 0,
        journalCount: 0,
        buildingPiecesCount: 0,
        structuresBuilt: structInfo.structuresCount,
        namedChests: structInfo.namedChests,
        walkedDistanceMeters: 0,
        lastLocation: "",
        inventorySlotsOccupied: 0,
        loadoutSlotsOccupied: 0,
        registeredOnly: true,
        rawProfile: { registeredOnly: true, ...gs },
      });
    }
  }

  // Ordenar por experiencia total y tiempo de juego
  players.sort((a, b) => {
    if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
    if (b.playtimeHours !== a.playtimeHours) return b.playtimeHours - a.playtimeHours;
    return b.structuresBuilt - a.structuresBuilt;
  });

  const highlights = calculateHighlights(players);

  // Asignar título honorífico y tarjeta de Discord a cada aventurero
  for (const p of players) {
    p.titleBadge = assignPlayerHonorificTitle(p, highlights);
    p.discordCard = generatePlayerDiscordCard(p, cleanWorldName);
  }

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
 * Lee un archivo .sav o .backup y busca posibles backups hermanos en la misma carpeta para extraer todas las estadísticas.
 */
export async function extractWorldStatsFromFile(filePath) {
  const buffers = [];
  const visitedPaths = new Set();

  try {
    buffers.push(await readFile(filePath));
    visitedPaths.add(filePath.toLowerCase());
  } catch (e) {
    throw new Error(`No se pudo leer la partida: ${e.message}`);
  }

  const dir = dirname(filePath);
  const rawBase = basename(filePath);
  const cleanBase = rawBase.replace(/(\.sav|\.backup)+$/i, "");

  // 1. Leer archivos hermanos en la misma carpeta (SaveGames)
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const isCandidate = lower.endsWith(".sav") || lower.endsWith(".backup") || lower.endsWith(".lvl");

      if (isCandidate) {
        const full = join(dir, entry.name);
        if (!visitedPaths.has(full.toLowerCase())) {
          visitedPaths.add(full.toLowerCase());
          try {
            const sibBuf = await readFile(full);
            if (sibBuf && sibBuf.length > 0) buffers.push(sibBuf);
          } catch {}
        }
      }
    }
  } catch {}

  // 2. Leer SpudCache/L_World.lvl si existe en rutas relativas o absolutas (contiene progreso de personajes)
  const spudCandidates = [
    join(dir, "..", "SpudCache", "L_World.lvl"),
    join(dir, "SpudCache", "L_World.lvl"),
    "/home/steam/rsdw-dedicated/RSDragonwilds/Saved/SpudCache/L_World.lvl",
  ];
  for (const spudFile of spudCandidates) {
    if (!visitedPaths.has(spudFile.toLowerCase())) {
      visitedPaths.add(spudFile.toLowerCase());
      try {
        const spudBuf = await readFile(spudFile);
        if (spudBuf && spudBuf.length > 0) buffers.push(spudBuf);
      } catch {}
    }
  }

  return extractWorldStatsFromBuffers(buffers, cleanBase);
}


