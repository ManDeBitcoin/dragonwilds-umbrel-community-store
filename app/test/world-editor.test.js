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

test("detecta reglas por defecto cuando el buffer no contiene datos", () => {
  const empty = Buffer.alloc(100);
  const result = inspectWorldSave(empty);
  assert.equal(result.difficulty, 1);
  assert.equal(result.difficultyLabel, "Normal");
  assert.equal(result.pvpEnabled, false);
});

test("inspecciona correctamente dificultad y PvP desde un buffer simulado", () => {
  const buf = createMockSaveBuffer(2, 1); // Difícil, PvP activo
  const result = inspectWorldSave(buf);
  assert.equal(result.detected, true);
  assert.equal(result.difficulty, 2);
  assert.equal(result.difficultyLabel, "Difícil");
  assert.equal(result.pvpEnabled, true);
  assert.equal(result.pvpLabel, PVP_LABELS[1]);
});

test("parchea dificultad y PvP modificando los bytes correspondientes", () => {
  const initial = createMockSaveBuffer(1, 0); // Normal, Coop
  const inspectedBefore = inspectWorldSave(initial);
  assert.equal(inspectedBefore.difficulty, 1);
  assert.equal(inspectedBefore.pvpEnabled, false);

  const patched = patchWorldSave(initial, { difficulty: 0, pvpEnabled: true });
  assert.equal(patched.modified, true);

  const inspectedAfter = inspectWorldSave(patched.buffer);
  assert.equal(inspectedAfter.difficulty, 0);
  assert.equal(inspectedAfter.difficultyLabel, "Historia / Fácil");
  assert.equal(inspectedAfter.pvpEnabled, true);
  assert.equal(inspectedAfter.pvpLabel, PVP_LABELS[1]);
});

test("lee y actualiza reglas directamente en archivos del disco", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "dragonwilds-test-"));
  const saveFile = join(tempDir, "TestWorld.sav");

  try {
    const mock = createMockSaveBuffer(0, 0);
    await writeFile(saveFile, mock);

    const initialRules = await readWorldRulesFromFile(saveFile);
    assert.equal(initialRules.difficulty, 0);
    assert.equal(initialRules.pvpEnabled, false);

    await updateWorldRulesInFile(saveFile, { difficulty: 2, pvpEnabled: true });

    const updatedRules = await readWorldRulesFromFile(saveFile);
    assert.equal(updatedRules.difficulty, 2);
    assert.equal(updatedRules.difficultyLabel, "Difícil");
    assert.equal(updatedRules.pvpEnabled, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
