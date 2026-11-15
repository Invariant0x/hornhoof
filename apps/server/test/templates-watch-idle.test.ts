import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../src/modules/templates/load.js';

/* These tests read the skill's text. They show what the watchdog is told, not what a model does with it. */
const body = loadTemplates(fileURLToPath(new URL('../../../templates', import.meta.url))).skills.get('ops-task-watch')!.body;
const step = body.split('\n').find(line => line.startsWith('6. ')) ?? '';

describe('what the watchdog is told about people who stand free', () => {
  describe('a department with free members and a task that waits for an answer from outside gets no letter', () => {
    it('counts only tasks that wait for other tasks of the same department as work that waits', () => {
      expect(step).toMatch(/Work waits in a department only when tasks in it wait for other tasks of the same department/);
    });

    it('leaves out each kind of wait no free member can take', () => {
      expect(step).toMatch(/A task that waits for a person, an answer from outside, a machine or a stand does not count, even with every member free/);
    });

    it('says the watchdog reads those waits from agents, where it can see them', () => {
      expect(step).toMatch(/agents shows each task's open waits/);
    });
  });

  describe('the same picture after the head moved gets no letter', () => {
    it('reads a move with the same picture as the head\'s decision, and stays silent about the department', () => {
      expect(step).toMatch(/When the head moved after your message and members still stand free under the same picture, it has decided there is nothing to give out: say nothing about that department until the picture changes/);
    });

    it('says what a move is and where it shows', () => {
      expect(step).toMatch(/A move is anything the head did after your message, which agents shows as its last activity/);
    });
  });

  describe('a picture that changed gets a new letter', () => {
    it('gives each picture one letter', () => {
      expect(step).toMatch(/When two or more members of a department are free while work waits, tell its head with message_employee, once for each picture/);
    });

    it('names everything that changes a picture, and only that', () => {
      expect(step).toMatch(/The picture changes when one more member becomes free, a new task appears or a task that was waited for closes\./);
    });

    it('no longer repeats by the clock', () => {
      expect(step).not.toMatch(/thirty minutes/);
    });
  });

  describe('Operations hears only when the head made no move', () => {
    it('tells the head of Operations when the head made no move in the two rounds after the letter', () => {
      expect(step).toMatch(/When the head made no move in the two rounds after your message, tell your own head, the head of Operations, who tells the orchestrator/);
    });

    it('does not tell it when the head moved', () => {
      expect(step).toMatch(/When the head moved, do not tell it/);
    });

    it('no longer goes up only because the department still stands free', () => {
      expect(step).not.toMatch(/still stands free two rounds/);
    });
  });

  it('never advises what to give out or how', () => {
    expect(step).toMatch(/Say only what you see, and never advise what to give out or how: the head knows its work and decides/);
  });

  it('counts for the head what the rule counts', () => {
    expect(step).toMatch(/how many tasks of the department are open and how many of them wait for other tasks of the department/);
  });

  it('stays abstract: no dates, numbers of tasks, names or em dashes', () => {
    expect(step).not.toBe('');
    expect(step).not.toMatch(/#\d|\b20\d\d\b|\u2014|@\S+\.\S+|(?<=[a-z,;:]\s)(?!Operations\b)[A-Z][a-z]+/);
  });
});
