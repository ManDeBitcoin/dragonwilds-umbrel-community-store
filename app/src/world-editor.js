import { readFile, writeFile } from "node:fs/promises";

/**
 * Constantes y mapeos de reglas de juego de Dragonwilds (sin emojis).
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
      if (expectedType === "difficulty" && (mockVal === 0 || mockVal === 1 || mockVal === 2) && buffer[cursor + 1] === 0) {
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
 * Lee las reglas de juego (dificultad y PvP) de un buffer .sav de Dragonwilds.
 */
export function inspectWorldSave(buffer) {
  const diffResult = inspectProperty(buffer, ["DifficultyType", "EDifficultyType", "Difficulty"], "difficulty");
  const pvpResult = inspectProperty(buffer, ["PvpEnabled", "PVPEnabled", "bPvPEnabled", "FriendlyFire", "bFriendlyFire"], "pvp");

  const detected = diffResult.found || pvpResult.found;
  const difficulty = diffResult.found ? diffResult.value : 1;
  const pvpEnabled = pvpResult.found ? Boolean(pvpResult.value) : false;

  return {
    detected,
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

  if (typeof difficulty === "number" && difficulty >= 0 && difficulty <= 2) {
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
