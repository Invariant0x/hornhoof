import { errorText, useT } from '../i18n';
import { isAway } from '../api';
import { useServiceView } from './ServiceRoad';

/* What a screen shows of a failed load: nothing for a failure that is the server being away, an update included, while the
   service road says it, since the load asks again by itself once the state ends; any other failure as it is. */
export function shownLoadFailure(failure: unknown, serviceSaysIt: boolean): unknown {
  if (failure === undefined || (serviceSaysIt && isAway(failure))) return null;
  return failure;
}

/* Whether the service road says a state now, in its window or its strip. */
export const useServiceSaysIt = (): boolean => useServiceView() !== null;

export const useLoadFailure = (failure: unknown): unknown => shownLoadFailure(failure, useServiceSaysIt());

/* The bar of a failed load. A failure of something the person did is not one: it stays by its button. */
export function LoadFailure({ failure }: { failure: unknown }) {
  const t = useT();
  const shown = useLoadFailure(failure);
  if (shown === null) return null;
  return <p className="alert" role="alert"><span dir="auto">{errorText(t, shown)}</span></p>;
}
