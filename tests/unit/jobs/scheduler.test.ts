import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { cancelJobsFor, listJobsFor, pendingJobs, recoverStaleJobs, registerJobHandler, resetJobHandlersForTests, runDueJobs, scheduleJob, sqliteTime } from '../../../src/jobs/scheduler';

// The durable job schedule: rows in scheduled_jobs, run when due, idempotent by dedupe key, retried then failed visibly, re-queued after a crash.
beforeAll(() => { getDb(); });
afterEach(() => { resetJobHandlersForTests(); getDb().prepare('DELETE FROM scheduled_jobs').run(); });

const T0 = new Date('2026-10-07T09:00:00Z');

describe('scheduleJob', () => {
  it('is idempotent by dedupe key: a second call re-times a pending job and never creates a duplicate; done jobs are left alone unless reopened', () => {
    const a = scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 7, runAt: T0, dedupeKey: 'followup:k:7' });
    const b = scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 7, runAt: new Date(T0.getTime() + 60_000), dedupeKey: 'followup:k:7' });
    expect(b.id).toBe(a.id);
    expect(b.run_at).toBe(sqliteTime(T0.getTime() + 60_000));
    expect(pendingJobs()).toHaveLength(1);
    getDb().prepare(`UPDATE scheduled_jobs SET status = 'done' WHERE id = ?`).run(a.id);
    expect(scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 7, runAt: T0, dedupeKey: 'followup:k:7' }).status).toBe('done');
    expect(scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 7, runAt: T0, dedupeKey: 'followup:k:7', reopen: true }).status).toBe('pending');
  });
});

describe('runDueJobs', () => {
  it('runs only due jobs, in order, inside the job\'s account; a cancelled job never runs', async () => {
    const ran: string[] = [];
    registerJobHandler('k', (job, payload) => { ran.push(`${job.ref_id}:${String(payload.n)}`); });
    scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 1, runAt: T0, dedupeKey: 'a', payload: { n: 1 } });
    scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 2, runAt: new Date(T0.getTime() + 3_600_000), dedupeKey: 'b', payload: { n: 2 } });
    scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 3, runAt: T0, dedupeKey: 'c', payload: { n: 3 } });
    expect(cancelJobsFor('followup', 3)).toBe(1);
    expect(await runDueJobs(new Date(T0.getTime() + 1000))).toBe(1);
    expect(ran).toEqual(['1:1']);
    expect(listJobsFor('followup', 1)[0]!.status).toBe('done');
    expect(listJobsFor('followup', 2)[0]!.status).toBe('pending');
    expect(listJobsFor('followup', 3)[0]!.status).toBe('cancelled');
    expect(await runDueJobs(new Date(T0.getTime() + 2 * 3_600_000))).toBe(1);
    expect(ran).toEqual(['1:1', '2:2']);
  });
  it('a failing handler is retried later and marked failed after the third attempt, with the error visible; an unknown kind fails at once', async () => {
    let calls = 0;
    registerJobHandler('boom', () => { calls += 1; throw new Error('provider down'); });
    scheduleJob({ accountId: 1, kind: 'boom', refKind: 'followup', refId: 9, runAt: T0, dedupeKey: 'boom:9' });
    scheduleJob({ accountId: 1, kind: 'nobody', refKind: 'followup', refId: 9, runAt: T0, dedupeKey: 'nobody:9' });
    await runDueJobs(T0);
    let row = listJobsFor('followup', 9).find((j) => j.kind === 'boom')!;
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'provider down' });
    expect(listJobsFor('followup', 9).find((j) => j.kind === 'nobody')).toMatchObject({ status: 'failed', last_error: 'no handler registered' });
    await runDueJobs(new Date(Date.now() + 10 * 60_000));
    await runDueJobs(new Date(Date.now() + 20 * 60_000));
    row = listJobsFor('followup', 9).find((j) => j.kind === 'boom')!;
    expect(row.status).toBe('failed');
    expect(calls).toBe(3);
  });
  it('a job left running by a crash is re-queued at boot and survives: nothing is lost on restart', async () => {
    registerJobHandler('k', vi.fn());
    const job = scheduleJob({ accountId: 1, kind: 'k', refKind: 'followup', refId: 5, runAt: T0, dedupeKey: 'k:5' });
    getDb().prepare(`UPDATE scheduled_jobs SET status = 'running' WHERE id = ?`).run(job.id);
    expect(recoverStaleJobs()).toBe(1);
    expect(listJobsFor('followup', 5)[0]!.status).toBe('pending');
    expect(await runDueJobs(T0)).toBe(1);
  });
});
