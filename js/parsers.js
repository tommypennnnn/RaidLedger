// =====================================================================
//  parsers.js — pure, browser-side parsing. No network, no DOM.
//  Everything here is deterministic and unit-testable.
// =====================================================================
import {
  FLASK_SPELL_IDS,
  POTION_SPELL_IDS,
  AVOIDABLE_SPELL_IDS,
  SCORING,
} from "./config.js";

// ---------------------------------------------------------------------
//  Small utilities
// ---------------------------------------------------------------------

// Strip the "-Realm" suffix so "Thrall-Area52" === "Thrall".
export function stripRealm(name) {
  if (!name) return "";
  return name.replace(/^"|"$/g, "").split("-")[0].trim();
}

// A player GUID looks like "Player-1234-000ABCDE". Anything else
// (Creature-, Vehicle-, GameObject-, or empty) is treated as hostile/env.
function isPlayerGUID(guid) {
  return typeof guid === "string" && guid.startsWith("Player-");
}

// Quote-aware CSV splitter for a single combat-log payload line.
// WoW wraps string fields in double quotes and may contain commas inside.
function splitCsv(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Parse "8/18/2025 20:15:30.123-7" or classic "8/18 20:15:30.123" -> ms epoch.
// Absolute year is irrelevant for durations; we default missing years so the
// math stays consistent across a session (and correctly rolls over midnight).
function parseTimestamp(ts) {
  const sp = ts.indexOf(" ");
  const datePart = ts.slice(0, sp);
  let timePart = ts.slice(sp + 1);

  // drop trailing timezone offset like "-7" / "+2" that follows the seconds
  timePart = timePart.replace(/([+-]\d+)$/, "");

  const dateBits = datePart.split("/").map(Number); // [M, D] or [M, D, Y]
  const month = dateBits[0];
  const day = dateBits[1];
  const year = dateBits.length >= 3 ? dateBits[2] : 2024;

  const [hms, msRaw] = timePart.split(".");
  const [h, m, s] = hms.split(":").map(Number);
  const ms = msRaw ? Number(msRaw.padEnd(3, "0").slice(0, 3)) : 0;

  return new Date(year, month - 1, day, h, m, s, ms).getTime();
}

const DIFFICULTY_MAP = {
  14: "Normal",
  15: "Heroic",
  16: "Mythic",
  17: "LFR",
  23: "Mythic", // dungeon mythic, kept for completeness
};

// ---------------------------------------------------------------------
//  COMBAT LOG PARSER
//  Returns { meta, players } where players carry every computed metric.
// ---------------------------------------------------------------------
export function parseCombatLog(text) {
  const lines = text.split(/\r?\n/);

  const encounters = []; // {id, name, difficulty, start, end, durationSec, success}
  let current = null; // encounter in progress

  // Per-player accumulators keyed by realm-stripped name.
  const players = new Map();
  function player(name) {
    const key = stripRealm(name);
    if (!key) return null;
    if (!players.has(key)) {
      players.set(key, {
        name: key,
        flaskApplications: 0,
        flaskIntervals: [], // [{start, end|null}]
        _flaskOpen: null,
        potionCasts: [], // [ts]
        deaths: [], // [{ts, avoidable}]
        recentDamage: [], // rolling [{ts, kind, spellId, hostile}]
        seen: false, // appeared as an actor -> counts as present
      });
    }
    return players.get(key);
  }

  let firstTs = null;
  let lastTs = null;
  let instanceId = null;
  let difficulty = null;

  for (const raw of lines) {
    if (!raw) continue;
    // timestamp and payload are separated by two spaces in the log format
    const sep = raw.indexOf("  ");
    if (sep === -1) continue;
    const ts = parseTimestamp(raw.slice(0, sep));
    if (firstTs === null) firstTs = ts;
    lastTs = ts;

    const f = splitCsv(raw.slice(sep + 2));
    const event = f[0];

    // ---- Encounter boundaries -------------------------------------
    if (event === "ENCOUNTER_START") {
      const id = Number(f[1]);
      current = {
        id,
        name: f[2].replace(/^"|"$/g, ""),
        difficulty: Number(f[3]),
        start: ts,
        end: null,
        success: false,
      };
      instanceId = Number(f[5]);
      difficulty = DIFFICULTY_MAP[Number(f[3])] || `Diff ${f[3]}`;
      continue;
    }
    if (event === "ENCOUNTER_END") {
      if (current) {
        current.end = ts;
        current.success = f[5] === "1";
        current.durationSec = (current.end - current.start) / 1000;
        encounters.push(current);
        current = null;
      }
      continue;
    }

    // ---- Actor presence (source is a player) ----------------------
    const sGUID = f[1];
    const sName = f[2];
    if (isPlayerGUID(sGUID)) {
      const p = player(sName);
      if (p) p.seen = true;
    }

    // ---- Flask aura up/down ---------------------------------------
    if (
      (event === "SPELL_AURA_APPLIED" ||
        event === "SPELL_AURA_REFRESH" ||
        event === "SPELL_AURA_REMOVED") &&
      isPlayerGUID(f[5]) // aura is ON a player (dest)
    ) {
      const spellId = Number(f[9]);
      if (FLASK_SPELL_IDS.has(spellId)) {
        const p = player(f[6]);
        if (p) {
          if (event === "SPELL_AURA_APPLIED") {
            p.flaskApplications++;
            if (p._flaskOpen === null) p._flaskOpen = ts;
          } else if (event === "SPELL_AURA_REFRESH") {
            if (p._flaskOpen === null) p._flaskOpen = ts;
          } else {
            // REMOVED
            if (p._flaskOpen !== null) {
              p.flaskIntervals.push({ start: p._flaskOpen, end: ts });
              p._flaskOpen = null;
            }
          }
        }
      }
    }

    // ---- Combat potion cast ---------------------------------------
    if (event === "SPELL_CAST_SUCCESS" && isPlayerGUID(sGUID)) {
      const spellId = Number(f[9]);
      if (POTION_SPELL_IDS.has(spellId)) {
        const p = player(sName);
        if (p) p.potionCasts.push(ts);
      }
    }

    // ---- Damage TO a player (for death cause analysis) ------------
    if (event.endsWith("_DAMAGE") && isPlayerGUID(f[5])) {
      const p = player(f[6]);
      if (p) {
        let kind = "spell";
        let spellId = 0;
        if (event.startsWith("SWING")) {
          kind = "swing";
        } else if (event.startsWith("ENVIRONMENTAL")) {
          kind = "env";
        } else {
          spellId = Number(f[9]); // SPELL_/RANGE_ damage
        }
        p.recentDamage.push({ ts, kind, spellId, hostile: !isPlayerGUID(sGUID) });
        if (p.recentDamage.length > 20) p.recentDamage.shift(); // bound memory
      }
    }

    // ---- Player death ---------------------------------------------
    if (event === "UNIT_DIED" && isPlayerGUID(f[5])) {
      // only deaths during a boss encounter matter
      if (current) {
        const p = player(f[6]);
        if (p) {
          p.deaths.push({
            ts,
            encounterId: current.id,
            avoidable: classifyDeath(p, ts, current.id),
          });
        }
      }
    }
  }

  // close any flask interval still open at end of log
  const endTs = lastTs !== null ? lastTs : 0;
  for (const p of players.values()) {
    if (p._flaskOpen !== null) {
      p.flaskIntervals.push({ start: p._flaskOpen, end: Math.max(endTs, p._flaskOpen) });
      p._flaskOpen = null;
    }
  }

  // ------------------- derive per-player metrics -------------------
  const totalBossMs = encounters.reduce((a, e) => a + (e.end - e.start), 0) || 1;
  const legitPulls = encounters.filter(
    (e) => e.durationSec >= SCORING.legitPullSeconds
  );

  const result = [];
  for (const p of players.values()) {
    if (!p.seen && p.deaths.length === 0 && p.potionCasts.length === 0) continue;

    // Flask uptime = overlap of flask intervals with boss windows.
    let flaskMs = 0;
    for (const e of encounters) {
      for (const iv of p.flaskIntervals) {
        flaskMs += overlap(iv.start, iv.end, e.start, e.end);
      }
    }
    const flaskUptimePct = clamp((flaskMs / totalBossMs) * 100, 0, 100);

    // Potion effectiveness: cast inside a legit pull = effective.
    let potionsEffective = 0;
    for (const ts of p.potionCasts) {
      const e = encounterAt(encounters, ts);
      if (e && e.durationSec >= SCORING.legitPullSeconds) potionsEffective++;
    }
    const potionsUsed = p.potionCasts.length;
    const consumableEfficiency =
      potionsUsed > 0 ? (potionsEffective / potionsUsed) * 100 : 0;

    // Potion score for preparedness: did they pop on the real pulls?
    const potionScore =
      legitPulls.length > 0
        ? clamp((potionsEffective / legitPulls.length) * 100, 0, 100)
        : 0;

    const preparednessScore =
      SCORING.flaskWeight * flaskUptimePct + SCORING.potionWeight * potionScore;

    const avoidable = p.deaths.filter((d) => d.avoidable).length;
    const unavoidable = p.deaths.length - avoidable;
    const deathCostIndex =
      avoidable * SCORING.avoidableDeathWeight +
      unavoidable * SCORING.unavoidableDeathWeight;

    result.push({
      name: p.name,
      status: "present",
      flasks_used: p.flaskApplications,
      flask_uptime_pct: round1(flaskUptimePct),
      potions_used: potionsUsed,
      potions_effective: potionsEffective,
      consumable_efficiency: round1(consumableEfficiency),
      preparedness_score: round1(preparednessScore),
      avoidable_deaths: avoidable,
      unavoidable_deaths: unavoidable,
      death_cost_index: round2(deathCostIndex),
    });
  }

  const meta = {
    raidDate: firstTs ? isoDate(firstTs) : isoDate(Date.now()),
    instanceId,
    difficulty: difficulty || "Unknown",
    zoneNameGuess:
      encounters.length > 0 ? `Instance ${instanceId}` : "Unknown Zone",
    encounters: encounters.map((e) => ({
      id: e.id,
      name: e.name,
      durationSec: round1(e.durationSec),
      success: e.success,
    })),
  };

  return { meta, players: result };

  // ---- inner helper: avoidable vs unavoidable -------------------
  function classifyDeath(p, ts, encounterId) {
    const lookbackMs = 6000;
    const recent = p.recentDamage.filter((d) => ts - d.ts <= lookbackMs && d.hostile);

    // Preferred path: a curated per-boss avoidable spell list exists.
    const set = AVOIDABLE_SPELL_IDS[encounterId];
    if (set && set.size) {
      return recent.some((d) => d.kind === "spell" && set.has(d.spellId));
    }

    // Fallback heuristic (documented as approximate):
    //  - killing blow / last hit is a SPELL from the boss  -> AVOIDABLE
    //    (you got hit by a cast/mechanic you could dodge)
    //  - environmental (fire/fall/lava/slime)              -> AVOIDABLE
    //  - last hit is melee SWING (sustained tank/melee dmg) -> UNAVOIDABLE
    //  - no recent hostile damage recorded                  -> UNAVOIDABLE
    if (recent.length === 0) return false;
    const last = recent[recent.length - 1];
    if (last.kind === "env") return true;
    if (last.kind === "spell") return true;
    return false; // swing
  }
}

// ---------------------------------------------------------------------
//  RCLootCouncil PARSER  (JSON, CSV/TSV, or best-effort Lua export)
//  Returns { loot: [...], players: [{name, class}] }
// ---------------------------------------------------------------------
export function parseRCLootCouncil(text) {
  const trimmed = text.trim();

  // 1) JSON export
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);
      const arr = Array.isArray(data) ? data : data.loot || data.items || [];
      return normalizeLoot(
        arr.map((e) => ({
          player: e.player || e.name || e.character,
          item_name: extractItemName(e.item || e.itemName || e.itemLink || ""),
          item_id: extractItemId(String(e.itemID || e.id || e.item || "")),
          source_boss: e.boss || e.instance || e.encounter || "",
          response: e.response || e.awardReason || "",
          class: e.class || e.classFile || "",
          date: e.date || e.time || "",
        }))
      );
    } catch (_) {
      /* fall through to CSV / Lua */
    }
  }

  // 2) CSV / TSV export (header row required)
  if (trimmed.includes("\n")) {
    const delim = trimmed.indexOf("\t") !== -1 ? "\t" : ",";
    const rows = trimmed.split(/\r?\n/).filter(Boolean);
    const header = splitDelimited(rows[0], delim).map((h) =>
      h.trim().toLowerCase().replace(/^"|"$/g, "")
    );
    // only treat as CSV if it actually looks like one
    if (header.includes("player") || header.includes("item")) {
      const col = (names) => header.findIndex((h) => names.includes(h));
      const ci = {
        player: col(["player", "name", "character"]),
        item: col(["item", "itemname"]),
        id: col(["itemid", "id", "itemstring"]),
        boss: col(["boss", "encounter"]),
        instance: col(["instance", "zone"]),
        response: col(["response", "awardreason"]),
        cls: col(["class"]),
        date: col(["date", "time"]),
      };
      const out = rows.slice(1).map((r) => {
        const c = splitDelimited(r, delim).map((x) => x.replace(/^"|"$/g, ""));
        return {
          player: get(c, ci.player),
          item_name: extractItemName(get(c, ci.item)),
          item_id: extractItemId(get(c, ci.id) || get(c, ci.item)),
          source_boss: get(c, ci.boss) || get(c, ci.instance),
          response: get(c, ci.response),
          class: get(c, ci.cls),
          date: get(c, ci.date),
        };
      });
      return normalizeLoot(out);
    }
  }

  // 3) Best-effort Lua export: pair each item link with the nearest player.
  //    Less reliable than JSON/CSV — prefer those exports when possible.
  const luaLoot = [];
  const playerRe = /\["?player"?\]\s*=\s*"([^"]+)"/gi;
  const itemRe = /\|Hitem:(\d+):[^|]*\|h\[([^\]]+)\]/g;
  const bossRe = /\["?boss"?\]\s*=\s*"([^"]+)"/i;

  // Split into loose records on "}," boundaries and scan each.
  for (const chunk of trimmed.split(/\}\s*,/)) {
    playerRe.lastIndex = 0;
    itemRe.lastIndex = 0;
    const pm = playerRe.exec(chunk);
    const im = itemRe.exec(chunk);
    if (im) {
      const bm = bossRe.exec(chunk);
      luaLoot.push({
        player: pm ? pm[1] : "",
        item_name: im[2],
        item_id: Number(im[1]),
        source_boss: bm ? bm[1] : "",
        response: "",
        class: "",
        date: "",
      });
    }
  }
  return normalizeLoot(luaLoot);
}

