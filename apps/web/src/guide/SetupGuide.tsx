import { useRef, useState } from 'react';
import { useT } from '../i18n';
import { GuideCoach } from './GuideCoach';
import { loadPreSetupGuide, savePreSetupGuide } from './storage';
import type { GuidePhase, GuideStep } from './types';

export type SetupStage =
  | { kind: 'step'; index: 0 | 1 | 2; hasError: boolean }
  | { kind: 'link' }
  | { kind: 'machine' };

function setupStepInfo(stage: SetupStage): { step: GuideStep; phase: GuidePhase; anchors: string[] } {
  if (stage.kind === 'link') return { step: 'plan', phase: 'link_ready', anchors: ['Setup.linkNext'] };
  if (stage.kind === 'machine') return { step: 'machine', phase: 'guidance', anchors: ['Setup.machineCommand'] };
  if (stage.index === 0) return { step: 'company', phase: stage.hasError ? 'recovery' : 'guidance', anchors: ['Setup.companyName'] };
  if (stage.index === 1) return { step: 'account', phase: stage.hasError ? 'recovery' : 'guidance', anchors: ['Setup.yourName'] };
  return { step: 'plan', phase: stage.hasError ? 'recovery' : 'guidance', anchors: ['Setup.orchestratorMode'] };
}

function previousConfirmed(stage: SetupStage): GuideStep | null {
  if (stage.kind === 'step' && stage.index === 1) return 'company';
  if (stage.kind === 'step' && stage.index === 2) return 'account';
  return null;
}

/* Pre-setup guide state: persists only visibility and offers a quiet Resume button in Setup's card header. */
export function useSetupGuide() {
  const [skipped, setSkipped] = useState(() => loadPreSetupGuide().skipped);
  const [focusRequest, setFocusRequest] = useState(0);
  const resumeRef = useRef<HTMLButtonElement | null>(null);

  const skip = () => {
    setSkipped(true);
    savePreSetupGuide(true);
  };

  const resume = () => {
    setSkipped(false);
    savePreSetupGuide(false);
    setFocusRequest(n => n + 1);
  };

  return { skipped, focusRequest, resumeRef, skip, resume };
}

export function SetupResumeButton({ skipped, resumeRef, onResume }: {
  skipped: boolean;
  resumeRef: { current: HTMLButtonElement | null };
  onResume: () => void;
}) {
  const t = useT();
  if (!skipped) return null;
  return (
    <button ref={resumeRef} className="btn ghost guide-quiet" type="button" onClick={onResume}>
      {t.guide.resume}
    </button>
  );
}

export function SetupGuideCoach({ stage, guide }: { stage: SetupStage; guide: ReturnType<typeof useSetupGuide> }) {
  const info = setupStepInfo(stage);
  const confirmed = stage.kind === 'step' && !stage.hasError ? previousConfirmed(stage) : null;
  return (
    <GuideCoach
      visible={!guide.skipped}
      step={info.step}
      phase={info.phase}
      confirmedStep={confirmed}
      anchors={info.anchors}
      flowInline
      focusRequest={guide.focusRequest}
      fallbackFocusRef={guide.resumeRef}
      onSkip={guide.skip}
    />
  );
}
