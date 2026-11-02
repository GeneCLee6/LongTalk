import { describe, expect, it } from 'vitest'
import { Scheduler } from '../../worker/scheduler.ts'

// e1-t04: every timed job of a Durable Object behind its one alarm

describe('Scheduler', () => {
  it('has no alarm until a job is set, then the earliest one', () => {
    const jobs = new Scheduler()
    expect(jobs.next()).toBeNull()
    jobs.set('close', 600)
    jobs.set('sweep', 15)
    jobs.set('handoff', 60)
    expect(jobs.next()).toBe(15)
    jobs.clear('sweep')
    expect(jobs.next()).toBe(60)
  })

  it('moves a job that is set again, but not with ensure', () => {
    const jobs = new Scheduler()
    jobs.set('sweep', 15)
    jobs.ensure('sweep', 30)
    expect(jobs.get('sweep')).toBe(15)
    jobs.set('sweep', 30)
    expect(jobs.get('sweep')).toBe(30)
    expect(jobs.get('close')).toBeNull()
  })

  it('takes what is due, earliest first, and keeps the rest', () => {
    const jobs = new Scheduler()
    jobs.set('close', 600)
    jobs.set('handoff', 60)
    jobs.set('sweep', 45)
    expect(jobs.take(10)).toEqual([])
    expect(jobs.take(60)).toEqual(['sweep', 'handoff'])
    expect(jobs.take(60)).toEqual([])
    expect(jobs.next()).toBe(600)
  })

  it('survives a round trip through storage, ignoring anything that is not a time', () => {
    const jobs = new Scheduler()
    jobs.set('sweep', 15)
    jobs.set('close', 600)
    const stored = JSON.parse(JSON.stringify(jobs)) as Record<string, number>
    expect(stored).toEqual({ sweep: 15, close: 600 })
    const again = new Scheduler({ ...stored, broken: Number.NaN })
    expect(again.toJSON()).toEqual(stored)
    expect(again.next()).toBe(15)
    again.clearAll()
    expect(again.next()).toBeNull()
  })
})
