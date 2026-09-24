const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const app = {
  bootstrap: null,
  status: null,
  settings: null,
  backups: [],
  rules: null,
  players: [],
  onlinePlayers: [],
  logs: [],
  activeLogFilter: "all",
  logEventSource: null,
  poller: null,
  fastPoller: null,
  worldRulesLoaded: false,
  worldRulesDirty: false,
  localLogClearedAt: 0,
  cpuHistory: [],
  ramHistory: [],
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
  stopFastPolling();
  if (app.logEventSource) {
    app.logEventSource.close();
    app.logEventSource = null;
  }
  $("#app-view").classList.add("hidden");
  $("#auth-view").classList.remove("hidden");
  $("#auth-password").focus();
}

function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  initLogStream();
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

function drawSparkline(canvasId, data, strokeColor = "#9ddc7b", fillColor = "rgba(157, 220, 123, 0.15)", isPercent = false) {
  const canvas = $(`#${canvasId}`);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = rect.width || canvas.width || 220;
  const height = rect.height || canvas.height || 42;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  if (!data || data.length === 0) {
    ctx.restore();
    return;
  }

  const points = data.length === 1 ? [data[0], data[0]] : [...data];
  let min = isPercent ? 0 : Math.min(...points);
  let max = isPercent ? 100 : Math.max(...points);
  if (max === min) max = min + 1;

  if (!isPercent) {
    const pad = (max - min) * 0.15;
    min = Math.max(0, min - pad);
    max += pad;
  }

  const paddingX = 4;
  const paddingY = 4;
  const chartW = width - paddingX * 2;
  const chartH = height - paddingY * 2;

  const coords = points.map((val, idx) => {
    const x = paddingX + (idx / (points.length - 1)) * chartW;
    const norm = (val - min) / (max - min);
    const y = paddingY + chartH - Math.max(0, Math.min(1, norm)) * chartH;
    return { x, y };
  });

  // Area fill under spline
  ctx.beginPath();
  ctx.moveTo(coords[0].x, height);
  ctx.lineTo(coords[0].x, coords[0].y);

  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    const midX = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
  }

  ctx.lineTo(coords[coords.length - 1].x, height);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, paddingY, 0, height);
  grad.addColorStop(0, fillColor);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  // Line stroke
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    const midX = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(midX, p0.y, midX, p1.y, p1.x, p1.y);
  }
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();

  // Glowing dot at latest point
  const last = coords[coords.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();

  ctx.restore();
}

function deduplicatePlayers(players = []) {
  const map = new Map();
  for (const p of players) {
    if (!p) continue;
    const key = (p.userName || p.userId || "").toLowerCase().trim();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, p);
    } else if (!/^[0-9a-fA-F]{32}$/.test(existing.userId) && /^[0-9a-fA-F]{32}$/.test(p.userId)) {
      map.set(key, p);
    }
  }
  return Array.from(map.values());
}

function renderPlayerSlots(onlineCount, maxPlayers = 6, onlinePlayers = []) {
  const uniquePlayers = deduplicatePlayers(onlinePlayers);
  const effectiveCount = Math.max(0, uniquePlayers.length > 0 ? uniquePlayers.length : onlineCount);
  const pill = $("#player-slots-indicator");
  if (pill) {
    let nodes = "";
    for (let i = 0; i < maxPlayers; i++) {
      const occupied = i < effectiveCount;
      nodes += `<span class="slot-node ${occupied ? "occupied" : ""}" title="Slot ${i + 1}: ${occupied ? "Ocupado" : "Libre"}"></span>`;
    }
    pill.innerHTML = nodes;
  }

  const badge = $("#slots-badge-count");
  if (badge) {
    badge.textContent = `${effectiveCount} / ${maxPlayers} Ocupados`;
    badge.className = `badge-mini ${effectiveCount > 0 ? "online" : ""}`;
  }

  const rosterVisual = $("#roster-slots-visual");
  if (rosterVisual) {
    let orbs = "";
    for (let i = 0; i < maxPlayers; i++) {
      const isOccupied = i < effectiveCount;
      const player = isOccupied ? uniquePlayers[i] : null;
      const name = player ? escapeHtml(player.userName) : `Slot ${i + 1}`;
      orbs += `
        <div class="roster-slot-orb ${isOccupied ? "occupied" : "empty"}" title="${name} (${isOccupied ? "En línea" : "Disponible"})">
          ${isOccupied 
            ? `<svg class="slot-icon" style="stroke: var(--green); fill: none; stroke-width: 2;"><use href="#icon-sword"/></svg>` 
            : `<svg class="slot-icon" style="stroke: #55665b; stroke-width: 1.5; fill: none;"><path d="M12 5v14M5 12h14"/></svg>`
          }
          <span class="slot-num">S${i + 1}</span>
        </div>
      `;
    }
    rosterVisual.innerHTML = orbs;
  }
}

