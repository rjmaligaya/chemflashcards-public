/**
 * session0-content.js — teaching content for the Session 0 topic lessons.
 *
 * Draft wording. Not yet reviewed for participant-facing use (the same status
 * as features-v2.js). Each list covers its 12 features across topic cards:
 * 7 cards for C-1 and 8 for C-2.
 *
 * Each topic:
 *   id       — stable key (for logging / per-topic data; the ease-of-learning
 *              rating is saved with item_id = this id)
 *   title    — card heading shown to the participant
 *   family   — short noun phrase used in the after-card rating prompt
 *              ("Was the name for {family} easy to learn?")
 *   features — the v2 features this lesson introduces (for the audit trail)
 *   body     — HTML string: plain-language explanation. <strong>/<em> only.
 *   example  — { full_name, image?, caption }  (a single worked example)
 *   examples — [ {full_name, image?, caption}, ... ]  (use INSTEAD of `example`
 *              to show more than one worked example). lessonStep renders
 *              `examples` if present, else falls back to the single `example`.
 *                full_name -> caption + structures/ image (graceful fallback)
 *                image     -> optional path override for the structure image
 *
 * Participant-facing strings use commas and periods, not em dashes.
 */

export const SESSION0_TOPICS = {
  // ── List A (C-1): al, amide, ene, eth, fluoro, hex, iodo, ol, pent, prop,
  //    pyridine, pyrrole ──────────────────────────────────────────────────
  "C-1": [
    {
      id: "a-alkyl-chains",
      title: "Carbon-chain lengths",
      family: "these carbon chains",
      features: ["eth", "prop", "pent", "hex"],
      body: `The longest unbroken line of carbon atoms is the main chain, and a prefix counts how many carbons it has. In this set you will meet four lengths: <strong>eth</strong> for two carbons, <strong>prop</strong> for three, <strong>pent</strong> for five, and <strong>hex</strong> for six. When the chain has only single bonds and nothing else attached, the name ends in <em>-ane</em>, so a six-carbon chain is <strong>hexane</strong>.`,
      example: { full_name: "hexane", image: "images/session0/chains/hexane.svg", caption: "Hexane: a six-carbon chain (prefix hex, ending -ane)." },
    },
    {
      id: "a-alkenes",
      title: "Double bonds (-ene)",
      family: "double bonds",
      features: ["ene"],
      body: `A double bond between two carbons is shown by two parallel lines, and it changes the ending of the name to <strong>-ene</strong>. A number in front of the ending tells you which carbon the double bond starts from. For example, <strong>hex-1-ene</strong> has its double bond starting at carbon 1, while <strong>hex-2-ene</strong> has it starting at carbon 2. Only the number changes.`,
      examples: [
        { full_name: "hex-1-ene", caption: "Hex-1-ene: double bond starting at carbon 1." },
        { full_name: "hex-2-ene", caption: "Hex-2-ene: double bond starting at carbon 2." },
      ],
    },
    {
      id: "a-alcohols",
      title: "Alcohols (-ol)",
      family: "alcohols",
      features: ["ol"],
      body: `An alcohol has an <strong>OH</strong> group, an oxygen joined to a hydrogen, attached to the carbon chain. The name ends in <strong>-ol</strong>, and a number shows which carbon carries the OH. For example, <strong>propan-1-ol</strong> has the OH on carbon 1, while <strong>propan-2-ol</strong> has it on carbon 2.`,
      examples: [
        { image: "images/structures/generic_alcohol.svg", caption: "The alcohol group in general: an OH joined to the rest of the molecule (shown as a circle)." },
        { full_name: "propan-1-ol", caption: "Propan-1-ol: OH on carbon 1 of a three-carbon chain." },
        { full_name: "propan-2-ol", caption: "Propan-2-ol: OH on carbon 2 of a three-carbon chain." },
      ],
    },
    {
      id: "a-aldehydes",
      title: "Aldehydes (-al)",
      family: "aldehydes",
      features: ["al"],
      body: `An aldehyde has a carbon at the <em>end</em> of the chain that is double-bonded to an oxygen and also joined to a hydrogen. The name ends in <strong>-al</strong>. For example, <strong>propanal</strong> is the three-carbon aldehyde.`,
      examples: [
        { image: "images/structures/generic_aldehyde.svg", caption: "The aldehyde group in general: a carbon at the end of the chain, double-bonded to oxygen and joined to an H. The circle stands for the rest of the molecule." },
        { full_name: "propanal", caption: "Propanal: a three-carbon chain ending in an aldehyde group." },
      ],
    },
    {
      id: "a-amides",
      title: "Amides (-amide)",
      family: "amides",
      features: ["amide"],
      body: `An amide has a carbon double-bonded to an oxygen and also joined to a <strong>nitrogen</strong>. The name ends in <strong>-amide</strong>. For example, <strong>propanamide</strong> is the three-carbon amide.`,
      examples: [
        { image: "images/structures/generic_amide.svg", caption: "The amide group in general: a carbon double-bonded to oxygen and joined to a nitrogen (NH2). The circle stands for the rest of the molecule." },
        { full_name: "propanamide", caption: "Propanamide: a three-carbon chain ending in an amide group." },
      ],
    },
    {
      id: "a-halides",
      title: "Halogens (fluoro, iodo)",
      family: "these halogens",
      features: ["fluoro", "iodo"],
      body: `A halogen atom attached to the chain is named with a prefix and a position number: <strong>fluoro</strong> for fluorine and <strong>iodo</strong> for iodine. The number says which carbon it is on. For example, <strong>1-fluoropropane</strong> has the fluorine on carbon 1, while <strong>2-fluoropropane</strong> has it on carbon 2. When a halogen can only sit in one place, like <strong>iodoethane</strong>, no number is needed.`,
      examples: [
        { full_name: "1-fluoropropane", caption: "1-fluoropropane: fluorine on carbon 1." },
        { full_name: "2-fluoropropane", caption: "2-fluoropropane: fluorine on carbon 2." },
      ],
    },
    {
      id: "a-aromatic",
      title: "Nitrogen rings (pyridine, pyrrole)",
      family: "these nitrogen rings",
      features: ["pyridine", "pyrrole"],
      body: `Some rings contain a nitrogen atom and have their own fixed names. <strong>Pyridine</strong> is a six-membered ring with one nitrogen in place of a carbon. <strong>Pyrrole</strong> is a five-membered ring with one nitrogen. These two names are used as they are, with nothing added.`,
      example: { full_name: "pyridine", caption: "Pyridine: a six-membered ring containing one nitrogen." },
    },
  ],

  // ── List B (C-2): benzene, bromo, but, chloro, iso, methyl, oate, oct,
  //    one, hept, tert, toluene ────────────────────────────────────────────
  "C-2": [
    {
      id: "b-alkyl-chains",
      title: "Carbon-chain lengths",
      family: "these carbon chains",
      features: ["but", "hept", "oct"],
      body: `A prefix counts how many carbons are in the main chain: <strong>but</strong> for four, <strong>hept</strong> for seven, and <strong>oct</strong> for eight. When the chain has only single bonds and nothing else attached, the name ends in <em>-ane</em>, so an eight-carbon chain is <strong>octane</strong>.`,
      example: { full_name: "octane", image: "images/session0/chains/octane.svg", caption: "Octane: an eight-carbon chain (prefix oct, ending -ane)." },
    },
    {
      id: "b-methyl",
      title: "Methyl branches (methyl)",
      family: "methyl branches",
      features: ["methyl"],
      body: `A short branch made of a single carbon coming off the main chain is a <strong>methyl</strong> group. It is named with the prefix <strong>methyl</strong> and a position number that says which carbon it is attached to. For example, <strong>2-methylbutane</strong> has the methyl branch on carbon 2 of a four-carbon chain, while <strong>3-methylheptane</strong> has it on carbon 3 of a seven-carbon chain.`,
      examples: [
        { full_name: "2-methylbutane", caption: "2-methylbutane: methyl branch on carbon 2 of a four-carbon chain." },
        { full_name: "3-methylheptane", caption: "3-methylheptane: methyl branch on carbon 3 of a seven-carbon chain." },
      ],
    },
    {
      id: "b-ketones",
      title: "Ketones (-one)",
      family: "ketones",
      features: ["one"],
      body: `A ketone has a carbon in the <em>middle</em> of the chain double-bonded to an oxygen. The name ends in <strong>-one</strong>, with a number for the position of that carbon. For example, <strong>octan-3-one</strong> has the carbon-oxygen double bond on carbon 3, while <strong>octan-4-one</strong> has it on carbon 4 of the same eight-carbon chain.`,
      examples: [
        { full_name: "octan-3-one", caption: "Octan-3-one: carbon-oxygen double bond on carbon 3 of an eight-carbon chain." },
        { full_name: "octan-4-one", caption: "Octan-4-one: carbon-oxygen double bond on carbon 4 of an eight-carbon chain." },
      ],
    },
    {
      id: "b-esters",
      title: "Esters (-oate)",
      family: "esters",
      features: ["oate"],
      body: `An ester is built from two parts. The first word names the small group attached through an oxygen, and the second word names the acid part and ends in <strong>-oate</strong>. For example, <strong>methyl ethanoate</strong> has a methyl group joined to the ethanoate part.`,
      example: { full_name: "methyl ethanoate", caption: "Methyl ethanoate: a methyl group joined to an ethanoate (acid) part." },
    },
    {
      id: "b-aromatic",
      title: "Benzene and toluene",
      family: "benzene and toluene",
      features: ["benzene", "toluene"],
      body: `<strong>Benzene</strong> is a six-membered carbon ring with alternating double bonds, usually drawn as a hexagon with three double bonds or a circle inside. <strong>Toluene</strong> is a benzene ring with a single methyl group attached. Both names are used as they are.`,
      example: { full_name: "benzene", caption: "Benzene: a six-membered carbon ring with alternating double bonds." },
    },
    {
      id: "b-halides",
      title: "Halogens (bromo, chloro)",
      family: "these halogens",
      features: ["bromo", "chloro"],
      body: `A halogen attached to the chain is named with a prefix and a position number: <strong>bromo</strong> for bromine and <strong>chloro</strong> for chlorine. The number says which carbon it is on. For example, <strong>2-bromobutane</strong> has a bromine on carbon 2, while <strong>1-chlorobutane</strong> has a chlorine on carbon 1.`,
      examples: [
        { full_name: "2-bromobutane", caption: "2-bromobutane: bromine on carbon 2 of a four-carbon chain." },
        { full_name: "1-chlorobutane", caption: "1-chlorobutane: chlorine on carbon 1 of a four-carbon chain." },
      ],
    },
    {
      id: "b-iso",
      title: "The iso- shape",
      family: "the iso- shape",
      features: ["iso"],
      body: `<strong>iso</strong> describes a particular branched shape where the chain splits into two methyl groups at one end. An <strong>iso-butyl</strong> group is a four-carbon branch with that forked shape. For example, <strong>iso-butyl chloride</strong> is an iso-butyl group joined to a chlorine.`,
      example: { full_name: "iso-butyl chloride", caption: "iso-butyl chloride: a forked four-carbon (iso-butyl) group joined to a chlorine." },
    },
    {
      id: "b-tert",
      title: "The tert- shape",
      family: "the tert- shape",
      features: ["tert"],
      body: `<strong>tert</strong>, short for tertiary, describes a branch where one carbon is joined to three other carbons at once. A <strong>tert-butyl</strong> group is a four-carbon branch built that way. For example, <strong>tert-butyl chloride</strong> is a tert-butyl group joined to a chlorine.`,
      example: { full_name: "tert-butyl chloride", caption: "tert-butyl chloride: a four-carbon (tert-butyl) group joined to a chlorine." },
    },
  ],
};

/** The topic lessons for a participant's list group ('C-1' | 'C-2'). */
export function topicsForGroup(group) {
  return SESSION0_TOPICS[group] || [];
}
