import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { maxCpcInr, DEFAULT_MAX_CPC_INR } from '../src/config.ts';

test('max CPC: default is 4, a service can set its own, bad values are refused', () => {
  assert.equal(DEFAULT_MAX_CPC_INR, 4);
  assert.equal(maxCpcInr(undefined), 4);
  assert.equal(maxCpcInr(''), 4);
  assert.equal(maxCpcInr('  '), 4);
  assert.equal(maxCpcInr('5'), 5);
  assert.equal(maxCpcInr(' 4.5 '), 4.5);
  assert.equal(maxCpcInr('3.25'), 3.25);
  for (const bad of ['0', '-1', 'five', '5 rupees', '₹5', '4.555', 'Infinity', 'NaN']) {
    assert.throws(() => maxCpcInr(bad), /MAX_CPC_INR/, bad);
  }
});

// The cap is read once when the service starts, so each case runs in its own process.
function campaignCapMicros(env: Record<string, string>): { status: number | null; out: string; err: string } {
  const code = `
    const { campaignOperations } = await import('./src/ads.ts');
    const H = Array.from({ length: 15 }, (_, i) => 'Headline ' + i);
    const D = Array.from({ length: 4 }, (_, i) => 'Description number ' + i + '.');
    const plan = campaignOperations('938-000-0000', 'Chicken | T2 Fampy Eats 0001',
      [{ url: 'https://fampy.com/eats/a/', adGroup: 'chicken', keyword: 'chicken recipe', headlines: H, descriptions: D }],
      'customers/9380000000/labels/5');
    const c = plan.operations.find((o) => o.entity === 'campaign').resource;
    console.log(c.target_spend.cpc_bid_ceiling_micros + ' ' + c.name);
  `;
  const base = { ...process.env };
  delete base.MAX_CPC_INR;
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code], { env: { ...base, ...env }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('max CPC: a created campaign carries the cap of its service', () => {
  assert.equal(campaignCapMicros({}).out, '4000000 Chicken | T2 Fampy Eats 0001');
  assert.equal(campaignCapMicros({ MAX_CPC_INR: '5' }).out, '5000000 Chicken | T2 Fampy Eats 0001');
  const bad = campaignCapMicros({ MAX_CPC_INR: 'five' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.err, /MAX_CPC_INR must be a positive amount/);
});
