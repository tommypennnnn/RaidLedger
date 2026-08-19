// =====================================================================
//  parsers.js — pure, browser-side parsing. No network, no DOM.
//  parseCombatLog now splits a continuous log into separate raid nights
//  (sessions separated by a long gap) and returns one result per night.
// =====================================================================
import {
  CONSUMABLE_PATTERNS, EXTRA_FLASK_IDS, EXTRA_ELIXIR_IDS,
  POTION_SPELL_IDS, AVOIDABLE_SPELL_IDS, SCORING,
} from "./config.js";

export function stripRealm(name){ if(!name) return ""; return name.replace(/^"|"$/g,"").split("-")[0].trim(); }
function isPlayerGUID(g){ return typeof g==="string" && g.startsWith("Player-"); }
function splitCsv(line){ const o=[]; let c="",q=false; for(let i=0;i<line.length;i++){const ch=line[i];
  if(ch==='"')q=!q; else if(ch===","&&!q){o.push(c);c="";} else c+=ch;} o.push(c); return o; }
function parseTimestamp(ts){ const sp=ts.indexOf(" "); const dp=ts.slice(0,sp);
  let tp=ts.slice(sp+1).replace(/([+-]\d+)$/,""); const d=dp.split("/").map(Number);
  const year=d.length>=3?d[2]:new Date().getFullYear(); const [hms,msRaw]=tp.split("."); const [h,m,s]=hms.split(":").map(Number);
  const ms=msRaw?Number(msRaw.padEnd(3,"0").slice(0,3)):0; return new Date(year,d[0]-1,d[1],h,m,s,ms).getTime(); }
const DIFFICULTY_MAP={14:"Normal",15:"Heroic",16:"Mythic",17:"LFR",9:"25 Player",4:"25 Player"};

export async function hashText(text){ const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b)=>b.toString(16).padStart(2,"0")).join(""); }

function buffCategory(name,spellId){ const n=name||"";
  if(CONSUMABLE_PATTERNS.food.test(n)) return "food";
  if(CONSUMABLE_PATTERNS.flask.test(n)||EXTRA_FLASK_IDS.has(spellId)) return "flask";
  if(CONSUMABLE_PATTERNS.elixir.test(n)||EXTRA_ELIXIR_IDS.has(spellId)) return "elixir";
  return null; }

function zoneFromInstance(id){ const map={548:"Serpentshrine Cavern",550:"Tempest Keep",565:"Gruul's Lair",
  544:"Magtheridon's Lair",532:"Karazhan",534:"Hyjal Summit",564:"Black Temple",580:"Sunwell Plateau"};
  return map[id]||(id?`Instance ${id}`:"Unknown Zone"); }

