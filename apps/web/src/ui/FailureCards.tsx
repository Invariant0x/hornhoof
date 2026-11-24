import { useT } from '../i18n';
import type { Decisions, GitHubLimitCard, MachineAwayCard } from '../types';

/* What Failures shows besides its tasks: the machines that went away and the repositories GitHub's request limit holds back.
   A server from before either sends none. */
export function failureCards(decisions: Decisions | undefined): { machinesAway: MachineAwayCard[]; githubLimits: GitHubLimitCard[] } {
  return { machinesAway: decisions?.machinesAway ?? [], githubLimits: decisions?.githubLimits ?? [] };
}

/* Each repository GitHub's request limit holds back, and when its blocked action can be tried again. */
export function GitHubLimitCards({ cards }: { cards: GitHubLimitCard[] }) {
  const t = useT();
  return (
    <>
      {cards.map(({ repository, resetAt }) => (
        <section className="machine-away" key={repository} aria-label={t.tasks.githubLimit(repository)}>
          <h3 dir="auto">{t.tasks.githubLimit(repository)}</h3>
          <p>{resetAt === null ? t.tasks.githubLimitUnknown : t.tasks.githubLimitRetry(new Date(resetAt).toISOString().slice(11, 16))}</p>
        </section>
      ))}
    </>
  );
}
