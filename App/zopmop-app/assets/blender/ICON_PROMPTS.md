# ZopMop Service Icon Set — Design System & Per-Icon Prompts

Goal: one consistent, professional 3D icon family for all 18 services.
Built in Blender (clay/soft-plastic look), rendered transparent, must read
crisply on BOTH light (`#FAF8F2` cream) and dark (`#0D0D0F` ink) app themes.

## Design System (applies to every icon)

**Composition**
- One HERO prop (instantly identifies the service) + max 2 supporting props.
- Everything sits on the same rounded squircle base tile (2.9 × 2.9, h 0.34,
  corner radius ~0.5) — the family signature.
- Subject fills ~70% of frame. Fixed camera: azimuth 18°, elevation 24°,
  80mm lens. Identical soft 3-point studio light. No scene-to-scene drift.

**Material language**
- Soft matte clay (roughness 0.5–0.65), generous bevels, no hard edges.
- One subtle metallic or glass accent allowed per icon, never more.

**Color tokens (mid-tones only — no pure white, no black; every token
tested to hold contrast on cream AND ink backgrounds)**

| Token | Hex | Use |
|---|---|---|
| `tile` | #D8DCE4 | base squircle, every icon |
| `surface` | #ECE9E1 | "white" objects (appliances, ceramics) |
| `indigo` | #4F46E5 | brand hero accents |
| `indigo-soft` | #818CF8 | secondary brand surfaces |
| `indigo-pale` | #C7D2FE | tertiary fills |
| `amber` | #F5A300 | brand warm accent (1 touch per icon) |
| `amber-soft` | #FFC042 | warm highlights |
| `slate` | #3F4756 | dark elements (replaces black) |
| `slate-soft` | #8E99AB | mid neutrals, metals base |
| `teal` | #4FB3A5 | water / freshness |
| `green` | #5FA85F | plants |
| `terracotta` | #C96F4A | pots, warm props |
| `wood` | #C89A6B | wooden props |
| `blue-soft` | #7FA7D9 | textiles |

**Brand discipline**: every icon carries ≥1 indigo touch and ≥1 amber touch
(handle, button, cloth trim, bristle band…) so the set reads as one family.

## Per-Icon Prompts

1. **mopping-and-sweeping** — Hero: indigo flat-mop, pole leaning at 15°,
   amber pad-trim. Support: teal bucket with rolled cloth. Floor-shine arc on tile.
2. **dusting** — Hero: feather duster with indigo handle, amber band, fluffy
   slate-soft head, held at jaunty 30°. Support: two soft dust puffs.
3. **bathroom-cleaning** — Hero: surface-white toilet, compact. Support: indigo
   scrub brush leaning on it, amber spray bottle.
4. **kitchen-cleaning** — Hero: stove hob (surface) with two slate burners.
   Support: amber spray bottle, indigo cloth folded on corner.
5. **kitchen-prep** — Hero: wood cutting board, knife with slate handle.
   Support: green cucumber + amber carrot. (Food = natural colors.)
6. **utensils** — Hero: stack of 3 surface plates. Support: indigo cup holding
   metal spoon+fork, amber sponge.
7. **laundry** — Hero: surface washing machine, indigo door ring, amber dial.
   Support: blue-soft folded towel on top, 2 bubbles.
8. **ironing-and-folding** — Hero: surface iron with indigo heel + amber dial
   on blue-soft folded shirt stack. Support: 2 steam puffs.
9. **wardrobe-organization** — Hero: indigo-soft open wardrobe cube. Support:
   folded stacks (blue-soft / amber-soft / surface) on shelves.
10. **window-cleaning** — Hero: slate window frame, teal-tint glass with shine
    streak. Support: indigo squeegee with amber grip band.
11. **balcony** — Hero: slate railing on raised step. Support: terracotta
    potted green plant, indigo hand-broom with amber bristles.
12. **fan-cleaning** — Hero: slate 3-blade ceiling fan tilted toward camera.
    Support: indigo long-pole duster with amber band, cloth on one blade.
13. **fridge-cleaning** — Hero: surface fridge, top door open showing indigo-pale
    interior shelves. Support: amber cloth over door edge.
14. **car-cleaning** — Hero: indigo-soft hatchback, slate wheels, amber
    headlight. Support: amber sponge with foam cluster.
15. **plant-care** — Hero: terracotta pot, lush green plant. Support: indigo
    watering can with amber spout-rose.
16. **packing** — Hero: indigo-soft open suitcase, slate trim, amber handle.
    Support: folded clothes (blue-soft + surface) inside.
17. **unpacking** — Same suitcase empty + lid towel; folded stack beside on
    tile. Mirror composition of packing (pair icons).
18. **pre-post-party** — Hero: amber confetti-popper cone firing indigo +
    amber + teal confetti. Support: indigo hand-broom sweeping 3 fallen
    confetti pieces. (Reads "party mess handled".)