function generatePlayerAvatar(userId, userName = "", size = 36) {
  const seedStr = String(userId || userName || "hero");
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash << 5) - hash + seedStr.charCodeAt(i);
    hash |= 0;
  }
  const h = Math.abs(hash);

  const palettes = [
    ["#14281d", "#0c1710", "#9ddc7b", "#c5e39d"],
    ["#2f1b0c", "#170c04", "#f0ae50", "#ffd494"],
    ["#0e2433", "#06121c", "#72acd4", "#bde0fe"],
    ["#24122e", "#120718", "#c084fc", "#e9d5ff"],
    ["#2b1210", "#140706", "#e96c56", "#fecaca"],
    ["#23231e", "#10100d", "#d4af37", "#fef08a"],
    ["#0f2824", "#061513", "#4ade80", "#86efac"],
    ["#201c2c", "#0f0d16", "#a78bfa", "#ddd6fe"],
  ];
  const p = palettes[h % palettes.length];

  const crestShapes = [
    "M18 4 L29 8 L29 19 C29 26 18 31 18 31 C18 31 7 26 7 19 L7 8 Z",
    "M18 4 L30 11 L30 25 L18 32 L6 25 L6 11 Z",
    "M18 5 C26 5 30 10 30 18 C30 26 23 31 18 32 C13 31 6 26 6 18 C6 10 10 5 18 5 Z",
    "M18 4 L28 14 L28 24 L18 31 L8 24 L8 14 Z",
  ];
  const crest = crestShapes[(h >> 3) % crestShapes.length];

  const runes = [
    `<path d="M18 10 L18 24 M13 15 L23 15 M14 11 L22 19" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/>`,
    `<path d="M18 10 L18 24 M18 13 L23 10 M18 18 L23 15" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/>`,
    `<path d="M13 12 L18 9 L23 12 L23 21 L18 24 L13 21 Z M18 9 L18 24" stroke="${p[3]}" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`,
    `<circle cx="18" cy="17" r="4.5" stroke="${p[3]}" stroke-width="1.8" fill="none"/><line x1="18" y1="9" x2="18" y2="12.5" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/><line x1="18" y1="21.5" x2="18" y2="25" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/><line x1="10" y1="17" x2="13.5" y2="17" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/><line x1="22.5" y1="17" x2="26" y2="17" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/>`,
    `<path d="M13 12 L18 17 L23 12 M13 17 L18 22 L23 17" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path d="M14 13 L22 21 M22 13 L14 21 M18 10 L18 24" stroke="${p[3]}" stroke-width="1.8" stroke-linecap="round"/>`,
  ];
  const rune = runes[(h >> 6) % runes.length];

  const uid = "av_" + (h % 100000);
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" aria-label="Emblema de ${escapeHtml(userName || userId)}">
      <defs>
        <radialGradient id="${uid}_bg" cx="50%" cy="30%" r="70%">
          <stop offset="0%" stop-color="${p[0]}"/>
          <stop offset="100%" stop-color="${p[1]}"/>
        </radialGradient>
        <linearGradient id="${uid}_edge" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${p[2]}" stop-opacity="0.8"/>
          <stop offset="100%" stop-color="${p[2]}" stop-opacity="0.2"/>
        </linearGradient>
      </defs>
      <rect width="36" height="36" fill="url(#${uid}_bg)"/>
      <path d="${crest}" fill="rgba(0,0,0,0.3)" stroke="url(#${uid}_edge)" stroke-width="1.5"/>
      ${rune}
    </svg>
  `.trim();
}

function navigate(page) {
  const target = $(`#page-${page}`) ? page : "overview";
  $$(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${target}`));
  $$("#nav button").forEach((node) => node.classList.toggle("active", node.dataset.page === target));
  const labels = { overview: "Resumen", world: "Mundo", players: "Jugadores", backups: "Backups", network: "Red y VPN", logs: "Registros", settings: "Ajustes" };
  $("#page-title").textContent = labels[target] || "Resumen";
  if (location.hash !== `#${target}`) history.replaceState(null, "", `#${target}`);
  if (target === "players") loadPlayers().catch(showError);
  if (target === "settings" && !app.settings) loadSettings().catch(showError);
  if (target === "backups") loadBackups().catch(showError);
  if (target === "network") loadRules().catch(showError);
  if (target === "logs") loadLogs(app.activeLogFilter).catch(showError);
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

  // Telemetry & Players
  const uniquePlayers = deduplicatePlayers(status.onlinePlayers || []);
  const onlineCount = uniquePlayers.length;
  const maxPlayers = status.maxPlayers || 6;
  const onlineMetric = $("#metric-online-players");
  if (onlineMetric) onlineMetric.textContent = `${onlineCount} / ${maxPlayers}`;
  const onlineDetail = $("#metric-online-detail");
  if (onlineDetail) onlineDetail.textContent = onlineCount ? `${onlineCount} jugador(es) activo(s)` : "Ninguno conectado";

  // Visual slot nodes & roster
  renderPlayerSlots(onlineCount, maxPlayers, uniquePlayers);

  if (status.metrics) {
    const gameCpu = status.metrics.process?.cpuPercent || 0;
    const sysLoad = status.metrics.system?.loadAvg?.[0]?.toFixed(1) || "0.0";
    const cpuMetric = $("#metric-cpu");
    if (cpuMetric) cpuMetric.textContent = `${gameCpu}%`;
    const cpuDetail = $("#metric-cpu-detail");
    if (cpuDetail) cpuDetail.textContent = `Servidor: ${gameCpu}% · Sis: ${sysLoad}`;

    app.cpuHistory.push(gameCpu);
    if (app.cpuHistory.length > 30) app.cpuHistory.shift();
    drawSparkline("cpu-sparkline", app.cpuHistory, "#c084fc", "rgba(192, 132, 252, 0.2)", true);

    const gameMem = status.metrics.process?.memoryMb || 0;
    const panelMem = status.metrics.panel?.memoryMb || 0;
    const ramMetric = $("#metric-ram");
    if (ramMetric) ramMetric.textContent = `${gameMem} MB`;
    const ramDetail = $("#metric-ram-detail");
    if (ramDetail) ramDetail.textContent = `Juego: ${gameMem} MB · Panel: ${panelMem} MB`;

    app.ramHistory.push(gameMem);
    if (app.ramHistory.length > 30) app.ramHistory.shift();
    drawSparkline("ram-sparkline", app.ramHistory, "#f0ae50", "rgba(240, 174, 80, 0.2)", false);
  }

  // VPN Status & Watchdog
  const vpnHealthy = status.vpn.healthy !== false;
  $("#vpn-state").textContent = status.vpn.active ? (vpnHealthy ? "Activo" : "Reconectando") : "Inactivo";
  $("#vpn-detail").textContent = status.vpn.handshakeAt
    ? `Handshake ${relativeTime(status.vpn.handshakeAt).toLowerCase()}`
    : "Esperando handshake";

  $("#backup-age").textContent = status.latestBackup ? relativeTime(status.latestBackup.createdAt) : "—";
  $("#backup-detail").textContent = status.latestBackup ? status.latestBackup.name : "Sin backups";
  $("#route-vps").textContent = status.vpn.endpoint || "Sin endpoint";

  $("#network-badge").textContent = status.vpn.active
    ? (vpnHealthy ? "Túnel saludable" : "Watchdog: reconectando")
    : "Túnel inactivo";
  $("#network-badge").classList.toggle("online", status.vpn.active && vpnHealthy);
  $("#network-endpoint").textContent = status.vpn.endpoint || "Sin endpoint";
  $("#network-handshake").textContent = status.vpn.handshakeAt
    ? `Último handshake: hace ${status.vpn.handshakeAgeSec !== null && status.vpn.handshakeAgeSec !== undefined ? status.vpn.handshakeAgeSec + "s" : relativeTime(status.vpn.handshakeAt).toLowerCase()}`
    : "Sin handshake reciente";
  $("#network-rx").textContent = formatBytes(status.vpn.received);
  $("#network-tx").textContent = formatBytes(status.vpn.sent);

  renderWorlds(status.worlds);
  renderActivity(status.logs);
  if (!app.logs || !app.logs.length) {
    app.logs = status.logs || [];
    renderLogs(app.logs);
  }
  renderOnlinePlayers(uniquePlayers);

  if (status.server.state === "starting" || status.server.state === "stopping") {
    if (!app.fastPoller) triggerFastPolling();
  } else {
    stopFastPolling();
  }
}

