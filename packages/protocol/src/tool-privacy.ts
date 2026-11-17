import type { AgentEvent } from './index.js';

export type ToolPrivacyPolicy = { sensitive?: boolean; secretInput?: readonly string[]; secretOutput?: readonly string[]; secretCommand?: boolean; secretExecution?: boolean; delegatesTool?: boolean };
/* Registration and telemetry use the same definitions. No secret value belongs to replay or a transcript. */
export const PRIVATE_TOOLS = {
  entry: { name: 'vault_entry', _meta: { sensitive: true, secretInput: [], secretOutput: ['password', 'code'] } },
  save: { name: 'vault_save', _meta: { sensitive: true, secretInput: ['password', 'code'], secretOutput: [] } },
  phone: { name: 'phone_action', _meta: { secretExecution: true, secretInput: [], secretOutput: [] } },
  delegate: { name: 'use_tool', _meta: { delegatesTool: true } },
} as const;

export const PRIVATE_TOOL_NOTE = 'Sensitive tool data and raw terminal output hidden.';
export const PRIVATE_COMMAND_REFUSED = 'This command contains a vault secret and was not sent or recorded. Type the password with your own program on the machine instead.';
export const PRIVATE_TURN_LOST = 'The server restarted after this turn used a vault secret. Its temporary value masks are gone, so no new changes can be recorded. End this turn and start a new one.';

export function toolPrivacy(name: string): ToolPrivacyPolicy | undefined {
  const plain = name.split(/\.|__/).at(-1);
  return Object.values(PRIVATE_TOOLS).find(tool => tool.name === plain)?._meta;
}
export const isSensitiveTool = (name: string): boolean => toolPrivacy(name)?.sensitive === true;

/* A dispatching tool has no data policy of its own: the named target owns its input and reply. */
export function privateToolCall(name: string, input: unknown, resolve = toolPrivacy): { name: string; input: unknown; policy: ToolPrivacyPolicy | undefined } {
  let policy = resolve(name);
  for (let depth = 0; depth < 8 && policy?.delegatesTool; depth++) {
    const call = input as { name?: unknown; arguments?: unknown } | null;
    if (!call || typeof call.name !== 'string') break;
    name = call.name;
    input = call.arguments;
    policy = resolve(name);
  }
  return { name, input, policy };
}

/* Routing and typed discriminants are identities, not report text. A one-character password must not change a task
   reference or turn an event's kind into a different protocol message. */
const IDENTITY = /^(?:id|task|employee|agent|department|product|request|candidate|machine|run|subscription|commit|branch|kind|type|state|status|provider|wait)$|(?:Id|Ids|Sha|Commit|Kind|Class|Type|State|Status)$/;
const PROSE = new Set(['text', 'freshText', 'subject', 'summary', 'evidence', 'question', 'answer', 'why', 'reason', 'title', 'brief', 'body', 'description', 'note', 'label', 'message', 'prompt', 'command', 'sql', 'caption', 'comment', 'delta']);
const opaqueMedia = (value: unknown): boolean => Boolean(value && typeof value === 'object' && 'type' in value && (value.type === 'image' || value.type === 'audio'));

/* Values live only in the current turn's memory, for text that must still reach people. Short passwords and OTPs count
   too. JSON-escaped forms cover text nested in tool replies without putting a value in a persistent redactor. */
export class PrivateValues {
  private readonly values = new Set<string>();

  /* An upper bound on UTF-8 bytes to withhold while examining a streamed attachment. */
  get retainedBytes(): number { return Math.max(0, ...[...this.values].map(value => value.length * 4)); }

  remember(value: unknown, fields?: readonly string[]): void {
    if (fields) return this.rememberFields(value, fields);
    if (typeof value === 'string' && value) {
      this.rememberText(value);
    } else if (Array.isArray(value)) for (const item of value) this.remember(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) this.remember(item);
  }

  private rememberFields(value: unknown, fields: readonly string[]): void {
    if (value && typeof value === 'object') for (const field of fields) this.remember((value as Record<string, unknown>)[field]);
  }

  private rememberText(value: string): void {
    this.values.add(value);
    let form = value;
    for (let i = 0; i < 3; i++) { form = JSON.stringify(form).slice(1, -1); this.values.add(form); }
  }