// ---------------------------------------------------------------------
//  Returns { raids: [ {meta, players}, ... ] } — one entry per raid night.
// ---------------------------------------------------------------------
export function parseCombatLog(text){
  const lines=text.split(/\r?\n/);
  const encounters=[]; let current=null;
  const players=new Map();
  function player(name){ const key=stripRealm(name); if(!key) return null;
    if(!players.has(key)) players.set(key,{ name:key,
      buffs:{flask:[],elixir:[],food:[]}, _open:{flask:null,elixir:null,food:null}, _oname:{flask:null,elixir:null,food:null},
      flaskAppliedTimes:[], potionCasts:[], deaths:[], recentDamage:[], events:[] });
    return players.get(key); }

  for(const raw of lines){
    if(!raw) continue;
    const sep=raw.indexOf("  "); if(sep===-1) continue;
    const ts=parseTimestamp(raw.slice(0,sep));
    const f=splitCsv(raw.slice(sep+2)); const event=f[0];

    if(event==="ENCOUNTER_START"){ current={id:Number(f[1]),name:f[2].replace(/^"|"$/g,""),
      difficulty:Number(f[3]),instanceId:Number(f[5]),start:ts,end:null,success:false,participants:new Set()};
      continue; }
    if(event==="ENCOUNTER_END"){ if(current){ current.end=ts; current.success=f[5]==="1";
      current.durationSec=(current.end-current.start)/1000; encounters.push(current); current=null; } continue; }

    const sGUID=f[1],sName=f[2];
    if(isPlayerGUID(sGUID)&&current){ const key=stripRealm(sName); if(key) current.participants.add(key); }

    if((event==="SPELL_AURA_APPLIED"||event==="SPELL_AURA_REFRESH"||event==="SPELL_AURA_REMOVED")&&isPlayerGUID(f[5])){
      const spellId=Number(f[9]); const name=f[10]; const cat=buffCategory(name,spellId);
      if(cat){ const p=player(f[6]); if(p){
        if(event==="SPELL_AURA_REMOVED"){ if(p._open[cat]!==null){ p.buffs[cat].push({start:p._open[cat],end:ts,name:p._oname[cat]}); p._open[cat]=null; } }
        else { if(event==="SPELL_AURA_APPLIED"){ if(cat==="flask") p.flaskAppliedTimes.push(ts); p.events.push({ts,kind:cat,name}); }
               if(p._open[cat]===null){ p._open[cat]=ts; p._oname[cat]=name; } }
      }}
    }

    if(event==="SPELL_CAST_SUCCESS"&&isPlayerGUID(sGUID)){ if(POTION_SPELL_IDS.has(Number(f[9]))){ const p=player(sName); if(p){ const nm=f[10]||"Potion"; p.potionCasts.push({ts,name:nm}); p.events.push({ts,kind:"potion",name:nm}); } } }

    if(event.endsWith("_DAMAGE")&&isPlayerGUID(f[5])){ const p=player(f[6]); if(p){
      let kind="spell",spellId=0,spellName="";
      if(event.startsWith("SWING")){ kind="swing"; spellName="Melee"; }
      else if(event.startsWith("ENVIRONMENTAL")){ kind="env"; spellName=f[9]||"Environmental"; }
      else { spellId=Number(f[9]); spellName=f[10]||"spell"; }
      p.recentDamage.push({ts,kind,spellId,spellName,hostile:!isPlayerGUID(sGUID)});
      if(p.recentDamage.length>20) p.recentDamage.shift();
    }}

    if(event==="UNIT_DIED"&&isPlayerGUID(f[5])&&current){ const p=player(f[6]); if(p){
      const cls=classifyDeath(p,ts,current.id);
      p.deaths.push({ts,boss:current.name,avoidable:cls.avoidable,cause:cls.cause});
    }}
  }

  // close open buff intervals at the last encounter end we saw
  const endTs=encounters.length?encounters[encounters.length-1].end:0;
  for(const p of players.values()) for(const cat of ["flask","elixir","food"])
    if(p._open[cat]!==null){ p.buffs[cat].push({start:p._open[cat],end:Math.max(endTs,p._open[cat]),name:p._oname[cat]}); p._open[cat]=null; }

  // ---- split encounters into raid-night sessions by a long gap ----
  encounters.sort((a,b)=>a.start-b.start);
  const gapMs=(SCORING.sessionGapHours||6)*3600000;
  const sessions=[]; let cur=[];
  for(const e of encounters){ if(cur.length&&e.start-cur[cur.length-1].end>gapMs){ sessions.push(cur); cur=[]; } cur.push(e); }
  if(cur.length) sessions.push(cur);

  const raids=sessions.map((encs)=>buildNight(encs,players));
  return { raids };

  function classifyDeath(p,ts,encounterId){
    const recent=p.recentDamage.filter((d)=>ts-d.ts<=6000&&d.hostile);
    const set=AVOIDABLE_SPELL_IDS[encounterId];
    if(set&&set.size){ const hit=recent.find((d)=>d.kind==="spell"&&set.has(d.spellId));
      if(hit) return {avoidable:true,cause:hit.spellName};
      const last0=recent[recent.length-1]; return {avoidable:false,cause:last0?last0.spellName:"Unknown"}; }
    if(recent.length===0) return {avoidable:false,cause:"Unknown"};
    const last=recent[recent.length-1];
    if(last.kind==="env") return {avoidable:true,cause:`Environmental (${last.spellName})`};
    if(last.kind==="spell") return {avoidable:true,cause:last.spellName};
    return {avoidable:false,cause:"Melee"};
  }
}

