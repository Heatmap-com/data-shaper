# Hero CTA, FAQ questions, and a replay that skips finished queries

Two repos. The naming bot is `/Users/kennpalm/source/heatmap/cnn-ai-bot`. The analyzer is this repo. Do this work on DVF only: idsite `5795`, page `https://dvf.com`, batch `9bbe0ed1-184c-469a-9f56-cae8426b94c2`. Do not bump `TAXONOMY_VERSION`. Do not raise bot-draft confidence. Do not analyze any other site.

The bot writes human names. The analyzer's `mapNameRows` turns those names into `hero_cta` and `faq_item`. Strategies read the class ids. Kimi names only the selectors the harvest missed that are still on the page (13 on the last seed). The hero control and the FAQ strings are already in the harvest, so a Kimi-prompt change by itself does not fix the stored analysis.

## What DVF already has

The hero control is the anchor `main#MainContent > div:nth-child(1) > div > div > a`, named `Collection Button Hero Banner new`, with `rollup: true`. `mapNameRows` skips every rollup, and the `hero_cta` rule also requires the name to start with `hero`. The children are `Section - Hero Banner…` and `Hero image`. `Hero image` is the picture and stays unnamed.

`Button - Shop Now` is `button#md-btn__form__onSubmit`, the country-modal submit. It stays a button.

The FAQ strings are `Footer FAQ Link`, `Footer Link - DVF Insider FAQs`, `Accordion Footer Menu - Help & FAQ`, and `Nav Link - Help & FAQ`. Those are links to an FAQ page and a footer disclosure. This homepage has no question node. `faq_item` is one question that is its own control. Those links stay links, and strategy P2 stays blocked on this page. That is the correct result.

The first render section is typed `other` because its heading is "Signature Styles, Refreshed for Fall" and `typeSectionForHeading` only matches the word `hero`.

`ae_dataset_row` is `ReplacingMergeTree(generated_at)` ordered by `(batch_id, idsite, idsitehsr, dataset_id, row_key)`. `rowKey` in `src/adapters/_lib/rows.js` hashes every dim, including `element_class`. A class change is a new key, so the old row remains until that dataset's rows for this batch and site are deleted. Fact-table scans are not required for that delete.

`toAeDatasetRows` never sets `dimElementClass`, so the `dim_element_class` column is empty and `kind-fleet-weekly` reads a blank class even when the in-memory dim was set. The class that strategy-triggers used during the last run lives in `dim_extra`.

## Rules the code has to keep

- A link or button that is the primary control of the first banner is `hero_cta`. On this page that is `Collection Button Hero Banner new` on the anchor above, including while `rollup` is still true, because that flag marks the banner group and the anchor is the control.
- `Hero image` and the `Section - Hero Banner…` wrappers stay unnamed.
- `Button - Shop Now` on `button#md-btn__form__onSubmit` stays unnamed as `hero_cta`.
- `faq_item` is a single question node: a name `FAQ Question - …`, or a question mark on a node inside an FAQ block. A footer or nav link whose text contains "FAQ" stays a link.
- An image, a section wrapper, and a rollup container that is not itself an `a` or `button` stay unnamed.

## Bot (`cnn-ai-bot`)

1. **Kimi prompt** — `src/domain/kimiNamingPrompt.ts`. Add two prefixes next to the ones it already lists:
   - `Hero CTA - ` for the primary control of the first banner (the link or button a visitor clicks, not the image and not a country-modal submit).
   - `FAQ Question - ` for one question that is its own node.
   Keep `Button - `, `Mobile Menu Item - `, `Nav Link - `, `Header `, and `Image - ` for everything else. The prompt already forbids inventing a control that is not on the card.

2. **Writer stamp** — `src/adapters/writer/writerSystemPrompt.ts` already lists `FAQ Question - `. Add `Hero CTA - ` for that same primary banner control, and state that the anchor is the control: `data-hm-rollup` stays on the section wrapper, not on the `a` or `button` the visitor clicks. The harvest copies `data-hm-rollup` into `NameRow.rollup`.

3. **Section type** — `src/domain/renderArtifact.ts`, `typeSectionForHeading`. A heading that does not contain "hero" stays `other` when that is all the scan can see. The render pass that builds sections (`src/adapters/playwright/renderDataInPage.ts` and the caller that assigns `type`) types the first content section `hero` when that section is the full-bleed banner: one primary link or button, above the fold, not the header. A heading that contains "faq" or "frequently asked" is already `faq_block`. Do not type a footer disclosure `faq_block` because its label says Help & FAQ.

4. **Tests.** Prompt text includes both prefixes and still forbids invented controls. `typeSectionForHeading("Signature Styles, Refreshed for Fall")` stays `other`. The first-banner rule, given a first-section fixture with one link, returns `hero`. A footer "Help & FAQ" disclosure stays `other`.

The on-disk harvest at `dataset/5795/landing/index/` is the input for the analyzer's first replay. Do not re-seed until the bot tests pass. One seed after that refreshes `names.json`, both `render.<device>.json` files, and the section type. `bin/seed-named-page.sh` stays one invocation, desktop and mobile, no device flag.

## Analyzer (this repo)

1. **Mapper** — `src/naming-mapper.js`, `classify`. Apply the rules in the section above. A rollup row whose selector's terminal tag is `a` or `button`, and whose name marks the hero banner (`hero` together with `button` or `banner`), is `hero_cta`. Every other rollup stays skipped. `faq_item` stays the question rule already in `classify`. Add cases to the naming-mapper tests for the three DVF rows: the hero anchor, the country-modal button, and `Footer FAQ Link`.

2. **Write the class column** — `toAeDatasetRows` in `src/runner-ae.js` sets `dimElementClass` from `dims.element_class`. `kind-fleet-weekly` then reads the class it already selects.

