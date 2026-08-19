// =====================================================================
//  app.js — router + views + Supabase integration
// =====================================================================
import { SUPABASE_URL, SUPABASE_ANON_KEY, SCORING } from "./config.js";
import { parseCombatLog, parseRCLootCouncil, hashText } from "./parsers.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const root = () => $("view-root");

const CLASS_COLORS = {
  Warrior:"#C69B6D",Paladin:"#F48CBA",Hunter:"#AAD372",Rogue:"#FFF468",
  Priest:"#E9ECF2",Shaman:"#0070DD",Mage:"#3FC7EB",Warlock:"#8788EE",Druid:"#FF7C0A",
};
const classColor = (c) => CLASS_COLORS[c] || "#b7becb";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pname = (name,cls) => `<span class="pname"><span class="pill-dot" style="background:${classColor(cls)}"></span>${esc(name)}${cls?` <span class="cls">${esc(cls)}</span>`:""}</span>`;
const meterColor = (v) => v>=80?"var(--good)":v>=50?"var(--warn)":"var(--bad)";
const meter = (v) => `<div class="metric-cell"><div class="meter"><span style="width:${Math.max(0,Math.min(100,v))}%;background:${meterColor(v)}"></span></div><span class="num">${v}</span></div>`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : "—";

let charts = [];
const killCharts = () => { charts.forEach((c)=>c.destroy()); charts = []; };

// ---------------------------------------------------------------- auth
async function refreshAuth(){
  const { data } = await sb.auth.getSession();
  const signed = !!data.session;
  $("auth").hidden = signed; $("app").hidden = !signed;
  if (signed){ $("who").textContent = data.session.user.email; setView(currentView); }
}
$("sign-in").addEventListener("click", async ()=>{
  $("auth-error").textContent="";
  const { error } = await sb.auth.signInWithPassword({ email:$("email").value.trim(), password:$("password").value });
  if (error) $("auth-error").textContent = error.message; else refreshAuth();
});
$("sign-out").addEventListener("click", async ()=>{ await sb.auth.signOut(); refreshAuth(); });
sb.auth.onAuthStateChange(()=>refreshAuth());

// --------------------------------------------------------------- router
let currentView = "home";
$("tabs").addEventListener("click",(e)=>{ const b=e.target.closest("button[data-view]"); if(b) setView(b.dataset.view); });
function setTab(v){ [...$("tabs").children].forEach((b)=>b.classList.toggle("active",b.dataset.view===v)); }
async function setView(v, arg){
  currentView = v; setTab(v); killCharts();
  root().innerHTML = `<div class="spin">Loading…</div>`;
  try{
    if (v==="home") await renderHome();
    else if (v==="players") await renderPlayers();
    else if (v==="player") await renderPlayerProfile(arg);
    else if (v==="raids") await renderRaids();
    else if (v==="raid") await renderRaidDetail(arg);
    else if (v==="loot") await renderLoot();
    else if (v==="upload") await renderUpload();
  }catch(err){ root().innerHTML = `<div class="card"><div class="empty">Couldn't load this view.<br><small>${esc(err.message||err)}</small></div></div>`; }
}

// -------------------------------------------------------------- fetchers
const q = (t,sel="*") => sb.from(t).select(sel);
async function rows(t,sel="*"){ const { data,error } = await q(t,sel); if(error) throw error; return data||[]; }

