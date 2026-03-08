/**
 * HTML Entity Decoder
 *
 * Decodes HTML entities using JSDOM (already in dependencies)
 * Prevents tokenizer crashes from encoded text (e.g., &amp;, &#39;, &quot;)
 */

import { JSDOM } from 'jsdom';

/**
 * Decode HTML entities in text
 * Converts &amp;, &amp;#39;, &quot;, etc. to their actual characters
 */
// Reuse JSDOM instance to prevent memory leaks
let dom: JSDOM | null = null;

export function decodeHtmlEntities(text: string): string {
  if (!text) return text;

  // Quick check: if no entities, return as-is (optimization)
  if (!text.includes('&')) return text;

  try {
    // Lazy-initialize shared JSDOM instance
    if (!dom) {
      dom = new JSDOM();
    }

    const parser = new dom.window.DOMParser();
    const doc = parser.parseFromString(`<!doctype html><body>${text}`, 'text/html');
    const decoded = doc.body.textContent || text;

    // Clean up document to prevent memory accumulation
    doc.body.innerHTML = '';

    return decoded;
  } catch (error) {
    console.error('HTML decode failed, returning original text:', error);
    return text;
  }
}
