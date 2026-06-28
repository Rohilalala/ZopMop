-- 114_seed_service_catalog_content.up.sql
-- Service Catalog Rework — STEP 2 of 4 (content seed), part 2: data.
--
-- Seeds per-service content for the 17 active services from the locked content
-- reference (zopmop-service-content.md), VERBATIM. Mapping:
--   hook              -> service_categories.short_description
--   description       -> service_categories.description
--   includes          -> service_includes (item, display_order)
--   does-not-include  -> service_excludes (item, display_order)
--   how-its-done      -> service_steps (step_number, title, description)
--   global FAQs (2)   -> faq_items (shared, once)
--   supplies FAQ      -> service_faqs (per service)
--   party price FAQ   -> service_faqs (override row on Pre and Post Party Clean)
-- Duration-logic text is intentionally NOT seeded (deferred to Step 4 UI).
-- No pricing/duration columns touched. No icons (Step 3).
--
-- Idempotent: re-running clears this migration's own seed first, then re-inserts.

BEGIN;

-- ── Idempotency: clear any prior run of this seed ─────────────────────────────
DELETE FROM service_includes WHERE service_id IN (
  'a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000005','a1000000-0000-0000-0000-000000000006','a1000000-0000-0000-0000-000000000007','a1000000-0000-0000-0000-000000000008',
  'a1000000-0000-0000-0000-000000000009','a1000000-0000-0000-0000-000000000010','a1000000-0000-0000-0000-000000000012','a1000000-0000-0000-0000-000000000014',
  'a1000000-0000-0000-0000-000000000018','a1000000-0000-0000-0000-000000000019','a1000000-0000-0000-0000-000000000020','a1000000-0000-0000-0000-000000000021',
  'a1000000-0000-0000-0000-000000000022');
DELETE FROM service_excludes WHERE service_id IN (
  'a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000005','a1000000-0000-0000-0000-000000000006','a1000000-0000-0000-0000-000000000007','a1000000-0000-0000-0000-000000000008',
  'a1000000-0000-0000-0000-000000000009','a1000000-0000-0000-0000-000000000010','a1000000-0000-0000-0000-000000000012','a1000000-0000-0000-0000-000000000014',
  'a1000000-0000-0000-0000-000000000018','a1000000-0000-0000-0000-000000000019','a1000000-0000-0000-0000-000000000020','a1000000-0000-0000-0000-000000000021',
  'a1000000-0000-0000-0000-000000000022');
DELETE FROM service_steps WHERE service_id IN (
  'a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000005','a1000000-0000-0000-0000-000000000006','a1000000-0000-0000-0000-000000000007','a1000000-0000-0000-0000-000000000008',
  'a1000000-0000-0000-0000-000000000009','a1000000-0000-0000-0000-000000000010','a1000000-0000-0000-0000-000000000012','a1000000-0000-0000-0000-000000000014',
  'a1000000-0000-0000-0000-000000000018','a1000000-0000-0000-0000-000000000019','a1000000-0000-0000-0000-000000000020','a1000000-0000-0000-0000-000000000021',
  'a1000000-0000-0000-0000-000000000022');
DELETE FROM service_faqs WHERE service_id IN (
  'a1000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','a1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000005','a1000000-0000-0000-0000-000000000006','a1000000-0000-0000-0000-000000000007','a1000000-0000-0000-0000-000000000008',
  'a1000000-0000-0000-0000-000000000009','a1000000-0000-0000-0000-000000000010','a1000000-0000-0000-0000-000000000012','a1000000-0000-0000-0000-000000000014',
  'a1000000-0000-0000-0000-000000000018','a1000000-0000-0000-0000-000000000019','a1000000-0000-0000-0000-000000000020','a1000000-0000-0000-0000-000000000021',
  'a1000000-0000-0000-0000-000000000022');
DELETE FROM faq_items WHERE question IN ('Are your pros safe to let in?','How is the price worked out?');

