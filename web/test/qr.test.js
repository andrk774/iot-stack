// QR-кодировщик: размеры и служебные узоры; если есть Python с OpenCV — настоящее распознавание.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { qrMatrix } from '../public/assets/qr.js';

const SAMPLES = [
  'hello',
  'otpauth://totp/iot.example.com%3Aandrey%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=iot.example.com&algorithm=SHA1&digits=6&period=30',
  'Домашний IoT — проверка UTF-8 '.repeat(4),
  'x'.repeat(300),
];

test('matrix size grows with data, finder patterns in corners', () => {
  const m1 = qrMatrix('hello');
  assert.equal(m1.length, 21); // версия 1
  const big = qrMatrix('x'.repeat(300));
  assert.ok(big.length > 41 && (big.length - 17) % 4 === 0);
  for (const m of [m1, big]) {
    const n = m.length;
    for (const [x, y] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      assert.equal(m[y][x], true);
      assert.equal(m[y + 1][x + 1], false);
      assert.equal(m[y + 3][x + 3], true);
    }
    assert.equal(m[n - 8][8], true); // «тёмный модуль»
  }
  assert.throws(() => qrMatrix('x'.repeat(3000)));
});

const py = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' });
test('OpenCV decodes generated codes', { skip: py.status !== 0 && 'нет python3 с cv2' }, () => {
  const script = `
import sys, json, cv2, numpy as np
for item in json.load(sys.stdin):
    m = np.array(item, dtype=np.uint8)
    img = np.where(m == 1, 0, 255).astype(np.uint8)
    img = np.pad(img, 4, constant_values=255)
    img = cv2.resize(img, (img.shape[1] * 8, img.shape[0] * 8), interpolation=cv2.INTER_NEAREST)
    text, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    print(json.dumps(text))
`;
  const input = JSON.stringify(SAMPLES.map((s) => qrMatrix(s).map((r) => r.map((v) => (v ? 1 : 0)))));
  const out = spawnSync('python3', ['-c', script], { input, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const decoded = out.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(decoded, SAMPLES);
});
