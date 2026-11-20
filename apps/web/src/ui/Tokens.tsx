import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { ModelTokens, SubView, TokenPeriods, TokenSum } from '../types';
import { Gauge } from './Cards';
import { LoadState, noneYet, useLoad, type LoadPart } from './Loading';
import { tokenCount } from './token-count';

const PERIODS = ['today', 'week', 'month', 'all'] as const;

type Tokens = { tokens: TokenPeriods; models: ModelTokens[] };
/* A server that keeps no tokens for the plan: an answer, with nothing to show. */
const NONE = 'none';

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

type Own = Tokens | typeof NONE | null;

/* Asks for a subscription's tokens and keeps the answer, or why it failed, while the card still wants it: a server that keeps
   none for the plan answers that it has none. Returns what stops the card wanting the answer. */
function askTokens(id: string, setOwn: Dispatch<SetStateAction<Own>>, setFailure: (failure: unknown) => void): () => void {
  let live = true;
  setFailure(null);
  api.get<{ tokens: TokenPeriods; models?: ModelTokens[] }>(`/api/subscriptions/${id}/tokens?zone=${encodeURIComponent(viewerZone())}`).then(
    answer => live && setOwn({ tokens: answer.tokens, models: answer.models ?? [] }),
    error => live && (noneYet(error) ? setOwn(o => o ?? NONE) : setFailure(error)),
  );
  return () => {
    live = false;
  };
}

/* What the card shows: its own answer, else the list's sums, else that there are none, or nothing yet. */
function tokensShown(own: Own, sums: TokenPeriods | undefined): Own {
  const fromList = sums ? { tokens: sums, models: [] } : null;
  return own === NONE ? (fromList ?? NONE) : (own ?? fromList);
}

/* What a subscription's turns used, its today from midnight where the viewer is, and its 30 days by model, as a part of
   the card's load. The list's sums, whose day is UTC's, stand in until the card's own answer comes, and again when a new
   turn adds to them. An older server tells no models. */
function useTokens(sub: SubView): LoadPart & { data: Own } {
  const [own, setOwn] = useState<Own>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [round, setRound] = useState(0);
  const turns = sub.tokens?.all.turns;
  useEffect(() => askTokens(sub.id, setOwn, setFailure), [sub.id, turns, round]);
  return { data: tokensShown(own, sub.tokens), failure, load: () => setRound(r => r + 1) };
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
   then input, output and cache. */
function PeriodGauge({ label, sum, t, language }: { label: string; sum: TokenSum; t: Messages; language: Language }) {
  const full = t.subs.tokens.full(new Intl.NumberFormat(language).format(sum.total), sum.total);
  const split = [[t.subs.tokens.input, sum.input], [t.subs.tokens.output, sum.output], [t.subs.tokens.cache, sum.cacheRead + sum.cacheWrite]] as const;
  return <Gauge label={<Piece text={label} />} name={`${label}: ${full}`} title={full} figure={<TokenCount count={sum.total} />} sub={split.map(([term, count]) => <span key={term}>{`${term} `}<TokenCount count={count} /></span>)} empty={!sum.turns} />;
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
  const part = useTokens(sub);
  const load = useLoad([part]);
  const own = part.data;
  /* Until the tokens came, their room holds the ring: it never says that there were no turns before the answer. */
  if (load.phase !== 'done') return <LoadState load={load} />;
  if (!own || own === NONE) return <p className="part-note">{t.subs.tokens.none}</p>;
  const { tokens, models } = own;
  return <>
    <div className="gauges">
      {PERIODS.map(period => <PeriodGauge key={period} label={t.subs.tokens[period]} sum={tokens[period]} t={t} language={language} />)}
    </div>
    {tokens.all.noData > 0 && <p className="part-note">{t.subs.tokens.noData(tokens.all.noData)}</p>}
    <ModelShares sub={sub} models={models} />
  </>;
}
