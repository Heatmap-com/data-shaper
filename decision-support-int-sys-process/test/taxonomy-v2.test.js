import { describe, expect, it } from 'vitest';
import {
  ELEMENT_CLASSES,
  ELEMENT_ROLES,
  isElementClass,
  isElementRole,
  elementRoles,
  PG_CLASSES,
  PLAN_CLASSES,
  TAXONOMY_VERSION,
  V1_CLASSES,
  V1_TO_V2,
} from '../src/domain/taxonomy.js';

/**
 * Taxonomy v2 (data-capture-plan.md §6.3): 54 classes (19 v1 kept + 20 from
 * PG §8 + 15 plan-added), a bounded element_role per class, and the v1 → v2
 * mapping. The version bump deliberately stales every stored name and
 * capture, re-queuing every page (Phase 4 task 5).
 */

describe('taxonomy v2 classes', () => {
  it('exports 54 classes: 19 v1 + 20 PG + 15 plan-added', () => {
    expect(V1_CLASSES).toHaveLength(19);
    expect(PG_CLASSES).toHaveLength(20);
    expect(PLAN_CLASSES).toHaveLength(15);
    expect(ELEMENT_CLASSES).toHaveLength(54);
    expect(new Set(ELEMENT_CLASSES).size).toBe(54);
    for (const cls of [...V1_CLASSES, ...PG_CLASSES, ...PLAN_CLASSES]) {
      expect(ELEMENT_CLASSES).toContain(cls);
    }
  });

  it('keeps every v1 class and maps it to itself in V1_TO_V2', () => {
    for (const cls of V1_CLASSES) {
      expect(V1_TO_V2[cls]).toBe(cls);
    }
    expect(Object.keys(V1_TO_V2)).toHaveLength(19);
  });

  it('isElementClass accepts taxonomy strings and rejects everything else', () => {
    expect(isElementClass('sticky_atc')).toBe(true);
    expect(isElementClass('proof_badge')).toBe(true);
    expect(isElementClass('gallery_item')).toBe(true);
    for (const bad of ['', 'hero', 'Hero CTA', 'page', 'pdp', 'not_a_class', 'nav-link', undefined, null]) {
      expect(isElementClass(/** @type {string} */ (bad))).toBe(false);
    }
  });

  it('bumps TAXONOMY_VERSION so every stored capture goes stale', () => {
    expect(TAXONOMY_VERSION).toBe('2026-10-04.2');
    expect(TAXONOMY_VERSION).not.toBe('2026-10-03');
  });
});

describe('ELEMENT_ROLES bounded vocabularies (§6.3)', () => {
  it('bounds exactly the classes the plan lists', () => {
    expect(Object.keys(ELEMENT_ROLES).sort()).toEqual(
      [
        'carousel_control',
        'content_section',
        'form_field',
        'nav_link',
        'outbound_link',
        'payment_option',
        'policy_link',
        'popup_control',
        'proof_badge',
        'reassurance_item',
        'urgency_element',
      ].sort(),
    );
  });

  it('carries the plan role values per class', () => {
    expect(ELEMENT_ROLES.nav_link).toEqual(['primary', 'submenu', 'footer', 'utility']);
    expect(ELEMENT_ROLES.content_section).toEqual([
      'hero',
      'proof',
      'how_it_works',
      'comparison',
      'faq_block',
      'reviews_block',
      'story',
      'ingredients_specs',
      'guarantee',
      'founder',
      'ugc',
      'other',
    ]);
    expect(ELEMENT_ROLES.payment_option).toEqual(['bnpl', 'express', 'wallet', 'card']);
    expect(ELEMENT_ROLES.reassurance_item).toEqual(['shipping', 'returns', 'guarantee', 'security']);
    expect(ELEMENT_ROLES.carousel_control).toEqual(['next', 'prev', 'dot', 'pause']);
    expect(ELEMENT_ROLES.urgency_element).toEqual(['stock', 'timer', 'shipping_cutoff']);
    expect(ELEMENT_ROLES.form_field).toEqual(['required', 'optional']);
    expect(ELEMENT_ROLES.popup_control).toEqual(['open', 'dismiss', 'submit']);
    expect(ELEMENT_ROLES.outbound_link).toEqual(['social', 'marketplace', 'other']);
    expect(ELEMENT_ROLES.policy_link).toEqual(['shipping', 'returns', 'privacy', 'terms']);
    expect(ELEMENT_ROLES.proof_badge).toEqual(['press', 'rating', 'units_sold', 'certification']);
  });

  it('roles are bounded: inside true, outside false', () => {
    expect(isElementRole('nav_link', 'primary')).toBe(true);
    expect(isElementRole('nav_link', 'hero')).toBe(false);
    expect(isElementRole('payment_option', 'bnpl')).toBe(true);
    expect(isElementRole('payment_option', 'primary')).toBe(false);
    expect(isElementRole('proof_badge', 'units_sold')).toBe(true);
    expect(isElementRole('proof_badge', 'trustpilot')).toBe(false);
  });

  it('role-less classes report [] and never accept a role', () => {
    for (const cls of ELEMENT_CLASSES) {
      if (ELEMENT_ROLES[cls]) continue;
      expect(elementRoles(cls), cls).toEqual([]);
      expect(isElementRole(cls, 'primary'), cls).toBe(false);
      expect(isElementRole(cls, ''), cls).toBe(false);
    }
    // spot-check classes from each group
    for (const cls of ['product_tile', 'sticky_atc', 'gallery_item', 'review_item', 'cart_icon', 'video_player']) {
      expect(elementRoles(cls)).toEqual([]);
      expect(isElementRole(cls, 'anything')).toBe(false);
    }
  });

  it('elementRoles is [] for strings that are not taxonomy classes', () => {
    expect(elementRoles('not_a_class')).toEqual([]);
    expect(isElementRole('not_a_class', 'primary')).toBe(false);
  });
});