function renderWorlds(worlds) {
  const datalist = $("#world-datalist");
  if (datalist) {
    const datalistHtml = worlds.map((w) => `<option value="${escapeHtml(w.baseName || w.name.replace(/\.sav$/i, ""))}"></option>`).join("");
    if (datalist.innerHTML !== datalistHtml) {
      datalist.innerHTML = datalistHtml;
    }
  }

  const worldSelect = $("#rules-world-select");
  if (worldSelect && worlds.length) {
    const currentVal = worldSelect.value || $("#rules-world-input")?.value;
    const targetBase = worlds.some((w) => (w.baseName || w.name.replace(/\.sav$/i, "")) === currentVal)
      ? currentVal
      : ((worlds.find((w) => w.active) || worlds[0]).baseName || (worlds.find((w) => w.active) || worlds[0]).name.replace(/\.sav$/i, ""));

    const newOptionsHtml = worlds.map((w) => {
      const base = w.baseName || w.name.replace(/\.sav$/i, "");
      const activeTag = w.active ? " (Activo)" : "";
      return `<option value="${escapeHtml(base)}">${escapeHtml(base)}${activeTag}</option>`;
    }).join("");

    if (worldSelect.innerHTML !== newOptionsHtml) {
      worldSelect.innerHTML = newOptionsHtml;
      worldSelect.value = targetBase;
    } else if (worldSelect.value !== targetBase && !app.worldRulesDirty) {
      worldSelect.value = targetBase;
    }

    if (!app.worldRulesLoaded) {
      loadWorldRulesIntoForm(targetBase, worlds);
      app.worldRulesLoaded = true;
    }
  }

  $("#world-list").innerHTML = worlds.length ? worlds.map((world) => {
    const base = world.baseName || world.name.replace(/\.sav$/i, "");
    const isActive = world.active;
    const modeText = world.rules?.gameModeLabel || "Estándar";
    const diffText = world.rules?.difficultyLabel || "Normal";
    const pvpText = world.rules?.pvpEnabled ? "JcJ activado" : "Cooperativo";
    const pvpClass = world.rules?.pvpEnabled ? "amber" : "blue";
    const crossText = world.rules?.crossplayLabel || (world.rules?.crossplayEnabled !== false ? "Crossplay ON" : "Crossplay OFF");

    return `
      <div class="world-item-card ${isActive ? 'active-card' : ''}">
        <div class="world-item-main">
          <div class="world-title-row">
            <b>${escapeHtml(base)}</b>
            ${isActive ? '<span class="status-badge online">ACTIVO</span>' : ''}
          </div>
          <div class="world-badges">
            <span class="badge-tag purple">${escapeHtml(modeText)}</span>
            <span class="badge-tag green">${escapeHtml(diffText)}</span>
            <span class="badge-tag ${pvpClass}">${escapeHtml(pvpText)}</span>
            <span class="badge-tag">${escapeHtml(crossText)}</span>
            <small class="muted">${formatBytes(world.size)} · ${formatDate(world.updatedAt)}</small>
          </div>
        </div>
        <div class="world-item-actions">
          ${!isActive ? `<button class="button tiny ghost activate-world" data-name="${encodeURIComponent(base)}" type="button">Activar</button>` : ''}
          <button class="button tiny ghost edit-world-rules" data-name="${encodeURIComponent(base)}" type="button">Editar reglas</button>
          <a class="button tiny ghost" href="/api/worlds/${encodeURIComponent(base)}/download" download="${escapeHtml(world.name)}">Descargar</a>
        </div>
      </div>
    `;
  }).join("") : '<p class="empty">Aún no hay mundos guardados.</p>';

  $$(".activate-world").forEach((btn) => {
    btn.addEventListener("click", () => activateWorld(decodeURIComponent(btn.dataset.name)));
  });
  $$(".edit-world-rules").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetName = decodeURIComponent(btn.dataset.name);
      const sel = $("#rules-world-select");
      if (sel) sel.value = targetName;
      loadWorldRulesIntoForm(targetName);
      $("#world-rules-panel")?.scrollIntoView({ behavior: "smooth" });
    });
  });
}

