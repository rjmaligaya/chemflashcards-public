# DESIGN_PLAN.md

The visual system for ChemFlashcards v2. Captured 2026-05-23 from RJ's
references (Almond/Matcha/Forest/Eclipse palette, "Anatomy of a Strong
Homepage" diagram, Duolingo-style learning-tool warmth without the
gamification). This file is the authoritative record so future sessions
do not re-litigate the choices.

---

## Direction

Clean academic / research instrument. Warm rather than clinical. Reads
as a thoughtful study tool, not a quiz app and not a hospital form.
Colours come from RJ's reference palette so the green hints at organic
chemistry without being literal.

Hints from Duolingo that we are borrowing: chunky touch-friendly button
proportions, generous card padding, friendly sans typography,
celebratory micro-animations for correct answers. Lessons we are
leaving behind: gamification, mascot, neon saturation, points.

Hints from the homepage-anatomy diagram (public landing only):
logo + simple nav, hero with one stand-out CTA, social proof, about,
three key-feature tiles, secondary lead CTA, content, footer. The
stand-out CTA uses the amber-tuned colour.

---

## Palette

| Role | Light theme | Dark theme | Reference |
|---|---|---|---|
| Page background | Pale cream `#FBF6EA` | Eclipse `#1A3636` | Lighter than Almond |
| Surface (card) | Soft cream `#F5EBD9` | Forest Roast `#40534C` | Almond-tinted |
| Surface elevated | Almond `#D6BD98` (sparingly) | Forest Roast lighter `#4F6660` | |
| Border | Warm tan `#E5D5B8` | Forest tinted `#2A4039` | |
| Border emphatic | Almond `#C9A878` | Matcha tinted `#3D5247` | |
| Text primary | Eclipse `#1A3636` | Warm cream `#E8DDC7` | |
| Text muted | Forest tone `#5E7268` | Sage `#8AA092` | |
| Accent primary | Matcha Brew `#677D6A` | Lifted Matcha `#8AA68D` | |
| Accent hover | Forest Roast `#40534C` | Pale sage `#A5BE9F` | |
| Accent soft fill | Sage tint `#DFE5DA` | Deep forest `#2A3D36` | |
| Stand-out CTA (amber) | Honey `#B9893E` | Honey lifted `#D6A659` | Tuned to palette |
| Success | Warm green `#5E9A55` | Warm green `#7DBA72` | Different from accent |
| Error | Terracotta `#B54A3A` | Coral `#D17765` | Warm, not safety-red |
| Warning | Amber `#C69449` | Amber `#DBAE6E` | |

Pill backgrounds use the matching dim tones.

---

## Typography

| Token | Light | Dark | Notes |
|---|---|---|---|
| Font family | Sora (existing) | Sora | Sans-serif throughout |
| Mono family | IBM Plex Mono | IBM Plex Mono | Trial timer, PID display |
| Scale | 12, 14, 16, 18, 20, 24, 32, 40 px | same | 4-px grid |
| Body line height | 1.6 | 1.6 | Generous, readable |
| Heading line height | 1.2 | 1.2 | Tight |
| Weights | 400, 500, 600, 700 | same | |
| Numerals | Tabular for timer / PID | same | `font-variant-numeric: tabular-nums` |

Body sets at 16px (1rem). Trial prompt text uses 20px so the underline
blank reads at a comfortable distance. The timer uses mono.

---

## Spacing, radius, shadow, motion

