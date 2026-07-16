// Species name/type resolution: Paldeck lookup with boss/tower prefix and
// variant suffix handling, plus captured-human detection.
import { PALDEX } from "./paldex.js";

const HUMAN_RE = /hunter|police|soldier|salesperson|dealer|citizen|people|farmer|ranger|ninja|believer|^male_|^female_|visitor|guard|trader|scientist|firecult|viking|pirate/i;
const VARIANT_SUFFIXES = /_(otomo|oilrig|flower|max|small|rainbow|purple|blue|red|pink|green|yellow|black|white|dark|ice|fire|water|thunder|grass|ground|dragon|noukin|invader|tower)$/i;

export function humanize(id) {
  return id.replace(/_/g, " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
}

// Resolve a save CharacterID to Paldeck info, handling boss/tower prefixes,
// variant suffixes, and captured humans.
export function palMeta(pal) {
  let id = pal.species.toLowerCase(); // BOSS_ already stripped case-sensitively upstream
  id = id.replace(/^(boss_|gym_|raid_|summon_|predator_)/, "");
  const variants = [];
  let dex = PALDEX[id];
  while (!dex) {
    const m = VARIANT_SUFFIXES.exec(id);
    if (!m) break;
    variants.unshift(m[1]);
    id = id.slice(0, -m[0].length);
    dex = PALDEX[id];
  }
  const variant = variants.length ? variants.map(humanize).join(" ") : null;
  const isHuman = HUMAN_RE.test(pal.species);
  if (dex) {
    return {
      no: dex.no,
      key: id,
      displayName: dex.name + (variant ? ` (${variant})` : ""),
      elements: dex.el,
      category: isHuman ? "human" : "pal",
    };
  }
  return {
    no: null,
    key: null,
    displayName: humanize(pal.species),
    elements: [],
    category: isHuman ? "human" : "unknown",
  };
}

/** Icon path for a resolved palMeta (deck species only), or null. */
export function palIcon(meta) {
  return meta.key && meta.no ? `icons/${meta.key}.png` : null;
}

export const ELEMENT_COLORS = {
  Normal: "#b8a88f", Grass: "#6fbf4a", Fire: "#f0703a", Water: "#4a9df0",
  Electricity: "#f0d43a", Electric: "#f0d43a", Ice: "#7adcf0", Earth: "#c98d4a",
  Dark: "#a05adf", Dragon: "#7a6af0", Leaf: "#6fbf4a",
};

