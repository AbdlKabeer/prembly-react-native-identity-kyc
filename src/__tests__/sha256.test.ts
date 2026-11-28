import { sha256Hex } from '../sha256';

// Node's own SHA-256 is the reference. `require` keeps this file free of Node type packages.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createHash } = require('crypto');

describe('sha256Hex', () => {
  it('matches the known answers', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches Node for text of every length around a block boundary and for non-ASCII', () => {
    const samples = [
      ...Array.from({ length: 140 }, (_, n) => 'x'.repeat(n)),
      'Zoë café 日本語 💳',
      JSON.stringify({ device: { model: 'Pixel 8', note: 'tést ✓' }, n: 1.5 }),
    ];
    for (const text of samples) {
      expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    }
  });
});
