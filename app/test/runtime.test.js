import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings, publicSettings, validateSettings } from "../src/runtime.js";

test("valida una instalación directa y oculta secretos", () => {
  const settings = validateSettings({
    ownerId: "eos-owner-123",
    serverName: "Umbrel Test",
    worldName: "Ashenfall",
    worldPassword: "join-secret",
    adminPassword: "admin-secret",
    administrators: "eos-admin-1",
    autoStart: true,
    autoUpdate: true,
    backupRetention: 12,
    networkMode: "direct",
  }, defaultSettings());

  assert.equal(settings.configured, true);
  assert.equal(settings.backupRetention, 12);
  assert.equal(settings.worldPassword, "join-secret");
  const visible = publicSettings(settings);
  assert.equal(visible.worldPassword, "");
  assert.equal(visible.adminPassword, "");
  assert.equal(visible.hasWorldPassword, true);
  assert.equal(visible.hasAdminPassword, true);
});

test("rechaza WireGuard incompleto", () => {
  assert.throws(() => validateSettings({
    ownerId: "owner",
    serverName: "Server",
    worldName: "World",
    adminPassword: "secret",
    networkMode: "wireguard",
    vpn: { endpoint: "vps.example.com:51820", address: "10.8.0.2/24" },
  }, defaultSettings()), /claves privada local y pública/);
});

test("rechaza claves WireGuard malformadas e inyección de configuración", () => {
  assert.throws(() => validateSettings({
    ownerId: "owner",
    serverName: "Server",
    worldName: "World",
    adminPassword: "secret",
    networkMode: "wireguard",
    vpn: {
      endpoint: "vps.example.com:51820",
      address: "10.8.0.2/24",
      privateKey: "not-a-key\nPostUp = touch /tmp/injected",
      peerPublicKey: "A".repeat(43) + "=",
    },
  }, defaultSettings()), /formato base64 válido/);
});
