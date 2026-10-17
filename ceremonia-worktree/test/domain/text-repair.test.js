import { describe, expect, it } from 'vitest';
import { repairStrippedEscapes } from '../../src/domain/text-repair.js';

describe('repairStrippedEscapes', () => {
  it('restores Latin-1 letters whose backslash was stripped', () => {
    expect(repairStrippedEscapes('Kit Cu00f3ctel Hyaluron')).toBe('Kit Cóctel Hyaluron');
    expect(repairStrippedEscapes('Mascarilla De Alta Hidrataciu00f3n')).toBe('Mascarilla De Alta Hidratación');
    expect(repairStrippedEscapes('Pestau00f1as u00bfY tu?')).toBe('Pestañas ¿Y tu?');
  });

  it('restores the same letters when the backslash survived', () => {
    expect(repairStrippedEscapes('C\\u00f3ctel')).toBe('Cóctel');
  });

  it('leaves ASCII-range escapes and ordinary text alone', () => {
    expect(repairStrippedEscapes('SKU u0041-12')).toBe('SKU u0041-12');
    expect(repairStrippedEscapes('Plain title')).toBe('Plain title');
    expect(repairStrippedEscapes(null)).toBe('');
  });
});
