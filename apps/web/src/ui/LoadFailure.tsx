import { createContext, useContext } from 'react';
import { ApiFailure } from '../api';
import { errorText, useT } from '../i18n';

/* Whether the update panel shows an update in progress, as the Shell knows it. The panel says Hornhoof takes no changes
   until the update ends, so a load the server refused for that has nothing to add. */
export const UpdateSaysIt = createContext(false);

const maintenanceRefusal = (failure: unknown): boolean => failure instanceof ApiFailure && failure.status === 503 && failure.reason === 'maintenance';

/* What a screen shows of a failed load: nothing for a maintenance refusal while the update panel says it, since the load
   asks again by itself once the update ends; any other failure as it is. */
export function shownLoadFailure(failure: unknown, updateSaysIt: boolean): unknown {
  if (failure === undefined || (updateSaysIt && maintenanceRefusal(failure))) return null;
  return failure;
}

export const useUpdateSaysIt = (): boolean => useContext(UpdateSaysIt);

export const useLoadFailure = (failure: unknown): unknown => shownLoadFailure(failure, useUpdateSaysIt());

/* The bar of a failed load. A failure of something the person did is not one: it stays by its button. */
export function LoadFailure({ failure }: { failure: unknown }) {
  const t = useT();
  const shown = useLoadFailure(failure);
  if (shown === null) return null;
  return <p className="alert" role="alert"><span dir="auto">{errorText(t, shown)}</span></p>;
}
