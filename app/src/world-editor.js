import { readFile, writeFile } from "node:fs/promises";

/**
 * Constantes y mapeos de reglas de juego de Dragonwilds (sin emojis).
 */
export const DIFFICULTY_LABELS = {
  0: "Personalizado",
  1: "Normal",
  2: "Creativo",
  3: "Difícil",
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
    if (offset + len > buffer.length) return null;
    const str = buffer.toString("utf8", offset, offset + len - 1);
    return { value: str, nextOffset: offset + len };
  } else {
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
 * Analiza un tag de propiedad en formato Unreal Engine GVAS (ByteProperty, BoolProperty, EnumProperty, IntProperty).
 */
function parseTaggedProperty(buffer, propName) {
  const matches = findOccurrences(buffer, propName);
  for (const pos of matches) {
    let cursor = pos + propName.length;
    if (cursor < buffer.length && buffer[cursor] === 0) cursor += 1;
    if (cursor + 4 <= buffer.length && buffer.readInt32LE(cursor) === 0) {
      cursor += 4;
    }

    const typeFStr = readFString(buffer, cursor);
    if (!typeFStr) continue;
    const typeName = typeFStr.value;
    cursor = typeFStr.nextOffset;
    if (cursor + 4 <= buffer.length && buffer.readInt32LE(cursor) === 0) {
      cursor += 4;
    }

    if (typeName === "BoolProperty") {
      for (const sizeBytes of [4, 8]) {
        const valOffset = cursor + sizeBytes + 4;
        if (valOffset < buffer.length) {
          const val = buffer[valOffset];
          if (val === 0 || val === 1) {
            return { found: true, type: "bool", valOffset, value: val === 1 };
          }
        }
      }
    }

    if (typeName === "ByteProperty") {
      for (const sizeBytes of [4, 8]) {
        const enumCursor = cursor + sizeBytes + 4;
        const enumFStr = readFString(buffer, enumCursor);
        if (enumFStr) {
          let afterEnum = enumFStr.nextOffset;
          if (afterEnum + 4 <= buffer.length && buffer.readInt32LE(afterEnum) === 0) {
            afterEnum += 4;
          }
          const valOffset = afterEnum + 1;
          if (valOffset < buffer.length) {
            const val = buffer[valOffset];
            if (val >= 0 && val <= 5) {
              return { found: true, type: "byte", valOffset, value: val };
            }
          }
        }
      }
    }

    if (typeName === "EnumProperty") {
      for (const sizeBytes of [4, 8]) {
        const enumCursor = cursor + sizeBytes + 4;
        const enumFStr = readFString(buffer, enumCursor);
        if (enumFStr) {
          let afterEnum = enumFStr.nextOffset;
          if (afterEnum + 4 <= buffer.length && buffer.readInt32LE(afterEnum) === 0) {
            afterEnum += 4;
          }
          const valOffset = afterEnum + 1;
          const enumValFStr = readFString(buffer, valOffset);
          if (enumValFStr) {
            const str = enumValFStr.value.toLowerCase();
            let numVal = 1;
            if (str.includes("easy") || str.includes("0")) numVal = 0;
            else if (str.includes("hard") || str.includes("difficult") || str.includes("2")) numVal = 2;
            else if (str.includes("normal") || str.includes("1")) numVal = 1;

            return { found: true, type: "enum", valOffset, value: numVal };
          }
        }
      }
    }

    if (typeName === "IntProperty") {
      for (const sizeBytes of [4, 8]) {
        const valOffset = cursor + sizeBytes + 4 + 1;
        if (valOffset + 4 <= buffer.length) {
          const val = buffer.readInt32LE(valOffset);
          if (val >= 0 && val <= 5) {
            return { found: true, type: "int", valOffset, value: val };
          }
        }
      }
    }
  }
  return { found: false };
}

/**
 * Busca e inspecciona una propiedad por nombre o lista de nombres posibles.
 */
function inspectProperty(buffer, propNames, expectedType) {
  // 1. Detección estándar Unreal Engine GVAS
  for (const name of propNames) {
    const tagged = parseTaggedProperty(buffer, name);
    if (tagged.found) return tagged;
  }

  // 2. Fallback heurístico / formato mock SPUD
  for (const name of propNames) {
    const matches = findOccurrences(buffer, name);
    for (const pos of matches) {
      let cursor = pos + name.length;
      if (cursor < buffer.length && buffer[cursor] === 0) cursor += 1;
      const mockVal = buffer[cursor];
      if (expectedType === "difficulty" && (mockVal >= 0 && mockVal <= 3) && buffer[cursor + 1] === 0) {
        return { found: true, type: "byte", valOffset: cursor, value: mockVal };
      }
      if (expectedType === "pvp" && (mockVal === 0 || mockVal === 1) && buffer[cursor + 1] === 0) {
        return { found: true, type: "bool", valOffset: cursor, value: mockVal === 1 };
      }
    }
  }

  return { found: false };
}

/**
 * Analiza un archivo de guardado nativo de RuneScape: Dragonwilds (formato binario SAVE / CINF / PROP).
 */
export function inspectDragonwildsBinary(buffer) {
  if (buffer.length < 100 || buffer.subarray(0, 4).toString("ascii") !== "SAVE") {
    return null;
  }

  const cinfIdx = buffer.indexOf(Buffer.from("CINF"));
  if (cinfIdx === -1) return null;

  try {
    const propCount = buffer.readInt32LE(cinfIdx + 8);
    let cursor = cinfIdx + 12;
    const names = [];
    for (let i = 0; i < propCount; i++) {
      const len = buffer.readInt32LE(cursor);
      cursor += 4;
      names.push(buffer.toString("utf8", cursor, cursor + len - 1));
      cursor += len;
    }

    cursor += 4; // Salta offset count
    const offsets = [];
    for (let i = 0; i <= propCount; i++) {
      offsets.push(buffer.readInt32LE(cursor));
      cursor += 4;
    }
    const payloadStart = cursor;

    let cinfDiffOffset = null;
    let cinfPvpOffset = null;

    for (let i = 0; i < names.length; i++) {
      if (names[i] === "FriendlyFire") {
        cinfPvpOffset = payloadStart + offsets[i];
      } else if (names[i] === "SurvivalDifficulty") {
        cinfDiffOffset = payloadStart + offsets[i];
      }
    }

    let propDiffOffset = null;
    let propPvpOffset = null;
    const propIdx = buffer.indexOf(Buffer.from("PROP"));
    if (propIdx !== -1) {
      const pCount = buffer.readInt32LE(propIdx + 8);
      let pCursor = propIdx + 12;
      const pOffsets = [];
      for (let i = 0; i <= pCount; i++) {
        pOffsets.push(buffer.readInt32LE(pCursor));
        pCursor += 4;
      }
      const pPayloadStart = pCursor;
      if (pOffsets.length >= 7) {
        propPvpOffset = pPayloadStart + pOffsets[5];
        propDiffOffset = pPayloadStart + pOffsets[6];
      }
    }

    if (cinfDiffOffset === null && propDiffOffset === null) return null;

    const diff = cinfDiffOffset !== null
      ? buffer.readInt32LE(cinfDiffOffset)
      : buffer.readUInt16LE(propDiffOffset);
    const pvp = cinfPvpOffset !== null
      ? buffer[cinfPvpOffset] === 1
      : buffer[propPvpOffset] === 1;

    return {
      detected: true,
      format: "dragonwilds",
      difficulty: (diff >= 0 && diff <= 3) ? diff : 1,
      difficultyLabel: DIFFICULTY_LABELS[diff] || "Normal",
      pvpEnabled: Boolean(pvp),
      pvpLabel: pvp ? PVP_LABELS[1] : PVP_LABELS[0],
      offsets: {
        cinfDiffOffset,
        cinfPvpOffset,
        propDiffOffset,
        propPvpOffset,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Lee las reglas de juego (dificultad y PvP) de un buffer .sav de Dragonwilds.
 */
export function inspectWorldSave(buffer) {
  // 1. Detección nativa del formato específico de Dragonwilds (SAVE / CINF / PROP)
  const nativeDw = inspectDragonwildsBinary(buffer);
  if (nativeDw && nativeDw.detected) {
    return nativeDw;
  }

  // 2. Detección estándar Unreal Engine GVAS
  const diffResult = inspectProperty(buffer, ["SurvivalDifficulty", "DifficultyType", "EDifficultyType", "Difficulty"], "difficulty");
  const pvpResult = inspectProperty(buffer, ["FriendlyFire", "bFriendlyFire", "PvpEnabled", "PVPEnabled", "bPvPEnabled"], "pvp");

  const detected = diffResult.found || pvpResult.found;
  const difficulty = diffResult.found ? diffResult.value : 1;
  const pvpEnabled = pvpResult.found ? Boolean(pvpResult.value) : false;

  return {
    detected,
    format: "gvas",
    difficulty,
    difficultyLabel: DIFFICULTY_LABELS[difficulty] || "Normal",
    pvpEnabled,
    pvpLabel: pvpEnabled ? PVP_LABELS[1] : PVP_LABELS[0],
    offsets: {
      difficulty: diffResult.found ? diffResult.valOffset : null,
      pvp: pvpResult.found ? pvpResult.valOffset : null,
      diffType: diffResult.found ? diffResult.type : null,
      pvpType: pvpResult.found ? pvpResult.type : null,
    },
  };
}

/**
 * Modifica las reglas en un buffer binario .sav y devuelve el buffer actualizado.
 */
export function patchWorldSave(buffer, { difficulty, pvpEnabled }) {
  const inspected = inspectWorldSave(buffer);
  const copy = Buffer.from(buffer);

  let modified = false;

  if (inspected.format === "dragonwilds") {
    if (typeof difficulty === "number" && difficulty >= 0 && difficulty <= 3) {
      if (inspected.offsets.cinfDiffOffset !== null) {
        copy.writeInt32LE(difficulty, inspected.offsets.cinfDiffOffset);
        modified = true;
      }
      if (inspected.offsets.propDiffOffset !== null) {
        copy.writeUInt16LE(difficulty, inspected.offsets.propDiffOffset);
        modified = true;
      }
    }
    if (typeof pvpEnabled === "boolean" || typeof pvpEnabled === "number") {
      const val = pvpEnabled ? 1 : 0;
      if (inspected.offsets.cinfPvpOffset !== null) {
        copy[inspected.offsets.cinfPvpOffset] = val;
        modified = true;
      }
      if (inspected.offsets.propPvpOffset !== null) {
        copy[inspected.offsets.propPvpOffset] = val;
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

  // Fallback para formato GVAS / mock
  if (typeof difficulty === "number" && difficulty >= 0 && difficulty <= 3) {
    if (inspected.offsets.difficulty !== null) {
      if (inspected.offsets.diffType === "int") {
        copy.writeInt32LE(difficulty, inspected.offsets.difficulty);
      } else {
        copy.writeUInt8(difficulty, inspected.offsets.difficulty);
      }
      modified = true;
    }
  }

  if (typeof pvpEnabled === "boolean" || typeof pvpEnabled === "number") {
    const val = pvpEnabled ? 1 : 0;
    if (inspected.offsets.pvp !== null) {
      if (inspected.offsets.pvpType === "int") {
        copy.writeInt32LE(val, inspected.offsets.pvp);
      } else {
        copy.writeUInt8(val, inspected.offsets.pvp);
      }
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

