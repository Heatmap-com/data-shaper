import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog/index.js';
import { adapter as cardsQuiz } from '../src/adapters/datasets/cards-qz.js';
import { adapter as requirementStatus } from '../src/adapters/datasets/requirement-status.js';
import { quizPages } from '../src/adapters/subject-selectors/quiz-pages.js';

/**
 * The quiz subject: quiz-pages takes a page as a quiz on its URL first and
 * its p12.tools descriptor second; the QZ cards gate on the quiz events
 * the event contract does not record yet.
 */

const candidate = (hsr, url, entrySessions) => ({ url, type: 'content', title: '', hsr: String(hsr), entrySessions, orders: 0, revenue: 0, channel: '' });

const CANDIDATES = [
  candidate(1, 'https://x.com/pages/skin-QUIZ', 900),
  candidate(2, 'https://x.com/pages/finder', 800),
  candidate(3, 'https://x.com/pages/about', 700),
  candidate(4, 'https://x.com/quiz/step-1', 40),
];

const TOOLS = { 2: '["Shade quiz"]', 3: '["Size chart"]' };

describe('quiz-pages', () => {
  it('takes a quiz URL first and a quiz tool descriptor second, highest entry first', async () => {
    const reads = [];
    const subjects = await quizPages(CANDIDATES, {}, async (hsr) => {
      reads.push(hsr);
      return TOOLS[hsr] ?? '';
    });
    expect(subjects.map((s) => [s.subjectType, s.subjectKey, s.dims.signal, s.selectionReason])).toEqual([
      ['quiz', '1', 'url', 'URL holds "quiz" (900 exclude_confirmed sessions)'],
      ['quiz', '2', 'descriptor', 'descriptor p12.tools names "quiz" (800 exclude_confirmed sessions)'],
      ['quiz', '4', 'url', 'URL holds "quiz" (40 exclude_confirmed sessions)'],
    ]);
    expect(reads).toEqual(['2', '3']);
  });

  it('applies the entry floor, the limit, and the asked terms', async () => {
    const toolsOf = async (hsr) => TOOLS[hsr] ?? '';
    expect((await quizPages(CANDIDATES, { minEntrySessions: 100 }, toolsOf)).map((s) => s.subjectKey)).toEqual(['1', '2']);
    expect((await quizPages(CANDIDATES, { limitPerSite: 1 }, toolsOf)).map((s) => s.subjectKey)).toEqual(['1']);
    expect((await quizPages(CANDIDATES, { urlContains: ['finder'], toolTerms: ['size'] }, toolsOf)).map((s) => s.subjectKey))
      .toEqual(['2', '3']);
  });
});

describe('cards-qz', () => {
  it('builds one card per QZ strategy, each naming the missing quiz events', async () => {
    const page = { idsite: 1, idsitehsr: 7, qualified: { entrySessions: 100 } };
    const ctx = { datasets: new Map() };
    ctx.datasets.set('requirement-status', await requirementStatus.collect(page, ctx));
    const cards = await cardsQuiz.collect(page, ctx);
    const strategies = loadCatalog().strategies.QZ.strategies;
    expect(cards.rows.map((r) => r.dims.strategy_id)).toEqual(strategies.map((s) => s.id));
    for (const row of cards.rows) {
      expect(row.metrics.missing_requirements.some((key) => /^Q0[1-3]$/.test(key)), row.dims.strategy_id).toBe(true);
      expect(row.metrics.trigger_state, row.dims.strategy_id).not.toBe('silent');
    }
  });
});