3. **Stable grain** — `rowKey` hashes dims with `element_class` and `element_id` removed, so a later class change replaces the same click cell. `element-binding` rows keep the class in the key: one row per selector and class is the grain of that dataset.

4. **Replay** — `node src/cli.js --replay --batch 9bbe0ed1-184c-469a-9f56-cae8426b94c2 --sites 5795`. It does not claim `ae_site_queue`, does not qualify, and does not scan fact tables. An analyzed site stays analyzable. The flag loads `ae_dataset_row_current` for that batch and site, rebuilds `dims` from the promoted columns plus `dim_extra`, and runs only the lists below.

   **Leave stored, and load them for anything that reads them.** These queries already succeeded:

   `ad-creative`, `campaign-coverage`, `campaign-weekly`, `coverage`, `custom-event-inventory`, `dwell-model-inputs`, `entry-by-channel`, `experiments-weekly`, `exposure-weekly`, `forms-weekly`, `funnel-sequence-weekly`, `journey-weekly`, `line-items`, `order-value-hist`, `page-country`, `page-segment-weekly`, `page-speed`, `recordings-sample`, `returning-history`, `saliency`, `scroll-decile`, `sister-pages`, `site-baselines`, `tap-geometry-weekly`, `template-weekly`, `tool-registry`, `trigger-chains`, `viewport-weekly`.

   **Restamp, no fact scan.** Read the stored rows, set `dims.element_class` from `ae_element_binding_current` by exact selector, recompute `row_key` under the new hash, and write them back:

   `selector-weekly`, `rage-clicks`, `nav-next-page`.

   **Collect again.** These read bindings, render nodes, or the datasets above. They do not scan `log_*` or `udp_*`:

   `element-binding`, `render-snapshot`, `strategy-triggers`, `descriptor-snapshot`, `structural-screen`, `kind-fleet-weekly`, `requirement-status`, `bot-draft`, and every `cards-*` adapter.

   Before writing a restamped or recollected dataset, delete that dataset's rows for this batch and site (`ALTER TABLE … DELETE` scoped to `batch_id`, `idsite`, and `dataset_id`). The old `row_key` values include `element_class`, so a replace cannot see them. Leave every dataset in the first list untouched. Then write page analysis, site analysis, requirement status, and cards the same way the runner already does, so descriptor status and card state move with the new classes.

   A dataset id passed to `--replay` that is not in these lists is refused. The default is the restamp list plus the collect-again list.

5. **Tests.** Memory-persistence replay: a stored `selector-weekly` row with `element_class: ""` becomes `hero_cta` after the binding exists, the click metrics are unchanged, and a `journey-weekly` row is not collected again. Mapper tests from step 1. `dim_element_class` is populated on write.

## Run order

Inner loop, after the analyzer changes and before the bot seed. This proves the hero class from the harvest already on disk.

```bash
# bot tests (prompt + section rule), from cnn-ai-bot
pnpm test -- src/domain/kimiNamingPrompt src/domain/renderArtifact

# analyzer tests, from this repo
npx vitest run test/naming-mapper.test.js test/replay.test.js
```

The naming-mapper test file name follows whatever the suite already uses; add the cases there if the file has a different name.

```bash
# re-read the existing artifacts with the new mapper. Do not launch the bot.
cd /Users/kennpalm/work/analysis-engine
NAMING_COMMAND= TELEMETRY=0 node src/cli.js --capture --agents 1 \
  --site-source static-idsites --sites 5795

TELEMETRY=0 node src/cli.js --replay \
  --batch 9bbe0ed1-184c-469a-9f56-cae8426b94c2 --sites 5795
```

`--capture` still needs `--site-source`. `enqueueCapture` does nothing when a row already exists, so insert a newer `ae_capture_queue` row for 5795 with `status = queued`, `want = ['naming','render']`, `device_classes = ['desktop','mobile']`, and `generated_at = now()` before that capture. The consumer harvests names with an empty command and reads the render files already on disk.

Check after this pass: the hero anchor is bound as `hero_cta`; `Footer FAQ Link` is not `faq_item`; `Button - Shop Now` is not `hero_cta`; strategy rows B4 and B5 are no longer `blocked` for lack of `hero_cta` (they may be `silent` or `below_floor`); P2 is still `blocked`. `journey-weekly` and the other kept datasets have the same `generated_at` as before the replay.

Outer loop, once, after the bot changes pass their tests. One seed, then the same capture import and the same replay. No second `--run`.

```bash
cd /Users/kennpalm/source/heatmap/cnn-ai-bot
# the seed command already used for this page: both devices, require file, catalog
# bin/seed-named-page.sh does not take a device flag

cd /Users/kennpalm/work/analysis-engine
# new queued capture row, then:
NAMING_COMMAND= TELEMETRY=0 node src/cli.js --capture --agents 1 \
  --site-source static-idsites --sites 5795
TELEMETRY=0 node src/cli.js --replay \
  --batch 9bbe0ed1-184c-469a-9f56-cae8426b94c2 --sites 5795
```

After the seed, the first content section is `hero` on both devices. P2 stays blocked unless the seed found a real question node. If it did, that node is `faq_item` and P2 can leave `blocked`.

## Done when

- Mapper tests cover the hero anchor, the country-modal button, and the footer FAQ link.
- Replay tests show a kept dataset is not collected and a class-stamped click row changes class without a new click count.
- The stored binding for the hero anchor is `hero_cta`.
- No binding for this page is `faq_item` unless a question node was actually named.
- B4/B5 are not blocked on a missing `hero_cta` class.
- The fact-table datasets listed above still have their pre-replay `generated_at`.
