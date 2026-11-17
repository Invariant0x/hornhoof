import type { AgentEvent } from './index.js';

export type ToolPrivacyPolicy = { sensitive?: boolean; secretInput?: readonly string[]; secretOutput?: readonly string[]; secretCommand?: boolean };
/* Registration and telemetry use the same definitions. No secret value belongs to replay or a transcript. */
export const PRIVATE_TOOLS = {
  entry: { name: 'vault_entry', _meta: { sensitive: true, secretInput: [], secretOutput: ['password', 'code'] } },
  save: { name: 'vault_save', _meta: { sensitive: true, secretInput: ['password', 'code'], secretOutput: [] } },
} as const;

export const PRIVATE_TOOL_NOTE = 'Sensitive tool data hidden. The turn output is hidden too.';
export const PRIVATE_COMMAND_REFUSED = 'This command contains a vault secret and was not sent or recorded. Type the password with your own program on the machine instead.';
export const PRIVATE_TURN_LOST = 'The server restarted after this turn used a vault secret. Its temporary value masks are gone, so no new changes can be recorded. End this turn and start a new one.';

export function toolPrivacy(name: string): ToolPrivacyPolicy | undefined {
  const plain = name.split(/\.|__/).at(-1);
  return Object.values(PRIVATE_TOOLS).find(tool => tool.name === plain)?._meta;
}
export const isSensitiveTool = (name: string): boolean => toolPrivacy(name)?.sensitive === true;

/* Routing and typed discriminants are identities, not report text. A one-character password must not change a task
   reference or turn an event's kind into a different protocol message. */
const IDENTITY = /^(?:id|task|employee|agent|department|product|request|candidate|machine|run|subscription|commit|branch|kind|type|state|status|provider)$|(?:Id|Ids|Sha|Commit)$/;

/* Values live only in the current turn's memory, for text that must still reach people. Short passwords and OTPs count
   too. JSON-escaped forms cover text nested in tool replies without putting a value in a persistent redactor. */
export class PrivateValues {
  private readonly values = new Set<string>();

  remember(value: unknown, fields?: readonly string[]): void {
    if (fields) {
      if (value && typeof value === 'object') for (const field of fields) this.remember((value as Record<string, unknown>)[field]);
      return;
    }
    if (typeof value === 'string' && value) {
      this.values.add(value);
      let form = value;
      for (let i = 0; i < 3; i++) { form = JSON.stringify(form).slice(1, -1); this.values.add(form); }
    } else if (Array.isArray(value)) for (const item of value) this.remember(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) this.remember(item);
  }

  text(text: string): string {
    const forms = [...this.values].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return forms.length ? text.replace(new RegExp(forms.join('|'), 'g'), '[hidden]') : text;
  }

  hide<T>(value: T): T {
    if (typeof value === 'string') return this.text(value) as T;
    if (Array.isArray(value)) return value.map(item => this.hide(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IDENTITY.test(key) ? item : this.hide(item)])) as T;
    return value;
  }
}

const parsed = (value: string): unknown => { try { return JSON.parse(value); } catch { return value; } };

/* Results have no call identity. After a sensitive call, subsequent inputs and results can contain it, including
   commands that type it into a form. Text and reports still reach people, with exact values hidden. */
export function privateToolEvent(event: AgentEvent, sensitive: boolean, untracked = false): AgentEvent {
  if (!sensitive && !(event.kind === 'tool' && (event.sensitive || isSensitiveTool(event.name)))) return event;
  if (event.kind === 'tool') return { ...event, input: PRIVATE_TOOL_NOTE, sensitive: true };
  if (event.kind === 'tool_result') return { ...event, summary: PRIVATE_TOOL_NOTE };
  if (untracked && event.kind === 'text') return { ...event, text: PRIVATE_TOOL_NOTE };
  if (untracked && event.kind === 'todo') return { ...event, items: [] };
  return event;
}

export class ToolPrivacy {
  sensitive = false;
  readonly values = new PrivateValues();
  private readonly outputFields = new Set<string>();
  private plainOutput = false;

  input(name: string, input: unknown, policy = toolPrivacy(name)): void {
    if (!policy?.sensitive) return;
    this.sensitive = true;
    this.values.remember(input, policy.secretInput);
    if (policy.secretOutput === undefined) this.plainOutput = true;
    else for (const field of policy.secretOutput) this.outputFields.add(field);
  }

  result(result: unknown, policy?: ToolPrivacyPolicy): void {
    if (!this.sensitive) return;
    this.values.remember(result, policy?.secretOutput);
  }

  event(event: AgentEvent): AgentEvent {
    if (event.kind === 'tool' && (event.sensitive || isSensitiveTool(event.name))) this.input(event.name, parsed(event.input), toolPrivacy(event.name) ?? { sensitive: true });
    if (this.sensitive && event.kind === 'tool_result') this.result(parsed(event.summary), { secretOutput: this.plainOutput ? undefined : [...this.outputFields] });
    return this.values.hide(privateToolEvent(event, this.sensitive));
  }
}
