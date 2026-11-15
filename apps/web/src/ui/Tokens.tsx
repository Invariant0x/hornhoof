import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLanguage, useT } from '../i18n';
import type { SubView, TokenPeriods } from '../types';
import { Gauge } from './Cards';
import { tokenCount } from './token-count';

const PERIODS = ['today', 'week', 'month', 'all'] as const;


const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/* What a subscription's turns used, its today from midnight where the viewer is. The list's sums, whose day is UTC's,
   stand in until the card's own answer comes, and again when a new turn adds to them. */
function useTokens(sub: SubView): TokenPeriods | null {
  const [own, setOwn] = useState<TokenPeriods | null>(null);
  const turns = sub.tokens?.all.turns;
  useEffect(() => {
    let live = true;
    api.get<{ tokens: TokenPeriods }>(`/api/subscriptions/${sub.id}/tokens?zone=${encodeURIComponent(viewerZone())}`).then(
      answer => live && setOwn(answer.tokens),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sub.id, turns]);
  return own ?? sub.tokens ?? null;
}

/* The tokens of the subscription today, in 7 and 30 days and all along, each split into input, output and cache, with
   the turns whose program told none. */
export function TokenGauges({ sub }: { sub: SubView }) {
  const t = useT();
  const { language } = useLanguage();
  const tokens = useTokens(sub);
  if (!tokens) return <p className="part-note">{t.subs.tokens.none}</p>;
  const n = (count: number) => tokenCount(language, count);
  return <>
    <div className="gauges">
      {PERIODS.map(period => {
        const sum = tokens[period];
        return <Gauge key={period} label={t.subs.tokens[period]} figure={n(sum.total)} sub={t.subs.tokens.split(n(sum.input), n(sum.output), n(sum.cacheRead + sum.cacheWrite))} empty={!sum.turns} />;
      })}
    </div>
    {tokens.all.noData > 0 && <p className="part-note">{t.subs.tokens.noData(tokens.all.noData)}</p>}
  </>;
}
