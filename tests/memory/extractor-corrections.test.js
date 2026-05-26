'use strict';

/*
 * Direct extractor tests for the correction / negation pattern set.
 *
 * Covers every phrasing the operator's live test surfaced:
 *
 *   - "Daniel is not my brother" (+ punctuation variants)
 *   - "Daniel is not my brother…" (unicode ellipsis terminator)
 *   - "Daniel is not my brother and never has been" (trailing context)
 *   - "Daniel is not actually related to me"
 *   - "That information is wrong" / "That's wrong"
 *   - "I never said that"
 *   - "Do not remember that"
 *   - "Forget that relationship"
 *   - "Don't treat Daniel as my brother" (+ "as a relative")
 *
 * Each test asserts the extractor produces a CORRECTION:/RETRACTION:
 * fact at high confidence so the writer's correction loop picks it
 * up. Negative cases (affirmative statements that should still
 * extract, questions that should not) are included as guardrails so
 * future tightening doesn't accidentally break them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMemoriableFacts } = require('../../src/memory/extractor');

async function extractAll(message) {
  const facts = await extractMemoriableFacts(message, {});
  return facts || [];
}

function hasCorrectionWith(facts, substring) {
  return facts.some(
    (f) => f.confidence >= 0.8 && (f.content.startsWith('CORRECTION:') || f.content.startsWith('RETRACTION:')) && f.content.includes(substring)
  );
}

function hasAnyCorrection(facts) {
  return facts.some(
    (f) => f.confidence >= 0.8 && (f.content.startsWith('CORRECTION:') || f.content.startsWith('RETRACTION:'))
  );
}

// ---------------------------------------------------------------
// "<Name> is not my <relationship>" — relationship-specific
// ---------------------------------------------------------------

test('Daniel is not my brother', async () => {
  const facts = await extractAll('Daniel is not my brother');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'),
    'extractor must produce a CORRECTION naming brother+Daniel');
});

test('Daniel is not my brother. (trailing period)', async () => {
  const facts = await extractAll('Daniel is not my brother.');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'));
});

test('Daniel is not my brother... (trailing three-dot ellipsis)', async () => {
  const facts = await extractAll('Daniel is not my brother...');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'));
});

test('Daniel is not my brother… (unicode ellipsis terminator)', async () => {
  const facts = await extractAll('Daniel is not my brother…');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'),
    'unicode ellipsis must be accepted as a terminator');
});

test('Daniel is not my brother and never has been (trailing context)', async () => {
  const facts = await extractAll('Daniel is not my brother and never has been');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'),
    'pattern must allow trailing context after the relationship word');
});

test('Correction: Daniel is not my brother (prefixed)', async () => {
  const facts = await extractAll('Correction: Daniel is not my brother');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'));
});

test('Actually, Daniel is not my brother', async () => {
  const facts = await extractAll('Actually, Daniel is not my brother');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'));
});

test('My brother is not Daniel (reverse phrasing)', async () => {
  const facts = await extractAll('My brother is not Daniel');
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'));
});

// ---------------------------------------------------------------
// "Don't treat X as Y" (with various determiners)
// ---------------------------------------------------------------

test("Don't treat Daniel as my brother", async () => {
  const facts = await extractAll("Don't treat Daniel as my brother");
  assert.ok(hasCorrectionWith(facts, 'brother named Daniel'));
});

test("Don't treat Daniel as a relative", async () => {
  const facts = await extractAll("Don't treat Daniel as a relative");
  assert.ok(hasCorrectionWith(facts, 'relative named Daniel'));
});

test('Do not treat Daniel as a family member', async () => {
  const facts = await extractAll('Do not treat Daniel as a family member');
  assert.ok(hasCorrectionWith(facts, 'Daniel'),
    'must produce a CORRECTION that mentions Daniel');
});

// ---------------------------------------------------------------
// "<Name> is not (actually) related to me"
// ---------------------------------------------------------------

test('Daniel is not actually related to me', async () => {
  const facts = await extractAll('Daniel is not actually related to me');
  assert.ok(hasCorrectionWith(facts, 'Daniel'),
    'must produce a CORRECTION mentioning Daniel');
});

// ---------------------------------------------------------------
// Generic retractions without a specific target. These don't have
// an entity for the writer to search/deactivate, but they should
// still be stored as a CORRECTION so retrieval surfaces them and
// the UNCERTAINTY_DIRECTIVE in the prompt instructs the model to
// hedge accordingly.
// ---------------------------------------------------------------

test("That's wrong (generic correction)", async () => {
  const facts = await extractAll("That's wrong");
  assert.ok(hasAnyCorrection(facts),
    "extractor must produce a CORRECTION for the generic 'that's wrong' marker");
});

test('That information is wrong', async () => {
  const facts = await extractAll('That information is wrong');
  assert.ok(hasAnyCorrection(facts));
});

test('I never said that', async () => {
  const facts = await extractAll('I never said that');
  assert.ok(hasAnyCorrection(facts));
});

test('Do not remember that', async () => {
  const facts = await extractAll('Do not remember that');
  assert.ok(hasAnyCorrection(facts));
});

test("Forget that relationship", async () => {
  const facts = await extractAll('Forget that relationship');
  assert.ok(hasAnyCorrection(facts));
});

// ---------------------------------------------------------------
// Affirmative statements must STILL extract correctly. The
// negation patterns must not regress these.
// ---------------------------------------------------------------

test('My brother is Daniel — affirmative still extracts as a fact', async () => {
  const facts = await extractAll('My brother is Daniel');
  // Must include an affirmative fact (NOT a CORRECTION)
  const affirmative = facts.find(
    (f) => !f.content.startsWith('CORRECTION:') && !f.content.startsWith('RETRACTION:')
      && f.content.toLowerCase().includes('brother')
      && f.content.toLowerCase().includes('daniel')
  );
  assert.ok(affirmative, 'affirmative relationship facts must still extract');
});

test('My favorite color is blue — affirmative still extracts', async () => {
  const facts = await extractAll('My favorite color is blue');
  const fact = facts.find((f) => f.content === "User's favorite color is blue");
  assert.ok(fact, 'favorite-color fact must still extract');
});

// ---------------------------------------------------------------
// Negative cases — must NOT extract anything.
// ---------------------------------------------------------------

test('Who is Daniel? — question must not extract', async () => {
  const facts = await extractAll('Who is Daniel?');
  assert.equal(facts.length, 0, 'questions must not produce facts');
});

test('Daniel called yesterday — narrative event, not a personal fact', async () => {
  const facts = await extractAll('Daniel called yesterday');
  assert.equal(facts.length, 0, 'narrative events must not extract as facts');
});

test('Treat Daniel well — not a negation', async () => {
  const facts = await extractAll('Treat Daniel well');
  assert.equal(facts.length, 0, 'affirmative imperatives must not produce CORRECTIONs');
});