// build one night's {meta, players} from its encounters + the global player map
function buildNight(encs,players){
  const winStart=encs[0].start, winEnd=encs[encs.length-1].end, prepStart=winStart-3600000;
  const totalBossMs=encs.reduce((a,e)=>a+(e.end-e.start),0)||1;
  const legitPulls=encs.filter((e)=>e.durationSec>=SCORING.legitPullSeconds);
  const present=new Set(); for(const e of encs) for(const nm of e.participants) present.add(nm);
  const encAt=(ts)=>encs.find((e)=>ts>=e.start&&ts<=e.end)||null;

  const out=[];
  for(const p of players.values()){
    const deathsWin=p.deaths.filter((d)=>d.ts>=prepStart&&d.ts<=winEnd);
    if(!present.has(p.name)&&deathsWin.length===0) continue;

    const uptime=(cat)=>{ let ms=0; const names=new Set();
      for(const e of encs) for(const iv of p.buffs[cat]){ const o=overlap(iv.start,iv.end,e.start,e.end); if(o>0){ ms+=o; if(iv.name) names.add(iv.name); } }
      return { pct:clamp((ms/totalBossMs)*100,0,100), names:[...names] }; };
    const fU=uptime("flask"), eU=uptime("elixir"), foU=uptime("food");
    const coverage=Math.max(fU.pct,eU.pct);

    const casts=p.potionCasts.filter((c)=>c.ts>=prepStart&&c.ts<=winEnd);
    let potionsEffective=0; const pullsWithPotion=new Set();
    for(const c of casts){ const e=encAt(c.ts); if(e&&e.durationSec>=SCORING.legitPullSeconds){ potionsEffective++; pullsWithPotion.add(e.start); } }
    const potionsUsed=casts.length;
    const consumableEfficiency=potionsUsed>0?(potionsEffective/potionsUsed)*100:0;
    // Potion component = on how many of the night's boss pulls did they use a
    // potion? 7 of 10 bosses = 70%. Distinct pulls, so 2 potions on one boss
    // still counts once.
    const potionScore=legitPulls.length>0?clamp((pullsWithPotion.size/legitPulls.length)*100,0,100):0;
    const preparednessScore=SCORING.coverageWeight*coverage+SCORING.foodWeight*foU.pct+SCORING.potionWeight*potionScore;

    const flasksUsed=p.flaskAppliedTimes.filter((ts)=>ts>=prepStart&&ts<=winEnd).length;
    const avoidable=deathsWin.filter((d)=>d.avoidable).length;
    const unavoidable=deathsWin.length-avoidable;
    const dci=avoidable*SCORING.avoidableDeathWeight+unavoidable*SCORING.unavoidableDeathWeight;

    out.push({ name:p.name, status:"present",
      flasks_used:flasksUsed,
      flask_uptime_pct:round1(fU.pct), elixir_uptime_pct:round1(eU.pct), food_uptime_pct:round1(foU.pct),
      coverage_pct:round1(coverage),
      flask_name:fU.names[0]||null, elixir_names:eU.names.join(", ")||null, food_name:foU.names[0]||null,
      potions_used:potionsUsed, potions_effective:potionsEffective,
      consumable_efficiency:round1(consumableEfficiency), potion_score:round1(potionScore), legit_pulls:legitPulls.length,
      preparedness_score:round1(preparednessScore),
      avoidable_deaths:avoidable, unavoidable_deaths:unavoidable, death_cost_index:round2(dci),
      deaths_detail:deathsWin.map((d)=>({boss:d.boss,avoidable:d.avoidable,cause:d.cause})),
      events:p.events.filter((e)=>e.ts>=prepStart&&e.ts<=winEnd).sort((a,b)=>a.ts-b.ts)
        .map((e)=>({time:new Date(e.ts).toISOString(),kind:e.kind,name:e.name,boss:(encAt(e.ts)?encAt(e.ts).name:null)})),
    });
  }

  const insts=[...new Set(encs.map((e)=>e.instanceId))];
  const meta={ raidDate:isoDate(winStart), instanceId:insts[0]||null,
    difficulty:DIFFICULTY_MAP[encs[0].difficulty]||`Diff ${encs[0].difficulty}`,
    zoneNameGuess:insts.map(zoneFromInstance).join(" + "),
    encounters:encs.map((e)=>({id:e.id,name:e.name,durationSec:round1(e.durationSec),success:e.success})) };
  return { meta, players:out };
}

