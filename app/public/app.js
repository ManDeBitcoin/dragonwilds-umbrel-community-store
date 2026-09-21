const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = {
  bootstrap: null,
  status: null,
  settings: null,
  backups: [],
  rules: null,
  poller: null,
  localLogClearedAt: 0,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Blob) && !(options.body instanceof File) ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") showAuth();
    throw new Error(result?.error || `Error HTTP ${response.status}`);
  }
  return result;
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.className = "toast"), 3600);
}

function showAuth() {
  clearInterval(app.poller);
  $("#app-view").classList.add("hidden");
  $("#auth-view").classList.remove("hidden");
  $("#auth-password").focus();
}

function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  navigate(location.hash.slice(1) || "overview");
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = -1;
  do { value /= 1024; index += 1; } while (value >= 1024 && index < units.length - 1);
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function relativeTime(value) {
  if (!value) return "Nunca";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Ahora";
  if (seconds < 3600) return `Hace ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `Hace ${Math.floor(seconds / 3600)} h`;
  return `Hace ${Math.floor(seconds / 86400)} d`;
}

function duration(value) {
  if (!value) return "Sin actividad";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} h ${minutes} min activo` : `${minutes} min activo`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function stateLabel(state) {
  return ({ running: "En línea", starting: "Arrancando", stopping: "Deteniendo", stopped: "Detenido", error: "Error" })[state] || state;
}

function navigate(page) {
  const target = $(`#page-${page}`) ? page : "overview";
  $$(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${target}`));
  $$("#nav button").forEach((node) => node.classList.toggle("active", node.dataset.page === target));
  const labels = { overview: "Resumen", world: "Mundo", backups: "Backups", network: "Red y VPN", logs: "Registros", settings: "Ajustes" };
  $("#page-title").textContent = labels[target];
  if (location.hash !== `#${target}`) history.replaceState(null, "", `#${target}`);
  if (target === "settings" && !app.settings) loadSettings().catch(showError);
  if (target === "backups") loadBackups().catch(showError);
  if (target === "network") loadRules().catch(showError);
}

function renderStatus(status) {
  app.status = status;
  const online = status.server.state === "running";
  const problem = status.server.state === "error";
  const label = stateLabel(status.server.state);
  $("#server-state").textContent = label;
  $("#server-message").textContent = status.server.message;
  $("#server-uptime").textContent = duration(status.server.startedAt);
  $("#side-state").textContent = label;
  $("#side-detail").textContent = online ? `UDP ${status.server.gamePort}` : status.server.message;
  for (const id of ["#side-dot", "#hero-dot"]) {
    $(id).className = online ? "online" : problem ? "error" : "";
  }
  const toggleText = online || status.server.state === "starting" ? "Detener" : "Arrancar";
  $("#quick-toggle").textContent = toggleText;
  $("#hero-toggle").textContent = `${toggleText} servidor`;
  $("#game-port").textContent = status.server.gamePort;
  $("#beacon-port").textContent = `Baliza ${status.server.beaconPort} / UDP`;
  $("#setup-banner").classList.toggle("hidden", status.configured);
  $("#vpn-state").textContent = status.vpn.active ? "Activo" : "Inactivo";
  $("#vpn-detail").textContent = status.vpn.handshakeAt ? `Handshake ${relativeTime(status.vpn.handshakeAt).toLowerCase()}` : "Esperando handshake";
  $("#world-count").textContent = status.worlds.length;
  $("#backup-age").textContent = status.latestBackup ? relativeTime(status.latestBackup.createdAt) : "—";
  $("#backup-detail").textContent = status.latestBackup ? status.latestBackup.name : "Sin backups";
  $("#route-vps").textContent = status.vpn.endpoint || "Sin endpoint";

  $("#network-badge").textContent = status.vpn.active ? "Túnel activo" : "Túnel inactivo";
  $("#network-badge").classList.toggle("online", status.vpn.active);
  $("#network-endpoint").textContent = status.vpn.endpoint || "Sin endpoint";
  $("#network-handshake").textContent = status.vpn.handshakeAt ? `Último handshake: ${relativeTime(status.vpn.handshakeAt).toLowerCase()}` : "Sin handshake reciente";
  $("#network-rx").textContent = formatBytes(status.vpn.received);
  $("#network-tx").textContent = formatBytes(status.vpn.sent);

  renderWorlds(status.worlds);
  renderActivity(status.logs);
  renderLogs(status.logs);
}

function renderWorlds(worlds) {
  $("#world-list").innerHTML = worlds.length ? worlds.map((world) => `
    <div class="list-row"><div><b>${escapeHtml(world.name)}</b><small>${formatBytes(world.size)} · ${formatDate(world.updatedAt)}</small></div><span class="status-badge online">Guardado</span></div>
  `).join("") : '<p class="empty">Aún no hay mundos guardados.</p>';
}

function renderActivity(logs) {
  const items = logs.slice(-6).reverse();
  $("#activity").innerHTML = items.length ? items.map((item) => `
    <div class="activity-item"><i></i><b>${escapeHtml(item.line.slice(0, 90))}</b><time>${relativeTime(item.at)}</time></div>
  `).join("") : '<p class="empty">Todavía no hay eventos.</p>';
}

function renderLogs(logs) {
  const filtered = logs.filter((item) => new Date(item.at).getTime() >= app.localLogClearedAt);
  $("#log-output").textContent = filtered.length
    ? filtered.map((item) => `${item.at.slice(11, 19)}  [${item.source.padEnd(6)}] ${item.line}`).join("\n")
    : "Esperando eventos…";
  $("#log-output").scrollTop = $("#log-output").scrollHeight;
}

async function refreshStatus(silent = true) {
  try {
    renderStatus(await api("/api/status"));
  } catch (error) {
    if (!silent) showError(error);
  }
}

async function loadSettings() {
  app.settings = await api("/api/settings");
  const form = $("#settings-form");
  const assign = (name, value) => {
    const field = form.elements.namedItem(name);
    if (!field) return;
    if (field instanceof RadioNodeList) {
      [...field].forEach((input) => (input.checked = input.value === value));
    } else if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value ?? "";
  };
  for (const key of ["ownerId", "serverName", "worldName", "administrators", "autoStart", "autoUpdate", "backupRetention", "networkMode"]) assign(key, app.settings[key]);
  for (const key of ["address", "endpoint", "listenPort", "keepalive", "peerPublicKey"]) assign(`vpn.${key}`, app.settings.vpn[key]);
  assign("worldPassword", "");
  assign("adminPassword", "");
  assign("vpn.privateKey", "");
  assign("vpn.presharedKey", "");
  updateVpnFields();
}

async function loadBackups() {
  app.backups = await api("/api/backups");
  $("#backup-list").innerHTML = app.backups.length ? app.backups.map((backup) => `
    <div class="backup-row"><div><b>${escapeHtml(backup.name)}</b><small>${formatDate(backup.createdAt)} · ${formatBytes(backup.size)}</small></div><button class="button tiny restore-backup" data-name="${encodeURIComponent(backup.name)}">Restaurar</button></div>
  `).join("") : '<p class="empty">Todavía no hay backups.</p>';
  $$(".restore-backup").forEach((button) => button.addEventListener("click", () => restoreBackup(decodeURIComponent(button.dataset.name))));
}

async function loadRules() {
  app.rules = await api("/api/vps-rules");
  $("#rules-up").value = app.rules.postUp;
  $("#rules-down").value = app.rules.postDown;
}

function settingsPayload(form) {
  const data = new FormData(form);
  return {
    ownerId: data.get("ownerId"),
    serverName: data.get("serverName"),
    worldName: data.get("worldName"),
    worldPassword: data.get("worldPassword"),
    adminPassword: data.get("adminPassword"),
    administrators: data.get("administrators"),
    autoStart: data.has("autoStart"),
    autoUpdate: data.has("autoUpdate"),
    backupRetention: Number(data.get("backupRetention")),
    networkMode: data.get("networkMode"),
    vpn: {
      address: data.get("vpn.address"),
      endpoint: data.get("vpn.endpoint"),
      listenPort: Number(data.get("vpn.listenPort")),
      keepalive: Number(data.get("vpn.keepalive")),
      privateKey: data.get("vpn.privateKey"),
      peerPublicKey: data.get("vpn.peerPublicKey"),
      presharedKey: data.get("vpn.presharedKey"),
    },
  };
}

async function serverAction(action) {
  const labels = { start: "Arrancando servidor…", stop: "Deteniendo servidor…", restart: "Reiniciando servidor…", update: "Creando backup y actualizando…", validate: "Validando archivos…" };
  toast(labels[action]);
  await api(`/api/server/${action}`, { method: "POST" });
  await refreshStatus(false);
}

function currentToggleAction() {
  return ["running", "starting"].includes(app.status?.server.state) ? "stop" : "start";
}

function confirmAction(title, copy) {
  return new Promise((resolve) => {
    const dialog = $("#confirm-dialog");
    $("#dialog-title").textContent = title;
    $("#dialog-copy").textContent = copy;
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

async function restoreBackup(name) {
  if (!(await confirmAction("Restaurar backup", `Se creará un backup de seguridad antes de reemplazar Saved con ${name}.`))) return;
  toast("Restaurando backup…");
  await api(`/api/backups/${encodeURIComponent(name)}/restore`, { method: "POST" });
  toast("Backup restaurado. El servidor vuelve a arrancar.");
  await Promise.all([loadBackups(), refreshStatus(false)]);
}

function updateVpnFields() {
  const mode = $("#settings-form").elements.namedItem("networkMode").value;
  $("#vpn-fields").classList.toggle("hidden", mode !== "wireguard");
}

function showError(error) {
  toast(error.message || String(error), true);
}

async function initialize() {
  app.bootstrap = await api("/api/bootstrap");
  const needsSetup = app.bootstrap.needsLocalPassword;
  $("#auth-confirm-wrap").classList.toggle("hidden", !needsSetup);
  $("#auth-label").textContent = needsSetup ? "Crea una contraseña" : "Contraseña";
  $("#auth-copy").textContent = needsSetup
    ? "Primera ejecución: crea una contraseña local de al menos 12 caracteres."
    : app.bootstrap.managedByUmbrel
      ? "Usa la contraseña de la app mostrada por Umbrel."
      : "Accede al centro de control de tu mundo.";
  $("#auth-form .button").textContent = needsSetup ? "Crear contraseña" : "Entrar al panel";
  if (app.bootstrap.authenticated) {
    showApp();
    await Promise.all([refreshStatus(false), loadSettings()]);
    app.poller = setInterval(() => refreshStatus(true), 5000);
  } else showAuth();
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const password = $("#auth-password").value;
    if (app.bootstrap.needsLocalPassword) {
      if (password !== $("#auth-confirm").value) throw new Error("Las contraseñas no coinciden.");
      await api("/api/setup-password", { method: "POST", body: JSON.stringify({ password }) });
    } else await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    showApp();
    await Promise.all([refreshStatus(false), loadSettings()]);
    clearInterval(app.poller);
    app.poller = setInterval(() => refreshStatus(true), 5000);
  } catch (error) { showError(error); }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  showAuth();
});

$("#nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (button) navigate(button.dataset.page);
});
$$(`[data-goto]`).forEach((button) => button.addEventListener("click", () => navigate(button.dataset.goto)));
window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));

