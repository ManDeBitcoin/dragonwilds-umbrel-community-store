import { readFile, writeFile } from "node:fs/promises";

/**
 * Constantes y mapeos de reglas de juego de Dragonwilds.
 */
export const DIFFICULTY_LABELS = {
  0: "Historia / Fácil",
  1: "Normal",
  2: "Difícil",
};

export const PVP_LABELS = {
  0: "Desactivado (Cooperativo)",
  1: "Activado (JcJ / Fuego amigo)",
};

/**
 * Lee una cadena Unreal FString desde un buffer en el offset dado.
 * Retorna { value: string, nextOffset: number }.
 */
function readFString(buffer, offset) {
  if (offset + 4 > buffer.length) return null;
  const len = buffer.readInt32LE(offset);
  offset += 4;

  if (len === 0) return { value: "", nextOffset: offset };

  if (len > 0) {
    // ASCII con byte nulo al final
    if (offset + len > buffer.length) return null;
    const str = buffer.toString("utf8", offset, offset + len - 1);
    return { value: str, nextOffset: offset + len };
  } else {
    // UTF-16
    const byteLen = -len * 2;
    if (offset + byteLen > buffer.length) return null;
    const str = buffer.toString("utf16le", offset, offset + byteLen - 2);
    return { value: str, nextOffset: offset + byteLen };
  }
}

/**
 * Busca todas las apariciones de una cadena ASCII en un buffer.
 */
function findOccurrences(buffer, str) {
  const target = Buffer.from(str, "ascii");
  const indices = [];
  let pos = 0;
  while ((pos = buffer.indexOf(target, pos)) !== -1) {
    indices.push(pos);
    pos += 1;
  }
  return indices;
}

/**
 * Analiza un archivo de guardado SPUD (empieza con "SAVE").
 * Devuelve un mapa con las ubicaciones de los campos o null si no se puede analizar.
 */
function parseSpudSave(buffer) {
  if (buffer.length < 8) return null;
  const magic = buffer.toString("ascii", 0, 4);
  if (magic !== "SAVE") return null;

  // Buscar PNIX (Property Name Index)
  const pnixPos = buffer.indexOf(Buffer.from("PNIX", "ascii"));
  if (pnixPos === -1) return null;

  const pnixLength = buffer.readUInt32LE(pnixPos + 4);
  let cursor = pnixPos + 8;
  const pnixEnd = cursor + pnixLength;

  if (pnixEnd > buffer.length) return null;

  // Leer lista de nombres de propiedades
  const numNames = buffer.readUInt32LE(cursor);
  cursor += 4;

  const propertyNames = [];
  for (let i = 0; i < numNames && cursor < pnixEnd; i++) {
    const res = readFString(buffer, cursor);
    if (!res) break;
    propertyNames.push(res.value);
    cursor = res.nextOffset;
  }

  const diffNameIndex = propertyNames.indexOf("DifficultyType");
  const pvpNameIndex = propertyNames.indexOf("PvpEnabled");

  return {
    type: "spud",
    propertyNames,
    diffNameIndex,
    pvpNameIndex,
  };
}

/**
 * Lee las reglas de juego (dificultad y PvP) de un buffer .sav de Dragonwilds.
 */
export function inspectWorldSave(buffer) {
  let difficulty = 1; // Default: Normal
  let pvpEnabled = false; // Default: Co-op
  let detected = false;
  const offsets = {
    difficulty: null,
    pvp: null,
  };

  // Método 1: Búsqueda de tags de propiedades estilo Unreal Engine / GVAS
  // Patrón común: [FString: "DifficultyType"] ... [Byte / Enum / Int value]
  const diffMatches = findOccurrences(buffer, "DifficultyType");
  for (const pos of diffMatches) {
    if (pos >= 4) {
      const len = buffer.readInt32LE(pos - 4);
      if (len === 15 || len === 14) {
        const offsetStart = buffer[pos + 14] === 0 ? pos + 15 : pos + 14;
        const searchWindow = buffer.subarray(offsetStart, Math.min(offsetStart + 64, buffer.length));
        for (let i = 0; i < searchWindow.length; i++) {
          const val = searchWindow[i];
          if ((val === 0 || val === 1 || val === 2) && searchWindow[i + 1] === 0) {
            offsets.difficulty = offsetStart + i;
            difficulty = val;
            detected = true;
            break;
          }
        }
      }
    }
  }

  const pvpMatches = findOccurrences(buffer, "PvpEnabled");
  for (const pos of pvpMatches) {
    if (pos >= 4) {
      const len = buffer.readInt32LE(pos - 4);
      if (len === 11 || len === 10) {
        const offsetStart = buffer[pos + 10] === 0 ? pos + 11 : pos + 10;
        const searchWindow = buffer.subarray(offsetStart, Math.min(offsetStart + 64, buffer.length));
        for (let i = 0; i < searchWindow.length; i++) {
          const val = searchWindow[i];
          if (val === 0 || val === 1) {
            offsets.pvp = offsetStart + i;
            pvpEnabled = val === 1;
            detected = true;
            break;
          }
        }
      }
    }
  }

  // Método 2: SPUD chunks estructurados
  const spud = parseSpudSave(buffer);
  if (spud && (spud.diffNameIndex !== -1 || spud.pvpNameIndex !== -1)) {
    detected = true;
  }

  return {
    detected,
    difficulty,
    difficultyLabel: DIFFICULTY_LABELS[difficulty] || "Normal",
    pvpEnabled,
    pvpLabel: pvpEnabled ? PVP_LABELS[1] : PVP_LABELS[0],
    offsets,
  };
}

/**
 * Modifica las reglas en un buffer binario .sav y devuelve el buffer actualizado.
 */
export function patchWorldSave(buffer, { difficulty, pvpEnabled }) {
  const inspected = inspectWorldSave(buffer);
  const copy = Buffer.from(buffer);

  let modified = false;

  if (typeof difficulty === "number" && difficulty >= 0 && difficulty <= 2) {
    if (inspected.offsets.difficulty !== null) {
      copy.writeUInt8(difficulty, inspected.offsets.difficulty);
      modified = true;
    }
  }

  if (typeof pvpEnabled === "boolean" || typeof pvpEnabled === "number") {
    const val = pvpEnabled ? 1 : 0;
    if (inspected.offsets.pvp !== null) {
      copy.writeUInt8(val, inspected.offsets.pvp);
      modified = true;
    }
  }

  return {
    buffer: copy,
    modified,
    rules: {
      difficulty: typeof difficulty === "number" ? difficulty : inspected.difficulty,
      pvpEnabled: typeof pvpEnabled === "boolean" ? pvpEnabled : inspected.pvpEnabled,
    },
  };
}

/**
 * Lee las reglas de un archivo .sav en disco.
 */
export async function readWorldRulesFromFile(filePath) {
  try {
    const buffer = await readFile(filePath);
    return inspectWorldSave(buffer);
  } catch (error) {
    return {
      detected: false,
      difficulty: 1,
      difficultyLabel: DIFFICULTY_LABELS[1],
      pvpEnabled: false,
      pvpLabel: PVP_LABELS[0],
      error: error.message,
    };
  }
}

/**
 * Aplica nuevas reglas a un archivo .sav en disco.
 */
export async function updateWorldRulesInFile(filePath, rules) {
  const buffer = await readFile(filePath);
  const result = patchWorldSave(buffer, rules);
  if (result.modified) {
    await writeFile(filePath, result.buffer);
  }
  return result;
}