// ---------------------------------------------------------------- HOME
async function renderHome(){
  const [rank, prio, byRaid] = await Promise.all([
    rows("player_rankings"), rows("loot_priority"), rows("attendance_by_raid"),
  ]);
  const raids = byRaid.length;
  const avgAtt = raids ? Math.round(byRaid.reduce((a,r)=>a+(r.roster_count?100*r.present_count/r.roster_count:0),0)/raids) : 0;
  const totalLoot = rank.reduce((a,r)=>a+r.items_won,0);

  const priority = [...prio].sort((a,b)=>b.loot_priority_score-a.loot_priority_score).slice(0,8);
  const regulars = [...rank].sort((a,b)=>b.attendance_pct-a.attendance_pct||b.raids_attended-a.raids_attended).slice(0,6);
  const watch = rank.filter((r)=> r.avg_coverage<50 || r.avg_food<50 || (r.avg_consumable_efficiency<60 && r.avg_consumable_efficiency>0))
    .sort((a,b)=>a.avg_preparedness-b.avg_preparedness).slice(0,6);

  const lootTag = (s)=> s>=40?`<span class="tag good">owed loot</span>`:s>=15?`<span class="tag neutral">balanced</span>`:`<span class="tag warn">well rewarded</span>`;

  root().innerHTML = `
  <div class="grid-stats">
    <div class="stat"><div class="label">Raids logged</div><div class="value num">${raids}</div></div>
    <div class="stat"><div class="label">Avg attendance</div><div class="value num">${avgAtt}%</div></div>
    <div class="stat"><div class="label">Roster tracked</div><div class="value num">${rank.length}</div></div>
    <div class="stat"><div class="label">Items awarded</div><div class="value num">${totalLoot}</div></div>
  </div>

  <div class="card">
    <h2>Loot priority</h2>
    <div class="sub">Contribution (attendance × preparedness, minus avoidable deaths) versus loot already won. A starting point for council — highest = most owed.</div>
    <div class="plist">
      ${priority.map((p)=>`
        <div class="prow clickable" data-pid="${p.player_id}">
          <div class="rank num"></div>
          <div class="pmeta">
            ${pname(p.name,p.class)}
            <div class="pwhy">Attendance ${p.attendance_pct}% · Prep ${p.avg_preparedness} · ${p.avoidable_deaths} avoidable death${p.avoidable_deaths===1?"":"s"} · ${p.items_won} item${p.items_won===1?"":"s"} won</div>
          </div>
          ${lootTag(p.loot_priority_score)}
          <div class="pscore num">${p.loot_priority_score}</div>
        </div>`).join("") || `<div class="empty">No data yet — upload a raid.</div>`}
    </div>
  </div>

  <div class="row">
    <div class="card">
      <h2>Most reliable</h2>
      <div class="sub">Who genuinely shows up.</div>
      <div class="plist">
        ${regulars.map((p)=>`
          <div class="prow clickable" data-pid="${p.player_id}">
            <div class="pmeta">${pname(p.name,p.class)}
              <div class="pwhy">${p.raids_attended}/${p.raids_recorded} raids · last seen ${fmtDate(p.last_seen)}</div></div>
            <div class="pscore num">${p.attendance_pct}%</div>
          </div>`).join("") || `<div class="empty">—</div>`}
      </div>
    </div>
    <div class="card">
      <h2>Preparedness watch</h2>
      <div class="sub">No flask/elixir, missing food, or wasted potions.</div>
      <div class="plist">
        ${watch.map((p)=>{
          const flags=[]; if(p.avg_coverage<50)flags.push("no flask/elixir"); if(p.avg_food<50)flags.push("no food"); if(p.avg_consumable_efficiency<60&&p.avg_consumable_efficiency>0)flags.push("wasted potions");
          return `<div class="prow clickable" data-pid="${p.player_id}">
            <div class="pmeta">${pname(p.name,p.class)}<div class="pwhy">${flags.join(" · ")}</div></div>
            <span class="tag warn">prep ${p.avg_preparedness}</span></div>`;
        }).join("") || `<div class="empty">Everyone's prepared 🎉</div>`}
      </div>
    </div>
  </div>

  <div class="card">
    <h2>Attendance over time</h2>
    <div class="sub">Players present per raid night.</div>
    <canvas id="att-chart" height="80"></canvas>
  </div>`;

  root().querySelectorAll("[data-pid]").forEach((el)=>el.addEventListener("click",()=>setView("player",Number(el.dataset.pid))));
  root().querySelectorAll(".prow .rank").forEach((el,i)=>el.textContent=i+1);
  drawTrend("att-chart", byRaid.map((r)=>r.raid_date), byRaid.map((r)=>r.present_count), "Present");
}

// -------------------------------------------------------------- PLAYERS
let playersData=[], playersSort={key:"avg_preparedness",dir:-1};
async function renderPlayers(){
  playersData = await rows("player_rankings");
  root().innerHTML = `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:.6rem;flex-wrap:wrap">
      <div><h2>Players</h2><div class="sub" style="margin:0">Click a name for their full history.</div></div>
      <input id="psearch" placeholder="Search player…" style="max-width:260px" />
    </div>
    <div class="tablewrap"><table>
      <thead><tr>
        <th class="no-sort">Player</th>
        <th class="num" data-k="attendance_pct">Attend.</th>
        <th data-k="avg_preparedness">Prepared</th>
        <th class="num" data-k="avg_consumable_efficiency">Pot. eff.</th>
        <th class="num" data-k="avoidable_deaths">Avoid.</th>
        <th class="num" data-k="unavoidable_deaths">Unavoid.</th>
        <th class="num" data-k="death_cost_index">DCI</th>
        <th class="num" data-k="items_won">Items</th>
      </tr></thead>
      <tbody id="pbody"></tbody>
    </table></div>
  </div>`;
  const draw=()=>{
    const term=($("psearch").value||"").toLowerCase();
    const list=playersData.filter((p)=>p.name.toLowerCase().includes(term))
      .sort((a,b)=>(a[playersSort.key]-b[playersSort.key])*playersSort.dir||a.name.localeCompare(b.name));
    $("pbody").innerHTML=list.map((p)=>`
      <tr class="clickable" data-pid="${p.player_id}">
        <td>${pname(p.name,p.class)}</td>
        <td class="num">${p.attendance_pct}%</td>
        <td>${meter(p.avg_preparedness)}</td>
        <td class="num">${p.avg_consumable_efficiency}%</td>
        <td class="num">${p.avoidable_deaths}</td>
        <td class="num">${p.unavoidable_deaths}</td>
        <td class="num" style="color:${p.death_cost_index>3?"var(--bad-ink)":"inherit"}">${p.death_cost_index}</td>
        <td class="num">${p.items_won}</td>
      </tr>`).join("") || `<tr><td colspan="8"><div class="empty">No players match.</div></td></tr>`;
    $("pbody").querySelectorAll("[data-pid]").forEach((el)=>el.addEventListener("click",()=>setView("player",Number(el.dataset.pid))));
  };
  $("psearch").addEventListener("input",draw);
  root().querySelectorAll("th[data-k]").forEach((th)=>th.addEventListener("click",()=>{
    const k=th.dataset.k; playersSort.dir = playersSort.key===k?-playersSort.dir:-1; playersSort.key=k; draw();
  }));
  draw();
}

// -------------------------------------------------------- PLAYER PROFILE
const pctColor=(v)=> v>=80?"var(--good-ink)":v>=50?"var(--warn-ink)":"var(--bad-ink)";
const pct=(v)=>`<span style="color:${pctColor(v)};font-weight:600">${v}%</span>`;
let ppTrend=[]; // closure data for the switchable chart
const TREND_METRICS={preparedness_score:"Preparedness",coverage_pct:"Flask/elixir coverage",flask_uptime_pct:"Flask uptime",food_uptime_pct:"Food uptime",consumable_efficiency:"Potion efficiency"};

async function renderPlayerProfile(pid){
  const [rankArr, prep, deaths, loot, cevents] = await Promise.all([
    sb.from("player_rankings").select("*").eq("player_id",pid).then(r=>r.data||[]),
    sb.from("preparedness").select("raid_id,preparedness_score,coverage_pct,flask_uptime_pct,elixir_uptime_pct,food_uptime_pct,consumable_efficiency,potion_score,legit_pulls,potions_used,potions_effective,flask_name,elixir_names,food_name,raids(raid_date,zone_name)").eq("player_id",pid).then(r=>r.data||[]),
    sb.from("raid_deaths").select("boss_name,cause,avoidable,raids(raid_date)").eq("player_id",pid).then(r=>r.data||[]),
    sb.from("loot_history").select("item_name,source_boss,response,won_at,raids(raid_date)").eq("player_id",pid).order("won_at",{ascending:false}).then(r=>r.data||[]),
    sb.from("consumable_events").select("raid_id,event_time,kind,name,boss_name").eq("player_id",pid).order("event_time",{ascending:true}).then(r=>r.data||[]),
  ]);
  const p=rankArr[0];
  if(!p){ root().innerHTML=`<div class="card"><div class="empty">Player not found.</div></div>`; return; }
  const byDate=[...prep].sort((a,b)=>new Date(a.raids?.raid_date)-new Date(b.raids?.raid_date));
  ppTrend=byDate;
  const avg=(k)=> prep.length?Math.round(prep.reduce((a,r)=>a+r[k],0)/prep.length):0;
  const consumCell=(r)=>{ const buff=r.flask_name?esc(r.flask_name):(r.elixir_names?esc(r.elixir_names):`<span style="color:var(--bad-ink)">no flask/elixir</span>`);
    const food=r.food_name?esc(r.food_name):`<span style="color:var(--bad-ink)">no food</span>`;
    return `<div style="font-size:.8rem;line-height:1.35">${buff}<br><span style="color:var(--muted)">${food}</span></div>`; };
  const deathsByDate=[...deaths].sort((a,b)=>new Date(b.raids?.raid_date)-new Date(a.raids?.raid_date));

  root().innerHTML=`
  <div class="back" id="back">← Players</div>
  <div class="card">
    <div style="display:flex;align-items:center;gap:.7rem;flex-wrap:wrap">
      <span class="pill-dot" style="width:14px;height:14px;background:${classColor(p.class)}"></span>
      <h2 style="font-size:1.35rem">${esc(p.name)}</h2>
      <span class="cls" style="color:var(--muted)">${esc(p.class||"")} ${esc(p.spec||"")}</span>
    </div>
    <div class="grid-stats" style="margin-top:1rem;margin-bottom:0">
      <div class="stat"><div class="label">Attendance</div><div class="value num">${p.attendance_pct}%</div></div>
      <div class="stat"><div class="label">Preparedness</div><div class="value num">${p.avg_preparedness}</div></div>
      <div class="stat"><div class="label">Items won</div><div class="value num">${p.items_won}</div></div>
      <div class="stat"><div class="label">Death cost index</div><div class="value num">${p.death_cost_index}</div></div>
    </div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap">
      <div><h2>Preparedness — per raid</h2><div class="sub" style="margin:0">What they actually ran each night. Averages up top; the nights are below.</div></div>
    </div>
    <div style="margin:.9rem 0 1.1rem">
      <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--surface2)">
        <span title="Coverage" style="width:${Math.round(avg("coverage_pct")*SCORING.coverageWeight)}%;background:var(--accent)"></span>
        <span title="Food" style="width:${Math.round(avg("food_uptime_pct")*SCORING.foodWeight)}%;background:var(--good)"></span>
        <span title="Potions on pulls" style="width:${Math.round(avg("potion_score")*SCORING.potionWeight)}%;background:var(--warn)"></span>
      </div>
      <div class="bars" style="margin-top:.8rem">
        <div class="barrow"><span class="lbl"><span class="pill-dot" style="background:var(--accent)"></span> Coverage</span><div class="meter"><span style="width:${avg("coverage_pct")}%;background:var(--accent)"></span></div><span class="num">${avg("coverage_pct")}%</span></div>
        <div class="barrow"><span class="lbl"><span class="pill-dot" style="background:var(--good)"></span> Food</span><div class="meter"><span style="width:${avg("food_uptime_pct")}%;background:var(--good)"></span></div><span class="num">${avg("food_uptime_pct")}%</span></div>
        <div class="barrow"><span class="lbl"><span class="pill-dot" style="background:var(--warn)"></span> Potions (per boss)</span><div class="meter"><span style="width:${avg("potion_score")}%;background:var(--warn)"></span></div><span class="num">${avg("potion_score")}%</span></div>
      </div>
      <div class="sub" style="margin-top:.6rem">
        Score = <b>${Math.round(avg("coverage_pct")*SCORING.coverageWeight)}</b> coverage + <b>${Math.round(avg("food_uptime_pct")*SCORING.foodWeight)}</b> food + <b>${Math.round(avg("potion_score")*SCORING.potionWeight)}</b> potions = <b>${p.avg_preparedness}</b>
      </div>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Date</th><th class="num no-sort">Cover</th><th class="num no-sort">Flask</th><th class="num no-sort">Elixir</th><th class="num no-sort">Food</th><th class="num no-sort" title="Boss pulls where a combat potion was used (covered / total)">Potions</th><th class="num no-sort">Score</th><th class="no-sort">Consumables run</th></tr></thead>
      <tbody>${byDate.map((r)=>`<tr class="clickable" data-raidrow="${r.raid_id}" title="Click for the consumable timeline">
        <td>${fmtDate(r.raids?.raid_date)} 🔍</td>
        <td class="num">${pct(r.coverage_pct)}</td>
        <td class="num">${pct(r.flask_uptime_pct)}</td>
        <td class="num">${pct(r.elixir_uptime_pct)}</td>
        <td class="num">${pct(r.food_uptime_pct)}</td>
        <td class="num" title="${r.potions_used} potion(s) cast, ${r.potions_effective} during boss fights${r.potions_used>r.potions_effective?` (${r.potions_used-r.potions_effective} wasted on wipes)`:``}" style="color:${pctColor(r.potion_score)};font-weight:600">${Math.round(r.potion_score/100*r.legit_pulls)}/${r.legit_pulls}</td>
        <td class="num" style="font-weight:600">${r.preparedness_score}</td>
        <td>${consumCell(r)}</td></tr>`).join("")||`<tr><td colspan="8"><div class="empty">No raids recorded.</div></td></tr>`}</tbody>
    </table></div>
    <details style="margin-top:.7rem"><summary style="cursor:pointer;color:var(--muted);font-size:.85rem">How is the preparedness score calculated?</summary>
      <div style="font-size:.85rem;color:var(--ink2);margin-top:.5rem;line-height:1.55">
        Score (0–100) = <b>${Math.round(SCORING.coverageWeight*100)}% coverage</b> + <b>${Math.round(SCORING.foodWeight*100)}% food</b> + <b>${Math.round(SCORING.potionWeight*100)}% potions</b>, measured only during boss fights.<br><br>
        <b>Coverage</b> is satisfied by a flask <i>or</i> by running both a battle and a guardian elixir, so a double-elixir raider isn't penalised for skipping a flask. <b>Food</b> is “Well Fed” uptime.<br><br>
        <b>Potions</b> is: on how many of the night's boss pulls did they use a combat potion? <b>7 of 10 bosses = 70%</b>, contributing ${Math.round(SCORING.potionWeight*100)}% × 70 = ${Math.round(SCORING.potionWeight*70)} points. It counts distinct bosses, so two potions on one fight still count as one covered pull. The Potions column shows covered/total (e.g. 7/10); hover it to see how many were cast in total and whether any were wasted on a wipe. Weights are editable in <code>config.js</code>.
      </div></details>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem">
      <h2>Trend</h2>
      <select id="trend-metric" style="max-width:220px">${Object.entries(TREND_METRICS).map(([k,l])=>`<option value="${k}">${l}</option>`).join("")}</select>
    </div>
    <canvas id="pp-chart" height="80"></canvas>
  </div>

  <div class="card">
    <h2>Deaths — per raid</h2><div class="sub">Every death, the boss, and what killed them.</div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Date</th><th class="no-sort">Boss</th><th class="no-sort">Killed by</th><th class="no-sort">Verdict</th></tr></thead>
      <tbody>${deathsByDate.map((d)=>`<tr>
        <td>${fmtDate(d.raids?.raid_date)}</td><td>${esc(d.boss_name)}</td><td>${esc(d.cause||"—")}</td>
        <td>${d.avoidable?`<span class="tag bad">avoidable</span>`:`<span class="tag neutral">unavoidable</span>`}</td></tr>`).join("")||`<tr><td colspan="4"><div class="empty">No deaths recorded — clean raider. 🛡️</div></td></tr>`}</tbody>
    </table></div>
    <details style="margin-top:.7rem"><summary style="cursor:pointer;color:var(--muted);font-size:.85rem">How is avoidable vs unavoidable decided?</summary>
      <div style="font-size:.85rem;color:var(--ink2);margin-top:.5rem;line-height:1.5">
        The combat log doesn't label mechanics, so each death is judged by <b>what dealt the killing blow</b>.
        If a boss's dangerous spells are listed in <code>AVOIDABLE_SPELL_IDS</code> (in <code>config.js</code>), a death caused by one of them is <b>avoidable</b> — this is the accurate mode.
        Otherwise a fallback is used: killed by a boss <b>spell</b> or by <b>environmental</b> damage (fire, fall, lava) → <b>avoidable</b>; killed by a <b>melee</b> hit (sustained tank/melee damage the healers couldn't cover) → <b>unavoidable</b>.
        The fallback is an approximation — for example a tank dying to a big physical cleave may show as avoidable. Listing each boss's real mechanics makes it exact.
      </div></details>
  </div>

  <div class="card">
    <h2>Loot history</h2>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Item</th><th class="no-sort">Boss</th><th class="no-sort">Response</th><th class="no-sort">Date</th></tr></thead>
      <tbody>${loot.map((l)=>`<tr><td>${esc(l.item_name)}</td><td>${esc(l.source_boss)}</td><td>${esc(l.response||"")}</td><td>${fmtDate(l.won_at||l.raids?.raid_date)}</td></tr>`).join("")||`<tr><td colspan="4"><div class="empty">No loot recorded.</div></td></tr>`}</tbody>
    </table></div>
  </div>`;
  $("back").addEventListener("click",()=>setView("players"));
  const redraw=(key)=>{ killCharts(); drawTrend("pp-chart", ppTrend.map((r)=>r.raids?.raid_date), ppTrend.map((r)=>r[key]), TREND_METRICS[key], true); };
  $("trend-metric").addEventListener("change",(e)=>redraw(e.target.value));
  redraw("preparedness_score");

  // click a per-raid row -> consumable timeline popup
  const ceByRaid=new Map();
  for(const ev of cevents){ if(!ceByRaid.has(ev.raid_id)) ceByRaid.set(ev.raid_id,[]); ceByRaid.get(ev.raid_id).push(ev); }
  root().querySelectorAll("tr[data-raidrow]").forEach((tr)=>tr.addEventListener("click",()=>{
    const rid=Number(tr.dataset.raidrow);
    const row=byDate.find((r)=>r.raid_id===rid);
    const evs=(ceByRaid.get(rid)||[]).sort((a,b)=>new Date(a.event_time)-new Date(b.event_time));
    const KTAG={potion:"warn",food:"good",flask:"neutral",elixir:"neutral"};
    const body=`<div class="sub" style="margin-bottom:.6rem">${esc(p.name)} — everything they flasked, ate, and drank that night, in order.</div>
      <div class="tablewrap"><table><thead><tr><th class="no-sort">Time</th><th class="no-sort">Type</th><th class="no-sort">Consumable</th><th class="no-sort">During</th></tr></thead>
      <tbody>${evs.map((e)=>`<tr><td class="num">${new Date(e.event_time).toLocaleTimeString()}</td><td><span class="tag ${KTAG[e.kind]||"neutral"}">${esc(e.kind)}</span></td><td>${esc(e.name||"")}</td><td>${esc(e.boss_name||"— (between pulls)")}</td></tr>`).join("")||`<tr><td colspan="4"><div class="empty">No consumable events recorded for this raid.</div></td></tr>`}</tbody></table></div>`;
    openModal(`Consumables — ${fmtDate(row?.raids?.raid_date)}`, body);
  }));
}

function openModal(title, html){
  let ov=document.getElementById("modal-ov");
  if(!ov){ ov=document.createElement("div"); ov.id="modal-ov";
    ov.style.cssText="position:fixed;inset:0;background:rgba(20,25,45,.45);display:grid;place-items:center;z-index:100;padding:1rem";
    document.body.appendChild(ov); ov.addEventListener("click",(e)=>{ if(e.target===ov) ov.remove(); }); }
  ov.innerHTML=`<div style="background:var(--surface);border-radius:14px;max-width:600px;width:100%;max-height:82vh;overflow:auto;box-shadow:var(--shadow-lg);padding:1.25rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem"><h2 style="font-size:1.05rem">${title}</h2><button class="btn ghost sm" id="modal-x">Close</button></div>${html}</div>`;
  document.getElementById("modal-x").addEventListener("click",()=>ov.remove());
}

// ---------------------------------------------------------------- RAIDS
async function renderRaids(){
  const manifest = await rows("raid_manifest");
  root().innerHTML = `
  <div class="card">
    <h2>Raid nights</h2><div class="sub">Click a raid to see that night's report.</div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Date</th><th class="no-sort">Zone</th><th class="no-sort">Difficulty</th><th class="num no-sort">Players</th><th class="num no-sort">Loot</th></tr></thead>
      <tbody>${manifest.map((r)=>`<tr class="clickable" data-rid="${r.raid_id}">
        <td>${fmtDate(r.raid_date)}</td><td>${esc(r.zone_name)}</td><td>${esc(r.difficulty||"—")}</td>
        <td class="num">${r.players}</td><td class="num">${r.loot_awards}</td></tr>`).join("")||`<tr><td colspan="5"><div class="empty">No raids yet.</div></td></tr>`}</tbody>
    </table></div>
  </div>`;
  root().querySelectorAll("[data-rid]").forEach((el)=>el.addEventListener("click",()=>setView("raid",Number(el.dataset.rid))));
}

async function renderRaidDetail(rid){
  const [rInfo, att, loot] = await Promise.all([
    sb.from("raids").select("*").eq("id",rid).single().then(r=>r.data),
    sb.from("attendance").select("status,players(id,name,class),raid_id").eq("raid_id",rid).then(r=>r.data||[]),
    sb.from("loot_history").select("item_name,source_boss,response,players(name,class)").eq("raid_id",rid).then(r=>r.data||[]),
  ]);
  const [prep, perf] = await Promise.all([
    sb.from("preparedness").select("player_id,preparedness_score,coverage_pct,food_uptime_pct,consumable_efficiency").eq("raid_id",rid).then(r=>r.data||[]),
    sb.from("performance").select("player_id,avoidable_deaths,unavoidable_deaths").eq("raid_id",rid).then(r=>r.data||[]),
  ]);
  const prepBy=Object.fromEntries(prep.map((x)=>[x.player_id,x]));
  const perfBy=Object.fromEntries(perf.map((x)=>[x.player_id,x]));
  const list=att.map((a)=>({name:a.players.name,cls:a.players.class,pid:a.players.id,
    prep:prepBy[a.players.id]?.preparedness_score??0, cov:prepBy[a.players.id]?.coverage_pct??0,
    av:perfBy[a.players.id]?.avoidable_deaths??0, un:perfBy[a.players.id]?.unavoidable_deaths??0}))
    .sort((a,b)=>b.prep-a.prep);

  root().innerHTML=`
  <div class="back" id="back">← Raids</div>
  <div class="card">
    <h2>${esc(rInfo.zone_name)} — ${fmtDate(rInfo.raid_date)}</h2>
    <div class="sub">${esc(rInfo.difficulty||"")} · ${list.length} players · ${loot.length} items</div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Player</th><th class="no-sort">Prepared</th><th class="num no-sort">Avoid.</th><th class="num no-sort">Unavoid.</th></tr></thead>
      <tbody>${list.map((p)=>`<tr class="clickable" data-pid="${p.pid}"><td>${pname(p.name,p.cls)}</td><td>${meter(p.prep)}</td><td class="num">${p.av}</td><td class="num">${p.un}</td></tr>`).join("")}</tbody>
    </table></div>
  </div>
  <div class="card">
    <h2>Loot dropped</h2>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Winner</th><th class="no-sort">Item</th><th class="no-sort">Boss</th><th class="no-sort">Response</th></tr></thead>
      <tbody>${loot.map((l)=>`<tr><td>${pname(l.players?.name,l.players?.class)}</td><td>${esc(l.item_name)}</td><td>${esc(l.source_boss)}</td><td>${esc(l.response||"")}</td></tr>`).join("")||`<tr><td colspan="4"><div class="empty">No loot recorded.</div></td></tr>`}</tbody>
    </table></div>
  </div>`;
  $("back").addEventListener("click",()=>setView("raids"));
  root().querySelectorAll("[data-pid]").forEach((el)=>el.addEventListener("click",()=>setView("player",Number(el.dataset.pid))));
}

// ----------------------------------------------------------------- LOOT
function gini(vals){ const v=vals.filter(x=>x>=0).sort((a,b)=>a-b); const n=v.length; if(!n)return 0;
  const s=v.reduce((a,b)=>a+b,0); if(!s)return 0; let c=0; for(let i=0;i<n;i++)c+=(i+1)*v[i]; return Math.max(0,(2*c)/(n*s)-(n+1)/n); }
const wow=(name,id)=> id?`<a href="https://www.wowhead.com/tbc/item=${id}" target="_blank" rel="noopener" class="wowlink">${esc(name)}</a>`:esc(name);

async function renderLoot(){
  const [rank, loot, raidsList] = await Promise.all([
    rows("player_rankings"),
    sb.from("loot_history").select("item_name,item_id,source_boss,response,won_at,player_id,players(name,class),raids(raid_date)").order("won_at",{ascending:false}).limit(2000).then(r=>r.data||[]),
    sb.from("raids").select("id,raid_date").order("raid_date",{ascending:true}).then(r=>r.data||[]),
  ]);
  const raidDates=raidsList.map(r=>r.raid_date).sort();
  // last-won date per player
  const lastWon=new Map();
  for(const l of loot){ const d=(l.won_at||l.raids?.raid_date||"").slice(0,10); if(!d)continue;
    const cur=lastWon.get(l.player_id); if(!cur||d>cur) lastWon.set(l.player_id,d); }

  // ---- distribution (Gini) ----
  const withData=rank.filter(r=>r.raids_attended>0);
  const g=gini(withData.map(r=>r.items_won));
  const gLabel=g<0.3?"fairly even":g<0.5?"somewhat uneven":"concentrated in a few players";
  const topShare=[...withData].sort((a,b)=>b.items_won-a.items_won).slice(0,10);
  const totalItems=withData.reduce((a,r)=>a+r.items_won,0)||1;

  // ---- loot per raid + drought ----
  const balance=withData.map(r=>{
    const lw=lastWon.get(r.player_id);
    const since = lw ? raidDates.filter(d=>d>lw).length : (r.raids_attended||0);
    return {...r, perRaid: r.raids_attended? r.items_won/r.raids_attended : 0, lastWon:lw, drought: lw?since:(r.raids_attended?`${r.raids_attended}+ (never)`:"never")};
  }).sort((a,b)=> (typeof b.drought==="number"?b.drought:999)-(typeof a.drought==="number"?a.drought:999) || a.perRaid-b.perRaid);

  // ---- contested / recurring drops (multiple distinct winners of same item) ----
  const byItem=new Map();
  for(const l of loot){ const k=l.item_name||"?"; if(!byItem.has(k)) byItem.set(k,{name:l.item_name,id:l.item_id,winners:new Map(),count:0});
    const e=byItem.get(k); e.count++; e.winners.set(l.players?.name||"?", (e.winners.get(l.players?.name||"?")||0)+1); }
  const contested=[...byItem.values()].filter(e=>e.winners.size>1).sort((a,b)=>b.winners.size-a.winners.size||b.count-a.count).slice(0,12);

  const all=loot.map((l)=>({player:l.players?.name||"—",cls:l.players?.class,item:l.item_name||"—",id:l.item_id,boss:l.source_boss||"—",response:l.response||"",date:(l.won_at||l.raids?.raid_date||"").slice(0,10)}));

  root().innerHTML=`
  <div class="row">
    <div class="card">
      <h2>Distribution fairness</h2><div class="sub">How evenly loot is spread across the roster.</div>
      <div style="display:flex;align-items:baseline;gap:.6rem"><div class="value num" style="font-family:'Space Grotesk';font-weight:700;font-size:2rem">${g.toFixed(2)}</div><div style="color:var(--muted)">Gini — ${gLabel}</div></div>
      <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--surface2);margin-top:.7rem">
        ${topShare.map((r,i)=>`<span title="${esc(r.name)}: ${r.items_won}" style="width:${100*r.items_won/totalItems}%;background:${classColor(r.class)};opacity:${1-i*0.06}"></span>`).join("")}
      </div>
      <div class="sub" style="margin-top:.5rem">0 = everyone equal · 1 = one person has it all. Segments = each player's share.</div>
    </div>
    <div class="card">
      <h2>Contested drops</h2><div class="sub">Items that have gone to more than one player — recurring competition.</div>
      <div class="tablewrap"><table><thead><tr><th class="no-sort">Item</th><th class="num no-sort">Times</th><th class="no-sort">Winners</th></tr></thead>
        <tbody>${contested.map(e=>`<tr><td>${wow(e.name,e.id)}</td><td class="num">${e.count}</td><td style="font-size:.82rem">${[...e.winners.entries()].map(([n,c])=>esc(n)+(c>1?` ×${c}`:"")).join(", ")}</td></tr>`).join("")||`<tr><td colspan="3"><div class="empty">No repeated drops yet.</div></td></tr>`}</tbody>
      </table></div>
    </div>
  </div>

  <div class="card">
    <h2>Loot balance &amp; drought</h2><div class="sub">Items per raid attended, and how long since each player last won something. Longest droughts first.</div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Player</th><th class="num no-sort">Items</th><th class="num no-sort">Raids</th><th class="num no-sort">Loot / raid</th><th class="num no-sort">Drought</th><th class="no-sort">Last won</th></tr></thead>
      <tbody>${balance.map(r=>`<tr class="clickable" data-pid="${r.player_id}">
        <td>${pname(r.name,r.class)}</td><td class="num">${r.items_won}</td><td class="num">${r.raids_attended}</td>
        <td class="num">${r.perRaid.toFixed(2)}</td>
        <td class="num" style="color:${(typeof r.drought==="number"&&r.drought>=3)||typeof r.drought==="string"?"var(--warn-ink)":"inherit"};font-weight:600">${typeof r.drought==="number"?(r.drought===0?"—":r.drought+" raids"):r.drought}</td>
        <td>${r.lastWon?fmtDate(r.lastWon):"—"}</td></tr>`).join("")||`<tr><td colspan="6"><div class="empty">No data yet.</div></td></tr>`}</tbody>
    </table></div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:.6rem;flex-wrap:wrap">
      <div><h2>Loot ledger</h2><div class="sub" style="margin:0">Every award, newest first. Item names link to Wowhead.</div></div>
      <input id="lsearch" placeholder="Search player, item, boss…" style="max-width:300px" />
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Winner</th><th class="no-sort">Item</th><th class="no-sort">Boss</th><th class="no-sort">Response</th><th class="no-sort">Date</th></tr></thead>
      <tbody id="lbody"></tbody>
    </table></div>
    <div class="sub" id="lcount" style="margin-top:.6rem"></div>
  </div>`;

  root().querySelectorAll("[data-pid]").forEach(el=>el.addEventListener("click",()=>setView("player",Number(el.dataset.pid))));
  const render=(list)=>{ $("lbody").innerHTML=list.map((l)=>`<tr><td>${pname(l.player,l.cls)}</td><td>${wow(l.item,l.id)}</td><td>${esc(l.boss)}</td><td>${esc(l.response)}</td><td>${esc(l.date)}</td></tr>`).join("")||`<tr><td colspan="5"><div class="empty">No loot matches.</div></td></tr>`;
    $("lcount").textContent=`${list.length} awards`; };
  render(all);
  $("lsearch").addEventListener("input",(e)=>{ const t=e.target.value.toLowerCase().trim();
    render(!t?all:all.filter((l)=>l.player.toLowerCase().includes(t)||l.item.toLowerCase().includes(t)||l.boss.toLowerCase().includes(t))); });
}

// --------------------------------------------------------------- UPLOAD
const staged={ combat:null, combatText:null, combatName:null, loot:null, lootText:null, lootName:null };
async function renderUpload(){
  const manifest = await rows("raid_manifest");
  root().innerHTML=`
  <div class="card">
    <h2>Upload a raid night</h2>
    <div class="sub">Drop the files, check the details, save. A continuous log covering several nights is split into separate raids automatically. Re-uploading detects nights already imported and skips them.</div>
    <div class="drops">
      <div class="drop" id="drop-combat"><div class="big">Combat log</div><div class="hint">WoWCombatLog.txt</div><input type="file" accept=".txt,text/plain"/><div class="status info" id="cs"></div></div>
      <div class="drop" id="drop-loot"><div class="big">RCLootCouncil export</div><div class="hint">JSON / CSV / Lua</div><input type="file" accept=".json,.csv,.txt,.lua"/><div class="status info" id="ls"></div></div>
    </div>
    <div class="raidform">
      <div><label>Date</label><input id="rdate" type="date"/></div>
      <div><label>Zone / instance</label><input id="rzone" type="text" placeholder="Serpentshrine Cavern"/></div>
      <div><label>Difficulty</label><input id="rdiff" type="text" placeholder="25 Player"/></div>
      <div><button id="save" class="btn" disabled>Save</button></div>
    </div>
    <div class="status" id="ss" style="margin-top:.7rem"></div>
  </div>
  <div class="card">
    <h2>Manage uploads</h2><div class="sub">Delete a raid night to remove all its data (attendance, prep, deaths, loot).</div>
    <div class="tablewrap"><table>
      <thead><tr><th class="no-sort">Date</th><th class="no-sort">Zone</th><th class="num no-sort">Players</th><th class="num no-sort">Loot</th><th class="no-sort"></th></tr></thead>
      <tbody id="mbody">${manifest.map((r)=>`<tr><td>${fmtDate(r.raid_date)}</td><td>${esc(r.zone_name)}</td><td class="num">${r.players}</td><td class="num">${r.loot_awards}</td><td style="text-align:right"><button class="btn danger sm" data-del="${r.raid_id}" data-lbl="${esc(r.zone_name)} ${esc(r.raid_date)}">Delete</button></td></tr>`).join("")||`<tr><td colspan="5"><div class="empty">No uploads yet.</div></td></tr>`}</tbody>
    </table></div>
  </div>`;

  wireDrop("drop-combat",(name,text)=>{
    try{ staged.combat=parseCombatLog(text); staged.combatText=text; staged.combatName=name;
      const nights=staged.combat.raids;
      if(nights.length===0){ setStatus("cs","No boss encounters found in this log.","err"); return; }
      if(nights.length===1){ const m=nights[0].meta;
        setStatus("cs",`✓ ${name}: 1 raid night — ${m.raidDate}, ${nights[0].players.length} players, ${m.encounters.length} bosses`,"ok");
        $("rdate").value=m.raidDate; if(!$("rzone").value)$("rzone").value=m.zoneNameGuess; if(!$("rdiff").value)$("rdiff").value=m.difficulty;
      } else {
        const list=nights.map((n)=>`${n.meta.raidDate} (${n.meta.encounters.length} bosses)`).join(", ");
        setStatus("cs",`✓ ${name}: ${nights.length} raid nights detected — ${list}. Each saved separately with its own date.`,"ok");
      }
      $("save").disabled=false;
    }catch(e){ setStatus("cs",`Couldn't parse: ${e.message}`,"err"); }
  });
  wireDrop("drop-loot",(name,text)=>{
    try{ staged.loot=parseRCLootCouncil(text); staged.lootText=text; staged.lootName=name;
      setStatus("ls",`✓ ${name}: ${staged.loot.loot.length} awards`,"ok");
    }catch(e){ setStatus("ls",`Couldn't parse: ${e.message}`,"err"); }
  });
  $("save").addEventListener("click",saveRaid);
  $("mbody").querySelectorAll("[data-del]").forEach((b)=>b.addEventListener("click",()=>deleteRaid(Number(b.dataset.del),b.dataset.lbl)));
}
function wireDrop(id,cb){
  const z=$(id), input=z.querySelector("input");
  const read=(f)=>{ if(!f)return; const r=new FileReader(); r.onload=()=>cb(f.name,r.result); r.readAsText(f); };
  ["dragenter","dragover"].forEach((e)=>z.addEventListener(e,(ev)=>{ev.preventDefault();z.classList.add("drag");}));
  ["dragleave","drop"].forEach((e)=>z.addEventListener(e,(ev)=>{ev.preventDefault();z.classList.remove("drag");}));
  z.addEventListener("drop",(ev)=>read(ev.dataTransfer.files[0]));
  z.addEventListener("click",()=>input.click());
  input.addEventListener("change",(ev)=>read(ev.target.files[0]));
}
function setStatus(id,msg,kind){ const el=$(id); el.textContent=msg; el.className=`status ${kind||"info"}`; }

