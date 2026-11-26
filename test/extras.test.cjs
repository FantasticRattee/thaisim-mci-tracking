const assert = require('assert');
(async () => {
  const extras = await import('../public/extras.js');
  assert.strictEqual(extras.normalizeCardCount(0), 12);
  assert.strictEqual(extras.normalizeCardCount(501), 500);
  assert.strictEqual(extras.normalizeStartCode('42'), 42);
  assert.strictEqual(
    extras.filterChemicals([{ nameThai: 'คลอรีน', un: '1017' }], '1017').length,
    1,
  );
})();
