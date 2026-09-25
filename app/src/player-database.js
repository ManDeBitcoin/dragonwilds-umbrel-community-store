import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_DATA_DIR = resolve(process.env.DATA_DIR || "/data/control");
const DEFAULT_DB_PATH = join(DEFAULT_DATA_DIR, "player-database.json");

/**
 * Gestor de base de datos persistente para jugadores de Dragonwilds.
 * Garantiza que las estadísticas de jugadores nunca se pierdan ni se reseteen a cero
 * cuando están desconectados, y mantiene un registro limpio y desduplicado de acciones.
 */
export class PlayerDatabase {
  constructor(filePath = DEFAULT_DB_PATH) {
    this.filePath = filePath;
    this.data = {
      version: 1,
      worlds: {},
    };
    this.loaded = false;
  }

  async load() {
    try {
      if (existsSync(this.filePath)) {
        const content = await readFile(this.filePath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object") {
          this.data = {
            version: parsed.version || 1,
            worlds: parsed.worlds || {},
          };
        }
      }
    } catch (err) {
      // Si el archivo está vacío o corrupto, continuar con el estado en memoria
      console.warn(`[PlayerDatabase] Aviso al cargar base de datos: ${err.message}`);
    }
    this.loaded = true;
    return this.data;
  }

  save() {
    this.savePromise = (this.savePromise || Promise.resolve()).then(async () => {
      try {
        const dir = dirname(this.filePath);
        await mkdir(dir, { recursive: true });
        const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        await writeFile(tempPath, JSON.stringify(this.data, null, 2), "utf8");
        const { rename } = await import("node:fs/promises");
        await rename(tempPath, this.filePath);
      } catch (err) {
        console.error(`[PlayerDatabase] Error al guardar base de datos: ${err.message}`);
      }
    });
    return this.savePromise;
  }

  getWorldData(worldName) {
    const cleanWorld = (worldName || "Chavito").trim();
    if (!this.data.worlds[cleanWorld]) {
      this.data.worlds[cleanWorld] = {
        players: {},
        actionLog: [],
        updatedAt: new Date().toISOString(),
      };
    }
    return this.data.worlds[cleanWorld];
  }

  /**
   * Registra una acción o hito de manera limpia y sin repetir eventos idénticos consecutivos.
   */
  recordAction(worldName, playerName, actionText, type = "milestone", details = {}) {
    const worldData = this.getWorldData(worldName);
    const log = worldData.actionLog || [];

    // Evitar duplicar exactamente la misma acción para el mismo jugador si ya fue registrada recientemente
    const recentDuplicate = log.slice(-20).find(
      (entry) =>
        entry.player.toLowerCase() === playerName.toLowerCase() &&
        entry.action === actionText &&
        entry.type === type
    );

    if (recentDuplicate) {
      return null;
    }

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      player: playerName,
      action: actionText,
      type,
      ...details,
    };

