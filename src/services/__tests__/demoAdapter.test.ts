import { describe, expect, it } from 'vitest';
import { demoAdapter } from '../demoAdapter';
import { createSeedState } from '../../data/seed';

describe('demoAdapter', () => {
  it('generates distinct reviewable plan variants', async () => {
    const planA = await demoAdapter.generatePlan('review usb', false);
    const planB = await demoAdapter.generatePlan('review usb', true);
    expect(planA.steps).toHaveLength(4);
    expect(planB.steps?.[1].title).not.toBe(planA.steps?.[1].title);
    expect(planA.planHash).not.toBe(planB.planHash);
  });

  it('returns structured read command logs', async () => {
    const log = await demoAdapter.executeCommand('eda.project.readCurrent', 'read');
    expect(log.status).toBe('success');
    expect(log.result).toContain('Mira Sense');
    expect(log.duration).toBeGreaterThanOrEqual(0);
  });

  it('runs every simulated validation check', async () => {
    const state = createSeedState();
    const result = await demoAdapter.runValidations(state.validations, () => undefined);
    expect(result).toHaveLength(8);
    expect(result.every((item) => item.status !== 'idle' && item.status !== 'running')).toBe(true);
  });
});
