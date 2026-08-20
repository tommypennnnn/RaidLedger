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

// Force-count a buff by its AURA spell ID (matched in SPELL_AURA_APPLIED).
// These IDs were taken directly from real combat logs, so they're the actual
// aura IDs — the primary detection path. The name regexes above are kept as a
// backstop, but every flask/elixir observed in the logs is pinned by ID here.
export const EXTRA_FLASK_IDS = new Set([
  28520, // Flask of Relentless Assault
  28540, // Flask of Pure Death
  28521, // Flask of Blinding Light
  28518, // Flask of Fortification
  28519, // Flask of Mighty Restoration
  17628, // Flask of Supreme Power   (buff "Supreme Power")
  17627, // Flask of Distilled Wisdom (buff "Distilled Wisdom")
]);

export const EXTRA_ELIXIR_IDS = new Set([
  39627, // Elixir of Draenic Wisdom
  28491, // Elixir of Healing Power
  33721, // Adept's Elixir
  28497, // Elixir of Major Agility
  28503, // Elixir of Major Shadow Power
  16589, // Noggenfogger Elixir
  17539, // Greater Arcane Elixir
  39625, // Elixir of Major Fortitude
  38954, // Fel Strength Elixir
  28502, // Elixir of Major Defense
  33720, // Onslaught Elixir
]);

// Combat potions, matched by the potion's USE (cast) spell ID as it appears
// in SPELL_CAST_SUCCESS when the potion is DRUNK.
//
// IMPORTANT — this is the USE spell, NOT the alchemy recipe. Wowhead's spell
// page for a potion (e.g. spell 28555 "Super Mana Potion") is the crafting
// recipe, filed under "Profession Spells"; that ID only fires when an
// alchemist MAKES the potion and never appears in a raid log. The earlier
// version of this file used those recipe IDs, so potion detection silently
// matched nothing. Every ID below is the verified drink/use spell.
//
// Restore potions share ONE use-spell across their whole tier, so a single ID
// covers the alchemy version and every vendor/instance re-skin at once.
export const POTION_SPELL_IDS = new Set([
  // --- observed in logs (mana) ---
  28499, // Super Mana Potion ("Restore Mana"); shared by Auchenai/Crystal Mana
         //  and the other 1800-3000 re-skins, so this one ID covers all of them
  41618, // Bottled Nethergon Energy (mana; Tempest Keep instances only)
  41617, // Restore Mana — minor/lesser instance mana potion
  17531, // Major Mana Potion (classic 1350-2250 tier)

  // --- observed in logs (health) ---
  28495, // Super Healing Potion ("Healing Potion"); shared by Auchenai/Crystal
         //  Healing and the other 1500-2500 re-skins
  41619, // Bottled Nethergon Vapor (health; Tempest Keep only). NB: the item
         //  page lists 41620; logs show 41619, so both are included for safety.
  41620,

  // --- observed in logs (offensive / combo) ---
  28507, // Haste Potion ("Haste", +400 haste rating)
  28508, // Destruction Potion (+120 spell dmg / +2% spell crit)
  45051, // Mad Alchemist's Potion (random mana/health/elixir)

  // --- not in these logs, kept for coverage (common raid pots) ---
  38929, // Fel Mana Potion ("Fel Mana", 3200 mana over 24s)
  28494, // Insane Strength Potion (+120 Str / -75 defense)
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