    log.push(entry);
    // Limitar el historial a las últimas 500 acciones relevantes por mundo
    if (log.length > 500) {
      log.splice(0, log.length - 500);
    }
    worldData.actionLog = log;
    worldData.updatedAt = new Date().toISOString();
    return entry;
  }

  /**
   * Fusiona las estadísticas extraídas de las partidas con la base de datos persistente.
   * - Restaura datos de jugadores offline para que NUNCA aparezcan en cero.
   * - Conserva la máxima progresión alcanzada (High-Water Mark).
   * - Une listas (bajas, recetas, santuarios) sin duplicar elementos.
   * - Registra hitos relevantes en el historial de acciones.
   */
  async mergeWorldStats(worldName, freshPlayers, onlineUserNames = new Set()) {
    if (!this.loaded) {
      await this.load();
    }

    const worldData = this.getWorldData(worldName);
    const dbPlayers = worldData.players;
    const mergedList = [];
    const processedNames = new Set();

    // Normalizar lista de nombres online para comparaciones case-insensitive
    const onlineSet = new Set(
      Array.from(onlineUserNames || []).map((n) => String(n).toLowerCase())
    );

    for (const fresh of freshPlayers) {
      const name = fresh.name;
      const lowerName = name.toLowerCase();
      processedNames.add(lowerName);

      const existing = dbPlayers[name] || Object.values(dbPlayers).find((p) => p.name.toLowerCase() === lowerName);
      const isOnline = onlineSet.has(lowerName) || (fresh.guid && onlineSet.has(fresh.guid.toLowerCase()));

      if (fresh.registeredOnly) {
        // El jugador solo apareció en GameState (está desconectado y el save no tiene su JSON activo)
        if (existing && existing.totalXp > 0) {
          // Restaurar todas las estadísticas históricas acumuladas
          const restored = {
            ...existing,
            isOnline,
            platform: fresh.platform || existing.platform,
            guid: fresh.guid || existing.guid,
            lastSeen: existing.lastSeen || new Date().toISOString(),
            registeredOnly: false, // ¡Tiene datos reales, no es solo registrado!
          };
          dbPlayers[name] = restored;
          mergedList.push(restored);
        } else {
          // Es un jugador nuevo que nunca ha registrado progreso
          const record = {
            ...fresh,
            isOnline,
            firstSeen: existing?.firstSeen || new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          };
          dbPlayers[name] = record;
          mergedList.push(record);
        }
      } else {
        // Tenemos datos frescos de GameProgress (el jugador jugó o estuvo activo en este save)
        if (!existing) {
          // Nuevo jugador con progreso
          const newPlayer = {
            ...fresh,
            isOnline,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            registeredOnly: false,
          };
          dbPlayers[name] = newPlayer;
          mergedList.push(newPlayer);

          this.recordAction(
            worldName,
            name,
            `Comenzó su aventura en el reino de ${worldName} (Nivel ${fresh.totalLevel})`,
            "join"
          );
        } else {
          // Jugador existente: fusionar de forma monótona (sin retrocesos ni duplicados)
          const mergedTotalXp = Math.max(existing.totalXp || 0, fresh.totalXp || 0);
          const mergedPlaytimeSeconds = Math.max(existing.playtimeSeconds || 0, fresh.playtimeSeconds || 0);
          const mergedPlaytimeHours = Number((mergedPlaytimeSeconds / 3600).toFixed(1));
          const mergedStructures = Math.max(existing.structuresBuilt || 0, fresh.structuresBuilt || 0);
          const mergedDistance = Math.max(existing.walkedDistanceMeters || 0, fresh.walkedDistanceMeters || 0);
          const mergedSaveCount = Math.max(existing.saveCount || 0, fresh.saveCount || 0);

          // Unión sin duplicados de colecciones
          const uniqueKillsSet = new Set([...(existing.uniqueKills || []), ...(fresh.uniqueKills || [])]);
          const uniqueKills = Array.from(uniqueKillsSet);

          const shrinesSet = new Set([...(existing.shrinesUnlocked || []), ...(fresh.shrinesUnlocked || [])]);
          const shrinesUnlocked = Array.from(shrinesSet);

          const spellsSet = new Set([...(existing.spellsUnlocked || []), ...(fresh.spellsUnlocked || [])]);
          const spellsUnlocked = Array.from(spellsSet);

          const journalSet = new Set([...(existing.journalEntries || []), ...(fresh.journalEntries || [])]);
          const journalEntries = Array.from(journalSet);

          const chestsSet = new Set([...(existing.namedChests || []), ...(fresh.namedChests || [])]);
          const namedChests = Array.from(chestsSet);

          // Habilidades: conservar el nivel y XP máxima alcanzada por cada habilidad
          const skillMap = new Map();
          for (const s of (existing.skills || [])) {
            if (s && s.id) skillMap.set(s.id, { ...s });
          }
          for (const s of (fresh.skills || [])) {
            if (s && s.id) {
              const current = skillMap.get(s.id);
              if (!current || (s.xp || 0) > (current.xp || 0)) {
                skillMap.set(s.id, { ...s });
              }
            }
          }
          const mergedSkills = Array.from(skillMap.values());
          const mergedLevel = Math.max(
            existing.totalLevel || 1,
            fresh.totalLevel || 1,
            mergedSkills.reduce((acc, s) => acc + (s.level || 1), 0)
          );

          // Detectar hitos para el registro de acciones
          if (fresh.totalLevel > (existing.totalLevel || 1)) {
            this.recordAction(
              worldName,
              name,
              `Alcanzó el Nivel General ${fresh.totalLevel} (+${fresh.totalLevel - (existing.totalLevel || 1)})`,
              "level_up"
            );
          }

          if (uniqueKills.length > (existing.uniqueKillsCount || (existing.uniqueKills || []).length)) {
            const diff = uniqueKills.length - (existing.uniqueKillsCount || 0);
            this.recordAction(
              worldName,
              name,
              `Derrotó a ${diff} nueva(s) criatura(s) o jefe(s) único(s) (Total: ${uniqueKills.length})`,
              "kill"
            );
          }

          if (shrinesUnlocked.length > (existing.shrinesCount || (existing.shrinesUnlocked || []).length)) {
            this.recordAction(
              worldName,
              name,
              `Desbloqueó un nuevo santuario sagrado (Total: ${shrinesUnlocked.length})`,
              "shrine"
            );
          }

          if (mergedStructures >= 20 && (existing.structuresBuilt || 0) < 20) {
            this.recordAction(
              worldName,
              name,
              `Construyó más de 20 estructuras en el mundo`,
              "builder"
            );
          }

          const mergedPlayer = {
            ...existing,
            ...fresh,
            name,
            guid: fresh.guid || existing.guid,
            platform: fresh.platform || existing.platform,
            isHardcore: Boolean(fresh.isHardcore ?? existing.isHardcore),
            isOnline,
            saveCount: mergedSaveCount,
            totalXp: mergedTotalXp,
            totalLevel: mergedLevel,
            playtimeSeconds: mergedPlaytimeSeconds,
            playtimeHours: mergedPlaytimeHours,
            structuresBuilt: mergedStructures,
            walkedDistanceMeters: mergedDistance,
            skills: mergedSkills,
            uniqueKillsCount: uniqueKills.length,
            uniqueKills,
            shrinesCount: shrinesUnlocked.length,
            shrinesUnlocked,
            spellsCount: spellsUnlocked.length,
            spellsUnlocked,
            journalCount: journalEntries.length,
            journalEntries,
            namedChests,
            lastLocation: fresh.lastLocation || existing.lastLocation,
            firstSeen: existing.firstSeen || new Date().toISOString(),
            lastSeen: isOnline ? new Date().toISOString() : (existing.lastSeen || new Date().toISOString()),
            registeredOnly: false,
          };

          dbPlayers[name] = mergedPlayer;
          mergedList.push(mergedPlayer);
        }
      }
    }

    // Incluir cualquier jugador histórico en la base de datos que ni siquiera haya sido encontrado en el scan actual
    for (const [dbName, dbPlayer] of Object.entries(dbPlayers)) {
      if (!processedNames.has(dbName.toLowerCase())) {
        const isOnline = onlineSet.has(dbName.toLowerCase());
        const preserved = {
          ...dbPlayer,
          isOnline,
          registeredOnly: Boolean(dbPlayer.registeredOnly && dbPlayer.totalXp === 0),
        };
        mergedList.push(preserved);
      }
    }

    worldData.updatedAt = new Date().toISOString();
    await this.save();

    return {
      players: mergedList,
      actionLog: (worldData.actionLog || []).slice(-100).reverse(), // Más recientes primero
    };
  }

  getActionLog(worldName, limit = 50) {
    const worldData = this.getWorldData(worldName);
    const log = worldData.actionLog || [];
    return log.slice(-limit).reverse();
  }

  getAllPlayers(worldName) {
    const worldData = this.getWorldData(worldName);
    return Object.values(worldData.players || {});
  }

  updatePlayerConnection(worldName, playerName, { userId = "", connected = true, timestamp = new Date().toISOString() } = {}) {
    const worldData = this.getWorldData(worldName);
    const lowerName = playerName.toLowerCase();
    let player = worldData.players[playerName] || Object.values(worldData.players).find((p) => p.name.toLowerCase() === lowerName);
    if (!player) {
      player = {
        name: playerName,
        guid: userId || "",
        totalXp: 0,
        totalLevel: 1,
        playtimeSeconds: 0,
        playtimeHours: 0,
        uniqueKillsCount: 0,
        structuresBuilt: 0,
        firstSeen: timestamp,
        lastSeen: timestamp,
        registeredOnly: true,
      };
      worldData.players[playerName] = player;
    }
    player.isOnline = Boolean(connected);
    player.lastSeen = timestamp;
    if (userId && !player.guid) player.guid = userId;
    this.recordAction(
      worldName,
      playerName,
      connected ? "Se conectó a la partida" : "Se desconectó de la partida",
      connected ? "connection" : "disconnection"
    );
    worldData.updatedAt = new Date().toISOString();
    this.save().catch(() => {});
  }
}