-- ── 1. Hook (short_description) + Description ─────────────────────────────────
UPDATE service_categories SET short_description='Spotless, sanitized, done right', description='Every surface that actually gets touched, handled properly, by a salaried ZopMop pro who shows up on time and leaves the place looking right.' WHERE id='a1000000-0000-0000-0000-000000000002';
UPDATE service_categories SET short_description='Dishes cleared, kitchen back to yours', description='Piled-up dishes, pots, and pans, all hand-washed and stacked back by a ZopMop pro. No counting heads, no per-item math, just a clean sink when it is done.' WHERE id='a1000000-0000-0000-0000-000000000003';
UPDATE service_categories SET short_description='Floors you can walk on barefoot', description='Every room swept and mopped by a ZopMop pro, dust and grime lifted off your floors so the place feels fresh underfoot.' WHERE id='a1000000-0000-0000-0000-000000000001';
UPDATE service_categories SET short_description='Surfaces clear, dust gone', description='Shelves, tables, and surfaces wiped free of dust by a ZopMop pro, so the settled layer on everything finally lifts off.' WHERE id='a1000000-0000-0000-0000-000000000004';
UPDATE service_categories SET short_description='Bags ready, nothing forgotten', description='A ZopMop pro helps pack your bags, folding and organising clothes and essentials so your luggage is sorted and ready to go.' WHERE id='a1000000-0000-0000-0000-000000000019';
UPDATE service_categories SET short_description='Bags emptied, things in place', description='A ZopMop pro empties your bags and puts things back where they belong, so you skip the pile of luggage waiting to be sorted.' WHERE id='a1000000-0000-0000-0000-000000000020';
UPDATE service_categories SET short_description='Creases out, clothes ready to wear', description='A ZopMop pro irons and folds your clothes, so the heap of wrinkled laundry turns into a neat, ready-to-wear stack.' WHERE id='a1000000-0000-0000-0000-000000000009';
UPDATE service_categories SET short_description='Washed, dried, sorted out', description='A ZopMop pro runs your laundry through the machine, then sorts and dries it, so the basket of dirty clothes gets handled start to finish.' WHERE id='a1000000-0000-0000-0000-000000000006';
UPDATE service_categories SET short_description='Chopped, prepped, ready to cook', description='A ZopMop pro handles the prep work, washing, peeling, and chopping vegetables and ingredients, so everything is ready when you start cooking.' WHERE id='a1000000-0000-0000-0000-000000000005';
UPDATE service_categories SET short_description='Clear glass, more light in', description='A ZopMop pro cleans your windows inside out, clearing the dust and smudges so the glass lets in more light.' WHERE id='a1000000-0000-0000-0000-000000000007';
UPDATE service_categories SET short_description='Counters clear, kitchen fresh', description='A ZopMop pro cleans your kitchen surfaces, wiping down counters, the stove, and sink so the everyday grease and grime is cleared.' WHERE id='a1000000-0000-0000-0000-000000000012';
UPDATE service_categories SET short_description='Balcony back to sitting-out clean', description='A ZopMop pro clears and cleans your balcony, sweeping out the dust and washing down the floor so it is ready to use again.' WHERE id='a1000000-0000-0000-0000-000000000010';
UPDATE service_categories SET short_description='Blades dust-free, air cleaner', description='A ZopMop pro cleans your fans, wiping the dust and grime off the blades so they run cleaner and stop spreading dust around.' WHERE id='a1000000-0000-0000-0000-000000000021';
UPDATE service_categories SET short_description='Shelves wiped, fridge fresh again', description='A ZopMop pro empties, wipes, and resets your fridge, clearing spills and odours so it is clean inside and out.' WHERE id='a1000000-0000-0000-0000-000000000008';
UPDATE service_categories SET short_description='Folded, sorted, easy to find', description='A ZopMop pro sorts and arranges your wardrobe, folding and grouping clothes so everything has its place and is easy to reach.' WHERE id='a1000000-0000-0000-0000-000000000014';
UPDATE service_categories SET short_description='Watered, wiped, looking healthy', description='A ZopMop pro tends to your plants, watering, wiping leaves, and clearing dead growth so your greens stay in good shape.' WHERE id='a1000000-0000-0000-0000-000000000018';
UPDATE service_categories SET short_description='Set up before, cleared up after', description='A ZopMop pro gets your place ready before guests arrive or clears the mess after they leave, so the party is the only thing you think about.' WHERE id='a1000000-0000-0000-0000-000000000022';

