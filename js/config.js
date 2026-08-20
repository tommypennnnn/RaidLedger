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

// Aura-name patterns (case-insensitive), tested against the buff name in
// SPELL_AURA_APPLIED. Detection is by the *buff* name, which is NOT always
// the item name — see the Classic flasks below.
//
//  - flask:  Every TBC flask (incl. Shattrath and Unstable variants) applies a
//            buff literally named "Flask of ...", so /flask/i catches them.
//            The leftover *Classic* flasks used in TBC raiding apply an
//            EFFECT-named buff with no "flask" in it, so they're added by name:
//              "Supreme Power"        = Flask of Supreme Power  (+70 spell dmg, all schools)
//              "Distilled Wisdom"     = Flask of Distilled Wisdom (+65 Intellect)
//              "Chromatic Resistance" = Flask of Chromatic Resistance (+25 all resist)
//
//  - elixir: Every TBC battle & guardian elixir applies an "Elixir ..."-named
//            buff, so /elixir/i catches all of them. "mageblood" also catches
//            the classic Mageblood Potion (guardian slot, buff "Mageblood").
//            (Truly obscure Classic battle-elixir leftovers — Winterfall
//             Firewater, Juju Might/Power, Ground Scorpok Assay, R.O.I.D.S.,
//             the Zanza buffs — are essentially never used in TBC raids since
//             TBC elixirs are strictly better; add their buff names here if
//             your guild somehow runs them.)
//
//  - food:   TBC stat foods apply the "Well Fed" aura. If a food is ever
//            missed, widen this the same way.
export const CONSUMABLE_PATTERNS = {
  flask:  /flask|supreme power|distilled wisdom|chromatic resistance/i,
  elixir: /elixir|mageblood/i,
  food:   /well fed/i,
};

// Optional escape hatch: force-count a buff by its AURA spell ID (matched in
// SPELL_AURA_APPLIED). Empty by default because the name patterns above
// already cover every flask & elixir used in TBC raiding. Use this only if a
// log shows a buff whose NAME doesn't match the patterns — e.g. a non-English
// client, or some obscure leftover you want tracked. Example:
//   export const EXTRA_FLASK_IDS = new Set([ 17628 ]); // "Supreme Power" by ID
export const EXTRA_FLASK_IDS  = new Set([]);
export const EXTRA_ELIXIR_IDS = new Set([]);

// Combat potions cast mid-fight (SPELL_CAST_SUCCESS), by spell ID.
// IDs verified against Wowhead TBC Classic (patch 2.5.6).
// Grouped so you can comment out a whole category you don't want to score.
export const POTION_SPELL_IDS = new Set([
  // --- mana restore ---
  28555, // Super Mana Potion
  38961, // Fel Mana Potion
  33733, // Unstable Mana Potion
  28586, // Super Rejuvenation Potion (mana + health)
  45061, // Mad Alchemist's Potion (mana + health + random elixir)
  27869, // Dark Rune    (mana at cost of health; healthstone-shared CD)
  16666, // Demonic Rune (mana at cost of health; healthstone-shared CD)

  // --- health restore ---
  28551, // Super Healing Potion
  33732, // Volatile Healing Potion
  38962, // Fel Regeneration Potion (HoT)

  // --- offensive / burst ---
  28564, // Haste Potion
  28565, // Destruction Potion
  28550, // Insane Strength Potion
  28563, // Heroic Potion

  // --- defensive / utility ---
  28579, // Ironshield Potion (+2500 armor)
  28554, // Shrouding Potion (threat drop)
  28562, // Major Dreamless Sleep Potion

  // --- school protection potions (situational: Vashj, Kael, Archimonde, ...) ---
  // Note: including these credits a "potion used" on any pull where someone
  // chugs a protection pot. Comment out this block if you only want to score
  // mana/health/offensive consumable usage.
  28571, // Major Fire Protection Potion
  28572, // Major Frost Protection Potion
  28573, // Major Nature Protection Potion
  28575, // Major Arcane Protection Potion
  28576, // Major Shadow Protection Potion
  28577, // Major Holy Protection Potion
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