async function saveRaid(){
  const btn=$("save"); btn.disabled=true; setStatus("ss","Saving…","info");
  try{
    if(!staged.combat||!staged.combat.raids?.length) throw new Error("Drop a combat log first.");
    const nights=staged.combat.raids;

    // upsert every player we know about (all nights + loot) once
    const classBy=new Map(); (staged.loot?.players||[]).forEach((p)=>classBy.set(p.name,p.class));
    const names=new Set(); nights.forEach((n)=>n.players.forEach((p)=>names.add(p.name)));
    (staged.loot?.loot||[]).forEach((l)=>names.add(l.player));
    const { error:pe }=await sb.from("players").upsert([...names].map((n)=>({name:n,class:classBy.get(n)||null})),{onConflict:"name"}); if(pe) throw pe;
    const pd=await sb.from("players").select("id,name").in("name",[...names]).then(r=>r.data||[]);
    const idBy=new Map(pd.map((p)=>[p.name,p.id]));

    const lootAll=staged.loot?.loot||[];
    const single=nights.length===1;
    let saved=0, skipped=0;

    for(const night of nights){
      const m=night.meta;
      // per-night fingerprint so a growing log only adds new nights
      const fp=await hashText(`night|${m.raidDate}|${m.encounters.map((e)=>e.id+":"+e.name).join(",")}`);
      const dupe=await sb.from("imports").select("raid_id").eq("file_hash",fp).maybeSingle().then(r=>r.data);
      if(dupe){ skipped++; continue; }

      const raidRow={
        raid_date: single ? ($("rdate").value||m.raidDate) : m.raidDate,
        zone_name: single ? ($("rzone").value||m.zoneNameGuess) : m.zoneNameGuess,
        difficulty: single ? ($("rdiff").value||m.difficulty) : m.difficulty,
      };
      const raid=await sb.from("raids").upsert(raidRow,{onConflict:"raid_date,zone_name,difficulty"}).select("id").single().then(r=>{ if(r.error) throw r.error; return r.data; });
      const raidId=raid.id;

      const att=[],prep=[],perf=[],deathRows=[];
      for(const p of night.players){ const pid=idBy.get(p.name); if(!pid)continue;
        att.push({raid_id:raidId,player_id:pid,status:p.status});
        prep.push({raid_id:raidId,player_id:pid,flasks_used:p.flasks_used,flask_uptime_pct:p.flask_uptime_pct,elixir_uptime_pct:p.elixir_uptime_pct,food_uptime_pct:p.food_uptime_pct,coverage_pct:p.coverage_pct,flask_name:p.flask_name,elixir_names:p.elixir_names,food_name:p.food_name,potions_used:p.potions_used,potions_effective:p.potions_effective,consumable_efficiency:p.consumable_efficiency,potion_score:p.potion_score,legit_pulls:p.legit_pulls,preparedness_score:p.preparedness_score});
        perf.push({raid_id:raidId,player_id:pid,avoidable_deaths:p.avoidable_deaths,unavoidable_deaths:p.unavoidable_deaths,death_cost_index:p.death_cost_index});
        for(const d of (p.deaths_detail||[])) deathRows.push({raid_id:raidId,player_id:pid,boss_name:d.boss,cause:d.cause,avoidable:d.avoidable});
      }
      await up("attendance",att,"raid_id,player_id");
      await up("preparedness",prep,"raid_id,player_id");
      await up("performance",perf,"raid_id,player_id");
      await sb.from("raid_deaths").delete().eq("raid_id",raidId);
      if(deathRows.length){ const { error:de }=await sb.from("raid_deaths").insert(deathRows); if(de) throw new Error("raid_deaths: "+de.message); }

      // consumable timeline (evidence trail)
      const ceRows=[];
      for(const p of night.players){ const pid=idBy.get(p.name); if(!pid)continue;
        for(const ev of (p.events||[])) ceRows.push({raid_id:raidId,player_id:pid,event_time:ev.time,kind:ev.kind,name:ev.name,boss_name:ev.boss}); }
      await sb.from("consumable_events").delete().eq("raid_id",raidId);
      for(let i=0;i<ceRows.length;i+=500){ const { error:ce }=await sb.from("consumable_events").insert(ceRows.slice(i,i+500)); if(ce) throw new Error("consumable_events: "+ce.message); }

      // loot for this night: match by date (single night takes all loot)
      const lootForNight=lootAll.filter((l)=>{ if(single) return true;
        const d=l.date?safeDate(l.date):null; return d?d.slice(0,10)===raidRow.raid_date:false; });
      if(lootForNight.length){
        const lootRows=lootForNight.map((l)=>{ const pid=idBy.get(l.player); if(!pid)return null;
          return {raid_id:raidId,player_id:pid,item_name:l.item_name,item_id:l.item_id,source_boss:l.source_boss,response:l.response,won_at:l.date?safeDate(l.date):null}; }).filter(Boolean);
        await up("loot_history",lootRows,"raid_id,player_id,item_id,source_boss,won_at");
      }

      await sb.from("imports").upsert([{file_hash:fp,file_name:staged.combatName,kind:"combatlog-night",raid_id:raidId}],{onConflict:"file_hash",ignoreDuplicates:true});
      saved++;
    }

    const msg = saved
      ? `Saved ${saved} raid night${saved===1?"":"s"}${skipped?`, skipped ${skipped} already imported`:""}.`
      : `Nothing new — ${skipped} night${skipped===1?"":"s"} already imported.`;
    setStatus("ss",msg,saved?"ok":"info");
    staged.combat=staged.loot=staged.combatText=staged.lootText=null;
    if(saved) setTimeout(()=>setView("home"),800);
    else btn.disabled=false;
  }catch(e){ setStatus("ss",`Save failed: ${e.message||e}`,"err"); btn.disabled=false; }
}
async function up(table,rowsArr,onConflict){ if(!rowsArr.length)return; const { error }=await sb.from(table).upsert(rowsArr,{onConflict}); if(error) throw new Error(`${table}: ${error.message}`); }
function safeDate(s){ const t=Date.parse(s); return Number.isNaN(t)?null:new Date(t).toISOString(); }

async function deleteRaid(rid,label){
  if(!confirm(`Delete "${label}" and all its attendance, preparedness, deaths, and loot? This can't be undone.`)) return;
  const { error }=await sb.from("raids").delete().eq("id",rid);
  if(error){ alert("Delete failed: "+error.message); return; }
  setView("upload");
}

// ----------------------------------------------------------- chart helper
function drawTrend(canvasId,labels,data,label,zeroToHundred){
  const ctx=$(canvasId); if(!ctx)return;
  const c=new window.Chart(ctx,{type:"line",data:{labels,datasets:[{label,data,
    borderColor:"#6b57e6",backgroundColor:"rgba(107,87,230,.12)",fill:true,tension:.3,pointRadius:3,pointBackgroundColor:"#6b57e6"}]},
    options:{responsive:true,plugins:{legend:{display:false}},
      scales:{x:{ticks:{color:"#727a8c",font:{size:11}},grid:{color:"#eef1f7"}},
        y:{beginAtZero:true,suggestedMax:zeroToHundred?100:undefined,ticks:{color:"#727a8c",font:{size:11}},grid:{color:"#eef1f7"}}}}});
  charts.push(c);
}

refreshAuth();