-- ── 2. Includes (ordered) ────────────────────────────────────────────────────
INSERT INTO service_includes (service_id, item, display_order) VALUES
-- Bathroom Cleaning
('a1000000-0000-0000-0000-000000000002','Cleans the mirror and glass, no smears left behind',1),
('a1000000-0000-0000-0000-000000000002','Wipes down the basin, tap, and surrounding ceramic',2),
('a1000000-0000-0000-0000-000000000002','Works through tiles at reachable height, no residue, no streaks',3),
('a1000000-0000-0000-0000-000000000002','Sanitizes the full toilet: bowl, rim, seat, and outer base',4),
('a1000000-0000-0000-0000-000000000002','Sweeps and mops the floor and leaves it dry',5),
('a1000000-0000-0000-0000-000000000002','Empties the dustbin on the way out',6),
-- Utensil Washing
('a1000000-0000-0000-0000-000000000003','Washes and rinses all plates, bowls, glasses, and cups',1),
('a1000000-0000-0000-0000-000000000003','Cleans pots, pans, and the pressure cooker',2),
('a1000000-0000-0000-0000-000000000003','Handles ladles, spoons, and the smaller utensils',3),
('a1000000-0000-0000-0000-000000000003','Dries and stacks everything where you want it',4),
('a1000000-0000-0000-0000-000000000003','Rinses and wipes the sink once the load is done',5),
-- Sweeping and Mopping
('a1000000-0000-0000-0000-000000000001','Sweeps all open floor space across rooms',1),
('a1000000-0000-0000-0000-000000000001','Mops hard floors until they dry clean',2),
('a1000000-0000-0000-0000-000000000001','Covers corners, edges, and under reachable furniture',3),
('a1000000-0000-0000-0000-000000000001','Clears the floor of loose dust and hair',4),
('a1000000-0000-0000-0000-000000000001','Tidies the area once the floor is done',5),
-- Dusting
('a1000000-0000-0000-0000-000000000004','Wipes down tables, shelves, and open surfaces',1),
('a1000000-0000-0000-0000-000000000004','Dusts furniture tops and reachable ledges',2),
('a1000000-0000-0000-0000-000000000004','Clears dust off electronics exteriors and decor',3),
('a1000000-0000-0000-0000-000000000004','Covers window sills and railings within reach',4),
('a1000000-0000-0000-0000-000000000004','Tidies surfaces once the dusting is done',5),
-- Packing
('a1000000-0000-0000-0000-000000000019','Folds and packs clothes neatly into bags',1),
('a1000000-0000-0000-0000-000000000019','Organises toiletries and essentials',2),
('a1000000-0000-0000-0000-000000000019','Groups items so they are easy to find',3),
('a1000000-0000-0000-0000-000000000019','Makes use of space to fit more in',4),
('a1000000-0000-0000-0000-000000000019','Keeps a packed bag tidy and zipped up',5),
-- Unpacking
('a1000000-0000-0000-0000-000000000020','Empties bags and sorts the contents',1),
('a1000000-0000-0000-0000-000000000020','Puts clothes away where you point them',2),
('a1000000-0000-0000-0000-000000000020','Returns toiletries and essentials to their spots',3),
('a1000000-0000-0000-0000-000000000020','Sets aside laundry separately',4),
('a1000000-0000-0000-0000-000000000020','Clears and folds up the empty bags',5),
-- Ironing and Folding
('a1000000-0000-0000-0000-000000000009','Irons shirts, trousers, and everyday wear',1),
('a1000000-0000-0000-0000-000000000009','Folds clothes into neat stacks',2),
('a1000000-0000-0000-0000-000000000009','Smooths out creases and wrinkles',3),
('a1000000-0000-0000-0000-000000000009','Hangs items that are better kept on hangers',4),
('a1000000-0000-0000-0000-000000000009','Groups folded clothes by type or person',5),
-- Laundry
('a1000000-0000-0000-0000-000000000006','Loads and runs the washing machine',1),
('a1000000-0000-0000-0000-000000000006','Separates lights and darks before washing',2),
('a1000000-0000-0000-0000-000000000006','Hangs or lays clothes out to dry',3),
('a1000000-0000-0000-0000-000000000006','Sorts dried clothes into stacks',4),
('a1000000-0000-0000-0000-000000000006','Sets aside anything that needs special care',5),
-- Kitchen Prep
('a1000000-0000-0000-0000-000000000005','Washes vegetables and ingredients',1),
('a1000000-0000-0000-0000-000000000005','Peels and chops as needed',2),
('a1000000-0000-0000-0000-000000000005','Measures out ingredients you set aside',3),
('a1000000-0000-0000-0000-000000000005','Sorts prepped items into bowls or containers',4),
('a1000000-0000-0000-0000-000000000005','Clears the prep area once done',5),
-- Window Cleaning
('a1000000-0000-0000-0000-000000000007','Cleans glass on the inside, streak-free',1),
('a1000000-0000-0000-0000-000000000007','Wipes reachable outer glass',2),
('a1000000-0000-0000-0000-000000000007','Clears window sills and ledges',3),
('a1000000-0000-0000-0000-000000000007','Wipes frames and grilles within reach',4),
('a1000000-0000-0000-0000-000000000007','Cleans glass on reachable sliding panels',5),
-- Kitchen Cleaning
('a1000000-0000-0000-0000-000000000012','Wipes down counters and backsplash',1),
('a1000000-0000-0000-0000-000000000012','Cleans the stove top and burners',2),
('a1000000-0000-0000-0000-000000000012','Scrubs and clears the sink',3),
('a1000000-0000-0000-0000-000000000012','Wipes the outer surfaces of cabinets and appliances',4),
('a1000000-0000-0000-0000-000000000012','Sweeps and mops the kitchen floor',5),
-- Balcony Cleaning
('a1000000-0000-0000-0000-000000000010','Sweeps out dust, leaves, and loose dirt',1),
('a1000000-0000-0000-0000-000000000010','Washes and scrubs the balcony floor',2),
('a1000000-0000-0000-0000-000000000010','Wipes the railing and grille',3),
('a1000000-0000-0000-0000-000000000010','Clears reachable ledges and sills',4),
('a1000000-0000-0000-0000-000000000010','Wipes down the balcony door glass',5),
-- Fan Cleaning
('a1000000-0000-0000-0000-000000000021','Wipes dust and grime off fan blades',1),
('a1000000-0000-0000-0000-000000000021','Cleans the top and sides of each blade',2),
('a1000000-0000-0000-0000-000000000021','Wipes the central mount within reach',3),
('a1000000-0000-0000-0000-000000000021','Covers ceiling and wall fans',4),
('a1000000-0000-0000-0000-000000000021','Clears fallen dust from below after',5),
-- Fridge Cleaning
('a1000000-0000-0000-0000-000000000008','Empties shelves and wipes them down',1),
('a1000000-0000-0000-0000-000000000008','Clears spills, crumbs, and sticky spots',2),
('a1000000-0000-0000-0000-000000000008','Wipes drawers, racks, and door pockets',3),
('a1000000-0000-0000-0000-000000000008','Cleans the outer body and handles',4),
('a1000000-0000-0000-0000-000000000008','Resets items back the way you had them',5),
-- Wardrobe Organization
('a1000000-0000-0000-0000-000000000014','Folds and stacks clothes neatly',1),
('a1000000-0000-0000-0000-000000000014','Groups items by type or how you use them',2),
('a1000000-0000-0000-0000-000000000014','Arranges shelves and hanging space',3),
('a1000000-0000-0000-0000-000000000014','Lines up smaller items like socks and accessories',4),
('a1000000-0000-0000-0000-000000000014','Sets aside anything for wash or ironing',5),
-- Plant Care
('a1000000-0000-0000-0000-000000000018','Waters plants as needed',1),
('a1000000-0000-0000-0000-000000000018','Wipes dust off leaves',2),
('a1000000-0000-0000-0000-000000000018','Clears dead leaves and trimmings',3),
('a1000000-0000-0000-0000-000000000018','Tidies pots and the surrounding area',4),
('a1000000-0000-0000-0000-000000000018','Flags any plant that looks unwell',5),
-- Pre and Post Party Clean
('a1000000-0000-0000-0000-000000000022','Tidies and arranges the space',1),
('a1000000-0000-0000-0000-000000000022','Clears tables, surfaces, and seating areas',2),
('a1000000-0000-0000-0000-000000000022','Washes party utensils and glassware',3),
('a1000000-0000-0000-0000-000000000022','Collects and bags the trash',4),
('a1000000-0000-0000-0000-000000000022','Sweeps and mops the main areas',5),
('a1000000-0000-0000-0000-000000000022','Resets the room once done',6);