// -------------------- RCLootCouncil parser (unchanged) --------------------
export function parseRCLootCouncil(text){
  const trimmed=text.trim();
  if(trimmed.startsWith("[")||trimmed.startsWith("{")){ try{ const data=JSON.parse(trimmed);
    const arr=Array.isArray(data)?data:data.loot||data.items||[];
    return normalizeLoot(arr.map((e)=>({ player:e.player||e.name||e.character,
      item_name:extractItemName(e.item||e.itemName||e.itemLink||""), item_id:extractItemId(String(e.itemID||e.id||e.item||"")),
      source_boss:e.boss||e.instance||e.encounter||"", response:e.response||e.awardReason||"",
      class:e.class||e.classFile||"", date:e.date||e.time||"" }))); }catch(_){} }
  if(trimmed.includes("\n")){ const delim=trimmed.indexOf("\t")!==-1?"\t":",";
    const rows=trimmed.split(/\r?\n/).filter(Boolean);
    const header=splitDelimited(rows[0],delim).map((h)=>h.trim().toLowerCase().replace(/^"|"$/g,""));
    if(header.includes("player")||header.includes("item")){ const col=(names)=>header.findIndex((h)=>names.includes(h));
      const ci={player:col(["player","name","character"]),item:col(["item","itemname"]),id:col(["itemid","id","itemstring"]),
        boss:col(["boss","encounter"]),instance:col(["instance","zone"]),response:col(["response","awardreason"]),
        cls:col(["class"]),date:col(["date","time"])};
      return normalizeLoot(rows.slice(1).map((r)=>{ const c=splitDelimited(r,delim).map((x)=>x.replace(/^"|"$/g,""));
        return { player:get(c,ci.player), item_name:extractItemName(get(c,ci.item)),
          item_id:extractItemId(get(c,ci.id)||get(c,ci.item)), source_boss:get(c,ci.boss)||get(c,ci.instance),
          response:get(c,ci.response), class:get(c,ci.cls), date:get(c,ci.date) }; })); } }
  const luaLoot=[]; const playerRe=/\["?player"?\]\s*=\s*"([^"]+)"/gi;
  const itemRe=/\|Hitem:(\d+):[^|]*\|h\[([^\]]+)\]/g; const bossRe=/\["?boss"?\]\s*=\s*"([^"]+)"/i;
  for(const chunk of trimmed.split(/\}\s*,/)){ playerRe.lastIndex=0; itemRe.lastIndex=0;
    const pm=playerRe.exec(chunk); const im=itemRe.exec(chunk);
    if(im){ const bm=bossRe.exec(chunk); luaLoot.push({player:pm?pm[1]:"",item_name:im[2],item_id:Number(im[1]),
      source_boss:bm?bm[1]:"",response:"",class:"",date:""}); } }
  return normalizeLoot(luaLoot);
}
function normalizeLoot(entries){ const loot=[]; const players=new Map();
  for(const e of entries){ const name=stripRealm(e.player||""); if(!name) continue;
    if(!players.has(name)) players.set(name,{name,class:e.class||null});
    else if(e.class&&!players.get(name).class) players.get(name).class=e.class;
    loot.push({player:name,item_name:e.item_name||null,item_id:e.item_id||null,source_boss:e.source_boss||null,response:e.response||null,date:e.date||null}); }
  return { loot, players:[...players.values()] }; }

function splitDelimited(line,delim){ const o=[]; let c="",q=false; for(const ch of line){ if(ch==='"')q=!q;
  else if(ch===delim&&!q){o.push(c);c="";} else c+=ch;} o.push(c); return o; }
function get(a,i){ return i>=0&&i<a.length?a[i].trim():""; }
function extractItemId(s){ const m=String(s).match(/item[:\-]?(\d+)/i)||String(s).match(/(\d{4,7})/); return m?Number(m[1]):null; }
function extractItemName(s){ const m=String(s).match(/\[([^\]]+)\]/); if(m) return m[1];
  return String(s).replace(/\|c[0-9a-f]{8}|\|r|\|H[^|]*\|h|\|h/gi,"").trim()||null; }
function overlap(a1,a2,b1,b2){ return Math.max(0,Math.min(a2,b2)-Math.max(a1,b1)); }
function clamp(x,lo,hi){ return Math.min(hi,Math.max(lo,x)); }
function round1(x){ return Math.round(x*10)/10; }
function round2(x){ return Math.round(x*100)/100; }
function isoDate(ms){ const d=new Date(ms); const p=(n)=>String(n).padStart(2,"0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