$("#refresh").addEventListener("click", () => refreshStatus(false));
$("#quick-toggle").addEventListener("click", () => serverAction(currentToggleAction()).catch(showError));
$("#hero-toggle").addEventListener("click", () => serverAction(currentToggleAction()).catch(showError));
$("#quick-restart").addEventListener("click", () => serverAction("restart").catch(showError));
$("#hero-update").addEventListener("click", () => serverAction("update").catch(showError));

$("#test-ip").addEventListener("click", async () => {
  try {
    $("#public-ip").textContent = "Comprobando…";
    const result = await api("/api/network/public-ip", { method: "POST" });
    $("#public-ip").textContent = result.ip || "Sin respuesta";
  } catch (error) { $("#public-ip").textContent = "Falló"; showError(error); }
});

$("#create-backup").addEventListener("click", async () => {
  try {
    toast("Deteniendo el juego y creando backup…");
    await api("/api/backups", { method: "POST" });
    toast("Backup creado correctamente.");
    await Promise.all([loadBackups(), refreshStatus(false)]);
  } catch (error) { showError(error); }
});

$("#world-file").addEventListener("change", () => {
  const file = $("#world-file").files[0];
  $("#import-world").disabled = !file;
  $("#world-file-name").textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "Máximo 2 GB";
});

