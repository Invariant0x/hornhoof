// Synthetic design review only. No runtime or quota producer imports this file.
const requiredFlags = [
  'running_artifact_bound',
  'runtime_version_bound',
  'process_generation_bound',
  'exclusive_noninteractive_stdin',
  'session_bound',
  'file_generation_bound',
  'complete_cursor_before_input',
  'byte_ranges_ordered',
  'single_native_prompt',
  'prompt_and_end_turn_match',
  'qualified_error_shape',
] as const;

export function evaluateDesign(record: Readonly<Record<string, unknown>>): 'SUFFICIENT_FOR_CODE' | 'UNKNOWN' {
  const profile = record.installed_profile === 'official_artifact_and_provenance_match';
  const mode = record.mode === 'headless_new_session_single_input';
  const excluded = [record.goal_or_background_or_reload, record.typed_before_ack].every(isFalse);
  const required = requiredFlags.every(field => record[field] === true);
  return profile && mode && excluded && required ? 'SUFFICIENT_FOR_CODE' : 'UNKNOWN';
}

function isFalse(value: unknown): boolean {
  return value === false;
}
