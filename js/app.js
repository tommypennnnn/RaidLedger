// =====================================================================
//  app.js — glue between the browser, the parsers, and Supabase.
//  Handles: auth, drag & drop, DB upserts, dashboard rendering.
// =====================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { parseCombatLog, parseRCLootCouncil } from "./parsers.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// hold parsed-but-not-yet-saved results between drops
const staged = { combat: null, loot: null };

// ---------------------------------------------------------------------
//  AUTH
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

async function refreshAuthUI() {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  const signedIn = !!session;
  $("auth-view").hidden = signedIn;
  $("app-view").hidden = !signedIn;
  if (signedIn) {
    $("who").textContent = session.user.email;
    // confirm officer status — RLS will also enforce this, but we can
    // give a friendlier message up front.
    const { count } = await supabase
      .from("officers")
      .select("user_id", { count: "exact", head: true });
    if (count === 0) {
      $("officer-warning").hidden = false;
    }
    loadDashboard();
  }
}

$("sign-in").addEventListener("click", async () => {
  $("auth-error").textContent = "";
  const { error } = await supabase.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value,
  });
  if (error) $("auth-error").textContent = error.message;
  else refreshAuthUI();
});

$("sign-out").addEventListener("click", async () => {
  await supabase.auth.signOut();
  refreshAuthUI();
});

// ---------------------------------------------------------------------
//  DRAG & DROP
// ---------------------------------------------------------------------
function wireDropZone(zoneId, onText) {
  const zone = $(zoneId);
  const input = zone.querySelector('input[type="file"]');

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onText(file.name, reader.result);
    reader.readAsText(file);
  };

  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove("drag");
    })
  );
  zone.addEventListener("drop", (e) => readFile(e.dataTransfer.files[0]));
  zone.addEventListener("click", () => input.click());
  input.addEventListener("change", (e) => readFile(e.target.files[0]));
}

wireDropZone("drop-combat", (name, text) => {
  try {
    staged.combat = parseCombatLog(text);
    const m = staged.combat.meta;
    $("combat-status").textContent =
      `✓ ${name}: ${staged.combat.players.length} players, ` +
      `${m.encounters.length} encounters, ${m.difficulty}, ${m.raidDate}`;
    // prefill the raid form from the log
    $("raid-date").value = m.raidDate;
    if (!$("raid-zone").value) $("raid-zone").value = m.zoneNameGuess;
    $("raid-difficulty").value = m.difficulty;
    $("save-btn").disabled = false;
  } catch (err) {
    $("combat-status").textContent = `Couldn't parse that log: ${err.message}`;
  }
});

wireDropZone("drop-loot", (name, text) => {
  try {
    staged.loot = parseRCLootCouncil(text);
    $("loot-status").textContent =
      `✓ ${name}: ${staged.loot.loot.length} loot awards, ` +
      `${staged.loot.players.length} players`;
  } catch (err) {
    $("loot-status").textContent = `Couldn't parse that export: ${err.message}`;
  }
});

// ---------------------------------------------------------------------
//  SAVE TO SUPABASE
//  Order: players -> raid -> attendance/preparedness/performance -> loot
//  Every write is an upsert on a natural key, so re-uploading a night
//  corrects the numbers instead of duplicating rows.
// ---------------------------------------------------------------------
$("save-btn").addEventListener("click", async () => {
  const btn = $("save-btn");
  btn.disabled = true;
  setSaveStatus("Saving…");

  try {
    if (!staged.combat) throw new Error("Drop a combat log first.");

    // 1) Collect every player name we know about (log + loot) and upsert.
    const classByName = new Map();
    (staged.loot?.players || []).forEach((p) =>
      classByName.set(p.name, p.class)
    );
    const names = new Set(staged.combat.players.map((p) => p.name));
    (staged.loot?.loot || []).forEach((l) => names.add(l.player));

    const playerRows = [...names].map((name) => ({
      name,
      class: classByName.get(name) || null,
    }));
    const { error: pErr } = await supabase
      .from("players")
      .upsert(playerRows, { onConflict: "name", ignoreDuplicates: false });
    if (pErr) throw pErr;

    // map name -> id
    const { data: playerData, error: pSelErr } = await supabase
      .from("players")
      .select("id, name")
      .in("name", [...names]);
    if (pSelErr) throw pSelErr;
    const idByName = new Map(playerData.map((p) => [p.name, p.id]));

    // 2) Upsert the raid, get its id.
    const raidRow = {
      raid_date: $("raid-date").value,
      zone_name: $("raid-zone").value || staged.combat.meta.zoneNameGuess,
      difficulty: $("raid-difficulty").value || staged.combat.meta.difficulty,
    };
    const { data: raidData, error: rErr } = await supabase
      .from("raids")
      .upsert(raidRow, {
        onConflict: "raid_date,zone_name,difficulty",
        ignoreDuplicates: false,
      })
      .select("id")
      .single();
    if (rErr) throw rErr;
    const raidId = raidData.id;

    // 3) Per-player fact rows.
    const attendance = [];
    const preparedness = [];
    const performance = [];
    for (const p of staged.combat.players) {
      const pid = idByName.get(p.name);
      if (!pid) continue;
      attendance.push({ raid_id: raidId, player_id: pid, status: p.status });
      preparedness.push({
        raid_id: raidId,
        player_id: pid,
        flasks_used: p.flasks_used,
        flask_uptime_pct: p.flask_uptime_pct,
        potions_used: p.potions_used,
        potions_effective: p.potions_effective,
        consumable_efficiency: p.consumable_efficiency,
        preparedness_score: p.preparedness_score,
      });
      performance.push({
        raid_id: raidId,
        player_id: pid,
        avoidable_deaths: p.avoidable_deaths,
        unavoidable_deaths: p.unavoidable_deaths,
        death_cost_index: p.death_cost_index,
      });
    }

    await upsertOrThrow("attendance", attendance, "raid_id,player_id");
    await upsertOrThrow("preparedness", preparedness, "raid_id,player_id");
    await upsertOrThrow("performance", performance, "raid_id,player_id");

    // 4) Loot rows (idempotent on the natural key from the schema).
    if (staged.loot?.loot?.length) {
      const lootRows = staged.loot.loot
        .map((l) => {
          const pid = idByName.get(l.player);
          if (!pid) return null;
          return {
            raid_id: raidId,
            player_id: pid,
            item_name: l.item_name,
            item_id: l.item_id,
            source_boss: l.source_boss,
            response: l.response,
            won_at: l.date ? safeDate(l.date) : null,
          };
        })
        .filter(Boolean);
      await upsertOrThrow(
        "loot_history",
        lootRows,
        "raid_id,player_id,item_id,source_boss,won_at"
      );
    }

    setSaveStatus(`Saved raid #${raidId}.`, "ok");
    staged.combat = null;
    staged.loot = null;
    $("combat-status").textContent = "";
    $("loot-status").textContent = "";
    loadDashboard();
  } catch (err) {
    setSaveStatus(`Save failed: ${err.message || err}`, "err");
  } finally {
    btn.disabled = false;
  }
});