| Token | Value | Use |
|---|---|---|
| `--space-3xs` | 2px | hairline gaps |
| `--space-2xs` | 4px | base unit |
| `--space-xs`  | 8px | tight gaps |
| `--space-sm`  | 12px | small padding |
| `--space-md`  | 16px | default padding |
| `--space-lg`  | 24px | card padding |
| `--space-xl`  | 32px | section padding |
| `--space-2xl` | 48px | page padding |
| `--space-3xl` | 64px | hero padding |
| `--radius-sm` | 8px | inputs, small chips |
| `--radius-md` | 14px | buttons, default cards |
| `--radius-lg` | 20px | hero, large cards |
| `--radius-pill` | 999px | pill badges |
| `--shadow-sm` | very light | resting cards |
| `--shadow-md` | moderate | hover state, primary buttons |
| `--shadow-lg` | strong | floating elements (rarely) |
| `--dur-fast` | 150ms | micro-interactions |
| `--dur-med`  | 200ms | state changes |
| `--dur-slow` | 300ms | page-level transitions |
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.3, 1)` | standard easing |
| `--ease-bounce` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | celebration |

Motion respects `prefers-reduced-motion`. All keyframe animations gate
on that media query.

---

## Components

### Buttons

Three resting variants plus modifiers.

- `.btn--primary`: solid Matcha fill, cream text on light, Eclipse text
  on dark. The default action.
- `.btn--ghost`: transparent with border. Secondary actions.
- `.btn--amber`: stand-out honey colour. The "Participants click here"
  CTA on the landing page. Used at most twice per page.
- Modifiers: `.btn--lg` (48px tall, larger padding), `.btn--sm` (32px
  tall), `.btn--full` (100% width).

States:
- Hover: lifts 1px, shadow strengthens, accent darkens to Forest Roast.
- Active: settles back, shadow softens, slight scale shrink.
- Focus visible (keyboard): 3px outline ring in Matcha at 30% opacity,
  2px offset so the ring never crops to the button edge.
- Disabled: opacity 0.4, no pointer events.

Existing `.popping` and `.shaking` animations stay; they fire on submit
success and failure inside the trial UI.

### Cards (Stage 2)

Soft cream background, 1px warm-tan border, soft small shadow. Generous
internal padding (`--space-lg`). Hover state for interactive cards
lifts 2px and strengthens shadow.

### Inputs (Stage 2)

Cream background, tan border, focus state matches the button focus
ring. Larger touch targets (44px minimum height).

### Trial UI (Stage 3)

Structure image: larger, centred, soft border, gentle shadow. Prompt
text: 20px with mono accents for the blank underscore region. Submit
button: dominant primary, full-width on mobile. Feedback panel: slides
in from below 4px, fades in over 200ms.

### Interstitials (Stage 4)

The Day-4 break countdown uses the same card shape. Mono timer in
Matcha. The "Continue" button only enables when the timer reaches
zero. The body text uses the standard prose styles.

---

## Stages

| Stage | Scope | Estimate |
|---|---|---|
| 1 (in progress) | Tokens + buttons + DESIGN_PLAN.md | ~1 hour |
| 2 | Cards, inputs, typography rhythm, landing pages | ~3 hours |
| 3 | Trial UI (TRIAL_CARD_HTML, feedback panel, summary card) | ~3 hours |
| 4 | Interstitials, admin, responsive sweep, accessibility check | ~2 hours |

Each stage is checked in by RJ before the next starts.

---

## Constraints respected

- No changes to data-collection logic. Tokens and CSS only; HTML class
  names change only where necessary to apply new components.
- Existing token names (`--color-accent`, `--color-text`, etc.) keep
  their identity so the rest of the codebase that already uses them
  continues to work. The values change; the names do not.
- Accessibility: 4.5:1 contrast minimum on text against backgrounds.
  Focus rings always visible for keyboard users. Touch targets ≥ 44px.
- Reduced motion: every animation block respects
  `prefers-reduced-motion: reduce`.
- Dark theme parity: every new token defined in both themes.

---

## Decisions deferred

- Whether to add a serif accent font for hero headlines. Currently
  sticking with Sora only per RJ's "sans throughout" answer. Revisit
  in Stage 2 if the hero feels flat.
- Whether to overhaul the trial timer presentation. Mono in Matcha is
  the Stage 1 default; if it reads as too restrained in Stage 3 we may
  size it up or add a circular-progress ring around it.
- The bento layout pattern. Set aside because RJ's chosen style is
  "academic instrument," not "Apple bento grid." Revisit only if
  Stage 2 reveals a card-layout need that bento solves better.
