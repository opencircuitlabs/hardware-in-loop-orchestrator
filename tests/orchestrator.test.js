import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesResource, ResourcePool, resumeManifest, runCampaign, ScriptedExecutor, toJUnit, validateCampaign } from '../src/index.js';
const campaign = JSON.parse(readFileSync(new URL('../examples/campaign.json', import.meta.url), 'utf8'));
const script = JSON.parse(readFileSync(new URL('../examples/passing-script.json', import.meta.url), 'utf8'));

test('example campaign validates', () => assert.deepEqual(validateCampaign(campaign), { valid: true, issues: [] }));
test('resource selectors support id, all, any, and none', () => {
  const resource = campaign.resources[0]; assert.equal(matchesResource(resource, { all: ['ice40'], any: ['serial', 'logic-analyzer'], none: ['esp32'] }), true); assert.equal(matchesResource(resource, { id: 'other' }), false);
});
test('resource pool creates exclusive leases and checks ownership', () => {
  const pool = new ResourcePool(campaign.resources); const lease = pool.tryAcquire({ all: ['logic-analyzer'] }, 'job-a', 1); assert.equal(lease.id, 'rig-ice40-a'); assert.equal(pool.tryAcquire({ all: ['logic-analyzer'] }, 'job-b'), null); assert.throws(() => pool.release(lease.id, 'job-b'), /not leased/); pool.release(lease.id, 'job-a', 2); assert.equal(pool.snapshot()[0].state, 'available');
});
test('campaign honors dependencies and completes on matching rigs', async () => {
  const executor = new ScriptedExecutor(script); const report = await runCampaign(campaign, (j, r, c) => executor.execute(j, r, c)); assert.equal(report.status, 'passed'); assert.equal(report.counts.passed, 4); const flashEnd = report.timeline.find((x) => x.type === 'job-end' && x.jobId === 'flash-ice40').atMs; assert.ok(report.timeline.filter((x) => x.type === 'job-start' && ['power-check','protocol-check'].includes(x.jobId)).every((x) => x.atMs >= flashEnd)); assert.ok(report.resources.every((r) => r.state === 'available'));
});
test('failed jobs retry and recover on the same lease', async () => {
  const retryScript = structuredClone(script); retryScript['flash-ice40'] = [{ error: 'probe busy' }, { output: { verified: true } }]; const executor = new ScriptedExecutor(retryScript); const report = await runCampaign(campaign, (j,r,c) => executor.execute(j,r,c)); const flash = report.jobs.find((j) => j.id === 'flash-ice40'); assert.equal(flash.status, 'passed'); assert.equal(flash.attempts.length, 2);
});
test('dependency failure skips downstream jobs', async () => {
  const bad = structuredClone(script); bad.build = [{ error: 'compile failed' }]; const executor = new ScriptedExecutor(bad); const report = await runCampaign(campaign, (j,r,c) => executor.execute(j,r,c)); assert.equal(report.status, 'failed'); assert.equal(report.jobs.find((j) => j.id === 'flash-ice40').status, 'skipped'); assert.equal(report.counts.skipped, 3);
});
test('jobs without matching resources become incomplete', async () => {
  const missing = structuredClone(campaign); missing.jobs = [{ id: 'needs-jtag', requires: { all: ['jtag'] } }]; const report = await runCampaign(missing, async () => true); assert.equal(report.status, 'incomplete'); assert.equal(report.jobs[0].reason, 'no matching resource');
});
test('resume manifest prevents already-passed jobs from rerunning', async () => {
  const first = await runCampaign(campaign, (j,r,c) => new ScriptedExecutor(script).execute(j,r,c));
  const manifest = resumeManifest(first); const executor = new ScriptedExecutor(script); const second = await runCampaign(campaign, (j,r,c) => executor.execute(j,r,c), { resumeFrom: manifest }); assert.equal(second.counts.resumed, 4); assert.equal(executor.calls.length, 0);
});
test('cycle and dangling dependency validation is actionable', () => {
  const cyclic = structuredClone(campaign); cyclic.jobs = [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]; assert.match(validateCampaign(cyclic).issues[0].message, /cycle/);
  const dangling = structuredClone(campaign); dangling.jobs[0].dependsOn = ['missing']; assert.match(validateCampaign(dangling).issues[0].message, /unknown/);
});
test('quarantine removes resources from allocation', () => {
  const pool = new ResourcePool(campaign.resources); pool.quarantine('rig-ice40-a', 'overcurrent'); const lease = pool.tryAcquire({ all: ['ice40'] }, 'job'); assert.equal(lease.id, 'rig-ice40-b'); assert.equal(pool.history[0].type, 'quarantine');
});
test('JUnit includes failed and skipped campaign jobs', () => {
  const report = { campaign: 'lab & test', counts: { total: 2, failed: 1, skipped: 1 }, jobs: [{ id: 'a', status: 'failed', message: '<bad>', durationMs: 1 }, { id: 'b', status: 'skipped', reason: 'dependency', durationMs: 0 }] }; const xml = toJUnit(report); assert.match(xml, /lab &amp; test/); assert.match(xml, /&lt;bad&gt;/); assert.match(xml, /<skipped/);
});
