# Hardware-in-the-Loop Orchestrator

A capability-aware scheduler for running dependency-ordered test campaigns across scarce, exclusive lab hardware.

The orchestrator matches jobs to compatible rigs, holds exclusive leases, respects a job DAG, runs independent work concurrently, retries transient failures, propagates dependency failures, supports fail-fast campaigns, and produces resumable state and JUnit results.

It is designed to sit above [`device-test-runner`](https://github.com/opencircuitlabs/device-test-runner): the orchestrator decides *where and when* a job runs, while a runner or remote agent performs the actual hardware steps.

## Quick start

```bash
npm install
npm test
node src/cli.js validate examples/campaign.json
node src/cli.js run examples/campaign.json \
  --script examples/passing-script.json \
  --output campaign-result.json \
  --junit campaign.xml \
  --save-resume resume.json
```

The portable CLI uses a deterministic scripted executor for CI. A production executor receives the job, leased resource, abort signal, attempt number, and campaign context:

```js
const report = await runCampaign(campaign, async (job, resource, context) => {
  return remoteAgents.get(resource.id).run(job.plan, {
    signal: context.signal,
    attempt: context.attempt
  });
});
```

## Resource matching

Each resource has a stable ID and capability list. Job requirements support:

- exact resource `id` pinning;
- `all`: every capability must be present;
- `any`: at least one capability must be present;
- `none`: excluded capabilities.

Selection is deterministic by resource ID. A resource can have only one active lease. Quarantined resources are excluded until an operator creates a healthy pool; the quarantine reason remains in the audit history.

## Scheduling semantics

- Jobs start only after every dependency passes.
- Independent ready jobs run up to `maxConcurrency` and available-rig limits.
- A failed dependency skips downstream jobs with an explicit reason.
- A job without any matching resource becomes skipped and the campaign is `incomplete`.
- Timeouts abort the executor signal; retries remain inside the same exclusive lease.
- Leases are released after success, failure, or timeout.
- Fail-fast prevents new pending work while already running jobs finish safely.

Campaign validation rejects duplicate IDs, dangling dependencies, cycles, malformed capabilities, and invalid retry settings before allocation begins.

## Resume and reports

`resumeManifest(report)` records only proven passing jobs. Supplying it as `resumeFrom` marks those jobs passed without repeating hardware actions; downstream dependency checks work normally. Failed, skipped, or incomplete jobs are never treated as completed.

The result includes attempts, outputs, durations, rig assignment, scheduling timeline, lease history, final resource states, and counts. JUnit output maps each campaign job to a test case for CI visibility.

## License

MIT
