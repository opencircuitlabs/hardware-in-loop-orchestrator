const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function validateCampaign(campaign) {
  const issues = []; const fail = (path, message) => issues.push({ path, message });
  if (!campaign || typeof campaign !== 'object' || Array.isArray(campaign)) return { valid: false, issues: [{ path: '$', message: 'must be an object' }] };
  if (campaign.schemaVersion !== 1) fail('schemaVersion', 'must equal 1'); if (!campaign.name?.trim()) fail('name', 'is required');
  if (!Array.isArray(campaign.resources) || !campaign.resources.length) fail('resources', 'must be non-empty'); if (!Array.isArray(campaign.jobs) || !campaign.jobs.length) fail('jobs', 'must be non-empty');
  const resourceIds = new Set(); for (const [i, resource] of (campaign.resources ?? []).entries()) { if (!ID.test(resource.id ?? '')) fail(`resources.${i}.id`, 'is invalid'); if (resourceIds.has(resource.id)) fail(`resources.${i}.id`, 'is duplicated'); resourceIds.add(resource.id); if (!Array.isArray(resource.capabilities)) fail(`resources.${i}.capabilities`, 'must be an array'); }
  const jobIds = new Set(); for (const [i, job] of (campaign.jobs ?? []).entries()) { if (!ID.test(job.id ?? '')) fail(`jobs.${i}.id`, 'is invalid'); if (jobIds.has(job.id)) fail(`jobs.${i}.id`, 'is duplicated'); jobIds.add(job.id); if (job.dependsOn && !Array.isArray(job.dependsOn)) fail(`jobs.${i}.dependsOn`, 'must be an array'); if (job.retries != null && (!Number.isInteger(job.retries) || job.retries < 0)) fail(`jobs.${i}.retries`, 'must be non-negative'); }
  for (const [i, job] of (campaign.jobs ?? []).entries()) for (const dependency of job.dependsOn ?? []) if (!jobIds.has(dependency)) fail(`jobs.${i}.dependsOn`, `references unknown job ${dependency}`);
  if (!issues.length) { const cycle = findCycle(campaign.jobs); if (cycle) fail('jobs', `dependency cycle: ${cycle.join(' -> ')}`); }
  return { valid: issues.length === 0, issues };
}

function findCycle(jobs) { const map = new Map(jobs.map((job) => [job.id, job.dependsOn ?? []])); const visiting = new Set(); const done = new Set(); const path = []; const visit = (id) => { if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id]; if (done.has(id)) return null; visiting.add(id); path.push(id); for (const dep of map.get(id) ?? []) { const cycle = visit(dep); if (cycle) return cycle; } path.pop(); visiting.delete(id); done.add(id); return null; }; for (const id of map.keys()) { const cycle = visit(id); if (cycle) return cycle; } return null; }

export function matchesResource(resource, requirements = {}) { const capabilities = new Set(resource.capabilities ?? []); return (!requirements.id || resource.id === requirements.id) && (requirements.all ?? []).every((tag) => capabilities.has(tag)) && (!(requirements.any?.length) || requirements.any.some((tag) => capabilities.has(tag))) && (requirements.none ?? []).every((tag) => !capabilities.has(tag)); }

export class ResourcePool {
  constructor(resources) { this.resources = resources.map((resource) => ({ ...structuredClone(resource), state: 'available', lease: null })); this.history = []; }
  tryAcquire(requirements, jobId, at = Date.now()) { const resource = this.resources.filter((item) => item.state === 'available' && matchesResource(item, requirements)).sort((a, b) => a.id.localeCompare(b.id))[0]; if (!resource) return null; resource.state = 'leased'; resource.lease = { jobId, acquiredAt: at }; this.history.push({ type: 'acquire', resourceId: resource.id, jobId, at }); return structuredClone(resource); }
  release(resourceId, jobId, at = Date.now()) { const resource = this.resources.find((item) => item.id === resourceId); if (!resource) throw new Error(`Unknown resource: ${resourceId}`); if (resource.state !== 'leased' || resource.lease?.jobId !== jobId) throw new Error(`Resource ${resourceId} is not leased by ${jobId}`); resource.state = 'available'; resource.lease = null; this.history.push({ type: 'release', resourceId, jobId, at }); }
  quarantine(resourceId, reason, at = Date.now()) { const resource = this.resources.find((item) => item.id === resourceId); if (!resource) throw new Error(`Unknown resource: ${resourceId}`); resource.state = 'quarantined'; resource.lease = null; resource.quarantineReason = reason; this.history.push({ type: 'quarantine', resourceId, reason, at }); }
  snapshot() { return this.resources.map((resource) => structuredClone(resource)); }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function executeWithRetries(job, resource, executor, campaignContext) { const attempts = []; const started = performance.now(); for (let attempt = 1; attempt <= (job.retries ?? 0) + 1; attempt++) { const controller = new AbortController(); let timer; try { const operation = executor(structuredClone(job), structuredClone(resource), { signal: controller.signal, attempt, campaign: campaignContext }); const output = job.timeoutMs ? await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`Job timed out after ${job.timeoutMs} ms`)); }, job.timeoutMs); })]) : await operation; clearTimeout(timer); attempts.push({ attempt, status: 'passed' }); return { status: 'passed', output, attempts, durationMs: performance.now() - started }; } catch (error) { clearTimeout(timer); attempts.push({ attempt, status: 'failed', message: error.message }); if (attempt > (job.retries ?? 0)) return { status: 'failed', message: error.message, attempts, durationMs: performance.now() - started }; if (job.retryDelayMs) await wait(job.retryDelayMs); } } }