function loadWorldRulesIntoForm(worldName, worldsList = app.status?.worlds || []) {
  const world = worldsList.find((w) => (w.baseName || w.name.replace(/\.sav$/i, "")) === worldName);
  const targetName = world ? (world.baseName || world.name.replace(/\.sav$/i, "")) : worldName;

  const worldSelect = $("#rules-world-select");
  if (worldSelect && worldSelect.value !== targetName) {
    worldSelect.value = targetName;
  }
  $("#rules-world-input").value = targetName;

  const isActive = world ? world.active : (app.status?.settings?.worldName === targetName);
  $("#rules-active-badge").textContent = isActive ? "ACTIVO" : "PARTIDA GUARDADA";
  $("#rules-active-badge").className = `status-badge ${isActive ? 'online' : ''}`;

  const activateBtn = $("#rules-activate-btn");
  if (activateBtn) {
    activateBtn.classList.toggle("hidden", isActive);
    activateBtn.textContent = `Activar "${targetName}"`;
  }

  const modeVal = String(world?.rules?.gameMode ?? 1);
  const diffVal = String(world?.rules?.difficulty ?? 0);
  const pvpVal = Boolean(world?.rules?.pvpEnabled);
  const crossplayVal = world?.rules?.crossplayEnabled !== undefined ? Boolean(world?.rules?.crossplayEnabled) : true;

  const modeSelect = $("#rules-mode-select");
  if (modeSelect) modeSelect.value = modeVal;

  const diffSelect = $("#rules-difficulty-select");
  if (diffSelect) diffSelect.value = diffVal;

  const pvpToggle = $("#rules-pvp-toggle");
  if (pvpToggle) {
    pvpToggle.checked = pvpVal;
    updatePvpToggleLabels(pvpVal);
  }

  const crossplayToggle = $("#rules-crossplay-toggle");
  if (crossplayToggle) {
    crossplayToggle.checked = crossplayVal;
    updateCrossplayToggleLabels(crossplayVal);
  }

  app.worldRulesDirty = false;
  updateUnsavedRulesIndicator();
}

function markRulesFormDirty() {
  app.worldRulesDirty = true;
  updateUnsavedRulesIndicator();
}

function updateUnsavedRulesIndicator() {
  const badge = $("#rules-unsaved-badge");
  if (badge) badge.classList.toggle("hidden", !app.worldRulesDirty);
}

function updatePvpToggleLabels(checked) {
  const title = $("#rules-pvp-title");
  const desc = $("#rules-pvp-desc");
  if (title) title.textContent = checked ? "Fuego amigo activado" : "Fuego amigo desactivado";
  if (desc) desc.textContent = checked ? "Modo JcJ: los ataques dañan a otros jugadores." : "Modo cooperativo: los jugadores no se hacen daño.";
}

function updateCrossplayToggleLabels(checked) {
  const title = $("#rules-crossplay-title");
  const desc = $("#rules-crossplay-desc");
  if (title) title.textContent = checked ? "Crossplay habilitado" : "Crossplay deshabilitado";
  if (desc) desc.textContent = checked ? "Permite que jugadores de PC y consolas se unan." : "Restringe el acceso cruzado de plataformas.";
}

