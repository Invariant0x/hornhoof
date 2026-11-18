import { ToolPrivacy, toolPrivacy, type AgentEvent, type ToolPrivacyPolicy } from '@hornhoof/protocol';
import type { Tmux } from './tmux.js';

/* A turn keeps the values its program must not show. */
type Private = { privacy?: ToolPrivacy };

/* What an agent's program must not show people: the values its sensitive tools take and give back, kept per turn and
   masked on the screens people watch and in the session's recording. */
export class SessionPrivacy {
  constructor(private readonly tmux: Pick<Tmux, 'outputValues' | 'maskRecording'>, private readonly log: (message: string) => void) {}

  /* A new turn's privacy starts from what the session's screens already mask. */
  fresh(session: string): ToolPrivacy {
    return new ToolPrivacy(this.tmux.outputValues(session));
  }

  /* A sensitive tool the program called, with its reply: their values join the turn's, or count for this call alone when
     no turn runs. */
  async tool(session: string, turn: Private | null, name: string, input: unknown, answer?: unknown, policy: ToolPrivacyPolicy | undefined = toolPrivacy(name)): Promise<void> {
    const privacy = turn ? this.of(turn, session) : this.fresh(session);
    privacy.input(name, input, policy);
    rememberSensitiveReply(privacy, answer, policy);
    await this.tmux.maskRecording(session);
  }

  /* An event of the program with the turn's values masked; a value it adds reaches the recording's masks too. */
  event(session: string, turn: Private, event: AgentEvent, policyOf: (name: string) => ToolPrivacyPolicy | undefined): AgentEvent {
    const privacy = this.of(turn, session);
    const before = privacy.values.forms();
    const masked = privacy.event(event, undefined, policyOf);
    if (before !== privacy.values.forms()) void this.tmux.maskRecording(session).catch(() => this.log('Terminal recorder did not receive its masks.'));
    return masked;
  }

  private of(turn: Private, session: string): ToolPrivacy {
    return (turn.privacy ??= this.fresh(session));
  }
}

function rememberSensitiveReply(privacy: ToolPrivacy, answer: unknown, policy: ToolPrivacyPolicy | undefined): void {
  if (!answer || typeof answer !== 'object') return;
  const content = (answer as { result?: { content?: { text?: string }[] } }).result?.content ?? [];
  for (const block of content) {
    if (typeof block.text !== 'string') continue;
    let value: unknown = block.text;
    try { value = JSON.parse(block.text); } catch { /* Plain sensitive replies are values too. */ }
    privacy.result(value, policy);
  }
}