export async function runCampaign(input, executor, options = {}) {
  const validation = validateCampaign(input); if (!validation.valid) throw new Error(validation.issues.map((x) => `${x.path}: ${x.message}`).join('; ')); if (typeof executor !== 'function') throw new Error('executor must be a function');
  const pool = options.resourcePool ?? new ResourcePool(input.resources); const previous = new Map((options.resumeFrom?.jobs ?? []).filter((job) => job.status === 'passed').map((job) => [job.id, job])); const status = new Map(); const results = new Map(); for (const job of input.jobs) { if (previous.has(job.id)) { status.set(job.id, 'passed'); results.set(job.id, { ...structuredClone(previous.get(job.id)), resumed: true }); } else status.set(job.id, 'pending'); }
  const running = new Map(); const timeline = []; const startedAt = new Date().toISOString(); const started = performance.now(); const maxConcurrency = Math.max(1, options.maxConcurrency ?? input.maxConcurrency ?? input.resources.length); let failFastTriggered = false;
  const startJob = (job, resource) => { status.set(job.id, 'running'); timeline.push({ type: 'job-start', jobId: job.id, resourceId: resource.id, atMs: performance.now() - started }); const promise = executeWithRetries(job, resource, executor, { name: input.name }).then((result) => ({ job, resource, result }), (error) => ({ job, resource, result: { status: 'failed', message: error.message, attempts: [], durationMs: 0 } })); running.set(job.id, promise); };
  while ([...status.values()].some((value) => value === 'pending' || value === 'running')) {
    let changed = false;
    for (const job of input.jobs) if (status.get(job.id) === 'pending') {
      const deps = job.dependsOn ?? []; const failedDependency = deps.find((id) => ['failed', 'skipped'].includes(status.get(id)));
      if (failedDependency) { status.set(job.id, 'skipped'); results.set(job.id, { id: job.id, status: 'skipped', reason: `dependency ${failedDependency} did not pass`, attempts: [], durationMs: 0 }); changed = true; continue; }
      if (failFastTriggered) { status.set(job.id, 'skipped'); results.set(job.id, { id: job.id, status: 'skipped', reason: 'fail-fast', attempts: [], durationMs: 0 }); changed = true; continue; }
      if (!deps.every((id) => status.get(id) === 'passed') || running.size >= maxConcurrency) continue;
      const resource = pool.tryAcquire(job.requires ?? {}, job.id); if (!resource) continue; startJob(job, resource); changed = true;
    }
    if (running.size) { const completed = await Promise.race(running.values()); running.delete(completed.job.id); pool.release(completed.resource.id, completed.job.id); const record = { id: completed.job.id, resourceId: completed.resource.id, ...completed.result }; status.set(completed.job.id, record.status); results.set(completed.job.id, record); timeline.push({ type: 'job-end', jobId: completed.job.id, resourceId: completed.resource.id, status: record.status, atMs: performance.now() - started }); if (record.status === 'failed' && (options.failFast ?? input.failFast)) failFastTriggered = true; changed = true; }
    if (!changed) { const pending = input.jobs.filter((job) => status.get(job.id) === 'pending'); for (const job of pending) { status.set(job.id, 'skipped'); results.set(job.id, { id: job.id, status: 'skipped', reason: 'no matching resource', attempts: [], durationMs: 0 }); } }
  }
  const jobs = input.jobs.map((job) => results.get(job.id)); const counts = { total: jobs.length, passed: jobs.filter((j) => j.status === 'passed').length, failed: jobs.filter((j) => j.status === 'failed').length, skipped: jobs.filter((j) => j.status === 'skipped').length, resumed: jobs.filter((j) => j.resumed).length };
  return { schemaVersion: 1, campaign: input.name, startedAt, durationMs: performance.now() - started, status: counts.failed ? 'failed' : counts.skipped ? 'incomplete' : 'passed', counts, jobs, timeline, resourceHistory: pool.history, resources: pool.snapshot() };
}

export function resumeManifest(report) { return { schemaVersion: 1, campaign: report.campaign, jobs: report.jobs.filter((job) => job.status === 'passed').map((job) => ({ id: job.id, status: 'passed', resourceId: job.resourceId, output: job.output, attempts: job.attempts, durationMs: job.durationMs })) }; }
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function toJUnit(report) { const cases = report.jobs.map((job) => `  <testcase classname="${xml(report.campaign)}" name="${xml(job.id)}" time="${((job.durationMs ?? 0) / 1000).toFixed(6)}">${job.status === 'failed' ? `<failure message="${xml(job.message ?? 'failed')}"/>` : job.status === 'skipped' ? `<skipped message="${xml(job.reason)}"/>` : ''}</testcase>`); return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(report.campaign)}" tests="${report.counts.total}" failures="${report.counts.failed}" skipped="${report.counts.skipped}">\n${cases.join('\n')}\n</testsuite>\n`; }

export class ScriptedExecutor {
  constructor(script = {}) { this.script = new Map(Object.entries(script)); this.calls = []; }
  async execute(job, resource, context) { this.calls.push({ jobId: job.id, resourceId: resource.id, attempt: context.attempt }); const entries = this.script.get(job.id) ?? []; const entry = entries[Math.min(context.attempt - 1, entries.length - 1)]; if (!entry) throw new Error(`No scripted result for ${job.id}`); if (entry.delayMs) await wait(entry.delayMs); if (entry.error) throw new Error(entry.error); return structuredClone(entry.output); }
}