  text(text: string): string {
    const forms = [...this.values].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return forms.length ? text.replace(new RegExp(forms.join('|'), 'g'), '[hidden]') : text;
  }

  contains(value: unknown): boolean {
    if (typeof value === 'string') return [...this.values].some(secret => value.includes(secret));
    if (Array.isArray(value)) return value.some(item => this.contains(item));
    if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) => !IDENTITY.test(key) && this.contains(item));
    return false;
  }

  hide<T>(value: T): T {
    /* Media is an opaque payload for the authorized caller, not text to rewrite. Its tool's privacy policy decides
       whether it may be persisted. A password fragment may coincidentally occur in base64. */
    if (opaqueMedia(value)) return value;
    if (typeof value === 'string') return this.hiddenString(value) as T;
    if (Array.isArray(value)) return value.map(item => this.hide(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IDENTITY.test(key) ? item : this.hide(item)])) as T;
    return value;
  }

  private hiddenString(value: string): string {
    if (this.values.has(value)) return '[hidden]';
    if (/^\s*[[{]/.test(value)) {
      try { return JSON.stringify(this.hide(JSON.parse(value))); }
      catch { /* A plain report may begin with a bracket. */ }
    }
    return this.text(value);
  }

  /* Tool arguments also carry UUID references, classifications, model names and other routing choices. Only prose is
     rewritten before a handler runs; a short password must not change the operation it was asked to perform. */
  input<T>(value: T): T {
    if (Array.isArray(value)) return value.map(item => this.input(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, PROSE.has(key) ? this.hide(item) : this.input(item)])) as T;
    return value;
  }
}

const parsed = (value: string): unknown => { try { return JSON.parse(value); } catch { return value; } };

/* Results have no call identity. After a sensitive call, subsequent inputs and results can contain it, including
   commands that type it into a form. Text and reports still reach people, with exact values hidden. */
export function privateToolEvent(event: AgentEvent, sensitive: boolean, untracked = false): AgentEvent {
  if (!sensitive && !sensitiveEvent(event)) return event;
  if (event.kind === 'tool') return { ...event, input: PRIVATE_TOOL_NOTE, sensitive: true };
  if (event.kind === 'tool_result') return { ...event, summary: PRIVATE_TOOL_NOTE };
  return untracked ? hiddenText(event) : event;
}

function sensitiveEvent(event: AgentEvent): boolean {
  return event.kind === 'tool' && (event.sensitive === true || privateToolCall(event.name, parsed(event.input)).policy?.sensitive === true);
}

function hiddenText(event: AgentEvent): AgentEvent {
  if (event.kind === 'text') return { ...event, text: PRIVATE_TOOL_NOTE };
  if (event.kind === 'todo') return { ...event, items: [] };
  return event;
}

export class ToolPrivacy {
  sensitive = false;
  readonly values = new PrivateValues();
  private readonly outputFields = new Set<string>();
  private plainOutput = false;
  private readonly executions = new Set<string>();

  /* Only the server's remembered vault values enable execution. Once typed, later captures of the same tool can show
     the value too. The program cannot opt into this by passing a flag. */
  execution(name: string, input: unknown): boolean {
    if (!this.sensitive) return false;
    if (this.executions.has(name)) return true;
    if (!this.values.contains(input)) return false;
    this.executions.add(name);
    return true;
  }

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

  event(event: AgentEvent, policy?: ToolPrivacyPolicy, resolve = toolPrivacy): AgentEvent {
    this.observe(event, policy, resolve);
    return this.values.hide(privateToolEvent(event, this.sensitive));
  }

  private observe(event: AgentEvent, policy: ToolPrivacyPolicy | undefined, resolve: typeof toolPrivacy): void {
    if (event.kind === 'tool') this.observeTool(event, policy, resolve);
    if (this.sensitive && event.kind === 'tool_result') this.result(parsed(event.summary), { secretOutput: this.plainOutput ? undefined : [...this.outputFields] });
  }

  private observeTool(event: Extract<AgentEvent, { kind: 'tool' }>, policy: ToolPrivacyPolicy | undefined, resolve: typeof toolPrivacy): void {
    const call = privateToolCall(event.name, parsed(event.input), name => name === event.name && policy ? policy : resolve(name));
    if (event.sensitive || call.policy?.sensitive) this.input(call.name, call.input, { ...call.policy, sensitive: true });
  }
}
