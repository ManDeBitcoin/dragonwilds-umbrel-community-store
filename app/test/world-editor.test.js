import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectWorldSave,
  patchWorldSave,
  readWorldRulesFromFile,
  updateWorldRulesInFile,
  DIFFICULTY_LABELS,
  PVP_LABELS,
} from "../src/world-editor.js";

/**
 * Crea un buffer simulado de Unreal Engine / SPUD con tags de DifficultyType y PvpEnabled.
 */
function createMockSaveBuffer(difficulty = 1, pvp = 0) {
  const parts = [];

  // Header SAVE
  const header = Buffer.alloc(8);
  header.write("SAVE", 0, "ascii");
  header.writeUInt32LE(256, 4);
  parts.push(header);

  // Property tag: DifficultyType
  const diffName = "DifficultyType";
  const diffTag = Buffer.alloc(4 + diffName.length + 1);
  diffTag.writeInt32LE(diffName.length + 1, 0);
  diffTag.write(diffName, 4, "ascii");
  diffTag.writeUInt8(0, 4 + diffName.length);
  parts.push(diffTag);

  // Dummy property metadata + value
  const diffVal = Buffer.alloc(16);
  diffVal.writeUInt8(difficulty, 0); // Byte value
  diffVal.writeUInt8(0, 1);
  parts.push(diffVal);

  // Property tag: PvpEnabled
  const pvpName = "PvpEnabled";
  const pvpTag = Buffer.alloc(4 + pvpName.length + 1);
  pvpTag.writeInt32LE(pvpName.length + 1, 0);
  pvpTag.write(pvpName, 4, "ascii");
  pvpTag.writeUInt8(0, 4 + pvpName.length);
  parts.push(pvpTag);

  // Dummy pvp metadata + value
  const pvpVal = Buffer.alloc(16);
  pvpVal.writeUInt8(pvp, 0);
  pvpVal.writeUInt8(0, 1);
  parts.push(pvpVal);

  return Buffer.concat(parts);
}

/**
 * Crea un buffer con la estructura real de Unreal Engine GVAS (Tagged Properties).
 */
function createGvasSaveBuffer(difficulty = 2, pvp = 1) {
  function writeFString(str) {
    const buf = Buffer.alloc(4 + str.length + 1);
    buf.writeInt32LE(str.length + 1, 0);
    buf.write(str, 4, "ascii");
    buf.writeUInt8(0, 4 + str.length);
    return buf;
  }
  function writeFName(str, number = 0) {
    const strBuf = writeFString(str);
    const numBuf = Buffer.alloc(4);
    numBuf.writeInt32LE(number, 0);
    return Buffer.concat([strBuf, numBuf]);
  }

  const parts = [];
  parts.push(Buffer.from("GVAS", "ascii"));
  parts.push(Buffer.alloc(20)); // Header metadata

  // DifficultyType (ByteProperty)
  parts.push(writeFName("DifficultyType"));
  parts.push(writeFName("ByteProperty"));
  const diffTagMeta = Buffer.alloc(8);
  diffTagMeta.writeInt32LE(1, 0); // Size = 1
  diffTagMeta.writeInt32LE(0, 4); // ArrayIndex = 0
  parts.push(diffTagMeta);
  parts.push(writeFName("None")); // EnumName
  parts.push(Buffer.from([0x00])); // Padding
  parts.push(Buffer.from([difficulty])); // Value

  // PvpEnabled (BoolProperty)
  parts.push(writeFName("PvpEnabled"));
  parts.push(writeFName("BoolProperty"));
  const pvpTagMeta = Buffer.alloc(8);
  pvpTagMeta.writeInt32LE(0, 0); // Size = 0
  pvpTagMeta.writeInt32LE(0, 4); // ArrayIndex = 0
  parts.push(pvpTagMeta);
  parts.push(Buffer.from([pvp ? 0x01 : 0x00])); // BoolVal
  parts.push(Buffer.from([0x00])); // Padding

  return Buffer.concat(parts);
}

test("detecta reglas por defecto cuando el buffer no contiene datos", () => {
  const empty = Buffer.alloc(100);
  const result = inspectWorldSave(empty);
  assert.equal(result.difficulty, 1);
  assert.equal(result.difficultyLabel, "Normal");
  assert.equal(result.pvpEnabled, false);
});

test("inspecciona correctamente dificultad y PvP desde un buffer simulado", () => {
  const buf = createMockSaveBuffer(3, 1); // Difícil (3), PvP activo
  const result = inspectWorldSave(buf);
  assert.equal(result.detected, true);
  assert.equal(result.difficulty, 3);
  assert.equal(result.difficultyLabel, "Difícil");
  assert.equal(result.pvpEnabled, true);
  assert.equal(result.pvpLabel, PVP_LABELS[1]);
});

