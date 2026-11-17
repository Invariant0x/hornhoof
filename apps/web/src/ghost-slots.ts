import type { CallMark, Department, OneShotStage } from './types';

type Slot = { key: string } & (
  { call: CallMark } | { call?: never; stage: OneShotStage['stage']; number: number; judge: boolean }
);

/* A live call lights its numbered place in a declared stage. Extra batches and ad hoc calls still get their own marks. */
export function ghostSlots(department: Department): Slot[] {
  const slots = new Map<string, Slot>();
  const extras: Slot[] = [];
  for (const { stage, fanOut, judge } of department.oneShotStages ?? []) {
    for (let number = 1; number <= fanOut; number++) {
      const key = `${stage}:${number}`;
      slots.set(key, { key, stage, number, judge: false });
    }
    if (judge) {
      const key = `${stage}:judge`;
      slots.set(key, { key, stage, number: fanOut + 1, judge: true });
    }
  }
  for (const call of department.calls ?? []) {
    const slot = slots.get(`${call.stage}:${call.judge ? 'judge' : call.number}`);
    if (slot && !slot.call) slots.set(slot.key, { key: slot.key, call });
    else extras.push({ key: call.id, call });
  }
  return [...slots.values(), ...extras];
}