function normalizeLoot(entries) {
  const loot = [];
  const players = new Map();
  for (const e of entries) {
    const name = stripRealm(e.player || "");
    if (!name) continue;
    if (e.class && !players.has(name)) players.set(name, { name, class: e.class });
    else if (!players.has(name)) players.set(name, { name, class: null });
    loot.push({
      player: name,
      item_name: e.item_name || null,
      item_id: e.item_id || null,
      source_boss: e.source_boss || null,
      response: e.response || null,
      date: e.date || null,
    });
  }
  return { loot, players: [...players.values()] };
}

// ---------------------------------------------------------------------
//  tiny helpers
// ---------------------------------------------------------------------
function splitDelimited(line, delim) {
  // quote-aware split for CSV/TSV
  const out = [];
  let cur = "";
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === delim && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}
function get(arr, i) {
  return i >= 0 && i < arr.length ? arr[i].trim() : "";
}
function extractItemId(s) {
  const m = String(s).match(/item[:\-]?(\d+)/i) || String(s).match(/(\d{4,7})/);
  return m ? Number(m[1]) : null;
}
function extractItemName(s) {
  const m = String(s).match(/\[([^\]]+)\]/);
  if (m) return m[1];
  // strip color/link codes if any remain
  return String(s).replace(/\|c[0-9a-f]{8}|\|r|\|H[^|]*\|h|\|h/gi, "").trim() || null;
}
function overlap(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(aStart, bStart);
  const e = Math.min(aEnd, bEnd);
  return Math.max(0, e - s);
}
function encounterAt(encounters, ts) {
  return encounters.find((e) => ts >= e.start && ts <= e.end) || null;
}
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
function isoDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
