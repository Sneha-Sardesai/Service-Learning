'use strict';

function normalizeFocusArea(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/^\s*(?:(?:\d+)[.)]\s*|[-*•]\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function focusAreaKey(value) {
  return normalizeFocusArea(value)
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function splitFocusAreas(...values) {
  const areas = new Map();
  for (const value of values) {
    const chunks = String(value ?? '').split(/[;\n|]+/u);
    for (const chunk of chunks) {
      // Some source cells put several numbered focus areas in one string. Split
      // only where the next numbered entry starts; commas inside a theme name
      // (for example "AI, IoT, Coding") remain part of that label.
      const entries = chunk.split(/(?:\s*,\s*|\s+)(?=\d+[.)]\s+)/u);
      for (const entry of entries) {
        const label = normalizeFocusArea(entry);
        const key = focusAreaKey(label);
        if (label && key && !areas.has(key)) areas.set(key, label);
      }
    }
  }
  return [...areas.values()];
}

module.exports = { focusAreaKey, normalizeFocusArea, splitFocusAreas };