$("#import-world").addEventListener("click", async () => {
  const file = $("#world-file").files[0];
  if (!file) return;
  try {
    if (!(await confirmAction("Importar mundo", "Se detendrá el servidor, se respaldará el estado actual y se importará el archivo seleccionado."))) return;
    toast("Importando mundo. No cierres esta pestaña…");
    await api("/api/worlds/import", { method: "POST", headers: { "x-file-name": file.name.replace(/[^a-zA-Z0-9._-]+/g, "-") }, body: file });
    toast("Mundo importado correctamente.");
    $("#world-file").value = "";
    $("#import-world").disabled = true;
    await refreshStatus(false);
  } catch (error) { showError(error); }
});

$("#vpn-apply").addEventListener("click", async () => {
  try { await api("/api/vpn/apply", { method: "POST" }); toast("Túnel aplicado."); await refreshStatus(false); } catch (error) { showError(error); }
});
$("#vpn-stop").addEventListener("click", async () => {
  try { await api("/api/vpn/stop", { method: "POST" }); toast("Túnel detenido."); await refreshStatus(false); } catch (error) { showError(error); }
});
$("#copy-rules").addEventListener("click", async () => {
  try {
    if (!app.rules) await loadRules();
    await navigator.clipboard.writeText(`WG_POST_UP=${app.rules.postUp}\n\nWG_POST_DOWN=${app.rules.postDown}`);
    toast("Reglas copiadas al portapapeles.");
  } catch (error) { showError(error); }
});
$("#clear-log-view").addEventListener("click", () => { app.localLogClearedAt = Date.now(); renderLogs(app.status?.logs || []); });

$$('input[name="networkMode"]').forEach((input) => input.addEventListener("change", updateVpnFields));
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    toast("Guardando y aplicando configuración…");
    app.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify(settingsPayload(event.currentTarget)) });
    toast("Configuración aplicada.");
    await Promise.all([loadSettings(), refreshStatus(false), loadRules()]);
    navigate("overview");
  } catch (error) { showError(error); }
});

initialize().catch(showError);
