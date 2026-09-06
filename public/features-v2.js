/**
 * features-v2.js — feedback strings for the 24 v2 features.
 *
 * Used by practice-engine.js to render the "naming rule reminder" panel
 * after an incorrect practice answer.
 *
 * Draft wording. Not yet reviewed for participant-facing use.
 *
 * Format: { feature: {displayName, rule}, ... }
 *   displayName — what shows in the feedback panel header
 *   rule        — 1-2 sentence reminder shown below the header
 *
 * The section comments group the features by stimulus list (C-1 vs C-2).
 */

export const FEATURES_V2 = {
  // ── Carbon-chain roots (C-1: eth, hex, pent, prop)(C-2: but, hept, oct) ─────
  eth: {
    displayName: "eth- (2-carbon chain)",
    rule: "eth- signals a 2-carbon backbone. Look for two carbons in the main chain.",
  },
  prop: {
    displayName: "prop- (3-carbon chain)",
    rule: "prop- signals a 3-carbon backbone. Count three carbons in the main chain.",
  },
  but: {
    displayName: "but- (4-carbon chain)",
    rule: "but- signals a 4-carbon backbone. Count four carbons in the main chain.",
  },
  pent: {
    displayName: "pent- (5-carbon chain)",
    rule: "pent- signals a 5-carbon backbone. Count five carbons in the main chain.",
  },
  hex: {
    displayName: "hex- (6-carbon chain)",
    rule: "hex- signals a 6-carbon backbone. Count six carbons in the main chain.",
  },
  hept: {
    displayName: "hept- (7-carbon chain)",
    rule: "hept- signals a 7-carbon backbone. Count seven carbons in the main chain.",
  },
  oct: {
    displayName: "oct- (8-carbon chain)",
    rule: "oct- signals an 8-carbon backbone. Count eight carbons in the main chain.",
  },

  // ── Halogens (C-1: fluoro, iodo)(C-2: bromo, chloro) ──────────────────
  fluoro: {
    displayName: "fluoro- (fluorine substituent)",
    rule: "fluoro- names a fluorine atom (F) attached to a carbon. Treated as a prefix with a locant.",
  },
  chloro: {
    displayName: "chloro- (chlorine substituent)",
    rule: "chloro- names a chlorine atom (Cl) attached to a carbon. Treated as a prefix with a locant.",
  },
  bromo: {
    displayName: "bromo- (bromine substituent)",
    rule: "bromo- names a bromine atom (Br) attached to a carbon. Treated as a prefix with a locant.",
  },
  iodo: {
    displayName: "iodo- (iodine substituent)",
    rule: "iodo- names an iodine atom (I) attached to a carbon. Treated as a prefix with a locant.",
  },

  // ── Substituents (C-2: methyl, iso, tert) ─────────────────────────────
  methyl: {
    displayName: "methyl- (CH3 substituent)",
    rule: "methyl- is a one-carbon (CH3) substituent. Named with a locant indicating its position on the main chain.",
  },
  iso: {
    displayName: "iso- (branched 4-carbon attached via a primary carbon)",
    rule: "iso-butyl is a 4-carbon substituent branched at the carbon next to the attachment point. The iso- prefix means a methyl branch one carbon in.",
  },
  tert: {
    displayName: "tert- (attached via a tertiary carbon)",
    rule: "tert- means the substituent attaches via a tertiary carbon. For tert-butyl, the attachment carbon has three other carbons bonded to it.",
  },

  // ── Aromatics (C-1: pyridine, pyrrole)(C-2: benzene, toluene) ─────────
  benzene: {
    displayName: "benzene (6-carbon aromatic ring)",
    rule: "benzene is the parent 6-carbon aromatic ring (C6H6). The same ring as a substituent is named phenyl-.",
  },
  toluene: {
    displayName: "toluene (methylbenzene, common name)",
    rule: "toluene is the common name for methylbenzene: a benzene ring with one methyl group attached.",
  },
  pyridine: {
    displayName: "pyridine (6-ring aromatic with one N)",
    rule: "pyridine is a 6-membered aromatic ring with one nitrogen replacing a CH. Memorize the name as a unit.",
  },
  pyrrole: {
    displayName: "pyrrole (5-ring aromatic with one N)",
    rule: "pyrrole is a 5-membered aromatic ring with one nitrogen and an N-H bond. Memorize the name as a unit.",
  },

  // ── Suffix functional groups (C-1: al, amide, ene, ol)(C-2: one, oate)
  ene: {
    displayName: "-ene (alkene)",
    rule: "-ene marks a C=C double bond. The locant in the name points to the lower-numbered carbon of the double bond.",
  },
  ol: {
    displayName: "-ol (alcohol)",
    rule: "-ol marks an -OH group attached to a carbon. The locant points to the carbon bearing the hydroxyl.",
  },
  al: {
    displayName: "-al (aldehyde)",
    rule: "-al marks an aldehyde: a -CHO group at the end of the chain. No locant needed because it is always at carbon 1.",
  },
  one: {
    displayName: "-one (ketone)",
    rule: "-one marks a ketone: a C=O bonded to two carbons. The locant points to the carbonyl carbon.",
  },
  amide: {
    displayName: "-amide (carboxamide)",
    rule: "-amide marks a -C(=O)-NH2 group at the end of the chain. Replaces the final -e of the parent alkane.",
  },
  oate: {
    displayName: "-oate (ester)",
    rule: "-oate marks the acid-derived half of esters. The alkyl group before the space names the alcohol-derived half.",
  },

  // ── Demo-only (not a v2 stimulus feature) ─────────────────────────────
  // Read by the /demo route's cyclo trial in public/demo-page.js when that
  // trial is answered incorrectly. No item in items_v2.csv uses this feature.
  cyclo: {
    displayName: "cyclo- (closed carbon ring)",
    rule: "cyclo- means the carbon chain forms a closed ring. The rest of the name (e.g. -hexane) describes the ring size.",
  },
};

/* Returns the feedback entry for a feature key, or null if the key is
 * unknown. The lookup is case-insensitive. */
export function getFeatureCopy(feature) {
  return FEATURES_V2[String(feature || "").toLowerCase()] ?? null;
}
