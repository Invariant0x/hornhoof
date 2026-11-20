import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { ModelTokens, SubView, TokenPeriods, TokenSum } from '../types';
import { Gauge } from './Cards';
import { tokenCount } from './token-count';
import { keepUnits, NBSP } from './units';

const PERIODS = ['today', 'week', 'month', 'all'] as const;

type Tokens = { tokens: TokenPeriods; models: ModelTokens[] };

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/* What a subscription's turns used, its today from midnight where the viewer is, and its 30 days by model. The list's
   sums, whose day is UTC's, stand in until the card's own answer comes, and again when a new turn adds to them. An older
   server tells no models. */
function useTokens(sub: SubView): Tokens | null {
  const [own, setOwn] = useState<Tokens | null>(null);
  const turns = sub.tokens?.all.turns;
  useEffect(() => {
    let live = true;
    api.get<{ tokens: TokenPeriods; models?: ModelTokens[] }>(`/api/subscriptions/${sub.id}/tokens?zone=${encodeURIComponent(viewerZone())}`).then(
      answer => live && setOwn({ tokens: answer.tokens, models: answer.models ?? [] }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [sub.id, turns]);
  return own ?? (sub.tokens ? { tokens: sub.tokens, models: [] } : null);
}

/* A figure in one piece that reads left to right, its number with its unit or percent sign, so a page laid out right to
   left keeps «25 млн» whole and the words around it stand mirrored (Design #1053). */
const Piece = ({ text }: { text: string }) => <bdi dir="ltr">{text}</bdi>;

/* A count of tokens on screen, short from a million. */
export function TokenCount({ count }: { count: number }) {
  const { language } = useLanguage();
  return <Piece text={tokenCount(language, count)} />;
}

/* A period's tile: its name in one piece as «7 дней», the short count on screen, the whole one in its name and tooltip,
   then input, output and cache, each on one line with its count. */
function PeriodGauge({ label, sum, t, language }: { label: string; sum: TokenSum; t: Messages; language: Language }) {
  const full = t.subs.tokens.full(new Intl.NumberFormat(language).format(sum.total), sum.total);
  const split = [[t.subs.tokens.input, sum.input], [t.subs.tokens.output, sum.output], [t.subs.tokens.cache, sum.cacheRead + sum.cacheWrite]] as const;
  return <Gauge label={<Piece text={keepUnits(label)} />} name={`${label}: ${full}`} title={full} figure={<TokenCount count={sum.total} />} sub={split.map(([term, count]) => <span key={term}>{`${term}${NBSP}`}<TokenCount count={count} /></span>)} empty={!sum.turns} />;
}

/* Each model's share of the connection's 30 days, the largest first, under the name the connection lists it by. */
function ModelShares({ sub, models }: { sub: SubView; models: ModelTokens[] }) {
  const t = useT();
  const { language } = useLanguage();
  const whole = models.reduce((sum, m) => sum + m.total, 0);
  if (!whole) return null;
  const share = new Intl.NumberFormat(language, { style: 'percent' });
  const name = (model: string | null) => (model === null ? t.subs.tokens.defaultModel : (sub.models?.find(m => m.id === model)?.name ?? model));
  return <div className="models">
    <h6 className="part-h">{t.subs.tokens.byModel}</h6>
    <ul>{models.map(m => <li key={m.model ?? ''}>
      <span className="mname">{name(m.model)}</span>
      <span className="dd"><Piece text={new Intl.NumberFormat(language).format(m.total)} /><small><Piece text={share.format(m.total / whole)} /></small></span>
      <span className="bar" aria-hidden="true"><i style={{ inlineSize: `${(m.total * 100) / whole}%` }} /></span>
    </li>)}</ul>
  </div>;
}

/* The tokens of the subscription today, in 7 and 30 days and all along, each split into input, output and cache, with
   the turns whose program told none, and the 30 days by model where turns told theirs. */
export function TokenGauges({ sub }: { sub: SubView }) {
  const t = useT();
  const { language } = useLanguage();
  const own = useTokens(sub);
  if (!own) return <p className="part-note">{t.subs.tokens.none}</p>;
  const { tokens, models } = own;
  return <>
    <div className="gauges">
      {PERIODS.map(period => <PeriodGauge key={period} label={t.subs.tokens[period]} sum={tokens[period]} t={t} language={language} />)}
    </div>
    {tokens.all.noData > 0 && <p className="part-note">{t.subs.tokens.noData(tokens.all.noData)}</p>}
    <ModelShares sub={sub} models={models} />
  </>;
}
