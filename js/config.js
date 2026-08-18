// =====================================================================
//  CONFIG — edit this file, nothing secret lives here.
//  The anon key is safe to expose in a static site: RLS on the server
//  is what actually protects your data. Never put the service_role key
//  in frontend code.
// =====================================================================

export const SUPABASE_URL = "https://khnihlfkypljxqimdjww.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_PJ1QUm6oLlCptHiRgWrUPw_MjbS9tGz";

// ---------------------------------------------------------------------
//  COMBAT-LOG TUNING
//  Spell IDs differ by expansion/patch. Fill these with the IDs your
//  guild actually uses. You can find them on Wowhead or by grepping the
//  log for the spell name in SPELL_AURA_APPLIED / SPELL_CAST_SUCCESS.
// ---------------------------------------------------------------------

// Flasks apply a 2-hour buff aura (SPELL_AURA_APPLIED). TBC Classic IDs:
export const FLASK_SPELL_IDS = new Set([
  28521, // Flask of Blinding Light   (+80 arcane/holy/nature spell dmg)
  28589, // Flask of Relentless Assault (+120 attack power)
  28591, // Flask of Pure Death        (+80 fire/frost/shadow spell dmg)
  28588, // Flask of Mighty Restoration (+25 mp5)
  28587, // Flask of Fortification     (+500 health, +10 defense — tanks)
  42736, // Flask of Chromatic Wonder  (+18 all stats, +35 all resist)
]);

// Combat potions cast mid-fight (SPELL_CAST_SUCCESS). TBC Classic IDs.
// Note: TBC potions share a ~2-min cooldown, so multiple per long fight is
// legitimate — this list is what counts as "using your combat potion".
export const POTION_SPELL_IDS = new Set([
  28564, // Haste Potion            (+400 haste, 15s — melee/ranged burst)
  28565, // Destruction Potion      (+120 spell power, +2% crit — casters)
  28550, // Insane Strength Potion  (+120 str, +5% crit, -10 defense — melee)
  38961, // Fel Mana Potion         (mana restore — casters)
  28555, // Super Mana Potion       (mana restore)
  28551, // Super Healing Potion    (health restore)
]);

// Per-boss "avoidable" mechanic spell IDs. Death caused by one of these
// (as the last significant hit) is counted as AVOIDABLE. Everything else
// is treated as unavoidable/tank/execution damage.
// Key = encounterID (from ENCOUNTER_START), value = Set of spell IDs.
// Leaving a boss out means "use the fallback heuristic" (see parsers.js).
export const AVOIDABLE_SPELL_IDS = {
  // 2820: new Set([ 410018, 410004 ]),   // example encounterID -> mechanics
};

// ---------------------------------------------------------------------
//  SCORING THRESHOLDS  (all tunable, all transparent)
// ---------------------------------------------------------------------
export const SCORING = {
  // A pull shorter than this many seconds is treated as an instant wipe,
  // so a potion spent on it is "wasted", not "effective".
  instantWipeSeconds: 20,

  // A pull must last at least this long to count as a "legitimate" pull
  // for potion-effectiveness purposes.
  legitPullSeconds: 30,

  // preparedness_score = flaskWeight*flaskUptime + potionWeight*potionScore
  flaskWeight: 0.7,
  potionWeight: 0.3,

  // Weight applied to avoidable vs unavoidable deaths in the Death Cost Index.
  avoidableDeathWeight: 2.0,
  unavoidableDeathWeight: 1.0,
};