async function upsertOrThrow(table, rows, onConflict) {
  if (!rows.length) return;
  const { error } = await supabase
    .from(table)
    .upsert(rows, { onConflict, ignoreDuplicates: false });
  if (error) throw new Error(`${table}: ${error.message}`);
}

function setSaveStatus(msg, kind = "") {
  const el = $("save-status");
  el.textContent = msg;
  el.className = kind;
}

function safeDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------------------------------------------------------------------
//  DASHBOARD
// ---------------------------------------------------------------------
let attendanceChart = null;

async function loadDashboard() {
  await Promise.all([loadAttendanceChart(), loadRankings(), loadLoot()]);
}

async function loadAttendanceChart() {
  const { data, error } = await supabase
    .from("attendance_by_raid")
    .select("*")
    .order("raid_date", { ascending: true });
  if (error) return;

  const labels = data.map((r) => r.raid_date);
  const present = data.map((r) => r.present_count);

  const ctx = $("attendance-chart");
  if (attendanceChart) attendanceChart.destroy();
  // Chart.js is loaded globally from the CDN in index.html
  attendanceChart = new window.Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Players present",
          data: present,
          borderColor: "#c9a227",
          backgroundColor: "rgba(201,162,39,.15)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#e7e2d6" } } },
      scales: {
        x: { ticks: { color: "#9a9384" }, grid: { color: "#2a2620" } },
        y: {
          beginAtZero: true,
          ticks: { color: "#9a9384" },
          grid: { color: "#2a2620" },
        },
      },
    },
  });
}

async function loadRankings() {
  const { data, error } = await supabase.from("player_rankings").select("*");
  if (error) return;
  const rows = (data || []).sort(
    (a, b) => b.avg_preparedness - a.avg_preparedness
  );

  const tbody = $("rankings-body");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="name">${esc(r.name)}</td>
      <td>${esc(r.class || "—")}</td>
      <td>${r.attendance_pct}%</td>
      <td>${r.avg_preparedness}</td>
      <td>${r.avg_consumable_efficiency}%</td>
      <td>${r.avg_flask_uptime}%</td>
      <td class="${r.death_cost_index > 3 ? "warn" : ""}">${r.death_cost_index}</td>
      <td>${r.items_won}</td>
      <td class="${lootBalanceClass(r.loot_balance_ratio)}">${r.loot_balance_ratio}</td>`;
    tbody.appendChild(tr);
  }
}

function lootBalanceClass(ratio) {
  if (ratio >= 1.5) return "warn"; // getting a lot relative to contribution
  if (ratio <= 0.3) return "ok"; // under-rewarded reliable raider
  return "";
}

async function loadLoot() {
  const { data, error } = await supabase
    .from("loot_history")
    .select("item_name, item_id, source_boss, response, won_at, players(name, class)")
    .order("won_at", { ascending: false })
    .limit(500);
  if (error) return;

  const all = data.map((l) => ({
    player: l.players?.name || "—",
    cls: l.players?.class || "",
    item: l.item_name || "—",
    itemId: l.item_id,
    boss: l.source_boss || "—",
    response: l.response || "",
    date: l.won_at ? l.won_at.slice(0, 10) : "",
  }));

  const render = (rows) => {
    const tbody = $("loot-body");
    tbody.innerHTML = "";
    for (const l of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(l.player)}</td>
        <td>${esc(l.item)}</td>
        <td>${esc(l.boss)}</td>
        <td>${esc(l.response)}</td>
        <td>${esc(l.date)}</td>`;
      tbody.appendChild(tr);
    }
    $("loot-count").textContent = `${rows.length} awards`;
  };
  render(all);

  $("loot-search").oninput = (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) return render(all);
    render(
      all.filter(
        (l) =>
          l.player.toLowerCase().includes(q) ||
          l.item.toLowerCase().includes(q) ||
          l.boss.toLowerCase().includes(q)
      )
    );
  };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// keep the UI in sync if the token refreshes / expires
supabase.auth.onAuthStateChange(() => refreshAuthUI());
refreshAuthUI();
