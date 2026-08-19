// =====================================================================
//  CONFIG — edit this file. Nothing secret lives here.
//  The publishable/anon key is safe in a static site; RLS protects data.
//  Never put the service_role / secret key in frontend code.
// =====================================================================

export const SUPABASE_URL = "https://khnihlfkypljxqimdjww.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_PJ1QUm6oLlCptHiRgWrUPw_MjbS9tGz";

// ---------------------------------------------------------------------
//  CONSUMABLE DETECTION
//  TBC has hundreds of flasks/elixirs/foods. Rather than list every ID,
//  we match on the BUFF NAME in the combat log (robust across patches).
//  Potions are matched by spell ID because they're cast events with
//  precise, well-known IDs.
// ---------------------------------------------------------------------

// Aura-name patterns (case-insensitive) for buffs in SPELL_AURA_APPLIED.
export const CONSUMABLE_PATTERNS = {
  flask:  /flask/i,       // "Flask of Relentless Assault", etc.
  elixir: /elixir/i,      // any Battle or Guardian elixir
  food:   /well fed/i,    // the standard raiding food buff
};

// Optional extra buff spell IDs to force-count. Usually leave empty.
export const EXTRA_FLASK_IDS  = new Set([]);
export const EXTRA_ELIXIR_IDS = new Set([]);

// Combat potions cast mid-fight (SPELL_CAST_SUCCESS), by spell ID.
export const POTION_SPELL_IDS = new Set([
  28564, // Haste Potion
  28565, // Destruction Potion
  28550, // Insane Strength Potion
  38961, // Fel Mana Potion
  28555, // Super Mana Potion
  28551, // Super Healing Potion
]);

// Per-boss "avoidable" mechanic spell IDs, keyed by encounterID.
// Leave a boss out to use the fallback heuristic.
export const AVOIDABLE_SPELL_IDS = {
  // 628: new Set([ 38509, 38280 ]),  // Lady Vashj: Shock Blast, Static Charge
};

// ---------------------------------------------------------------------
//  SCORING  (all transparent and tunable)
// ---------------------------------------------------------------------
export const SCORING = {
  instantWipeSeconds: 20, // shorter pull = instant wipe (potion wasted)
  legitPullSeconds:   30, // pull >= this = a "real" pull

  // A continuous WoWCombatLog.txt is split into separate raid nights
  // wherever there's a gap this long (hours) with no boss pulls. This also
  // keeps a raid that crosses midnight as a single night.
  sessionGapHours: 6,

  // Preparedness = coverage*W1 + food*W2 + potionUse*W3
  // coverage = flask up OR elixir up (credits flask AND double-elixir raiders)
  coverageWeight: 0.5,
  foodWeight:     0.2,
  potionWeight:   0.3,

  avoidableDeathWeight:   2.0,
  unavoidableDeathWeight: 1.0,

  // Loot priority: contribution / (itemsWon + 1); higher = more owed.
  avoidableDeathPenalty: 5,
};
