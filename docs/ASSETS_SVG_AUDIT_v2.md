# SVG asset audit for v2 (within-subjects design)

**Regenerated:** 2026-05-30 against `Study Schedules Stimuli.xlsx` (the new
spreadsheet that replaced `sec` with `hept` in List B).

**Source of truth:** `public/items_v2.csv` (96 practice items) +
`public/delayed_posttest_v2.csv` (36 delayed items). The delayed set draws only
from practice molecules, so it adds no new structures.

- **Unique molecules needed:** 71
- **SVG already present in `public/images/structures/`:** 17
- **SVG missing (must be drawn in ChemDraw):** 54

## What changed from the previous audit (sec → hept swap)

- **No longer needed (`sec` dropped):** sec-butyl chloride, sec-butyl methanoate,
  sec-butyl bromide, sec-butyl benzene. The file `sec-butyl_benzene.svg` already
  existed and is now an orphan (safe to leave or delete; see bottom).
- **Newly needed (`hept` added):** `heptane.svg`, `2-methylheptane.svg`.
  (`1-chloroheptane.svg`, `3-bromoheptane.svg`, `3-methylheptane.svg`, and
  `heptan-2-one.svg` were already on the missing list from before.)

## Already present (17)

2-bromobutane, 2-methylbutane, benzene, butan-2-one, cyclohexane, ethanamide,
hexanal, methyl ethanoate, pent-2-ene, pentanal, pentanamide, propan-2-ol,
propanal, propanamide, tert-butyl bromide, tert-butyl chloride, toluene.

## Missing — to draw in ChemDraw (54)

Place each at `public/images/structures/<filename>`. Filenames are the molecule
name lowercased with spaces turned into underscores and hyphens kept (this is
exactly what `imagePathFor` in `practice-engine.js` expects).

### Alkanes — linear & methyl-branched (13)
butane, ethane, heptane, hexane, octane, pentane, propane,
2-methylheptane, 2-methyloctane, 3-methylbutane, 3-methylheptane,
3-methyloctane, 4-methyloctane

### Cyclic alkanes & cyclic alcohols (4)
cyclopropane, cyclopentane, cyclohexanol, cyclopentanol

### Alkenes (4)
hex-1-ene, hex-2-ene, hex-3-ene, propene

### Alcohols — open chain (2)
ethanol, propan-1-ol

### Aldehyde (1)
ethanal

### Amide (1)
hexanamide

### Ketones (3)
heptan-2-one, octan-3-one, octan-4-one

### Esters (3)
methyl butanoate, methyl methanoate, methyl octanoate

### Halogenoalkanes & aryl halides (13)
1-chlorobutane, 1-chloroheptane, 2-chlorobutane, 1-fluorohexane,
1-fluoropropane, 2-fluoropropane, fluoroethane, iodoethane, 1-iodopentane,
2-iodopentane, 2-iodopropane, 3-bromoheptane, 3-bromooctane

### Aromatics (4)
bromobenzene, chlorobenzene, pyridine, pyrrole

### iso- / tert-butyl substituent compounds (6)
iso-butyl benzene, iso-butyl bromide, iso-butyl chloride, iso-butyl methanoate,
tert-butyl benzene, tert-butyl methanoate

## Filename → expected path examples

| Molecule | Expected file |
|---|---|
| heptane | `public/images/structures/heptane.svg` |
| 2-methylheptane | `public/images/structures/2-methylheptane.svg` |
| iso-butyl chloride | `public/images/structures/iso-butyl_chloride.svg` |
| 1-chloroheptane | `public/images/structures/1-chloroheptane.svg` |
| octan-4-one | `public/images/structures/octan-4-one.svg` |

## Orphan SVGs in the folder (not used by v2)

42 files in `public/images/structures/` are not referenced by any v2 item.
These are v1 leftovers plus the 4 now-unused `sec-butyl_*` files. They are
harmless (the app only loads files it names) but can be deleted in a post-launch
cleanup pass. The 4 sec-butyl orphans specifically: `sec-butyl_benzene.svg`,
`sec-butyl_acetate.svg`, `sec-butyl_amine.svg`, `sec-butyl_mercaptan.svg`.

> Note: until the 54 missing files are drawn, real trials for those molecules
> show the `[Structure image not yet drawn: <name>]` fallback. The demo's
> skeletal picker sources its chain SVGs from `public/images/session0/chains/`,
> which is a separate set and already complete for the demo.
