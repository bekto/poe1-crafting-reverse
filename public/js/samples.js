// Example items for the "Load an example" menu and the tests.
export const LABELS = {
  ring: "Rare ring (Ctrl+C)",
  boots: "Rare boots (Ctrl+Alt+C)",
  amulet: "Magic amulet",
  foil: "Weapon: physical foil",
  spinebow: "Weapon: bow (Ctrl+Alt+C)",
  wand: "Weapon: spell wand",
  plate: "Body armour with a hybrid mod (Ctrl+Alt+C)",
  shield: "Shield",
  belt: "Belt",
  jewel: "Jewel",
  hunterboots: "Influenced boots (Hunter)",
  fractured: "Fractured helmet",
  synthamulet: "Synthesised amulet",
  summedplate: "Body armour, Ctrl+C with a summed life line",
  awakened: "Helmet with two influences (Crusader + Hunter)",
  eldritchboots: "Boots with eldritch implicits",
  veiledamulet: "Amulet with an unveiled mod",
};

export const ITEMS = {
eldritchboots: `Item Class: Boots
Rarity: Rare
Ghoul Spur
Two-Toned Boots
--------
Evasion Rating: 120
Energy Shield: 25
--------
Item Level: 86
--------
+12% to Fire and Lightning Resistances (implicit)
8% increased Movement Speed (implicit)
8% increased Life Regeneration rate (implicit)
--------
+92 to maximum Life
25% increased Movement Speed
+44% to Cold Resistance
+27% to Chaos Resistance
--------
Searing Exarch Item
Eater of Worlds Item`,
ring: `Item Class: Rings
Rarity: Rare
Storm Loop
Two-Stone Ring
--------
Requirements:
Level: 64
--------
Item Level: 85
--------
+14% to Fire and Lightning Resistances (implicit)
--------
+74 to maximum Life
Adds 8 to 16 Physical Damage to Attacks
+44% to Cold Resistance
+41% to Lightning Resistance
+47 to Intelligence
+25 to maximum Energy Shield (crafted)`,
boots: `Item Class: Boots
Rarity: Rare
Gale Stride
Two-Toned Boots
--------
Evasion Rating: 120
Energy Shield: 25
--------
Requirements:
Level: 70
Dex: 62
Int: 62
--------
Sockets: B-G-G-R
--------
Item Level: 86
--------
+12% to Fire and Lightning Resistances (implicit)
--------
{ Prefix Modifier "Rotund" (Tier: 2) — Life }
+95(85-99) to maximum Life
{ Prefix Modifier "Cheetah's" (Tier: 1) — Speed }
30% increased Movement Speed
{ Suffix Modifier "of Haast" (Tier: 1) — Elemental, Cold, Resistance }
+46(46-48)% to Cold Resistance
{ Suffix Modifier "of Ephij" (Tier: 1) — Elemental, Lightning, Resistance }
+47(46-48)% to Lightning Resistance
{ Master Crafted Suffix Modifier "of Craft" (Rank: 3) — Elemental, Fire, Chaos, Resistance }
+14(13-15)% to Fire and Chaos Resistances (crafted)`,
amulet: `Item Class: Amulets
Rarity: Magic
Hale Onyx Amulet of the Whelpling
--------
Item Level: 40
--------
+12 to all Attributes (implicit)
--------
+20 to maximum Life
+10% to Fire Resistance`,
foil: `Item Class: Thrusting One Hand Swords
Rarity: Rare
Viper Needle
Jewelled Foil
--------
Thrusting One Handed Sword
Physical Damage: 101-180
Critical Strike Chance: 7.48%
Attacks per Second: 2.04
Weapon Range: 1.4 metres
--------
Requirements:
Level: 68
Dex: 212
--------
Sockets: G-G-B
--------
Item Level: 84
--------
+25% to Global Critical Strike Multiplier (implicit)
--------
Adds 24 to 48 Physical Damage
162% increased Physical Damage
26% increased Attack Speed
36% increased Critical Strike Chance
+37% to Global Critical Strike Multiplier`,
plate: `Item Class: Body Armours
Rarity: Rare
Golem Shell
Astral Plate
--------
Armour: 1650
--------
Requirements:
Level: 62
Str: 180
--------
Sockets: R-R-R-B-G-R
--------
Item Level: 86
--------
+10% to all Elemental Resistances (implicit)
--------
{ Prefix Modifier "Crocodile's" (Tier: 1) — Life, Defences, Armour }
+120(97-144) to Armour
+36(34-38) to maximum Life
{ Prefix Modifier "Girded" (Tier: 3) — Defences, Armour }
85(80-91)% increased Armour
{ Suffix Modifier "of the Magma" (Tier: 2) — Elemental, Fire, Resistance }
+44(42-45)% to Fire Resistance
{ Suffix Modifier "of Haast" (Tier: 1) — Elemental, Cold, Resistance }
+47(46-48)% to Cold Resistance
{ Suffix Modifier "of Bameth" (Tier: 1) — Chaos, Resistance }
+33(31-35)% to Chaos Resistance`,
jewel: `Item Class: Jewels
Rarity: Rare
Grim Glimmer
Cobalt Jewel
--------
Item Level: 83
--------
7% increased maximum Life
7% increased maximum Energy Shield
+11% to Global Critical Strike Multiplier
12% increased Spell Damage
--------
Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.`,
shield: `Item Class: Shields
Rarity: Rare
Rune Bulwark
Archon Kite Shield
--------
Chance to Block: 25%
Armour: 712
Energy Shield: 145
--------
Requirements:
Level: 68
Str: 85
Int: 85
--------
Item Level: 85
--------
+12% to all Elemental Resistances (implicit)
--------
+152 to maximum Life
88% increased Armour and Energy Shield
+17% to all Elemental Resistances
+43% to Lightning Resistance
+2% to maximum Lightning Resistance`,
wand: `Item Class: Wands
Rarity: Rare
Blight Song
Imbued Wand
--------
Wand
Physical Damage: 29-53
Critical Strike Chance: 7.00%
Attacks per Second: 1.50
--------
Requirements:
Level: 59
Int: 188
--------
Item Level: 84
--------
37% increased Spell Damage (implicit)
--------
92% increased Spell Damage
Adds 64 to 130 Fire Damage to Spells
26% increased Cast Speed
95% increased Spell Critical Strike Chance`,
hunterboots: `Item Class: Boots
Rarity: Rare
Corpse Track
Sorcerer Boots
--------
Energy Shield: 98
--------
Requirements:
Level: 67
Int: 123
--------
Item Level: 86
--------
+30 to maximum Energy Shield
30% increased Movement Speed
+2 to Level of Socketed Chaos Gems
+44% to Fire Resistance
+46% to Cold Resistance
--------
Hunter Item`,
fractured: `Item Class: Helmets
Rarity: Rare
Mind Halo
Hubris Circlet
--------
Energy Shield: 210
--------
Requirements:
Level: 69
Int: 154
--------
Item Level: 86
--------
+67 to maximum Mana (fractured)
95% increased Energy Shield
+2 to Level of all Minion Skill Gems
+47 to Intelligence
34% increased Energy Shield Recharge Rate
--------
Fractured Item`,
belt: `Item Class: Belts
Rarity: Rare
Dragon Lash
Stygian Vise
--------
Requirements:
Level: 64
--------
Item Level: 86
--------
Has 1 Abyssal Socket (implicit)
--------
+410 to Armour
+87 to maximum Life
Flasks applied to you have 11% increased Effect
+44% to Fire Resistance
+46% to Lightning Resistance
32% increased Flask Charges gained`,
spinebow: `Item Class: Bows
Rarity: Rare
Storm Fletch
Spine Bow
--------
Bow
Physical Damage: 40-165
Critical Strike Chance: 6.50%
Attacks per Second: 1.40
--------
Requirements:
Level: 64
Dex: 212
--------
Item Level: 85
--------
{ Prefix Modifier "Merciless" (Tier: 2) — Damage, Physical, Attack }
158(155-169)% increased Physical Damage
{ Suffix Modifier "of Celebration" (Tier: 2) — Attack, Speed }
24(23-25)% increased Attack Speed
{ Suffix Modifier "of the Wind" (Tier: 4) — Attribute }
+36(33-37) to Dexterity`,
synthamulet: `Item Class: Amulets
Rarity: Rare
Soul Charm
Synthesised Onyx Amulet
--------
Requirements:
Level: 60
--------
Item Level: 84
--------
8% increased maximum Life (implicit)
--------
+60 to maximum Life
+34 to Strength
+38% to Lightning Resistance
+31% to Global Critical Strike Multiplier
--------
Synthesised Item`,
summedplate: `Item Class: Body Armours
Rarity: Rare
Golem Shell
Astral Plate
--------
Armour: 1650
--------
Item Level: 86
--------
+10% to all Elemental Resistances (implicit)
--------
+120 to Armour
+215 to maximum Life
85% increased Armour
+44% to Fire Resistance
+47% to Cold Resistance
+33% to Chaos Resistance`,
awakened: `Item Class: Helmets
Rarity: Rare
Doom Crown
Royal Burgonet
--------
Armour: 520
--------
Requirements:
Level: 65
Str: 148
--------
Item Level: 86
--------
+90 to maximum Life
Adds 30 to 55 Fire Damage to Spells
+42% to Fire Resistance
Nearby Enemies have -9% to Lightning Resistance
--------
Crusader Item
Hunter Item`,
veiledamulet: `Item Class: Amulets
Rarity: Rare
Rune Charm
Onyx Amulet
--------
Item Level: 84
--------
+12 to all Attributes (implicit)
--------
+70 to maximum Life
+40% to Cold Resistance
+30% to Global Critical Strike Multiplier
+1 to Minimum Power Charges
4% chance to gain a Power Charge on Kill`,
};
