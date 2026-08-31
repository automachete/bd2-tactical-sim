let snapshot = null;

const api = async (path, body) => {
  const response = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
};

const commandLabel = command => {
  if (command.type === "USE_COSTUME") return `${command.costume_id} / Burst ${command.burst_level}`;
  return ({ NORMAL_ATTACK: "通常攻撃", KNOCKBACK: "ノックバック", WAIT: "待機" })[command.type] || command.type;
};

const drawGrid = (id, side, units) => {
  const root = document.querySelector(id);
  root.innerHTML = "";
  for (let row = 0; row < 3; row++) {
    for (let depth = 0; depth < 4; depth++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const occupants = units.filter(item => item.side === side && item.position.row === row && item.position.depth === depth);
      const unit = occupants.find(item => item.alive) || occupants[0];
      if (unit) {
        const card = document.createElement("div");
        card.className = `unit ${unit.alive ? "" : "dead"}`;
        const ratio = Math.max(0, 100 * unit.hp / unit.base_stats.max_hp);
        card.innerHTML = `<div class="unit-name">#${unit.id} ${unit.character_id}</div><div class="hp"><i style="width:${ratio}%"></i></div><div class="unit-meta">${unit.hp.toLocaleString()} / ${unit.base_stats.max_hp.toLocaleString()} · ${unit.effects.length} effects</div>`;
        cell.append(card);
      }
      root.append(cell);
    }
  }
};

const render = data => {
  snapshot = data;
  const state = data.state;
  const units = Object.values(state.units);
  document.querySelector("#mode").textContent = state.rules.mode;
  document.querySelector("#turn").textContent = `TURN ${state.game_turn}`;
  document.querySelector("#device").textContent = `${data.device.toUpperCase()}${data.policy_side ? ` · POLICY ${data.policy_side}` : ""}`;
  document.querySelector("#active-side").textContent = `${state.active_side} ACTIVE`;
  document.querySelector("#player-sp").textContent = state.teams[0].sp;
  document.querySelector("#enemy-sp").textContent = state.teams[1].sp;
  document.querySelector("#seed").textContent = `SEED ${data.seed}`;
  drawGrid("#player-grid", "PLAYER", units);
  drawGrid("#enemy-grid", "ENEMY", units);

  const commands = document.querySelector("#commands");
  commands.innerHTML = "";
  data.legal.forEach((entry, slot) => {
    const row = document.createElement("div");
    row.className = "command";
    row.innerHTML = `<label>#${entry.unit_id}</label><select data-slot="${slot}">${entry.commands.map((command, index) => `<option value="${index}">${commandLabel(command)}</option>`).join("")}</select>`;
    commands.append(row);
  });
  const events = document.querySelector("#events");
  events.innerHTML = state.event_log.slice(-120).reverse().map(event => `<li>${String(event.sequence).padStart(4, "0")} ${event.kind.type} ${JSON.stringify(event.kind).replaceAll(/[{}\"]/g, "")}</li>`).join("");
  document.querySelector("#event-count").textContent = state.event_log.length;
  const terminal = document.querySelector("#terminal");
  if (state.terminal) {
    terminal.classList.remove("hidden");
    terminal.textContent = `${state.terminal.outcome} · ${state.terminal.reason}`;
  } else terminal.classList.add("hidden");
};

document.querySelector("#execute").addEventListener("click", async () => {
  const actions = Array.from(document.querySelectorAll("select[data-slot]"), select => Number(select.value));
  while (actions.length < 5) actions.push(0);
  render(await api("/api/step", { actions }));
});
document.querySelector("#ai-step").addEventListener("click", async () => render(await api("/api/ai-step", {})));
document.querySelector("#reset").addEventListener("click", async () => render(await api("/api/reset", {})));

render(await api("/api/state"));
