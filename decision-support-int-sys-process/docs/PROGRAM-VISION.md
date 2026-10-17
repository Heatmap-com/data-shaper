# Decision Support Intelligence Platform (DSIP) — Program Vision

**Status:** program vision, version 1
**Date:** 14 October 2026
**Owner:** Heatmap enterprise data program
**Scope:** the whole program. That means the data transformation engine (the Analysis Engine), the Hypothesis Builder, and the single interface where merchants and ecommerce professionals meet both.
**How to read this document:** it stands alone. Every term is defined where it first appears and again in the glossary (§19). The worked example in §4 runs through the whole document. §18 lists the questions this vision raises for outside research.

---

## Contents

1. [Executive summary](#1-executive-summary)
2. [The thesis: ecommerce is a cognitive discipline](#2-the-thesis-ecommerce-is-a-cognitive-discipline)
3. [Context: Heatmap, its data, and its users](#3-context-heatmap-its-data-and-its-users)
4. [The worked example: the steady line that hides a leak](#4-the-worked-example-the-steady-line-that-hides-a-leak)
5. [Why "why did my results change?" is hard](#5-why-why-did-my-results-change-is-hard)
6. [The analysis journey today: the human](#6-the-analysis-journey-today-the-human)
7. [The analysis journey today: the AI](#7-the-analysis-journey-today-the-ai)
8. [Human and AI compared: one bottleneck, two failure modes](#8-human-and-ai-compared-one-bottleneck-two-failure-modes)
9. [The program: two systems, one interface](#9-the-program-two-systems-one-interface)
10. [Vision: the data transformation engine](#10-vision-the-data-transformation-engine)
11. [Vision: time series snapshots with segmentation](#11-vision-time-series-snapshots-with-segmentation)
12. [Vision: the Hypothesis Builder](#12-vision-the-hypothesis-builder)
13. [Vision: the single interface](#13-vision-the-single-interface)
14. [The worked example, revisited with DSIP](#14-the-worked-example-revisited-with-dsip)
15. [The second dividend: discarding dead ends](#15-the-second-dividend-discarding-dead-ends)
16. [Principles and limits](#16-principles-and-limits)
17. [Where it stands, roadmap, and measures of success](#17-where-it-stands-roadmap-and-measures-of-success)
18. [Questions for research](#18-questions-for-research)
19. [Glossary](#19-glossary)
20. [Appendix A: the worked example's numbers](#appendix-a-the-worked-examples-numbers)
21. [Appendix B: counting the manual iterations](#appendix-b-counting-the-manual-iterations)

---

## 1. Executive summary

Ecommerce results move for many reasons at once. A merchant who asks "why did my results change?" faces several problems at the same time:

- confounding factors;
- interactions between them;
- shifts in traffic mix;
- seasonality;
- a team that changed three things in the same week.

The data that holds the answer exists. Heatmap records page views, clicks, scroll depth, element-level revenue, campaign tags and orders for every session. The data does not exist in the *shape* of the question.

Every time series a person or an AI wants has to be assembled from raw events, one filtered query at a time. Each query is slow, and each one costs warehouse compute. The person or AI is left waiting, copying values, and repeating.

The Decision Support Intelligence Platform (DSIP) changes the shape of the data before anyone asks. It has two systems behind one interface.

1. **The data transformation engine** turns raw behavioral logs into **time series snapshots with segmentation**. These are stored, checked rows: one per subject, per segment, per week. A subject is a journey, a page, or a key interface element. A segment is a traffic source, a device, new against returning visitors, and so on. Routine transformations run every week for every site. New questions become new snapshots through declarations and single files, built by an agent and accepted only when the engine's own checks pass.
2. **The Hypothesis Builder** turns a merchant's question into hypotheses that can be falsified. It compares them against what the engine already knows and finds the gaps. It plans the data shaping needed to fill those gaps, and it drives the build. It answers only from stored, cited evidence. The human frames the question, rates the hypotheses, approves the analysis, and makes the decision.

**The interface** offers two things:

- **quick tabular views of time series data**, which appear instantly because the rows are already stored;
- **AI-friendly data you can talk to**. This is compact, labeled, partitioned, cited data that an AI can reason over without drowning in raw analytics, and without waiting on expensive synchronous queries.

The program rests on a claim about people. **DSIP does not replace the human in ecommerce, and no system can.** Success in ecommerce takes cognitive engagement:

- context that lives outside the data;
- judgment between competing goals;
- the creativity of the fix;
- accountability for the decision.

DSIP removes the clerical work that consumes the human's attention today: the filter, wait, capture and repeat. Attention goes back to thinking.

The program pays two dividends. It cuts the time and effort to **find** an insight. Just as importantly, it cuts the time and effort to **discard** a dead-end hypothesis. Most hypotheses in a real investigation are wrong. When ruling one out costs a lookup instead of an afternoon, people rule out more of them, faster, and they stop acting on the first plausible story.

The worked example in §4 shows why this matters. Two simultaneous events cancel each other out in the topline:

- a seasonal banner pushes a key call-to-action below the fold on mobile;
- a better-converting ad campaign scales up on a different journey.

Results look steady, and the merchant is losing about **$20,000 a week**. Worse, the steady line points the merchant toward cutting the campaign that is working. In the manual workflow, finding this takes **10 to 15 hours** of filter-wait-capture iterations, assuming the merchant guesses the right segmentation first. With stored snapshots it takes **minutes**, and the dead ends are discarded in seconds each.

---

## 2. The thesis: ecommerce is a cognitive discipline

### 2.1 Why the human cannot be replaced

People sometimes describe AI in analytics as a path to the autonomous store: the system watches the data, finds the problem, and fixes it. This program rejects that picture. It is not modesty about AI. Ecommerce has properties that make human cognitive engagement a requirement, not a stage to be automated away.

1. **The decisive context lives outside the data.** The analytics never record any of these:
   - the merchandising calendar;
   - the supplier delay;
   - the competitor's sale;
   - the influencer who mentioned a product;
   - the brand repositioning;
   - the team's decision to launch a banner on Monday.

   In nearly every real investigation, one sentence from the merchant ("we launched the holiday banner that week") collapses the hypothesis space more than any query.
2. **Goals are plural and value-laden.** Margin against growth. Acquisition against retention. Brand against conversion. A short-term promotion against long-term price perception. The data can show the trade-off. It cannot choose. Choosing is the merchant's job, and the merchant answers for it.
3. **Ecommerce is competitive and novel.** Competitors move, platforms change their rules, and customers' expectations shift. Winning moves are often new. A system that only replays patterns from the past is structurally behind.
4. **Causation needs intervention.** Behavioral data shows association. A merchant learns what causes what by changing something and watching: an experiment, a rollback, a staged rollout. Someone has to decide which intervention is worth its risk.
5. **The fix is creative.** Knowing that the add-to-cart button fell below the fold is diagnosis. Deciding how to fix it is design and brand judgment: shrink the banner, move the button, make it sticky, or rethink the page. So is deciding what the banner should have said.
6. **Disengagement makes operators worse.** A system that hands down conclusions trains people to accept them. Researchers call this *automation bias* and *deskilling*. An operator who stops understanding their store makes worse decisions exactly when the system is wrong. DSIP is designed to keep the human thinking, not to make thinking optional.

### 2.2 What the machine should do instead

If the human is the irreplaceable part, the machine's job is to protect the human's attention. Today most of that attention goes to work that is:

- **arduous:** many steps, each needing care;
- **repetitive:** the same filter-wait-capture loop, dozens or hundreds of times;
- **frustrating:** waiting on renders and slow queries, losing your place, starting over when the question changes;
- **perfunctory:** no judgment is exercised in copying a number from a chart into a spreadsheet.

DSIP takes that work. The engine does it once, ahead of time, for everyone who will ask. The Hypothesis Builder organises the reasoning: it keeps track of what has been considered, what has been ruled out, and why. The human keeps the parts that need a mind:

- framing the question;
- supplying context;
- judging plausibility;
- weighing trade-offs;
- choosing the intervention;
- owning the outcome.

### 2.3 Data that is friendly to both AI and humans

The program's central technical idea is that **the same structure serves both kinds of reader**. A time series snapshot is one stored row per subject, per segment, per week, with the same measures on every row. That suits both readers:

- **A person** can scan it as a table, without a query builder, and without waiting.
- **An AI** can read it as a few hundred labeled rows, not millions of raw events. It never has to compute a number itself, so it cannot miscompute one. Every value carries provenance it can cite.

Today an AI connected to analytics receives "an ocean of analytic data that it should sort out". It has to decide what to query, wait for each answer, hold the results in a limited context window, and do arithmetic it is not reliable at. DSIP hands it the shaped rows instead. Both the human and the AI stop waiting for long, expensive, synchronous time series queries, because the queries already ran.

---

## 3. Context: Heatmap, its data, and its users

### 3.1 The data

Heatmap is a behavioral analytics platform for ecommerce. Its tracking script runs on merchants' sites and records, for every session:

- **page views:** which page, how long, how far the visitor scrolled;
- **interactions:** clicks on specific interface elements, identified by selector, with rage clicks and dead clicks;
- **revenue attribution:** which sessions bought, what they spent, and which elements those buying sessions interacted with. This makes *element-level revenue* possible: the revenue of sessions that clicked a given button or image;
- **acquisition:** referrer, UTM campaign tags, ad platform click ids, partner tags;
- **identity:** a browser-level visitor id. Visits from the same browser can be chained across time, for example to see whether a new visitor came back and bought within 14 days;
- **orders:** revenue, products, time.

The raw data lives in a columnar warehouse (ClickHouse) as event tables: visits, page views, clicks, session tags, conversions. A large merchant generates millions of rows a month.

To give a sense of scale: for one large merchant, a single year-long "has this visitor bought before?" lookback reads about 546,000 visits, 3.07 million events, and 1.0 million orders. That happens before the period actually being analysed is touched.

### 3.2 The people who use it

| Person | What they need | What they lack today |
|---|---|---|
| **Merchant / founder** | To know whether the store is healthy, what changed, and what to do this week | Time and analytical training. They have the most context and the least time. |
| **Ecommerce or growth manager** | To explain movements to leadership, allocate budget, prioritise site work | Hours to assemble time series across tools |
| **CRO analyst / coach** | To find leaks, size them, and recommend fixes the merchant will act on | Fast iteration across segmentations, pages and elements |
| **Agency / consultant** | To serve many merchants with consistent, defensible analysis | A repeatable shape across clients |
| **AI assistant** (on behalf of any of the above) | Data it can reason over reliably, quickly, and cheaply | Shaped, labeled, bounded data. Today it gets raw query results. |

Heatmap's coaching program pairs merchants with CRO coaches, in recurring conversations about what changed and what to do. Those conversations are the native setting for this program. In a meeting, a coach and a merchant need an answer to a comparative question *during the meeting*, not next week.

### 3.3 The questions they ask

The hardest questions are comparative and temporal:

- Why have my results changed over time?
- How did Meta perform on our top money paths, week over week?
- Do new visitors from each traffic source come back and buy, and on which visit?
- Which elements on our key pages earn the most per session, and has that moved?
- We raised ad spend. Did it work?
- Results are flat. Is that good news, or is something hiding underneath?

The last question is the subject of the worked example.

---

## 4. The worked example: the steady line that hides a leak

All numbers in this example are illustrative. They are constructed to reconcile exactly, so every figure can be checked. Appendix A has the complete tables.

### 4.1 The store

*Northwind Outfitters* is a fictional apparel and gifts merchant on Shopify.

- About 100,000 sessions a week.
- Conversion rate 2.0%. Average order value (AOV) $80.
- About 2,000 orders and $160,000 revenue a week.
- 70% of sessions on mobile, 30% on desktop.

Two journeys matter for this example. A *journey* is the path a session takes through the site.

- **Journey A, the product path.** A visitor lands from search, email or direct, browses a collection, opens a product detail page (PDP), and adds to cart with the PDP's **Add to Cart** button. About 90% of sessions follow a journey through the PDP.
- **Journey B, the gift guide.** A visitor arrives from the Meta (Facebook/Instagram) *Holiday Gift Guide* campaign, lands on `/pages/gift-guide`, and adds products with **Quick Add** buttons on that page. This journey never touches the PDP's Add to Cart button. About 10% of sessions.

### 4.2 Event one: a seasonal banner pushes the call-to-action below the fold

On Monday 6 October the marketing team launches the holiday season. They add a seasonal banner, "Holiday gift guide is live · free gift wrap on every order", across the top of every product page.

On desktop, the banner is a thin strip, and the Add to Cart button stays well within the first screen. On mobile, the banner wraps to three lines and adds about 180 pixels. On most phones, that pushes the Add to Cart button **below the fold**: the visitor has to scroll before they can see it.

Many mobile visitors don't scroll on a product page before deciding. They look at the image, the price and the button. Now the button isn't there.

- **Reach:** the share of mobile PDP sessions in which the button ever entered the screen falls from **94% to 61%**.
- **Persuasion is unchanged.** Visitors who *do* see and click the button buy at the same rate as before: about $9.10 revenue per clicking session, before and after.
- The problem is visibility, not persuasion.

Journey A's conversion rate falls from **2.0% to 1.7%**. The whole drop comes from mobile: mobile's rate on Journey A falls from about 1.7% to 1.27%, while desktop holds at 2.7%.

### 4.3 Event two: ad spend rises on a campaign that converts better

The same week, as part of the same seasonal launch, the paid social manager raises the Holiday Gift Guide campaign's budget from $4,000 to $9,000 a week. The campaign uses new holiday creative aimed at gift buyers.

The traffic it sends converts well, because the gift guide is built for exactly these visitors. Quick Add buttons sit at the top of every product tile, so the seasonal banner doesn't push them below the fold.

- Journey B's sessions rise from **10,000 to 15,000 a week**.
- Its conversion rate rises from **2.0% to 3.7%**.

### 4.4 What the merchant sees

The merchant's dashboard shows weekly sessions, orders, conversion rate and revenue:

| Week starting | Sessions | Orders | Conversion | Revenue |
|---|---|---|---|---|
| 8 Sep | 99,400 | 1,994 | 2.01% | $159,520 |
| 15 Sep | 100,900 | 2,011 | 1.99% | $160,880 |
| 22 Sep | 100,200 | 2,009 | 2.00% | $160,720 |
| 29 Sep | 99,500 | 1,986 | 2.00% | $158,880 |
| **6 Oct** (banner + budget) | 100,600 | 2,013 | 2.00% | $161,040 |
| 13 Oct | 99,800 | 1,992 | 2.00% | $159,360 |
| 20 Oct | 100,700 | 2,016 | 2.00% | $161,280 |
| 27 Oct | 99,900 | 1,995 | 2.00% | $159,600 |

Everything is fine. Results are steady.

### 4.5 What actually happened

Underneath the steady line, two movements of the same size cancel exactly. Per week, averaged over each four-week period:

| Journey | Before: sessions | Before: conv. | Before: orders | After: sessions | After: conv. | After: orders | Change in orders |
|---|---|---|---|---|---|---|---|
| A, product path (PDP Add to Cart) | 90,000 | 2.0% | 1,800 | 85,000 | 1.7% | 1,445 | **−355** |
| B, gift guide (Meta, Quick Add) | 10,000 | 2.0% | 200 | 15,000 | 3.7% | 555 | **+355** |
| **Total** | 100,000 | 2.0% | 2,000 | 100,000 | 2.0% | 2,000 | **0** |

Split each journey's change into a *volume effect* (more or fewer sessions at the old rate) and a *rate effect* (the new rate on the new sessions):

- **Journey A:** −100 orders from volume (5,000 fewer sessions × 2.0%), and **−255 orders from the rate** (85,000 sessions × −0.3 points).
- **Journey B:** +100 orders from volume (5,000 more sessions × 2.0%), and **+255 orders from the rate** (15,000 sessions × +1.7 points).

The two volume effects are a *mix shift*: traffic moved from one journey to the other. They cancel because the two journeys started at the same rate. The two rate effects are the two events. They also cancel, by coincidence of size. Statisticians recognise the general pattern, where a blended total hides opposite movements in its parts: it belongs to the family of *Simpson's paradox* and *mix-shift masking*.

### 4.6 What it costs

**The leak.** Had Journey A kept its 2.0% rate, it would have produced 255 more orders a week. At $80 AOV, that is **$20,400 a week**, about 12.75% of revenue.

The holiday season runs twelve weeks from 6 October to the end of December. At baseline traffic, that is about **$245,000**. Holiday traffic peaks well above baseline, so the real figure is higher.

**The wrong decision.** The merchant raised Meta spend by $5,000 a week, and the topline didn't move. The natural conclusion: "we spent more and nothing happened."

Meta's own reporting credits the campaign with strong returns. The merchant suspects Meta is over-claiming, as merchants often do, because the total didn't change. So the merchant considers cutting the budget back.

In truth, the campaign is earning about $28,400 more revenue a week: 15,000 sessions at 3.7% and $80 is $44,400, against $16,000 before. That is about **5.7 times** the extra spend. Cutting it would remove that revenue and leave the leak in place. Revenue would fall to about $131,600 a week, and the merchant would probably blame the drop on "seasonality".

**Both stories the data tells at the top level are wrong:**

- "nothing changed";
- "the campaign didn't work".

The truth is one problem and one success, and each hides the other.

### 4.7 Why this is the normal case, not a contrived one

This pattern is not rare. **Confounders cluster.** A single business moment, such as a seasonal launch, a sale, a site redesign or a new product line, usually triggers several changes in the same week. Banner, ad budget, email cadence, pricing, theme updates. They overlap by design, because the team plans them together.

The weeks in which a merchant most wants to know "what worked" are exactly the weeks in which many things changed at once.

Flat results are also the hardest to investigate, because they don't prompt investigation. A drop triggers a hunt. A steady line triggers nothing, and the leak runs for the whole season.

---

## 5. Why "why did my results change?" is hard

### 5.1 The shape of the question

A question about change over time is really a search over a space with several dimensions:

- **Subjects:** the site, journeys, steps, pages, templates, elements.
- **Segmentations:** traffic source, campaign, device, new against returning, buyer history, country, landing page. Each has several values.
- **Time:** the period (day, week, month), the window, the comparison baseline, the change point.
- **Measures:** sessions, conversion, revenue, revenue per session (RPS), AOV, reach, clicks, progression between steps.
- **Mechanisms:** each candidate cause predicts a specific pattern across these dimensions.
  - A visibility problem predicts lower reach with unchanged revenue per click.
  - A traffic-quality problem predicts lower conversion concentrated in one source.
  - A checkout bug predicts a drop at one step across all sources.

Finding the cause means finding the slice of this space where a mechanism's predicted pattern appears. Discarding a cause means looking at the slice where its pattern *should* appear, and seeing that it doesn't.

### 5.2 The cost structure

In conventional tools, each point on a time series is a query:

- a filter for the segment;
- a date range for the period;
- a computation over raw events;
- a wait for the result to draw.

A time series of eight weeks is eight queries. Split by five traffic sources, it is forty. Add two devices and it is eighty.

The investigator doesn't know in advance which slice holds the answer, so the true cost is the sum over every slice they try. Each query is:

- **synchronous:** the person or agent waits for it;
- **expensive:** it scans raw events in the warehouse, and on a large site that is millions of rows;
- **isolated:** its result isn't stored in a shape the next question can reuse.

### 5.3 The asymmetry between confirming and discarding

Investigators tend to look for evidence *for* a favoured hypothesis. Confirming one plausible story feels like progress. Discarding the alternatives feels like overhead. Yet in a sound investigation most of the work *is* discarding, because most candidate explanations are wrong.

When each discard costs as much as each confirmation (another round of queries), people do less of it. They stop at the first plausible story, which may be the wrong one. In the worked example, the first plausible story is "the campaign didn't work".

---

## 6. The analysis journey today: the human

This section walks through what an ecommerce manager does today to investigate the worked example with conventional tools: an analytics product's journey and funnel explorer, plus a heatmap viewer. It assumes the manager is skilled and suspects something is wrong despite the steady topline. Most never start.

### 6.1 Round one: journeys by traffic source

The manager opens the journey or funnel explorer. To build an eight-week time series of conversion for the two journeys, split by traffic source, the loop is:

1. Set the date range to the week of 8 September.
2. Set the segment filter to "Google".
3. Choose the journey (Journey A's path, or the funnel steps that define it).
4. **Wait** for the report to compute and draw. On a large site this takes 15 to 90 seconds.
5. Read sessions, orders and revenue, and type them into a spreadsheet.
6. Change the segment to "Meta". Wait. Read. Type.
7. Repeat for organic/direct, email and "all".
8. Change the date range to the next week. Repeat steps 2 to 7.
9. Repeat for all eight weeks.
10. Switch to Journey B. Repeat everything.

That is 8 weeks × 5 source values × 2 journeys = **80 filter-wait-capture cycles**. At about two minutes each, including the wait, the reading and the typing, it takes **about 2.7 hours**. Appendix B has the arithmetic.

The result is a spreadsheet showing that Journey A's conversion fell from 6 October in *every* source, and that Journey B's conversion and volume rose.

This is real progress, but it is ambiguous. A drop in every source points away from traffic quality, but it doesn't say what *did* happen.

### 6.2 Round two: a different segmentation

The manager wonders whether the drop is on one device. They go back to step 1 with a different segmentation:

8 weeks × 3 device values (all, mobile, desktop) × 2 journeys = **48 more cycles, about 1.6 hours**.

Now they see it: Journey A's drop is entirely mobile.

In practice the manager doesn't know to try device second. They might try new against returning first (32 cycles), then campaign (48 cycles), and find nothing. Each wrong guess costs another hour or two.

### 6.3 Round three: the heatmap

A drop on mobile in the PDP journey suggests something on the product page. The manager opens the heatmap viewer. Heatmaps are usually per URL, and a template like the PDP covers hundreds of product URLs, so the manager picks the five top-selling products.

For each product page, the loop is:

1. Open the page's heatmap.
2. Set the date range to one week, and the device to mobile.
3. **Wait** for the heatmap to render. This can take a minute or more for a busy page.
4. Find the Add to Cart button. Read its clicks and the revenue attributed to sessions that clicked it. Switch to the scroll map and read how far down the page the button sits, and what share of sessions reached that depth.
5. Type the values into the spreadsheet.
6. Change to desktop. Wait. Read. Type.
7. Change the week. Repeat.
8. Repeat for the other key elements, to be sure the change is specific to Add to Cart: the size selector, the image gallery, the reviews link.
9. Repeat for each traffic source, to confirm it isn't one audience.

For 5 pages × 8 weeks × 2 devices × 4 sources, that is **320 renders**. Each render captures several elements' values. At about 90 seconds each, it comes to **about 8 hours**.

### 6.4 Round four: assembly

The manager now has hundreds of copied values across several spreadsheet tabs, so they build the time series:

- weekly conversion by journey;
- traffic mix by source;
- Add to Cart reach and revenue per session by device.

They check their copying, because one wrong cell can create a false trend. They compute the decomposition in §4.5 by hand.

**Total: 10 to 15 hours of focused work over several days,** and that assumes the manager guessed the right segmentations on the first or second try. Many would not finish.

### 6.5 What the work feels like

It is **arduous**: hundreds of precise steps, each one easy to get wrong.

It is **repetitive**: the same loop of filter, wait, read and type, again and again.

It is **frustrating**:
- the waits come every 30 to 90 seconds, too short to do anything else and too long to keep a train of thought;
- a slip means retracing steps;
- a new idea halfway through ("what about returning visitors?") means starting a new round from scratch.

It is **perfunctory**. Copying a number from a chart into a cell takes no judgment. The investigator's mind, the scarcest resource in the whole process, is used as a data pipe.

### 6.6 The shortcuts people take

Because the full investigation is so costly, people take shortcuts. Each one hides exactly the kind of problem in the worked example.

| Shortcut | What it hides |
|---|---|
| Compare two periods, before and after, instead of building a time series | When the change started, and whether it lines up with an event |
| Look only at the blended total | Opposite movements that cancel |
| Split by one segmentation only | A problem that lives in a different segmentation (device, not source) |
| Look at one top product page | Whether the problem is page-specific or template-wide |
| Stop at the first plausible story | The real cause, when the first story is wrong |
| Don't start, because results are steady | Everything |

---

## 7. The analysis journey today: the AI

Now give the same question to an AI assistant connected to the analytics through tools: an API or a Model Context Protocol (MCP) server that exposes functions such as "get analytics", "get heatmap" and "compare periods". This is the frontier of analytics today, and it is genuinely useful. It also inherits the cost structure of §5.2, and it adds failure modes of its own.

### 7.1 What the agent does

The merchant asks: *"We raised our Meta budget in October. Results are flat. What's going on?"*

A capable agent will typically:

1. Call a summary tool for the site: sessions, orders, revenue, conversion, for October against September. The result is flat.
2. Call a breakdown by traffic source for the two periods. Meta sessions are up, and Meta conversion is up.
3. Call a comparison of the two periods for the top pages. The deltas are small, and they are blended across devices and sources.
4. Perhaps call one heatmap for the home page.
5. Write an answer. A typical one:

   > "Overall performance is stable. Meta traffic increased and converts above average, but total revenue did not change, which suggests the additional Meta traffic may be cannibalising other channels or that Meta's reported conversions are inflated. Consider reallocating part of the Meta budget."

That answer is fluent, plausible and wrong, and it recommends the costly action from §4.6.

### 7.2 Why it goes wrong

1. **The ocean problem.** The agent receives raw query results, tables of rows with every measure, and has to decide what matters. Each result consumes context. After a few dozen calls, early results are summarised or dropped. A full investigation needs about 450 queries (§6), which no agent can hold.
2. **Synchronous, expensive queries.** Each tool call waits on the warehouse: seconds on a small site, a minute or more on a large one. Four hundred and fifty calls means hours of wall-clock time, real compute cost, and many tokens to read the results. So agents are built, or learn, to make few calls, which pushes them into the two-period, blended shortcuts.
3. **Premature closure.** Language models produce a coherent narrative from whatever evidence they have. A coherent story arrives after three calls, and nothing in the loop forces the agent to look for the evidence that would refute it.
4. **Confabulated mechanisms.** "Cannibalisation" and "inflated attribution" are real phenomena and plausible explanations. The agent offers them without testing them, because testing them costs more queries.
5. **Arithmetic and aggregation errors.** When the agent computes rates, shares or decompositions from raw results itself, it can make arithmetic mistakes, mix denominators, or sum across overlapping segments.
6. **No memory of what has been ruled out.** The next conversation starts from zero. Every investigation repeats the same discards, if it does them at all.
7. **No domain shape.** The agent doesn't know that element reach is the measure that separates a visibility problem from a persuasion problem. Nor does it know that a drop across every source points away from traffic quality. Unless the tools expose that structure, the agent has to rediscover it, query by query.

### 7.3 What the agent does well

The agent is fast at language, at proposing hypotheses, and at explaining results. Given the right data, it is an excellent research partner. Its failures above are almost all failures of **the data's shape and cost**, not of reasoning. That is the opening for this program.

---

## 8. Human and AI compared: one bottleneck, two failure modes

| Dimension | Human analyst | AI assistant |
|---|---|---|
| **Biggest strength** | Context: knows the banner launched on 6 October | Speed of language: proposes many hypotheses and explains clearly |
| **How it gathers data** | Filter, wait, read, type, repeat | Tool call, wait, read result into context, repeat |
| **Cost per data point** | 1 to 2 minutes of attention | Seconds to minutes of wall time, plus compute and tokens |
| **Capacity limit** | Patience, fatigue, the working day | Context window, call budget, cost |
| **Typical shortcut** | Two periods, blended, one segmentation | Same, because each call is expensive |
| **Typical failure** | Never starts on a steady line; stops early; copying errors | Premature, fluent closure; untested mechanisms; arithmetic slips |
| **Memory across investigations** | Spreadsheets, if kept | None by default |
| **Discarding hypotheses** | Expensive, so skipped | Expensive, so skipped |
| **What it needs** | The time series already built, in a table | The time series already built, labeled and cited, in a few hundred rows |

**The shared root cause:** the data isn't in the shape of the question, and reshaping it costs a slow, expensive, synchronous query per point. Both the human and the AI spend most of their effort on reshaping, and both cut corners to survive it.

**The complementary strengths:** the human holds the context and the judgment. The AI holds the breadth of hypotheses and the speed of explanation. Each is strongest when the other's weakness is covered. The program is designed around that complementarity, with one shaped body of data both can read.

---

## 9. The program: two systems, one interface

```text
                         ┌──────────────────────────────────────────────┐
                         │              The single interface            │
                         │                                              │
  merchant, manager,     │   Quick tabular time series views            │
  coach, agency  ───────▶│   AI-friendly data you can talk to           │
  (and their AI)         │   (web · Slack · MCP · other channels)       │
                         └───────────────┬───────────────┬──────────────┘
                                         │               │
                    question, framing,   │               │  tables read
                    ratings, approval    ▼               │  stored rows
                         ┌────────────────────────────┐  │
                         │     Hypothesis Builder     │  │
                         │ question → hypotheses →    │  │
                         │ gaps → plan → build →      │  │
                         │ cited answer               │  │
                         └──────┬──────────────┬──────┘  │
                  reads (only)  │              │ proposes│
                  stored rows   │              │ (data + │
                                ▼              ▼  code)  ▼
                         ┌────────────────────────────────────┐
                         │    Data transformation engine      │
                         │  raw events → checked time series  │
                         │  snapshots with segmentation       │
                         │  (routine weekly + agile new)      │
                         └────────────────┬───────────────────┘
                                          │ bounded reads
                                          ▼
                         ┌────────────────────────────────────┐
                         │  Raw behavioral data (ClickHouse)  │
                         │  visits · page views · clicks ·    │
                         │  session tags · orders             │
                         └────────────────────────────────────┘
```

**The data transformation engine** measures. It is the only writer of measurement. It turns raw events into stored, checked snapshots, and it refuses to write prose or guess.

**The Hypothesis Builder** reasons. It turns questions into hypotheses, finds what's missing, proposes new measurement, and composes cited answers. It never writes measurement, and it never computes a number of its own.

**The interface** is where people and their AI tools meet both. It has two views of one stored truth: tables and conversation.

The boundary between the engine and the builder is deliberate. Measurement is slow-changing, checked, and idempotent: rerunning a computation replaces its result instead of stacking a second copy. Conversation is fast, mutable, and exploratory. Keeping them apart lets each move at its own speed without compromising the other:

- **The builder proposes; the engine disposes.**
- New measurement crosses the boundary only as data and code: a declaration, a descriptor, a dataset specification.
- New measurement is accepted only when the engine's own checks pass.

---

## 10. Vision: the data transformation engine

### 10.1 Purpose

The engine turns raw behavioral data into the shapes that questions are asked in. It does that in two ways.

1. **Routine transformation.** Every transformation already known to be needed runs on a schedule, for every site it applies to, and is checked before anyone reads it. The stored rows are the reliable answer to the questions people ask most.
2. **Agile transformation.** A question nobody has asked before becomes a new dataset with little effort. The engine's extension points are declarations and single files with checks, not rewrites, so an agent can build the new dataset and the engine can verify it.

The raw log stays where it is. **The product is the transformed rows.**

### 10.2 What makes routine transformation reliable

- **An orchestrator runs it.**
  - Stages are declared, idempotent and leased.
  - A completion check decides success, not the exit code.
  - A dead worker's stage returns to the queue.
- **It grows by the week.**
  - A run adds the new week and leaves the stored weeks in place.
  - A short overlap recomputes the most recent week to catch late-arriving data.
  - A new subject backfills its history.
- **A rerun replaces, never stacks.** Every output is stored so that the latest write of the same identity replaces the earlier one, and readers see only the current version.
- **It verifies its own output.**
  - Each transformation has an acceptance check.
  - *Partition:* every segmentation's values sum to the total.
  - *Conservation:* every source total is accounted for in the rows.
- **It stays inside the warehouse budget.**
  - Every query on raw events is bounded to one site and a date range.
  - A governor keeps jobs on idle capacity, so they don't crowd out data collection.
- **It reads days, not years, for very large sites.**
  - A day-at-a-time scan keeps memory bounded.
  - A day store lets a later window read only its new days.

### 10.3 The routine outputs

| Output | What it answers |
|---|---|
| **Trend rows** (journeys, pages, elements) | Week over week, by traffic source, new against returning, buyer, rager, device and declared segmentations |
| **Trigger hits and chains** | Who showed intent, abandoned a cart, or became a super-shopper, and whether the same visitor came back and bought within the chain window |
| **Session-tag trends** | Week over week by the UTM and campaign tags that actually separate revenue, plus return intent |
| **Analysis datasets and strategy cards** | Per-page datasets and the state of each optimisation strategy: triggered, silent, below the volume floor, or blocked |
| **Experiment rows** | Partner experiment readouts by arm, section and element |
| **Reports** | Site Opportunity Report, Today Opportunities, User Journey Opportunity Analysis: written from the stored rows, never from fresh queries |

### 10.4 Agile transformation: four levels of effort

A new question should cost as little as the engine allows. The agent's job is to pick the lowest level that answers it.

| Level | What the agent produces | Examples |
|---|---|---|
| **Read** | Nothing new. The question is a filter on stored rows. | Meta against all traffic on the money paths, from trend rows |
| **Declare** | A configuration row or file. The engine validates it on load. | A segmentation (Google paid as its own value). A trigger of an existing type. A selector list for a page. A funnel definition. |
| **Extend** | One new file and its descriptor, with tests and an acceptance check | A new dataset adapter. A new trigger predicate. A new chain outcome field. |
| **New grain** | A new subject type or table. Rare, and reviewed by a person. | A grain the existing tables cannot hold without breaking an invariant |

Declarations are cheap because the engine checks them. An unknown id, step, event name or field fails at load, with the valid names listed.

Extensions are bounded for two reasons. The gateway rejects any query on raw events that isn't bounded to one site and a date range. Characterization tests pin the existing outputs, so a new file can't quietly change an old one.

**The engine does not trust the agent.** The orchestrator gives the agent the work, then runs the same check it would run on a deterministic step. The agent's claim that a dataset is right counts for nothing until the check passes.

### 10.5 Dataset requests: from a question or a transcript

A dataset request is a structured document. It names:

- the site and the window;
- the period: day, week, month, quarter, or the whole window, with rolling sums and the previous period beside each measure;
- up to three attributes to key by;
- up to eight segmentations;
- filters, measures, derived ratios and a rank;
- any external sources it may read, such as ad platforms, GA4 or a product catalog.

The engine answers each request with one of four results:

- **built:** a CSV, the same rows as JSON, and a dictionary of what every column means;
- **read:** the query on stored rows that answers it;
- **blocked:** with what is missing;
- **needs a person:** with the effort level and the file the change goes in.

The test of the agile path: drop a client meeting transcript in and say "prepare the datasets for the next step of analysis". The datasets that can be built come back built, plus a list of what is blocked and why.

### 10.6 Structure at the source

Some structure is cheapest to capture when the data is collected. One example is the visit history.

Today, "has this visitor been here before, and did they add to cart or buy then?" requires a long lookback across the warehouse, plus window functions that walk each visitor's history. The tracking script can instead keep a small per-browser history. Once per visit it attaches a frozen summary to the visit: previous visit, days since, last add to cart, last purchase, and a compact list of recent visits.

The engine then reads each visit's history from the visit's own row. There's no lead-in period, no year-long scan, and no cross-visit join. The principle generalises: **shape the data as early as it can be shaped correctly**.

### 10.7 What the engine will not do

- **Blocked is a result.** Missing data, an unnamed element, a requirement the warehouse can't meet, or a volume below the floor is stored and reported as that state. It is never filled with a guess.
- **Identity limits are stated.** The visitor id identifies a browser, not a person. A visitor who arrives in Meta's in-app browser and returns in Safari counts as two visitors. Cross-visit answers say how much of their traffic that affects.
- **A definition lives in one place.** A segment such as "Meta" is defined once, and every grain reads that definition.
- **Correlation stays correlation.** Revenue on an element row is the revenue of sessions that clicked the element. It ranks elements. It does not say the click caused the sale.
- **Questions the data can't answer go back to a person.** A merchant's test history, UTM conventions, or the pages they care about are asked for, not inferred.

---

## 11. Vision: time series snapshots with segmentation

### 11.1 What a snapshot is

A **time series snapshot** is one stored row per:

- **subject:** a journey step, a whole journey path, a page template, a specific page, or an interface element class on a page;
- **segment:** one segmentation, such as traffic source, and one of its values, such as Meta;
- **period:** a week, starting Monday.

Every row carries the same core measures: sessions, buyers, orders, revenue, clicks and progression. Each row type can also carry its own extra measures, such as reach for elements.

Rows are computed once per period from raw events, checked, and stored. Recomputing a period replaces it.

One table holds journeys, pages and elements. Segmentation is a pair of columns: the segmentation id and the value. A new way of cutting the data adds rows, not columns or tables.

A simplified view of the rows the worked example needs:

```text
row_type  row_key        subject                 segment          segment_value  week        sessions  orders  revenue
journey   path           collection > pdp > cart traffic_source   google         2026-09-08    30,000     600   48,000
journey   path           collection > pdp > cart traffic_source   google         2026-10-06    28,000     476   38,080
journey   path           gift-guide > quick-add  traffic_source   meta           2026-09-08    10,000     200   16,000
journey   path           gift-guide > quick-add  traffic_source   meta           2026-10-06    15,000     555   44,400
element   element_class  pdp.add_to_cart         device           mobile         2026-09-08    63,000   ...     ...     (+ reach 94%)
element   element_class  pdp.add_to_cart         device           mobile         2026-10-06    59,500   ...     ...     (+ reach 61%)
```

Within one segmentation, the values partition the sessions: each session sits in exactly one value, and the values sum to the total. The total is stored as its own row.

### 11.2 Two snapshot families that answer the worked example

**Family one: user journeys × traffic mix.** For every important journey (as steps and as whole paths) and every week, the snapshot answers several questions:
- how many sessions took the journey from each traffic source;
- how they converted;
- what they earned.

It also stores the traffic mix itself: the share of sessions from each source, each week.

This family shows three things in the example:
- Journey B's share and conversion rising;
- Journey A's conversion falling in every source;
- the mix shift between them.

**Family two: key interface element RPS on key pages × traffic mix.** For the important elements on the important pages (Add to Cart, size selector, gallery, reviews, Quick Add), and every week, the snapshot answers:
- what share of sessions saw the element (reach);
- how many clicked it;
- what clicking sessions spent;
- the element's revenue per session (RPS).

The same snapshots are stored split by device, and split by traffic source.

This family shows two things in the example:
- Add to Cart reach on mobile falling from 94% to 61%, with revenue per clicking session unchanged, which marks a visibility problem;
- the same drop in every traffic source, which marks a page problem, not an audience problem.

*Important pages* are chosen by rule: pages that earn revenue, pages a merchant has flagged, and templates that carry most sessions. *Important elements* come from a descriptor of element classes, site-specific rules, and the classes the data itself shows carrying traffic or revenue. Element snapshots depend on trustworthy element names. Where names aren't yet trustworthy, the row is stored as blocked, not filled.

### 11.3 Why precompute

- **Amortization.** A snapshot is computed once per week and read by every person, report and AI that asks. A manual investigation computes the same values again for every investigator, every time.
- **Latency.** Reading stored rows takes milliseconds to a second. The synchronous query each manual cycle waits on takes seconds to minutes.
- **Consistency.** Everyone reads the same definition of "Meta", the same bot filtering, and the same week boundaries. Two readers can't get two numbers for the same thing.
- **Checkability.** Partition and conservation checks run before rows are trusted. A copied value in a spreadsheet has no check.
- **Discardability.** A hypothesis can be ruled out by a lookup (§15).

### 11.4 What snapshots do not do

- The trend table holds **one segmentation per row**. It doesn't store every cross, such as device × source × campaign, because the combinations explode. Crosses come from dataset requests, built on demand from the same definitions, or from the cross-visit trigger grain.
- Snapshots are **descriptive**. They show where and when something moved, not why. The *why* comes from the combination of patterns, the merchant's context, and, where it matters, an experiment.
- Snapshots are **weekly** by default. Finding a change point within a week is a dataset request at daily grain.

---

## 12. Vision: the Hypothesis Builder

### 12.1 Purpose

The Hypothesis Builder is the question machine. It does six things:

1. turns a merchant's question into a structured set of hypotheses;
2. compares them against what the engine already knows;
3. classifies what's missing;
4. plans the cheapest data shaping that fills the gaps;
5. drives the build;
6. reads the refreshed results and composes a cited answer.

It keeps the human in the decision seat at every step.

### 12.2 The workflow

```text
1. Question      "Results are flat even though we raised Meta spend. What's going on?"
2. Framing       clarify scope, window, definitions, and what else changed (interactive)
3. Hypotheses    a structured, ranked list, built with the user, in the engine's vocabulary
4. Gap analysis  each hypothesis's evidence needs, against what is stored
5. Shaping plan  every gap classified: Read / Declare / Extend / New grain
6. Build         proposals cross to the engine; engine checks decide; snapshots refresh
7. Answer        cited synthesis from stored states, never recomputed numbers
```

### 12.3 A hypothesis is a claim with falsifiers

A hypothesis in the builder is not a sentence. It is a structured claim with six parts:

- **statement:** "The seasonal banner pushed Add to Cart below the fold on mobile."
- **mechanism:** fewer mobile visitors see the button, so fewer add to cart.
- **predicted observation:** mobile Add to Cart reach falls from the banner's launch week; revenue per clicking session holds; desktop is unchanged; the drop appears in every traffic source.
- **disconfirming observation:** reach unchanged; or the drop appears on desktop too; or it is confined to one source.
- **evidence references:** typed pointers to the snapshots that test the predictions.
- **status:** proposed, supported, contradicted, blocked, or awaiting data.

The disconfirming observation is what makes the hypothesis useful. It tells the system, and the human, exactly what would rule it out. That makes discarding as cheap as confirming.

### 12.4 Gap analysis and the shaping plan

For each hypothesis, the builder lists the evidence it needs and checks the engine's requirement registry and stored coverage. Each need is classified into one of five states:

- **readable:** the snapshots exist; answer now;
- **declarable:** a configuration would produce them, such as a new segmentation or a selector list;
- **extendable:** one new file would produce them;
- **new grain:** a new table is needed, which is rare and reviewed;
- **blocked:** the data doesn't exist in the platform. Examples are site speed with no speed source, or stock levels with no catalog connection. A blocked need names exactly what is missing and is routed to the human ("did anything change in site speed or stock that week?").

The plan orders the work so the human gets value immediately. Readable items are answered now. Declarable items follow in hours. Extendable and new-grain items are sized explicitly. Latency is visible, never hidden.

### 12.5 The builder proposes; the engine disposes

The builder never writes measurement. New measurement leaves the builder as a proposal: a segmentation declaration, a profile descriptor, or a dataset specification, with its tests. The engine accepts a proposal only when its own checks pass.

The builder tracks each proposal through review and checks to the refreshed snapshots, then returns to the waiting question.

### 12.6 Context from the information hierarchy

To reason well, the builder must know what the engine knows. It compiles the engine's published read model into a versioned index with four layers:

| Layer | What the builder learns |
|---|---|
| **Vocabulary** | Requirement keys, strategy ids, trigger rules, the event taxonomy, segmentation ids |
| **Beliefs** | What the platform currently concludes per site and page: strategy states, trigger states, missing requirements, with their batch and window |
| **Evidence** | The snapshot rows under those conclusions |
| **Semantics** | What the numbers mean and don't mean. For example: element revenue isn't additive; RPS isn't causal; definitions of windows and bot filtering. |

For each question, it assembles a **context pack**: a small, cited, checkable slice of that hierarchy, sized to a budget. That is what the AI reasons over, not the ocean.

### 12.7 Citations are checked, not trusted

Every item in a context pack, and every claim in an answer, carries a reference to a stored artifact. Before anything reaches the user, a deterministic check re-resolves every citation. It confirms the id exists, the version is compatible, and the site matches.

A citation that fails is removed and recorded as a gap. The user sees "I can't verify this" instead of an unverifiable claim. The AI may propose and explain. **The builder does not trust the AI**, in the same way the engine does not trust the agent.

### 12.8 The human's role in the builder

| Step | The human does | The system does |
|---|---|---|
| Question | Describes the issue in their own words, at any length, pasted from a meeting if they like | Classifies the question's shape; drafts framing questions |
| Framing | Answers clarifying questions, and volunteers context: what launched, what changed, what they suspect | Narrows scope; turns the context into hypotheses and markers on the timeline |
| Hypotheses | **Reviews, rates and comments on** each hypothesis; adds their own; rejects the implausible | Ranks by evidence coverage; shows what would confirm or refute each |
| Plan | **Approves** the analysis, seeing which answers come now and which after a build | Classifies gaps; sizes effort; shows latency |
| Answer | Judges it; asks follow-ups; **decides what to do** | Synthesises from cited stored states; lists unresolved gaps |
| Afterwards | Records the decision and its outcome | Keeps the ledger of what was supported and ruled out, for next time |

Ratings and feedback also tune the system over time: which hypotheses users found plausible, which proposals the engine accepted. Every tuning change stays behind a port and reads only the builder's own data.

### 12.9 Channels: Slack, MCP, web, and more

The builder's conversation is designed to run in many places. The core is built in a *ports and adapters* style:

- the application exposes use cases: start a session, answer a clarifying question, rate a hypothesis, approve a plan, get status;
- each channel is an adapter that translates its own events into those calls;
- an outbound notification port tells the user when a build finishes, in the same thread, hours later if need be;
- identity and site access are enforced in the core, not in any adapter.

| Channel | Fit |
|---|---|
| **Slack app** | The natural first channel. Paste a detailed description into a thread. Answer clarifying questions back and forth. Rate hypotheses with buttons. Approve the run. Get the cited answer in the same thread when the build completes. |
| **MCP** | An AI assistant the user already works with calls the builder as tools: start, answer, list hypotheses, rate, run, status. Smallest adapter. The client's AI writes the final reply, so citations must travel with every result. |
| **Web** | Inside the Heatmap app, beside the tabular views. The richest surface. |
| **WhatsApp, SMS** | Possible later. Smaller screens and simpler interactions: ratings by reply codes, summaries instead of long lists. Each brings its own platform approval process. |

---

## 13. Vision: the single interface

The two systems meet the user in one place, with two complementary views of one stored truth.

### 13.1 Vision one: quick tabular views of time series data

A merchant opens a page, a journey or an element and sees a table immediately. There is no query builder, no spinner, and no render wait, because the rows are already stored.

- **Rows** are subjects: journeys, pages, or the key elements on a page.
- **Columns** are weeks, with a sparkline and the change against the previous period and against the same period last year.
- **A segmentation switcher** re-cuts the table instantly by traffic source, device, new against returning, campaign, or any declared segmentation. One click replaces a round of 40 to 80 manual cycles.
- **A traffic-mix strip** shows each week's share of sessions by segment value, so mix shifts are visible beside rate changes.
- **Measures** switch between sessions, conversion, revenue, RPS, reach and progression. Rates are shown with their volumes. Rows below the volume floor are marked, not hidden.
- **Drill-down** goes from a journey to its steps, to the pages in a step, to the elements on a page, each a table of the same shape.
- **Annotations** are markers the human adds to the timeline: "6 Oct: holiday banner launched", "6 Oct: Gift Guide budget $4k → $9k". They appear on every table and seed hypotheses in the builder.
- **Blocked cells** say why they are blocked, for example "element names not yet trustworthy".
- **Export** produces the same rows as CSV or JSON, with a dictionary of what every column means.

The tables do more than speed up today's workflow. They change what people look at. A steady topline next to a journey table that is falling in one row and rising in another prompts the question nobody would have asked.

### 13.2 Vision two: AI-friendly data you can talk to

The same rows are built to be read by AI. "AI-friendly" means specific properties:

| Property | What it means | Why it matters to an AI |
|---|---|---|
| **Compact** | Hundreds of rows, not millions of events | Fits in context with room to reason |
| **Pre-aggregated** | Rates, shares and totals already computed and checked | The AI never does the arithmetic, so it can't get it wrong |
| **Labeled** | Every column has a definition; every segment value is named | No guessing what a field means |
| **Partitioned** | Values within a segmentation sum to the total, and the total is stored | Safe comparisons; no double counting across overlapping segments |
| **Versioned and cited** | Every row has an identity, a batch, a window | Every claim can point to its evidence, and the evidence can be re-checked |
| **Honest about gaps** | Blocked and below-floor states are stored as states | The AI can say "the data can't answer this" instead of inventing |
| **Semantically annotated** | What the number does *not* mean is written down | Fewer causal over-claims |
| **Fast** | Reads in milliseconds | The AI can explore many slices in one conversation |

**Talking to the data** means the user asks in plain language, through whichever channel they use, and the conversation draws on the snapshots through the Hypothesis Builder's context packs and checked citations.

The conversation and the tables are linked. A cited row in an answer highlights the matching cell in the table. A cell the user pins in the table becomes context in the conversation.

### 13.3 How the two views work together

- **The table is for seeing.** Humans spot shapes quickly: a step down, a crossing, a divergence.
- **The conversation is for asking.** Breadth, hypotheses, explanation, follow-ups.
- **The human connects them.** The human supplies the context neither view has, and makes the decision.

---

## 14. The worked example, revisited with DSIP

### 14.1 The conversation

The merchant pastes a message into the builder's Slack thread:

> **Merchant:** Results have been flat since early October, but we raised the Meta Gift Guide budget from $4k to $9k a week on 6 Oct. Meta says the campaign is doing great. I'm not sure I believe it. What's going on?

> **Builder:** A few questions so I look in the right place:
> 1. By "flat", do you mean revenue, conversion rate, or both? I'll compare 8 Sep – 27 Oct, four weeks before 6 Oct and four after. Is that right?
> 2. Did anything else change on the site or in marketing around 6 October? For example a theme change, banner, pricing, email cadence or stock.
> 3. Should I treat the Gift Guide landing page as a key page?

> **Merchant:** Both. Window is right. Yes — we launched the holiday season that week: a site-wide banner and the gift guide. Yes, gift guide is key.

The builder adds two markers to the timeline (6 Oct: banner; 6 Oct: budget) and proposes hypotheses.

### 14.2 The hypotheses, and how each one fares

| # | Hypothesis | What would rule it out | Evidence (stored snapshots) | Verdict | Time |
|---|---|---|---|---|---|
| H1 | The extra Meta traffic is low quality | Meta conversion steady or up | Journey B conversion 2.0% → 3.7%; Meta conversion on Journey A unchanged relative to other sources | **Ruled out** | seconds |
| H2 | Meta is over-claiming; the campaign added nothing | Gift-guide journey orders up on the site's own data | Journey B orders 200 → 555 a week in the site's own orders | **Ruled out** | seconds |
| H3 | Meta traffic is cannibalising other channels | Other sources' sessions steady and their own conversion explains their orders | Sessions from other sources down 5%, consistent with seasonal softening; their conversion fell on Journey A in every source, a separate effect | **Ruled out as the main cause** | seconds |
| H4 | Seasonality: early October always dips | Same weeks last year steady | Last year's Journey A conversion held 2.0% through October | **Ruled out** | seconds |
| H5 | Checkout broke | Checkout step completion steady | Checkout-started → purchase steady across devices and sources | **Ruled out** | seconds |
| H6 | Site speed regressed | — | No speed source connected | **Blocked**: asked the merchant; no deploy besides the banner | one question |
| H7 | A product went out of stock | — | No catalog connection | **Blocked**: merchant confirms stock was normal | one question |
| H8 | **The banner pushed Add to Cart below the fold on mobile** | Mobile reach unchanged, or desktop also down, or drop confined to one source | Mobile reach 94% → 61% from 6 Oct; revenue per clicking session steady (~$9.10); desktop reach 99% steady; drop in every source | **Supported** | seconds |
| H9 | **A better-converting campaign masked the leak** | Journey B's gain smaller than Journey A's loss | Journey B +355 orders a week; Journey A −355; blended unchanged | **Supported** | seconds |

The merchant rates H8 and H9 as plausible and H3 as "worth watching", then approves the summary.

Nothing needed a build: every hypothesis was *readable* from routine snapshots, or blocked and resolved with one question to the merchant. Had the merchant wanted the drop located within the week (a daily change point), or the five most affected product pages individually, those would have been a dataset request: a *declare* or a *read*, built in minutes to hours and announced in the same thread.

### 14.3 The tables the merchant sees

**Journey conversion by week, all traffic:**

| Journey | 8 Sep | 15 Sep | 22 Sep | 29 Sep | ▌6 Oct | 13 Oct | 20 Oct | 27 Oct |
|---|---|---|---|---|---|---|---|---|
| A, product path | 2.01% | 1.99% | 2.00% | 2.00% | 1.71% | 1.69% | 1.70% | 1.70% |
| B, gift guide | 2.02% | 1.98% | 2.01% | 1.99% | 3.66% | 3.72% | 3.70% | 3.71% |
| All | 2.01% | 1.99% | 2.00% | 2.00% | 2.00% | 2.00% | 2.00% | 2.00% |

**Traffic mix: share of sessions by journey:**

| Journey | 8 Sep | 15 Sep | 22 Sep | 29 Sep | ▌6 Oct | 13 Oct | 20 Oct | 27 Oct |
|---|---|---|---|---|---|---|---|---|
| A, product path | 90% | 90% | 90% | 90% | 85% | 85% | 85% | 85% |
| B, gift guide | 10% | 10% | 10% | 10% | 15% | 15% | 15% | 15% |

**Key element: PDP Add to Cart, mobile against desktop:**

| Measure | Device | 8 Sep | 15 Sep | 22 Sep | 29 Sep | ▌6 Oct | 13 Oct | 20 Oct | 27 Oct |
|---|---|---|---|---|---|---|---|---|---|
| Reach | mobile | 94% | 94% | 93% | 94% | 62% | 61% | 60% | 61% |
| Reach | desktop | 99% | 99% | 99% | 99% | 99% | 99% | 99% | 99% |
| Element RPS | mobile | $1.64 | $1.63 | $1.65 | $1.64 | $1.07 | $1.05 | $1.06 | $1.05 |
| Element RPS | desktop | $2.43 | $2.43 | $2.42 | $2.44 | $2.43 | $2.42 | $2.44 | $2.43 |
| Revenue per clicking session | mobile | $9.10 | $9.12 | $9.08 | $9.10 | $9.06 | $9.03 | $9.07 | $9.04 |

**Key element: PDP Add to Cart element RPS on mobile, by traffic source** (four-week averages):

| Source | Before 6 Oct | From 6 Oct | Change |
|---|---|---|---|
| Google | $1.66 | $1.07 | −36% |
| Organic / direct | $1.63 | $1.05 | −36% |
| Email | $1.70 | $1.10 | −35% |
| Meta | $1.55 | $1.00 | −35% |

Each table reads in under a second. The four together tell the whole story:
- a rate drop on one journey and a rate rise on another, cancelling;
- a mix shift toward the rising journey;
- a visibility collapse on one element, on one device, starting on the banner's launch date;
- the same drop in every audience.

### 14.4 The answer

> **Builder:** Results are flat because two changes of equal size cancelled each other out from 6 October.
>
> **1. The Gift Guide campaign is working.** The gift-guide journey went from 200 to 555 orders a week, about $28,400 more revenue a week on $5,000 more spend. Its conversion rose from 2.0% to 3.7%. [journey/path gift-guide > quick-add, Meta, weeks 8 Sep – 27 Oct]
>
> **2. The holiday banner is costing you about $20,400 a week on mobile.** On mobile product pages, the Add to Cart button left the first screen for about a third of visitors: reach fell from 94% to 61% the week the banner launched. Visitors who still click it buy as before, so this is visibility, not persuasion. Desktop is unaffected, and the drop is the same in every traffic source. [element pdp.add_to_cart, device = mobile/desktop; source split; weeks 8 Sep – 27 Oct]
>
> I ruled out low-quality Meta traffic, Meta over-claiming, cannibalisation as the main cause, seasonality, and a checkout break. Speed and stock aren't in the data; you confirmed both were normal.
>
> **What I can't tell you:** how best to fix the page. Options include shrinking the banner on mobile, moving Add to Cart above it, or making the button sticky. A quick split test would show which recovers the most. Keep the campaign running while you decide.

The merchant decides. They shrink the banner to one line on mobile, test a sticky Add to Cart against it, and keep the Meta budget. The decision, its reasoning and the ruled-out hypotheses are recorded. When the merchant asks "did the fix work?" in two weeks, the same tables answer it.

### 14.5 The comparison

| | Manual today | AI on raw tools today | DSIP |
|---|---|---|---|
| Starts the investigation on a steady line? | Rarely | Only if asked | Yes. The tables show diverging rows under a flat total. |
| Time to the answer | 10–15 hours, several days | Minutes to hours; usually stops early | Minutes |
| Queries on raw events at question time | ~450 synchronous | Few, because each is expensive | None. Stored rows only. |
| Finds the mix shift | If the right segmentation is tried | Rarely | Yes: mix strip and journey table |
| Finds the element visibility problem | After ~8 hours of heatmap renders | Rarely | Yes: element snapshot by device |
| Dead ends discarded | Few; each costs hours | Few; each costs calls | Nine considered, seven discarded or resolved, each in seconds or one question |
| Likely decision | "Nothing changed" or "cut Meta" | "Cut Meta" | Fix the mobile page; keep the campaign |
| Weekly value of the right decision | — | — | Recover ~$20,400; keep ~$28,400 |

---

## 15. The second dividend: discarding dead ends

### 15.1 Why discarding matters as much as finding

An investigation is a funnel of hypotheses. Most enter and few survive. The quality of the conclusion depends on how many alternatives were honestly considered and ruled out. A conclusion reached after discarding nothing is a guess that happens to sound like an answer.

When a discard costs as much as a confirmation, people stop discarding early. Their conclusions are then over-confident and often wrong: "the campaign didn't work."

### 15.2 How DSIP makes discarding cheap

1. **Every hypothesis carries its falsifier.** The builder writes down what would rule a hypothesis out, before looking.
2. **The falsifier is usually a lookup.** Because the snapshots are stored, checking "is Meta conversion steady?" costs a read, not a round of queries.
3. **Blocked is fast too.** If the data can't test a hypothesis, the system says so at once and turns it into a question for the human, who often answers it in one sentence.
4. **The ledger persists.** Ruled-out hypotheses are recorded, with their evidence, per site and question shape. The next investigation starts with "last time, we ruled out checkout and seasonality for a similar pattern; here's whether that still holds."
5. **The human sees the discards.** The answer lists what was ruled out and why. That builds justified confidence and gives the human a chance to object ("you ruled out seasonality, but last year we ran the banner too").

### 15.3 The economics

Say a typical "why did results change?" investigation considers ten hypotheses.

- **Manually:** each one takes a round of 40 to 80 query cycles to test properly. Testing all ten is days of work. In practice, two or three are tested and the rest are assumed.
- **With DSIP:** most are readable, and each is tested in seconds. The rest become one question to the human, or a build that runs while the conversation continues.

The time saved goes back to the human: to think about the fix, the trade-off, and what to test next.

---

## 16. Principles and limits

### 16.1 Design principles

1. **The human decides.** The system proposes, explains, and shows evidence. It does not decide, and it does not act on the store.
2. **Engagement over automation.** The interface invites framing, rating, objection and annotation. A system that makes thinking optional is a failure of design, not a feature.
3. **Measure once, read many times.** Expensive computation happens ahead of time, checked, and is shared by every reader.
4. **One definition per concept.** A segment, a measure and a window are each defined once, and every surface reads that one definition.
5. **Checks, not claims.** Agents and AI are trusted only as far as deterministic checks verify them.
6. **Blocked is a result.** Missing data is stated, never filled.
7. **Cited or not shown.** Every number in an answer points to a stored artifact that can be re-checked.
8. **Correlation stays correlation.** Associations rank and direct attention. Causal claims need an intervention, and the system says so.
9. **Cheapest sufficient effort.** Read before declare, declare before extend, extend before a new grain.
10. **Same data for human and AI.** The table a person sees and the rows an AI reads are the same rows.

### 16.2 What the program will not do

- It won't make changes to a merchant's store, ads or prices.
- It won't present an uncited number, or a number computed at answer time from raw events by an AI.
- It won't infer what can only be asked: test history, UTM conventions, the merchant's goals.
- It won't claim a browser id is a person.
- It won't hide low volume. Rows below the floor are marked.
- It won't let the conversational layer write measurement.

### 16.3 Known limits

- **Identity.** Browser-level visitor ids undercount cross-device and cross-browser returns. This affects channels such as Meta disproportionately, through in-app browsers.
- **Element names.** Element snapshots are only as good as the naming of elements. Unnamed or unstable selectors are blocked, not guessed.
- **Weekly grain.** Within-week change points need a daily dataset request.
- **Uncrossed segmentations.** Routine snapshots hold one segmentation per row. Crosses are built on request.
- **External context.** Site speed, stock, pricing history and competitor moves are outside the behavioral data until connected as sources.

---

## 17. Where it stands, roadmap, and measures of success

### 17.1 The data transformation engine

| Piece | State |
|---|---|
| Single-file dataset adapters, discovered at start-up | Built (48 adapters) |
| Orchestrator: declared stages, completion checks, agent fallback | Built |
| Trend rows: journey, page and element snapshots by segmentation | Built and proven on a large merchant |
| Declarative segmentations read by every grain, versioned, with backfill on change | Built |
| Incremental weeks: next window from the store; backfill of new subjects | Built |
| Day-at-a-time scan and day store for very large sites | Built; largest-site runs scheduled |
| Execution profiles: subject types beyond landing pages (pages, funnels, journeys) | Built |
| Trigger hits and chains; session-tag trends with return intent | Built |
| Dataset requests from a question or transcript | Built for sessions; external source connectors simulated, real connectors pending |
| Visit history at the source (tracker) | Implementation plan ready |
| Chain return attributes (the return visit's source, landing page, overlap) | Partly built |
| Facet integration (tables served to the product and Talk to My Data) | Target: journey by traffic source and key elements week over week, in production by 8 November 2026 |

### 17.2 The Hypothesis Builder

Planned as a sibling system with a read-only connection to the engine. Its phases:

| Phase | Delivers |
|---|---|
| H0 | Skeleton: architecture tests, ports, session store, first conversation adapter |
| H1 | Read-only connection to the engine's stored rows |
| H2 | Hierarchy indexer: vocabulary, beliefs, evidence and semantics at a pinned version |
| H3 | Context builder and citation check |
| H4 | Hypothesis loop: question shapes, templates, framing, evidence ranking |
| H5 | Gap analysis and shaping plan |
| H6 | Proposal emission to the engine, build tracking, cited answers |
| H7 | Feedback-driven tuning (once real conversations exist) |
| Channels | Slack app first; MCP; web inside the Heatmap app; others by demand |

### 17.3 Measures of success

| Measure | Target direction |
|---|---|
| Time from question to a cited answer, on "why did results change?" questions | Hours to days → minutes |
| Hypotheses considered and explicitly discarded per investigation | Up |
| Queries on raw events at question time | Toward zero for readable questions |
| Share of questions answered at the Read or Declare level | Up |
| Share of answers with every number cited and re-verified | 100% |
| Merchant-reported confidence in decisions, and decisions changed by the analysis | Up |
| Revenue recovered from leaks found under steady toplines | Tracked per merchant |
| Coach time per merchant conversation spent on interpretation, not data gathering | Up |
| Warehouse compute per answered question | Down |

---

## 18. Questions for research

These questions would strengthen or challenge this vision.

**The problem**
1. How often do aggregate ecommerce metrics mask opposing segment-level movements (mix-shift masking, Simpson's paradox) in practice? Are there published cases or measurements?
2. How do ecommerce teams actually investigate metric changes today? What tools, how long, and which shortcuts? Are there studies of analyst workflows and time spent on data gathering against interpretation?
3. What are the documented costs of acting on a wrong attribution conclusion, such as cutting a working campaign?

**Human cognition and decision support**
4. What does the decision support system literature say about the balance between automation and human judgment, from the classic data–model–dialogue architecture to modern AI-assisted analytics?
5. What is known about automation bias and deskilling in analytics and business decision-making, and which interface designs keep users cognitively engaged?
6. How do expert analysts use falsification and disconfirming evidence, and how can tools encourage it?

**AI and analytics**
7. What failure modes do LLM agents show when analysing tabular and time series data through tools: context limits, arithmetic errors, premature closure, confabulated causes? What mitigations work?
8. How do semantic layers, metrics layers and pre-aggregated cubes compare with text-to-SQL for reliable AI question answering?
9. What citation and verification patterns exist for grounding LLM answers in structured data?

**Market and comparables**
10. How do existing products approach this? Examples:
    - GA4 Explorations;
    - Adobe Analytics anomaly detection and contribution analysis;
    - Amplitude, Mixpanel, Heap;
    - Contentsquare, Hotjar, Microsoft Clarity;
    - Shopify Analytics;
    - Triple Whale, Northbeam.

    Which offer precomputed, segmented time series at the journey and element level?
11. Which products offer automated root-cause or driver analysis for metric changes, and how do they handle confounders and mix shift?
12. Where is element-level revenue attribution offered, and how is it presented?

**Methods**
13. What decomposition methods best separate mix effects from rate effects in conversion metrics, and how should they be shown to non-statisticians?
14. What change-point detection methods suit weekly and daily ecommerce series with seasonality?
15. How should element visibility (reach) be measured and validated across devices and viewport sizes?

**Product and channels**
16. What does research say about conversational analytics in workplace chat tools such as Slack: adoption, trust, and asynchronous long-running tasks?
17. What are the platform requirements and constraints for business messaging on WhatsApp and SMS?

---

## 19. Glossary

| Term | Meaning |
|---|---|
| **AOV** | Average order value: revenue ÷ orders. |
| **Agile transformation** | Building a new dataset for a new question, at the lowest effort level that answers it. |
| **Annotation** | A human-entered marker on the timeline, such as "banner launched", shown on every table and used to seed hypotheses. |
| **Blocked** | A stored state meaning the data cannot answer a question, with the reason. Never filled with a guess. |
| **Chain** | A trigger followed through later visits from the same browser, for example whether a cart abandoner came back and bought within 14 days. |
| **Citation** | A reference from a claim to a stored artifact, re-verified before display. |
| **Context pack** | A small, cited, budgeted slice of the engine's information hierarchy, assembled for one question. |
| **Conversion rate** | Orders ÷ sessions. |
| **Data transformation engine (Analysis Engine)** | The system that turns raw behavioral data into checked, stored snapshots. The sole writer of measurement. |
| **Declare / Extend / New grain / Read** | The four effort levels of agile transformation (§10.4). |
| **Element** | An interface element on a page, such as Add to Cart, identified by class and selector. |
| **Element RPS** | Revenue of sessions that clicked an element ÷ sessions on the page. It ranks elements. It is not causal. |
| **Falsifier** | The observation that would rule a hypothesis out. |
| **Hypothesis Builder** | The system that turns questions into falsifiable hypotheses, plans data shaping, drives builds, and composes cited answers. |
| **Journey** | The path a session takes through a site, stored as steps and as whole paths. |
| **MCP** | Model Context Protocol: a standard way for AI assistants to call external tools and read data. |
| **Mix shift** | A change in the share of sessions across segments or journeys, which moves blended results even when no segment's rate changes. |
| **Partition** | The property that a segmentation's values cover every session exactly once and sum to the total. |
| **Ports and adapters** | An architecture where the core exposes interfaces (ports) and each external system, channel or store connects through a replaceable adapter. |
| **Reach** | The share of page sessions in which an element entered the visible screen. |
| **Routine transformation** | A known-needed transformation that runs on a schedule for every applicable site, and is checked. |
| **RPS** | Revenue per session: revenue ÷ sessions. |
| **Segmentation / segment value** | A way of dividing sessions (traffic source, device, new against returning) and one of its values (Meta, mobile, new). |
| **Simpson's paradox** | A trend that appears in groups and reverses or disappears when the groups are combined. |
| **Snapshot (time series snapshot)** | One stored, checked row per subject, segment value and week, with the same core measures on every row. |
| **Strategy card** | A stored state for an optimisation strategy on a page: triggered, silent, below floor, or blocked, with its rule results. |
| **Traffic mix** | The distribution of sessions across a segmentation's values in a period. |
| **Trend row** | The engine's snapshot table holding journeys, pages and elements by segmentation and week. |

---

## Appendix A: the worked example's numbers

All figures are illustrative and per week. "Before" is the average of the weeks starting 8, 15, 22 and 29 September. "After" is the average of the weeks starting 6, 13, 20 and 27 October.

**A.1 Journeys**

| | Before | After |
|---|---|---|
| Journey A sessions | 90,000 | 85,000 |
| Journey A conversion | 2.0% | 1.7% |
| Journey A orders | 1,800 | 1,445 |
| Journey B sessions | 10,000 | 15,000 |
| Journey B conversion | 2.0% | 3.7% |
| Journey B orders | 200 | 555 |
| Total sessions | 100,000 | 100,000 |
| Total orders | 2,000 | 2,000 |
| Total conversion | 2.0% | 2.0% |
| Revenue at $80 AOV | $160,000 | $160,000 |

**A.2 Decomposition of the change in orders**

| | Volume effect | Rate effect | Total |
|---|---|---|---|
| Journey A | (85,000 − 90,000) × 2.0% = −100 | 85,000 × (1.7% − 2.0%) = −255 | −355 |
| Journey B | (15,000 − 10,000) × 2.0% = +100 | 15,000 × (3.7% − 2.0%) = +255 | +355 |
| Total | 0 | 0 | 0 |

**A.3 Journey A by device**

| | Share of Journey A | Conversion before | Conversion after |
|---|---|---|---|
| Mobile | 70% | 1.70% | 1.27% |
| Desktop | 30% | 2.70% | 2.70% |
| Journey A | 100% | 0.7 × 1.70 + 0.3 × 2.70 = 2.00% | 0.7 × 1.27 + 0.3 × 2.70 = 1.70% |

**A.4 Journey A sessions by traffic source**

| Source | Before | After |
|---|---|---|
| Google | 30,000 | 28,000 |
| Organic / direct | 40,000 | 38,000 |
| Email | 12,000 | 11,500 |
| Meta (other campaigns) | 8,000 | 7,500 |
| Total | 90,000 | 85,000 |

Meta's share of all sessions rises from 18% (8,000 + 10,000) to 22.5% (7,500 + 15,000).

**A.5 The cost and the value**

- Leak: 85,000 × (2.0% − 1.7%) = 255 orders × $80 = **$20,400 a week**. Over 12 weeks at baseline traffic: about **$245,000**.
- Campaign: Journey B revenue $44,400 after against $16,000 before = **+$28,400 a week** on +$5,000 spend, about **5.7×**.
- If the campaign were cut back to its old level and the leak left in place: revenue $160,000 − $28,400 = about **$131,600 a week**. Even counting the $5,000 of spend saved, the merchant is about **$23,400 a week** worse off.

**A.6 PDP Add to Cart element (mobile)**

| | Before | After |
|---|---|---|
| Reach | 94% | 61% |
| Click share of PDP sessions | 18.0% | 11.7% |
| Revenue per clicking session | $9.10 | $9.05 |
| Element RPS (click share × revenue per clicker) | $1.64 | $1.06 |

The element figures describe the button's own clicks on product pages. They are not meant to reconcile to journey totals, which include sessions that add to cart through other routes.

---

## Appendix B: counting the manual iterations

| Round | Dimensions | Cycles | Minutes per cycle | Hours |
|---|---|---|---|---|
| 1. Journeys by source | 8 weeks × 5 source values × 2 journeys | 80 | 2.0 | 2.7 |
| 2. Journeys by device | 8 weeks × 3 device values × 2 journeys | 48 | 2.0 | 1.6 |
| 3. Heatmaps | 5 pages × 8 weeks × 2 devices × 4 sources | 320 renders | 1.5 | 8.0 |
| 4. Assembly, checking, decomposition | — | — | — | 1–2 |
| **Total, right segmentations first** | | **448 query cycles** | | **~13–14** |
| Each wrong segmentation tried first (for example new against returning, 32 cycles; campaign, 48 cycles) | | +32 to +48 | 2.0 | +1 to +1.6 |

The total sits at the top of the 10-to-15-hour range quoted in the text. A faster investigator, or one who samples fewer heatmap combinations, lands lower. Each wrong guess adds to it.

Assumptions: 15 to 90 seconds of computation or render wait per cycle on a large site, plus reading and typing. One investigator, working without interruption. In practice, interruptions, context switches and re-work push the elapsed time to several days.

By comparison, each of the DSIP tables in §14.3 is one read of stored rows: under a second each, and a few minutes for the whole investigation, including the conversation.