test("inspecciona correctamente formato real de Unreal Engine GVAS (ej. Chavito: Difícil + JcJ Activo)", () => {
  const gvasBuf = createGvasSaveBuffer(3, 1); // Difícil (3), PvP Activo (1)
  const result = inspectWorldSave(gvasBuf);
  assert.equal(result.detected, true);
  assert.equal(result.difficulty, 3);
  assert.equal(result.difficultyLabel, "Difícil");
  assert.equal(result.pvpEnabled, true);
  assert.equal(result.pvpLabel, PVP_LABELS[1]);
});

test("parchea buffer real GVAS modificando dificultad y PvP y lo verifica", () => {
  const gvasBuf = createGvasSaveBuffer(2, 1); // Difícil + JcJ
  const patched = patchWorldSave(gvasBuf, { difficulty: 0, pvpEnabled: false });
  assert.equal(patched.modified, true);

  const inspected = inspectWorldSave(patched.buffer);
  assert.equal(inspected.difficulty, 0);
  assert.equal(inspected.difficultyLabel, "Personalizado");
  assert.equal(inspected.pvpEnabled, false);
  assert.equal(inspected.pvpLabel, PVP_LABELS[0]);
});

test("parchea dificultad y PvP modificando los bytes correspondientes en buffer simulado", () => {
  const initial = createMockSaveBuffer(1, 0); // Normal, Coop
  const inspectedBefore = inspectWorldSave(initial);
  assert.equal(inspectedBefore.difficulty, 1);
  assert.equal(inspectedBefore.pvpEnabled, false);

  const patched = patchWorldSave(initial, { difficulty: 0, pvpEnabled: true });
  assert.equal(patched.modified, true);

  const inspectedAfter = inspectWorldSave(patched.buffer);
  assert.equal(inspectedAfter.difficulty, 0);
  assert.equal(inspectedAfter.difficultyLabel, "Personalizado");
  assert.equal(inspectedAfter.pvpEnabled, true);
  assert.equal(inspectedAfter.pvpLabel, PVP_LABELS[1]);
});

test("lee y actualiza reglas directamente en archivos del disco", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "dragonwilds-test-"));
  const saveFile = join(tempDir, "Chavito.sav");

  try {
    const mock = createGvasSaveBuffer(3, 1);
    await writeFile(saveFile, mock);

    const initialRules = await readWorldRulesFromFile(saveFile);
    assert.equal(initialRules.difficulty, 3);
    assert.equal(initialRules.difficultyLabel, "Difícil");
    assert.equal(initialRules.pvpEnabled, true);

    await updateWorldRulesInFile(saveFile, { difficulty: 1, pvpEnabled: false });

    const updatedRules = await readWorldRulesFromFile(saveFile);
    assert.equal(updatedRules.difficulty, 1);
    assert.equal(updatedRules.difficultyLabel, "Normal");
    assert.equal(updatedRules.pvpEnabled, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("inspecciona y parchea formato nativo SAVE/CINF/PROP de Dragonwilds", async () => {
  // Construye un buffer simulado exacto con CINF y PROP
  const parts = [];
  parts.push(Buffer.from("SAVE", "ascii"));
  parts.push(Buffer.alloc(60)); // Header

  // CINF
  const cinfStart = Buffer.alloc(12);
  cinfStart.write("CINF", 0, "ascii");
  cinfStart.writeInt32LE(200, 4); // len
  cinfStart.writeInt32LE(2, 8); // 2 props: FriendlyFire, SurvivalDifficulty
  parts.push(cinfStart);

  function writeStr(s) {
    const b = Buffer.alloc(4 + s.length + 1);
    b.writeInt32LE(s.length + 1, 0);
    b.write(s, 4, "utf8");
    return b;
  }
  parts.push(writeStr("FriendlyFire"));
  parts.push(writeStr("SurvivalDifficulty"));

  // Offsets
  const offBuf = Buffer.alloc(4 + 3 * 4);
  offBuf.writeInt32LE(2, 0);
  offBuf.writeInt32LE(0, 4);  // FriendlyFire at 0
  offBuf.writeInt32LE(1, 8);  // SurvivalDifficulty at 1
  offBuf.writeInt32LE(5, 12); // End at 5
  parts.push(offBuf);

  // Payload: FriendlyFire (1 byte: 1), SurvivalDifficulty (4 bytes: 1)
  const payload = Buffer.alloc(5);
  payload.writeUInt8(1, 0); // FriendlyFire = 1
  payload.writeInt32LE(1, 1); // SurvivalDifficulty = 1
  parts.push(payload);

  const nativeBuf = Buffer.concat(parts);
  const inspected = inspectWorldSave(nativeBuf);
  assert.equal(inspected.detected, true);
  assert.equal(inspected.format, "dragonwilds");
  assert.equal(inspected.difficulty, 1);
  assert.equal(inspected.pvpEnabled, true);

  // Parchear a Dificil (3) y PvP Desactivado (0)
  const patched = patchWorldSave(nativeBuf, { difficulty: 3, pvpEnabled: false });
  assert.equal(patched.modified, true);

  const reInspected = inspectWorldSave(patched.buffer);
  assert.equal(reInspected.difficulty, 3);
  assert.equal(reInspected.difficultyLabel, "Difícil");
  assert.equal(reInspected.pvpEnabled, false);
});