-- ── 3. Does-not-include (ordered) ────────────────────────────────────────────
INSERT INTO service_excludes (service_id, item, display_order) VALUES
-- Bathroom Cleaning
('a1000000-0000-0000-0000-000000000002','Anything above arm''s reach: ceilings, exhaust vents, high windows',1),
('a1000000-0000-0000-0000-000000000002','Geyser, exhaust fan, or any electrical fitting',2),
('a1000000-0000-0000-0000-000000000002','Restoring discoloured tiles or grout to original colour',3),
('a1000000-0000-0000-0000-000000000002','Unclogging a slow drain or fixing a leaking tap',4),
-- Utensil Washing
('a1000000-0000-0000-0000-000000000003','Soaking and scraping burnt or charred vessels',1),
('a1000000-0000-0000-0000-000000000003','Cleaning mixers, grinders, or any electrical kitchen gear',2),
('a1000000-0000-0000-0000-000000000003','Wiping counters, stove, or backsplash',3),
('a1000000-0000-0000-0000-000000000003','Collecting dishes left in other rooms',4),
-- Sweeping and Mopping
('a1000000-0000-0000-0000-000000000001','Moving heavy furniture or appliances to clean under them',1),
('a1000000-0000-0000-0000-000000000001','Scrubbing stuck-on stains or paint marks off the floor',2),
('a1000000-0000-0000-0000-000000000001','Carpet, rug, or upholstery cleaning',3),
('a1000000-0000-0000-0000-000000000001','Polishing or waxing wooden floors',4),
('a1000000-0000-0000-0000-000000000001','Balcony or outdoor area floors',5),
-- Dusting
('a1000000-0000-0000-0000-000000000004','Anything above arm''s reach: ceilings, fans, high shelves',1),
('a1000000-0000-0000-0000-000000000004','Moving heavy items or pulling out furniture to dust behind',2),
('a1000000-0000-0000-0000-000000000004','Wiping interiors of cupboards or drawers',3),
('a1000000-0000-0000-0000-000000000004','Cleaning screens or delicate gadget surfaces',4),
('a1000000-0000-0000-0000-000000000004','Wet wiping or stain removal off surfaces',5),
-- Packing
('a1000000-0000-0000-0000-000000000019','Supplying bags, pouches, or packing cubes',1),
('a1000000-0000-0000-0000-000000000019','Packing valuables, jewellery, or documents',2),
('a1000000-0000-0000-0000-000000000019','Washing or ironing clothes before packing',3),
('a1000000-0000-0000-0000-000000000019','Carrying bags out of the home',4),
-- Unpacking
('a1000000-0000-0000-0000-000000000020','Washing, ironing, or folding laundry',1),
('a1000000-0000-0000-0000-000000000020','Deep cleaning or organising cupboards',2),
('a1000000-0000-0000-0000-000000000020','Putting away valuables, jewellery, or documents',3),
('a1000000-0000-0000-0000-000000000020','Carrying bags or boxes around the home',4),
('a1000000-0000-0000-0000-000000000020','Storing bags away in lofts or high storage',5),
-- Ironing and Folding
('a1000000-0000-0000-0000-000000000009','Washing or drying clothes before ironing',1),
('a1000000-0000-0000-0000-000000000009','Ironing delicate fabrics that need special care',2),
('a1000000-0000-0000-0000-000000000009','Steaming or pressing heavy formal wear like suits',3),
('a1000000-0000-0000-0000-000000000009','Putting clothes away inside cupboards',4),
('a1000000-0000-0000-0000-000000000009','Supplying an iron or ironing board',5),
-- Laundry
('a1000000-0000-0000-0000-000000000006','Ironing or folding into cupboards',1),
('a1000000-0000-0000-0000-000000000006','Hand-washing delicate or special-care fabrics',2),
('a1000000-0000-0000-0000-000000000006','Dry cleaning or stain treatment',3),
('a1000000-0000-0000-0000-000000000006','Supplying detergent or fabric softener',4),
('a1000000-0000-0000-0000-000000000006','Repairing or running a faulty machine',5),
-- Kitchen Prep
('a1000000-0000-0000-0000-000000000005','Cooking, frying, or any heat work',1),
('a1000000-0000-0000-0000-000000000005','Handling or cutting meat, fish, or poultry',2),
('a1000000-0000-0000-0000-000000000005','Grinding masalas or running appliances',3),
('a1000000-0000-0000-0000-000000000005','Deciding the menu or recipes',4),
('a1000000-0000-0000-0000-000000000005','Supplying ingredients or containers',5),
-- Window Cleaning
('a1000000-0000-0000-0000-000000000007','Anything beyond safe reach or needing ladders',1),
('a1000000-0000-0000-0000-000000000007','Exterior glass on higher floors from outside',2),
('a1000000-0000-0000-0000-000000000007','Removing or refitting window panels',3),
('a1000000-0000-0000-0000-000000000007','Repairing frames, hinges, or fittings',4),
('a1000000-0000-0000-0000-000000000007','Washing curtains, blinds, or mesh screens',5),
-- Kitchen Cleaning
('a1000000-0000-0000-0000-000000000012','Cleaning inside cabinets, fridge, or oven',1),
('a1000000-0000-0000-0000-000000000012','Degreasing the chimney or exhaust internals',2),
('a1000000-0000-0000-0000-000000000012','Washing utensils or dishes',3),
('a1000000-0000-0000-0000-000000000012','Moving heavy appliances to clean behind',4),
('a1000000-0000-0000-0000-000000000012','Removing tough grease that needs a deep clean',5),
-- Balcony Cleaning
('a1000000-0000-0000-0000-000000000010','Cleaning the outer face of the building or glass',1),
('a1000000-0000-0000-0000-000000000010','Moving heavy pots, furniture, or stored items',2),
('a1000000-0000-0000-0000-000000000010','Washing or repotting plants',3),
('a1000000-0000-0000-0000-000000000010','Anything beyond safe reach over the railing',4),
('a1000000-0000-0000-0000-000000000010','Clearing construction debris or large waste',5),
-- Fan Cleaning
('a1000000-0000-0000-0000-000000000021','Removing or dismantling the fan from its mount',1),
('a1000000-0000-0000-0000-000000000021','Cleaning internal motor parts or wiring',2),
('a1000000-0000-0000-0000-000000000021','Repairing or rebalancing a wobbling fan',3),
('a1000000-0000-0000-0000-000000000021','Exhaust fans set into walls or ceilings',4),
('a1000000-0000-0000-0000-000000000021','Working on fans beyond safe ladder reach',5),
-- Fridge Cleaning
('a1000000-0000-0000-0000-000000000008','Throwing out food without being told',1),
('a1000000-0000-0000-0000-000000000008','Defrosting a heavily iced freezer',2),
('a1000000-0000-0000-0000-000000000008','Cleaning the coils or rear mechanics',3),
('a1000000-0000-0000-0000-000000000008','Repairing or moving the fridge',4),
('a1000000-0000-0000-0000-000000000008','Restocking or grocery sorting',5),
-- Wardrobe Organization
('a1000000-0000-0000-0000-000000000014','Washing, ironing, or steaming clothes',1),
('a1000000-0000-0000-0000-000000000014','Deciding what to keep or throw out',2),
('a1000000-0000-0000-0000-000000000014','Deep cleaning the wardrobe interior',3),
('a1000000-0000-0000-0000-000000000014','Repairing shelves, rods, or fittings',4),
('a1000000-0000-0000-0000-000000000014','Handling valuables, jewellery, or documents',5),
-- Plant Care
('a1000000-0000-0000-0000-000000000018','Repotting or changing soil',1),
('a1000000-0000-0000-0000-000000000018','Pruning or trimming large branches',2),
('a1000000-0000-0000-0000-000000000018','Treating pests or applying chemicals',3),
('a1000000-0000-0000-0000-000000000018','Supplying pots, soil, or fertiliser',4),
('a1000000-0000-0000-0000-000000000018','Moving heavy planters around',5),
-- Pre and Post Party Clean
('a1000000-0000-0000-0000-000000000022','Cooking, serving, or handling food',1),
('a1000000-0000-0000-0000-000000000022','Moving heavy furniture or setups',2),
('a1000000-0000-0000-0000-000000000022','Deep cleaning carpets or upholstery',3),
('a1000000-0000-0000-0000-000000000022','Clearing outdoor or common-area mess',4);