async function activateWorld(name) {
  if (!(await confirmAction("Activar mundo", `¿Deseas activar "${name}" como el mundo principal del servidor? El juego se reiniciará con esta partida.`))) {
    return;
  }
  try {
    toast(`Activando mundo ${name} y reiniciando…`);
    await api(`/api/worlds/${encodeURIComponent(name)}/activate`, { method: "POST" });
    toast(`Mundo "${name}" activado correctamente.`);
    await refreshStatus(false);
  } catch (error) {
    showError(error);
  }
}

function renderActivity(logs) {
  const items = logs.slice(-6).reverse();
  $("#activity").innerHTML = items.length ? items.map((item) => `
    <div class="activity-item"><i></i><b>${escapeHtml(item.line.slice(0, 90))}</b><time>${relativeTime(item.at)}</time></div>
  `).join("") : '<p class="empty">Todavía no hay eventos.</p>';
}

function renderLogs(logs) {
  const list = logs || app.logs || [];
  const filtered = list
    .filter((item) => new Date(item.at).getTime() >= app.localLogClearedAt)
    .filter((item) => app.activeLogFilter === "all" || (item.source || "").toLowerCase() === app.activeLogFilter.toLowerCase());

  $("#log-output").textContent = filtered.length
    ? filtered.map((item) => `${(item.at || "").slice(11, 19) || "--:--:--"}  [${(item.source || "server").padEnd(6)}] ${item.line}`).join("\n")
    : "Esperando eventos…";
  $("#log-output").scrollTop = $("#log-output").scrollHeight;
}

function updateLogViewMeta(filter) {
  const titles = {
    all: "dragonwilds.log (Todos los registros)",
    server: "RSDragonwilds.log (Servidor de Juego)",
    panel: "panel.log (Panel de Control)",
    vpn: "vpn.log (WireGuard VPN)",
    backup: "backup.log (Copias de Seguridad)",
    world: "world.log (Gestor de Mundos)",
  };
  const titleSpan = $(".terminal-bar span");
  if (titleSpan) {
    titleSpan.textContent = titles[filter] || "dragonwilds.log";
  }
  const downloadBtn = $("#download-log-btn");
  if (downloadBtn) {
    downloadBtn.href = `/api/logs/download?source=${encodeURIComponent(filter)}`;
    downloadBtn.setAttribute("download", filter === "server" ? "RSDragonwilds.log" : `dragonwilds-${filter}.log`);
  }
}

async function loadLogs(source = app.activeLogFilter) {
  try {
    const data = await api(`/api/logs?source=${encodeURIComponent(source)}&limit=300`);
    if (data && Array.isArray(data.logs)) {
      if (source === "all") {
        app.logs = data.logs;
      } else {
        const otherLogs = (app.logs || []).filter((l) => (l.source || "").toLowerCase() !== source.toLowerCase());
        app.logs = [...otherLogs, ...data.logs].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      }
      renderLogs(app.logs);
    }
  } catch (err) {
    console.warn("No se pudieron cargar registros:", err);
  }
}

function initLogStream() {
  if (app.logEventSource) {
    app.logEventSource.close();
    app.logEventSource = null;
  }
  try {
    const es = new EventSource("/api/logs/stream");
    app.logEventSource = es;
    const pill = $("#sse-status-pill");
    es.onopen = () => {
      if (pill) {
        pill.textContent = "SSE EN VIVO";
        pill.className = "status-badge online";
      }
    };
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "connected") return;
        if (data.type === "state") {
          refreshStatus(true);
          return;
        }
        if (data.type === "players") {
          refreshStatus(true);
          loadPlayers();
          return;
        }
        if (!app.logs) app.logs = [];
        app.logs.push(data);
        if (app.logs.length > 2000) app.logs.shift();
        if (!app.status) app.status = { logs: [] };
        if (!app.status.logs) app.status.logs = [];
        app.status.logs.push(data);
        if (app.status.logs.length > 200) app.status.logs.shift();
        renderLogs(app.logs);
        renderActivity(app.logs);
      } catch {}
    };
    es.onerror = () => {
      if (pill) {
        pill.textContent = "SSE RECONECTANDO";
        pill.className = "status-badge";
      }
    };
  } catch (err) {
    console.warn("No se pudo iniciar EventSource SSE:", err);
  }
}

function triggerFastPolling(durationMs = 20000) {
  if (app.fastPoller) clearInterval(app.fastPoller);
  app.fastPoller = setInterval(async () => {
    try {
      const status = await api("/api/status");
      renderStatus(status);
    } catch {}
  }, 1000);

  clearTimeout(triggerFastPolling.timer);
  triggerFastPolling.timer = setTimeout(() => {
    stopFastPolling();
  }, durationMs);
}

function stopFastPolling() {
  if (app.fastPoller) {
    clearInterval(app.fastPoller);
    app.fastPoller = null;
  }
  if (triggerFastPolling.timer) {
    clearTimeout(triggerFastPolling.timer);
    triggerFastPolling.timer = null;
  }
}

