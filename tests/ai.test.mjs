import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapFieldsWithGemini, describeForAI } from '../lib/ai.js';
import { newProfile, keyCatalog } from '../lib/schema.js';

test('Gemini request contains labels only, never profile values', async () => {
  const p = newProfile('Me');
  Object.assign(p.personal, { firstName: 'Asha', dob: '1996-03-07', aadhaar: '999988887777' });
  p.custom.push({ label: 'Employee ID', value: 'EX-1042' });

  const fields = [
    { tag: 'input', type: 'text', label: "Father's Name", name: 'father', section: 'Personal', value: 'SHOULD-NOT-LEAK' },
    { tag: 'select', type: '', label: 'Category', options: [{ text: '--Select--', placeholder: true }, { text: 'UR' }, { text: 'OBC' }] },
    { tag: 'input', type: 'text', label: 'Employee ID' }
  ];
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ mappings: [
        { i: 0, key: 'family.fatherName', confidence: 'high' },
        { i: 1, key: 'category.category', confidence: 'low' },
        { i: 2, key: 'not.a.real.key', confidence: 'high' }
      ] }) }] } }]
    }), { status: 200 });
  };

  const m = await mapFieldsWithGemini('KEY123', 'gemini-3.5-flash-lite', fields, keyCatalog(p));
  const body = sent.init.body;
  for (const secret of ['Asha', '1996', '999988887777', 'EX-1042', 'SHOULD-NOT-LEAK']) {
    assert.ok(!body.includes(secret), `request must not contain ${secret}`);
  }
  assert.ok(body.includes("Father's Name") && body.includes('Employee ID'));
  assert.ok(!body.includes('--Select--'), 'placeholder options are dropped');
  assert.ok(sent.url.includes('gemini-3.5-flash-lite:generateContent'));
  assert.ok(!sent.url.includes('KEY123'), 'API key goes in a header, not the URL');
  assert.equal(sent.init.headers['x-goog-api-key'], 'KEY123');
  assert.deepEqual(m.get(0), { key: 'family.fatherName', confidence: 'high', dateFormat: null });
  assert.equal(m.get(1).confidence, 'low');
  assert.equal(m.has(2), false, 'unknown keys are ignored');
});

test('describeForAI drops values and extra properties', () => {
  const d = describeForAI({ tag: 'input', type: 'text', label: 'Name', value: 'x', ffId: 'ff1', idAttr: 'n' }, 0);
  assert.deepEqual(Object.keys(d).sort(), ['i', 'label', 'type']);
});