-- ── 4. How it's done (ordered steps; title + body) ───────────────────────────
INSERT INTO service_steps (service_id, step_number, title, description) VALUES
-- Bathroom Cleaning
('a1000000-0000-0000-0000-000000000002',1,'Walk-through','Pro checks the space and flags anything already chipped or stained.'),
('a1000000-0000-0000-0000-000000000002',2,'Tiles and fittings','Tiles, mirror, and tap worked top to bottom.'),
('a1000000-0000-0000-0000-000000000002',3,'Washbasin and toilet','Basin wiped, then toilet bowl, rim, and seat sanitized.'),
('a1000000-0000-0000-0000-000000000002',4,'Finishing up','Floor mopped and left dry, dustbin emptied.'),
-- Utensil Washing
('a1000000-0000-0000-0000-000000000003',1,'Quick sort','Pro separates the more soiled items and checks where finished dishes go.'),
('a1000000-0000-0000-0000-000000000003',2,'Wash and rinse','Everything washed and rinsed clean.'),
('a1000000-0000-0000-0000-000000000003',3,'Dry and stack','Everything dried and placed back the way you like.'),
('a1000000-0000-0000-0000-000000000003',4,'Finishing up','Sink rinsed and wiped before wrap-up.'),
-- Sweeping and Mopping
('a1000000-0000-0000-0000-000000000001',1,'Quick scan','Pro checks the rooms and clears loose items off the floor.'),
('a1000000-0000-0000-0000-000000000001',2,'Sweep through','All floor space swept, corners and edges included.'),
('a1000000-0000-0000-0000-000000000001',3,'Mop down','Hard floors mopped and left to dry clean.'),
('a1000000-0000-0000-0000-000000000001',4,'Finishing up','Area tidied with a final look before wrap-up.'),
-- Dusting
('a1000000-0000-0000-0000-000000000004',1,'Quick scan','Pro looks over the rooms and notes the surfaces to cover.'),
('a1000000-0000-0000-0000-000000000004',2,'Working through','Shelves, ledges, and furniture tops dusted across the rooms.'),
('a1000000-0000-0000-0000-000000000004',3,'Surfaces and decor','Tables and decor wiped clear.'),
('a1000000-0000-0000-0000-000000000004',4,'Finishing up','Surfaces tidied with a final look before wrap-up.'),
-- Packing
('a1000000-0000-0000-0000-000000000019',1,'Quick scan','Pro looks over the items laid out for packing.'),
('a1000000-0000-0000-0000-000000000019',2,'Folding','Clothes folded and grouped as needed.'),
('a1000000-0000-0000-0000-000000000019',3,'Packing in','Items packed neatly with space used well.'),
('a1000000-0000-0000-0000-000000000019',4,'Finishing up','Bags zipped and set aside with a final check.'),
-- Unpacking
('a1000000-0000-0000-0000-000000000020',1,'Quick scan','Pro looks over the bags and checks where things go.'),
('a1000000-0000-0000-0000-000000000020',2,'Sorting','Contents taken out and grouped.'),
('a1000000-0000-0000-0000-000000000020',3,'Putting away','Items placed where you point them.'),
('a1000000-0000-0000-0000-000000000020',4,'Finishing up','Empty bags folded and set aside with a final check.'),
-- Ironing and Folding
('a1000000-0000-0000-0000-000000000009',1,'Quick scan','Pro looks over the clothes and sorts what gets ironed or folded.'),
('a1000000-0000-0000-0000-000000000009',2,'Ironing','Clothes ironed and creases smoothed out.'),
('a1000000-0000-0000-0000-000000000009',3,'Folding','Items folded into neat stacks.'),
('a1000000-0000-0000-0000-000000000009',4,'Finishing up','Clothes grouped and set aside with a final check.'),
-- Laundry
('a1000000-0000-0000-0000-000000000006',1,'Quick scan','Pro sorts the clothes and checks any care labels.'),
('a1000000-0000-0000-0000-000000000006',2,'Washing','Load run through the machine.'),
('a1000000-0000-0000-0000-000000000006',3,'Drying','Clothes hung or laid out to dry.'),
('a1000000-0000-0000-0000-000000000006',4,'Finishing up','Dried clothes sorted into stacks with a final check.'),
-- Kitchen Prep
('a1000000-0000-0000-0000-000000000005',1,'Quick scan','Pro checks the ingredients and how you want them prepped.'),
('a1000000-0000-0000-0000-000000000005',2,'Washing','Vegetables and ingredients rinsed clean.'),
('a1000000-0000-0000-0000-000000000005',3,'Chopping','Items peeled and chopped as needed.'),
('a1000000-0000-0000-0000-000000000005',4,'Finishing up','Prepped items sorted into bowls with the area cleared.'),
-- Window Cleaning
('a1000000-0000-0000-0000-000000000007',1,'Quick scan','Pro checks which windows are within safe reach.'),
('a1000000-0000-0000-0000-000000000007',2,'Glass','Inner and reachable outer glass cleaned.'),
('a1000000-0000-0000-0000-000000000007',3,'Frames and sills','Frames, grilles, and sills wiped down.'),
('a1000000-0000-0000-0000-000000000007',4,'Finishing up','Glass checked for streaks with a final look.'),
-- Kitchen Cleaning
('a1000000-0000-0000-0000-000000000012',1,'Quick scan','Pro looks over the kitchen and notes what needs cleaning.'),
('a1000000-0000-0000-0000-000000000012',2,'Surfaces','Counters, stove, and backsplash wiped down.'),
('a1000000-0000-0000-0000-000000000012',3,'Sink and cabinets','Sink cleared and outer cabinet surfaces wiped.'),
('a1000000-0000-0000-0000-000000000012',4,'Finishing up','Floor swept and mopped with a final look.'),
-- Balcony Cleaning
('a1000000-0000-0000-0000-000000000010',1,'Quick scan','Pro looks over the balcony and clears loose items aside.'),
('a1000000-0000-0000-0000-000000000010',2,'Sweeping','Dust, leaves, and dirt swept out.'),
('a1000000-0000-0000-0000-000000000010',3,'Washing','Floor washed and scrubbed, railing wiped.'),
('a1000000-0000-0000-0000-000000000010',4,'Finishing up','Floor left to dry with a final look.'),
-- Fan Cleaning
('a1000000-0000-0000-0000-000000000021',1,'Quick scan','Pro checks the fans and sets up safe reach.'),
('a1000000-0000-0000-0000-000000000021',2,'Blades','Dust and grime wiped off each blade.'),
('a1000000-0000-0000-0000-000000000021',3,'Mount','Central mount wiped within reach.'),
('a1000000-0000-0000-0000-000000000021',4,'Finishing up','Fallen dust cleared from below with a final look.'),
-- Fridge Cleaning
('a1000000-0000-0000-0000-000000000008',1,'Quick scan','Pro checks the fridge and confirms what stays in.'),
('a1000000-0000-0000-0000-000000000008',2,'Emptying','Shelves cleared and items set aside.'),
('a1000000-0000-0000-0000-000000000008',3,'Wiping','Shelves, drawers, and body wiped down.'),
('a1000000-0000-0000-0000-000000000008',4,'Finishing up','Items reset with a final look.'),
-- Wardrobe Organization
('a1000000-0000-0000-0000-000000000014',1,'Quick scan','Pro looks over the wardrobe and checks how you want it grouped.'),
('a1000000-0000-0000-0000-000000000014',2,'Sorting','Clothes sorted and grouped by type.'),
('a1000000-0000-0000-0000-000000000014',3,'Arranging','Items folded, stacked, and lined up neatly.'),
('a1000000-0000-0000-0000-000000000014',4,'Finishing up','Wardrobe set in order with a final look.'),
-- Plant Care
('a1000000-0000-0000-0000-000000000018',1,'Quick scan','Pro looks over the plants and checks watering needs.'),
('a1000000-0000-0000-0000-000000000018',2,'Watering','Plants watered as needed.'),
('a1000000-0000-0000-0000-000000000018',3,'Wiping','Leaves wiped and dead growth cleared.'),
('a1000000-0000-0000-0000-000000000018',4,'Finishing up','Pots and area tidied with a final look.'),
-- Pre and Post Party Clean
('a1000000-0000-0000-0000-000000000022',1,'Quick scan','Pro looks over the space and checks what needs doing.'),
('a1000000-0000-0000-0000-000000000022',2,'Clearing','Surfaces cleared, utensils washed, and trash collected.'),
('a1000000-0000-0000-0000-000000000022',3,'Cleaning','Main areas swept and mopped.'),
('a1000000-0000-0000-0000-000000000022',4,'Finishing up','Room reset and tidied with a final look.');