async function refreshStatus(silent = true) {
  try {
    renderStatus(await api("/api/status"));
  } catch (error) {
    if (!silent) showError(error);
  }
}

async function loadPlayers() {
  try {
    const data = await api("/api/players");
    app.players = data.knownPlayers || [];
    app.onlinePlayers = data.onlinePlayers || [];
    renderKnownPlayers(app.players);
    renderOnlinePlayers(app.onlinePlayers);
  } catch (error) {
    showError(error);
  }
}

function renderOnlinePlayers(players) {
  const uniquePlayers = deduplicatePlayers(players);
  const countSpan = $("#online-players-count");
  if (countSpan) countSpan.textContent = uniquePlayers.length;

  const list = $("#online-players-list");
  if (!list) return;

  if (!uniquePlayers.length) {
    list.innerHTML = '<p class="empty">No hay jugadores conectados en este momento.</p>';
    return;
  }

  list.innerHTML = uniquePlayers.map((p) => `
    <div class="list-row" style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid var(--line);">
      <div class="player-user-cell" style="gap: 0.85rem;">
        <div class="player-avatar-wrap">${generatePlayerAvatar(p.userId, p.userName)}</div>
        <i class="player-online-dot active"></i>
        <div>
          <b>${escapeHtml(p.userName)}</b>
          <small class="muted" style="display: block; margin-top: 0.2rem;"><code>${escapeHtml(p.userId)}</code> · Conectado ${p.joinedAt ? relativeTime(p.joinedAt).toLowerCase() : "recientemente"}</small>
        </div>
      </div>
      <div>
        ${p.isAdmin ? '<span class="role-badge admin"><svg class="action-svg" style="width:12px;height:12px;"><use href="#icon-shield"/></svg> Admin</span>' : '<span class="role-badge player"><svg class="action-svg" style="width:12px;height:12px;"><use href="#icon-sword"/></svg> Jugador</span>'}
      </div>
    </div>
  `).join("");
}

