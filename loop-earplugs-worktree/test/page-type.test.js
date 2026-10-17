import { describe, expect, it } from 'vitest';
import { pageType } from '../src/page-type.js';

// The same URLs as page_type.py's suite, plus branch boundaries.
describe('pageType', () => {
  it('classifies the Python suite URLs', () => {
    expect(pageType('https://curiouselixirs.com/')).toBe('home');
    expect(pageType('https://hyperlitemountaingear.com/products/x')).toBe('product');
    expect(pageType('https://x.com/collections/x/products/y')).toBe('product');
    expect(pageType('https://x.com/pages/x')).toBe('content');
    expect(pageType('')).toBe('unknown');
    expect(pageType(null)).toBe('unknown');
    expect(pageType(undefined)).toBe('unknown');
    expect(pageType('https://x.com/?a=1')).toBe('home');
    expect(pageType('https://x.com')).toBe('home');
  });

  it('strips query and fragment', () => {
    expect(pageType('https://x.com/products/a?size=m#reviews')).toBe('product');
    expect(pageType('https://x.com/pages/guide?utm_source=email')).toBe('content');
  });

  it('bare paths without scheme or host', () => {
    expect(pageType('/')).toBe('home');
    expect(pageType('/products')).toBe('product');
    expect(pageType('/collections')).toBe('collection');
    expect(pageType('/cart/')).toBe('cart');
    expect(pageType('/search?q=x')).toBe('search');
  });

  it('branch boundaries', () => {
    expect(pageType('https://x.com/cart')).toBe('cart');
    expect(pageType('https://x.com/blogs/news/post')).toBe('content');
    expect(pageType('https://x.com/blog')).toBe('other'); // /blogs prefix only
    expect(pageType('https://x.com/checkout')).toBe('checkout');
    expect(pageType('https://x.com/account/login')).toBe('account');
    expect(pageType('https://x.com/shop')).toBe('other');
    expect(pageType('https://x.com/PRODUCTS/Big')).toBe('product');
    expect(pageType('https://x.com/accounting')).toBe('account');
  });
});
