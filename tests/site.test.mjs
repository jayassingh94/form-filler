import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sitePattern } from '../lib/site.js';

test('site permission pattern from tab URL', () => {
  assert.deepEqual(sitePattern('http://localhost:8765/sample-form.html'), { pattern: 'http://localhost/*' });
  assert.deepEqual(sitePattern('https://ssc.gov.in/apply?x=1#top'), { pattern: 'https://ssc.gov.in/*' });
  assert.deepEqual(sitePattern('http://127.0.0.1:3000/'), { pattern: 'http://127.0.0.1/*' });
  assert.deepEqual(sitePattern('http://[::1]:8080/form'), { pattern: 'http://[::1]/*' });
  assert.deepEqual(sitePattern('file:///Users/me/form.html'), { pattern: 'file:///*' });
  assert.deepEqual(sitePattern('chrome://extensions/'), { reason: 'restricted' });
  assert.deepEqual(sitePattern('chrome-extension://abc/options.html'), { reason: 'restricted' });
  assert.deepEqual(sitePattern('https://chromewebstore.google.com/detail/x'), { reason: 'restricted' });
  assert.deepEqual(sitePattern(undefined), { reason: 'unknown' });
  assert.deepEqual(sitePattern(''), { reason: 'unknown' });
});