function renderKnownPlayers(players) {
  const tbody = $("#known-players-tbody");
  if (!tbody) return;

  if (!players.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty" style="padding: 1.5rem; text-align: center;">No hay jugadores registrados aún en KnownPlayerList.</td></tr>';
    return;
  }

  tbody.innerHTML = players.map((p) => {
    const isOwner = p.isOwner;
    const isAdmin = p.isAdmin;
    const isBanned = p.isBanned;
    const isOnline = p.isOnline;

    const roleHtml = isOwner
      ? '<span class="role-badge owner"><svg class="action-svg" style="width:12px;height:12px;"><use href="#icon-crown"/></svg> Propietario</span>'
      : isAdmin
        ? '<span class="role-badge admin"><svg class="action-svg" style="width:12px;height:12px;"><use href="#icon-shield"/></svg> Admin</span>'
        : '<span class="role-badge player"><svg class="action-svg" style="width:12px;height:12px;"><use href="#icon-sword"/></svg> Jugador</span>';

    const statusHtml = isBanned
      ? '<span class="status-tag banned">Baneado</span>'
      : '<span class="status-tag active">Permitido</span>';

    const actionsHtml = isOwner
      ? '<small class="muted">Propietario del servidor</small>'
      : `
        <div class="player-actions-cell">
          <button class="button tiny ghost player-toggle-admin" data-id="${escapeHtml(p.userId)}" data-admin="${isAdmin ? "1" : "0"}">
            ${isAdmin ? "Quitar admin" : "Hacer admin"}
          </button>
          <button class="button tiny ${isBanned ? "ghost" : "danger"} player-toggle-ban" data-id="${escapeHtml(p.userId)}" data-banned="${isBanned ? "1" : "0"}">
            ${isBanned ? "Desbanear" : "Banear"}
          </button>
          <button class="button tiny ghost player-delete" data-id="${escapeHtml(p.userId)}" data-name="${escapeHtml(p.userName)}" title="Eliminar">
            ✕
          </button>
        </div>
      `;

    return `
      <tr class="player-row">
        <td style="text-align: center;">
          <div class="player-avatar-wrap" style="margin: 0 auto;">${generatePlayerAvatar(p.userId, p.userName)}</div>
        </td>
        <td>
          <div class="player-user-cell">
            <i class="player-online-dot ${isOnline ? "active" : ""}" title="${isOnline ? "Conectado ahora" : "Desconectado"}"></i>
            <b>${escapeHtml(p.userName)}</b>
          </div>
        </td>
        <td><code>${escapeHtml(p.userId)}</code></td>
        <td>${roleHtml}</td>
        <td>${statusHtml}</td>
        <td style="text-align: right;">${actionsHtml}</td>
      </tr>
    `;
  }).join("");

  $$(".player-toggle-admin").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const currentAdmin = btn.dataset.admin === "1";
      try {
        toast("Actualizando rol en DedicatedServer.ini…");
        await api(`/api/players/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ isAdmin: !currentAdmin }),
        });
        toast("Permisos actualizados.");
        await Promise.all([loadPlayers(), refreshStatus(false)]);
      } catch (err) {
        showError(err);
      }
    });
  });

  $$(".player-toggle-ban").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const currentBanned = btn.dataset.banned === "1";
      const actionStr = currentBanned ? "desbanear" : "banear";
      if (!(await confirmAction(`Confirmar ${actionStr}`, `¿Seguro que deseas ${actionStr} a este jugador?`))) return;
      try {
        toast("Actualizando estado del jugador…");
        await api(`/api/players/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ isBanned: !currentBanned }),
        });
        toast(`Jugador ${currentBanned ? "desbaneado" : "baneado"} correctamente.`);
        await Promise.all([loadPlayers(), refreshStatus(false)]);
      } catch (err) {
        showError(err);
      }
    });
  });

  $$(".player-delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!(await confirmAction("Eliminar jugador", `¿Eliminar a "${name}" (${id}) de KnownPlayerList?`))) return;
      try {
        toast("Eliminando jugador…");
        await api(`/api/players/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast("Jugador eliminado de la lista.");
        await Promise.all([loadPlayers(), refreshStatus(false)]);
      } catch (err) {
        showError(err);
      }
    });
  });
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
  for (const key of ["ownerId", "serverName", "worldName", "administrators", "platformPolicy", "autoUpdate", "backupRetention", "backupSchedule", "networkMode"]) assign(key, app.settings[key]);
  assign("performance.tickRate", String(app.settings.performance?.tickRate || 60));
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
    <div class="backup-row" style="display: flex; justify-content: space-between; align-items: center; padding: 0.9rem 0; border-bottom: 1px solid var(--line);">
      <div>
        <b>${escapeHtml(backup.name)}</b>
        <small style="display: block; margin-top: 0.25rem; color: var(--muted);">${formatDate(backup.createdAt)} · ${formatBytes(backup.size)}</small>
      </div>
      <div style="display: flex; gap: 0.4rem; align-items: center;">
        <a class="button tiny ghost" href="/api/backups/${encodeURIComponent(backup.name)}/download" download="${escapeHtml(backup.name)}">Descargar</a>
        <button class="button tiny restore-backup" data-name="${encodeURIComponent(backup.name)}">Restaurar</button>
      </div>
    </div>
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
    platformPolicy: data.get("platformPolicy") || "Crossplay",
    administrators: data.get("administrators"),
    autoStart: false,
    autoUpdate: data.has("autoUpdate"),
    backupRetention: Number(data.get("backupRetention")),
    backupSchedule: data.get("backupSchedule") || "disabled",
    performance: {
      tickRate: Number(data.get("performance.tickRate") || 60),
    },
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
  triggerFastPolling(30000);
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
  if (location.search) {
    history.replaceState(null, "", location.pathname + location.hash);
  }
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

async function handleManualRefresh() {
  const refreshBtn = $("#refresh");
  if (refreshBtn) refreshBtn.classList.add("rotating");
  toast("Actualizando datos del servidor…");
  try {
    await Promise.all([refreshStatus(false), loadPlayers(), loadBackups()]);
  } catch (err) {
    showError(err);
  } finally {
    if (refreshBtn) {
      setTimeout(() => refreshBtn.classList.remove("rotating"), 500);
    }
  }
}

$("#refresh").addEventListener("click", handleManualRefresh);
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

$("#refresh-worlds")?.addEventListener("click", () => refreshStatus(false));

$("#rules-world-select")?.addEventListener("change", async (event) => {
  const name = event.target.value;
  if (!name) return;
  loadWorldRulesIntoForm(name);
  try {
    const fresh = await api(`/api/worlds/${encodeURIComponent(name)}/rules`);
    // Proteger contra condiciones de carrera: NO sobreescribir si el usuario ya empezó a editar o si cambió de mundo
    if (fresh && !app.worldRulesDirty && $("#rules-world-input")?.value === name) {
      const modeSelect = $("#rules-mode-select");
      if (modeSelect && typeof fresh.gameMode === "number") modeSelect.value = String(fresh.gameMode);
      const diffSelect = $("#rules-difficulty-select");
      if (diffSelect && typeof fresh.difficulty === "number") diffSelect.value = String(fresh.difficulty);
      const pvpToggle = $("#rules-pvp-toggle");
      if (pvpToggle && typeof fresh.pvpEnabled === "boolean") {
        pvpToggle.checked = fresh.pvpEnabled;
        updatePvpToggleLabels(fresh.pvpEnabled);
      }
      const crossToggle = $("#rules-crossplay-toggle");
      if (crossToggle && typeof fresh.crossplayEnabled === "boolean") {
        crossToggle.checked = fresh.crossplayEnabled;
        updateCrossplayToggleLabels(fresh.crossplayEnabled);
      }
    }
  } catch (error) {
    console.warn("No se pudieron refrescar las reglas del mundo:", error);
  }
});

$("#rules-activate-btn")?.addEventListener("click", () => {
  const targetWorld = $("#rules-world-input")?.value;
  if (targetWorld) activateWorld(targetWorld);
});

["change", "input"].forEach((evt) => {
  $("#rules-mode-select")?.addEventListener(evt, markRulesFormDirty);
  $("#rules-difficulty-select")?.addEventListener(evt, markRulesFormDirty);

  $("#rules-pvp-toggle")?.addEventListener(evt, (event) => {
    updatePvpToggleLabels(event.target.checked);
    markRulesFormDirty();
  });

  $("#rules-crossplay-toggle")?.addEventListener(evt, (event) => {
    updateCrossplayToggleLabels(event.target.checked);
    markRulesFormDirty();
  });
});

$$(".toggle-card").forEach((card) => {
  card.addEventListener("click", () => {
    markRulesFormDirty();
  });
});

$("#world-rules-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetWorld = $("#rules-world-input").value;
  if (!targetWorld) {
    showError(new Error("Selecciona un mundo para aplicar las reglas."));
    return;
  }

  const gameMode = Number($("#rules-mode-select")?.value ?? 1);
  const difficulty = Number($("#rules-difficulty-select")?.value ?? 0);
  const pvpEnabled = Boolean($("#rules-pvp-toggle")?.checked);
  const crossplayEnabled = Boolean($("#rules-crossplay-toggle")?.checked);

  const modeName = gameMode === 2 ? "Hardcore (Muerte definitiva)" : gameMode === 3 ? "Creativo" : "Estándar";
  const diffName = difficulty === 1 ? "Difícil" : difficulty === 2 ? "Creativo" : difficulty === 3 ? "Personalizado" : "Normal";

  const confirmed = await confirmAction(
    "Guardar reglas del mundo",
    `Se detendrá el servidor, se creará un backup automático y se aplicarán las reglas seleccionadas (Modo: ${modeName}, Dificultad: ${diffName}, Fuego amigo: ${pvpEnabled ? "Activado" : "Desactivado"}, Crossplay: ${crossplayEnabled ? "Habilitado" : "Deshabilitado"}) a "${targetWorld}".`
  );

  if (!confirmed) return;

  const submitBtn = $("#save-rules-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "Aplicando reglas y guardando…";

  try {
    toast("Deteniendo servidor, creando backup y aplicando reglas…");
    const result = await api(`/api/worlds/${encodeURIComponent(targetWorld)}/rules`, {
      method: "POST",
      body: JSON.stringify({ gameMode, difficulty, pvpEnabled, crossplayEnabled }),
    });
    toast("¡Reglas aplicadas con éxito!");
    app.worldRulesDirty = false;
    updateUnsavedRulesIndicator();
    await refreshStatus(false);
  } catch (error) {
    showError(error);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Guardar y aplicar reglas";
  }
});

// Category filters for logs
$$(".log-filter").forEach((btn) => {
  btn.addEventListener("click", async () => {
    $$(".log-filter").forEach((b) => b.classList.remove("active", "dark"));
    $$(".log-filter").forEach((b) => b.classList.add("ghost"));
    btn.classList.add("active", "dark");
    btn.classList.remove("ghost");
    app.activeLogFilter = btn.dataset.filter || "all";
    updateLogViewMeta(app.activeLogFilter);
    await loadLogs(app.activeLogFilter);
  });
});

// Limpiar vista de registros
$("#clear-log-view")?.addEventListener("click", () => {
  app.localLogClearedAt = Date.now();
  renderLogs(app.logs);
  toast("Vista de registros limpiada.");
});

// Players modal and actions
$("#refresh-players")?.addEventListener("click", () => loadPlayers());

$("#add-player-btn")?.addEventListener("click", () => {
  const dialog = $("#player-dialog");
  $("#player-form-id").value = "";
  $("#player-form-name").value = "";
  $("#player-form-admin").checked = false;
  $("#player-form-banned").checked = false;
  dialog.showModal();
});

$("#player-modal-cancel")?.addEventListener("click", () => {
  $("#player-dialog")?.close();
});

$("#player-modal-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = $("#player-form-id").value.trim();
  const userName = $("#player-form-name").value.trim();
  const isAdmin = $("#player-form-admin").checked;
  const isBanned = $("#player-form-banned").checked;

  if (!userId || !userName) {
    showError(new Error("Player ID y Nombre de usuario son requeridos."));
    return;
  }

  try {
    toast("Añadiendo jugador a KnownPlayerList…");
    await api("/api/players", {
      method: "POST",
      body: JSON.stringify({ userId, userName, isAdmin, isBanned }),
    });
    toast(`Jugador "${userName}" registrado correctamente.`);
    $("#player-dialog").close();
    await Promise.all([loadPlayers(), refreshStatus(false)]);
  } catch (err) {
    showError(err);
  }
});

window.addEventListener("resize", () => {
  if (app.cpuHistory && app.cpuHistory.length) {
    drawSparkline("cpu-sparkline", app.cpuHistory, "#c084fc", "rgba(192, 132, 252, 0.2)", true);
  }
  if (app.ramHistory && app.ramHistory.length) {
    drawSparkline("ram-sparkline", app.ramHistory, "#f0ae50", "rgba(240, 174, 80, 0.2)", false);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshStatus(true);
    loadPlayers();
  }
});

window.addEventListener("focus", () => {
  refreshStatus(true);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "r" || e.key === "R") {
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || document.activeElement?.isContentEditable) {
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    handleManualRefresh();
  }
});

initialize().catch(showError);

