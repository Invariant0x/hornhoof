import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { enterLight, isRenderStorm, leaveLight, useLight } from '../guard';
import { useT } from '../i18n';

/* reset: what the block shows, such as the department open in it; when it changes, a stopped block draws again. float: the
   block stands on its own over the page, as an agent's window does, and so does what stands in for it. */
type Props = { block: string; children: ReactNode; reset?: unknown; float?: boolean };
type State = { error: unknown; round: number };

/* What stands in a stopped block: why it stopped, and a button that draws it anew. */
function GuardStop({ storm, float, onRestart }: { storm: boolean; float: boolean; onRestart: () => void }) {
  const t = useT();
  return (
    <div className={float ? 'guard-stop float' : 'guard-stop'} role="alert">
      <p dir="auto">{storm ? t.guard.stopped : t.guard.failed}</p>
      <button className="btn" type="button" onClick={onRestart}>
        {t.guard.restart}
      </button>
    </div>
  );
}

/* Keeps a block that fails or draws without end off the page while the rest of it works. A block that drew without end
   turns the page light too. The restart draws the block anew from nothing, as when it first opened. */
export class GuardBoundary extends Component<Props, State> {
  state: State = { error: null, round: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (isRenderStorm(error)) enterLight('render', this.props.block);
    console.error(`Hornhoof stopped the block ${this.props.block}.`, error, info.componentStack);
  }

  componentDidUpdate(before: Props): void {
    if (this.state.error && before.reset !== this.props.reset) this.restart();
  }

  private restart = () => this.setState(({ round }) => ({ error: null, round: round + 1 }));

  render() {
    const { error, round } = this.state;
    if (error) return <GuardStop storm={isRenderStorm(error)} float={!!this.props.float} onRestart={this.restart} />;
    return <Fragment key={round}>{this.props.children}</Fragment>;
  }
}

/* While the page is light, a line says why and turns the effects back on. */
export function LightNotice() {
  const t = useT();
  const light = useLight();
  if (!light) return null;
  return (
    <div className="light-note" role="status">
      <p>{t.guard.light}</p>
      <button className="btn ghost" type="button" onClick={leaveLight}>
        {t.guard.effectsBack}
      </button>
    </div>
  );
}
