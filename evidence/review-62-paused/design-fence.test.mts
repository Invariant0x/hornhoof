import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDesign } from './design-fence.mts';

const valid: Readonly<Record<string, unknown>> = Object.freeze({
  installed_profile: 'official_artifact_and_provenance_match',
  running_artifact_bound: true,
  runtime_version_bound: true,
  mode: 'headless_new_session_single_input',
  process_generation_bound: true,
  exclusive_noninteractive_stdin: true,
  session_bound: true,
  file_generation_bound: true,
  complete_cursor_before_input: true,
  byte_ranges_ordered: true,
  single_native_prompt: true,
  prompt_and_end_turn_match: true,
  qualified_error_shape: true,
  goal_or_background_or_reload: false,
  typed_before_ack: false,
});

const ambiguousChanges: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  unknown_version: { installed_profile: 'unknown' },
  unverified_running_artifact: { running_artifact_bound: false },
  unknown_runtime_version: { runtime_version_bound: false },
  interactive_terminal: { mode: 'interactive_terminal' },
  resume_requires_a_separate_fence: { mode: 'headless_resume' },
  wrong_process_generation: { process_generation_bound: false },
  unbound_input: { exclusive_noninteractive_stdin: false },
  wrong_session: { session_bound: false },
  file_replacement_or_truncation: { file_generation_bound: false },
  missing_before_cursor: { complete_cursor_before_input: false },
  out_of_order_records: { byte_ranges_ordered: false },
  typed_before_ack: { typed_before_ack: true },
  multiple_native_prompts: { single_native_prompt: false },
  wrong_turn: { prompt_and_end_turn_match: false },
  ordinary_error_shape: { qualified_error_shape: false },
  goal_background_or_reload: { goal_or_background_or_reload: true },
};

test('synthetic valid vector is sufficient for design only', () => {
  assert.equal(evaluateDesign(valid), 'SUFFICIENT_FOR_CODE');
});

for (const [name, change] of Object.entries(ambiguousChanges)) {
  test(`original 75 design negative: ${name}`, () => {
    assert.equal(evaluateDesign({ ...valid, ...change }), 'UNKNOWN');
  });
}

for (const field of ['goal_or_background_or_reload', 'typed_before_ack']) {
  test(`missing ${field} is unknown`, () => {
    const record = { ...valid };
    delete record[field];
    assert.equal(evaluateDesign(record), 'UNKNOWN');
  });

  for (const value of [null, 0, '']) {
    test(`${field}=${JSON.stringify(value)} is unknown`, () => {
      assert.equal(evaluateDesign({ ...valid, [field]: value }), 'UNKNOWN');
    });
  }
}