-- ── 5. Global FAQs (shared, in faq_items) ────────────────────────────────────
INSERT INTO faq_items (question, answer, category, display_order) VALUES
('Are your pros safe to let in?','Every ZopMop pro is formally trained and background-checked before their first job. If anything ever feels off, reach out and we will sort it out.','service',1),
('How is the price worked out?','Pricing is based on time. You pick the slot, 30, 60, or 90 minutes, and that is exactly what you pay for, with nothing added later.','service',2);

-- ── 6. Per-service FAQs (supplies + Pre/Post Party price override) ────────────
INSERT INTO service_faqs (service_id, question, answer, display_order) VALUES
('a1000000-0000-0000-0000-000000000002','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep the basics like a broom, mop, and detergent handy.',1),
('a1000000-0000-0000-0000-000000000003','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep the basics like dish soap and a scrubber handy.',1),
('a1000000-0000-0000-0000-000000000001','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep the basics like a broom, mop, and floor cleaner handy.',1),
('a1000000-0000-0000-0000-000000000004','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep the basics like a dusting cloth and surface cleaner handy.',1),
('a1000000-0000-0000-0000-000000000019','Do I need to provide any supplies?','Yes, your pro uses your materials, so keep your bags and any pouches handy before the slot.',1),
('a1000000-0000-0000-0000-000000000020','Do I need to provide any supplies?','No supplies needed for this one, just point your pro to where things should go.',1),
('a1000000-0000-0000-0000-000000000009','Do I need to provide any supplies?','Yes, your pro uses your equipment, so keep the iron and ironing board handy before the slot.',1),
('a1000000-0000-0000-0000-000000000006','Do I need to provide any supplies?','Yes, your pro uses your machine and materials, so keep detergent and softener handy before the slot.',1),
('a1000000-0000-0000-0000-000000000005','Do I need to provide any supplies?','Yes, your pro uses your kitchen, so keep the ingredients and a knife and board handy before the slot.',1),
('a1000000-0000-0000-0000-000000000007','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep a glass cleaner and cloth handy before the slot.',1),
('a1000000-0000-0000-0000-000000000012','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep a surface cleaner, cloth, and floor cleaner handy before the slot.',1),
('a1000000-0000-0000-0000-000000000010','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep a broom, brush, and floor cleaner handy before the slot.',1),
('a1000000-0000-0000-0000-000000000021','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep a cloth, surface cleaner, and a sturdy stool or ladder handy before the slot.',1),
('a1000000-0000-0000-0000-000000000008','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep a cloth and a mild cleaner handy before the slot.',1),
('a1000000-0000-0000-0000-000000000014','Do I need to provide any supplies?','No supplies needed for this one, just point your pro to the wardrobe and how you like things grouped.',1),
('a1000000-0000-0000-0000-000000000018','Do I need to provide any supplies?','Yes, your pro uses your materials, so keep a watering can and a cloth handy before the slot.',1),
('a1000000-0000-0000-0000-000000000022','Do I need to provide any supplies?','Yes, your pro uses your cleaning materials, so keep a broom, mop, floor cleaner, dish soap, and trash bags handy before the slot.',1),
-- Pre and Post Party Clean: price FAQ override (fixed 90-minute slot)
('a1000000-0000-0000-0000-000000000022','How is the price worked out?','Pricing is for a fixed 90-minute slot, and that is exactly what you pay for, with nothing added later.',2);

COMMIT;
