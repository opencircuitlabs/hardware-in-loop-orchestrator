#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resumeManifest, runCampaign, ScriptedExecutor, toJUnit, validateCampaign } from './index.js';

const args = process.argv.slice(2); const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
try {
  const command = args[0] ?? 'run'; const campaign = JSON.parse(readFileSync(args[1], 'utf8'));
  if (command === 'validate') { const result = validateCampaign(campaign); console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1; }
  else if (command === 'run') { const scriptFile = value('--script'); if (!scriptFile) throw new Error('--script is required by the portable CLI'); const scripted = new ScriptedExecutor(JSON.parse(readFileSync(scriptFile, 'utf8'))); const resume = value('--resume') ? JSON.parse(readFileSync(value('--resume'), 'utf8')) : undefined; const report = await runCampaign(campaign, (job, resource, context) => scripted.execute(job, resource, context), { maxConcurrency: value('--concurrency') ? Number(value('--concurrency')) : undefined, failFast: args.includes('--fail-fast'), resumeFrom: resume }); const output = value('--output'); const text = JSON.stringify(report, null, 2) + '\n'; if (output) writeFileSync(output, text); else process.stdout.write(text); if (value('--junit')) writeFileSync(value('--junit'), toJUnit(report)); if (value('--save-resume')) writeFileSync(value('--save-resume'), JSON.stringify(resumeManifest(report), null, 2) + '\n'); if (report.status !== 'passed') process.exitCode = 2; }
  else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
