import { useRef } from 'react';
import { useT } from '../i18n';
import type { Updates, UpdateCut as Cut } from '../updates';
import { ConfirmAction } from './ConfirmAction';

/* Before an update now stops turns that run: how many, and nothing goes without a yes. */
export function UpdateCut({ cut, updates }: { cut: Cut; updates: Updates }) {
  const t = useT();
  const { confirmCut, dropCut } = updates;
  /* confirmCut clears cut when the update starts, or raises the turn count when more turns began. */
  const answered = useRef(false);
  return (
    <ConfirmAction
      title={t.updates.cutTitle}
      effect={t.updates.cutText(cut.turns)}
      yes={t.updates.cutYes}
      danger
      onYes={async () => {
        await confirmCut();
        answered.current = true;
      }}
      onClose={() => {
        if (answered.current) answered.current = false;
        else dropCut();
      }}
    />
  );
}
