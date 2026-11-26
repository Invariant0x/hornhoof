/* Fixed Stage 1 achievement catalogue and public-safe showcase builder.
   Catalogue keeps only IDs, structured rule numbers, tiers, display sizes, and artKey;
   all localized titles and captions are read from achievement-captions.json. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STATUE_STAGES,
  STATUE_TASKS_PER_STAGE,
  agentLevelThreshold,
} from '@hornhoof/protocol/world';
import { z } from 'zod';

export type AchievementScope = 'shared' | 'personal';
export type AchievementTier = 'bronze' | 'silver' | 'gold';
export type AchievementDisplay = 'large' | 'medium' | 'shelf';
export type RewardRecordKind = 'task' | 'turn' | 'check' | 'goal';

export type LocalizedText = { en: string } & Record<string, string>;
export type LocalizedCaptions = { en: string[] } & Record<string, string[]>;

export type AchievementRule =
  | { kind: 'company_accepted_tasks'; threshold: number }
  | { kind: 'department_accepted_tasks'; threshold: number }
  | { kind: 'agent_level'; level: number; threshold: number; agents: number }
  | { kind: 'human_request_answered'; threshold: number }
  | { kind: 'weekly_rhythm'; weeks: number; daysPerWeek: number }
  | { kind: 'task_rework_accepted'; threshold: number }
  | { kind: 'failed_turn_recovered'; threshold: number }
  | { kind: 'watchdog_recovered'; threshold: number }
  | { kind: 'provider_handover'; threshold: number }
  | { kind: 'goal_progress_ratio'; ratio: number }
  | { kind: 'top_goal_reached'; threshold: number };

export type RewardRecordRef = {
  kind: RewardRecordKind;
  id: string;
  number: number;
  eventId?: string;
  commit?: string;
  version?: string;
};

export type AchievementCatalogueEntry = {
  id: string;
  researchNumber: number;
  scope: AchievementScope;
  name: LocalizedText;
  captions: LocalizedCaptions;
  rule: AchievementRule;
  tier: AchievementTier;
  display: AchievementDisplay;
  artKey: string | null;
};

export type EarnedAchievementView = {
  id: string;
  scope: AchievementScope;
  name: LocalizedText;
  captions: LocalizedCaptions;
  rule: AchievementRule;
  tier: AchievementTier;
  display: AchievementDisplay;
  artKey: string | null;
  earnedAt: string;
  record: RewardRecordRef;
};

export type ShowcaseCatalogueEntry = {
  id: string;
  scope: AchievementScope;
  name: LocalizedText;
  captions: LocalizedCaptions;
  tier: AchievementTier;
  display: AchievementDisplay;
  artKey: string | null;
};

export type ShowcaseEarnedCard = {
  achievementId: string;
  scope: AchievementScope;
  name: LocalizedText;
  captions: LocalizedCaptions;
  tier: AchievementTier;
  display: AchievementDisplay;
  artKey: string | null;
  share: {
    path: string;
    text: LocalizedText;
  };
};

export type ShowcaseRewardsView = {
  theme: string;
  catalogue: ShowcaseCatalogueEntry[];
  earned: ShowcaseEarnedCard[];
};

export type WorldRewardsView = {
  catalogue: AchievementCatalogueEntry[];
  earned: EarnedAchievementView[];
  counts: {
    acceptedTasks: number;
    releasedTurns: number;
    passedChecks: number;
    reachedGoals: number;
  };
  showcase: ShowcaseRewardsView;
};

export const DEPT_STAGE_TWO_TASKS = 10;
export const RESIDENCE_STAGE_TWO_TASKS = 50;
export const STATUE_ALLEY_TASKS = DEFAULT_STATUE_STAGES * STATUE_TASKS_PER_STAGE * 2;
export const MUDBRICK_AGENT_COUNT = 3;
export const STEADY_NILE_WEEKS = 4;
export const STEADY_NILE_DAYS_PER_WEEK = 3;
export const FIRST_TIER_RATIO = 0.1;

function hasEnglishText(rec: Record<string, string>): rec is LocalizedText {
  return Boolean(rec.en);
}

function hasEnglishCaptions(rec: Record<string, string[]>): rec is LocalizedCaptions {
  return Boolean(rec.en);
}

const LocalizedTextSchema = z
  .record(z.string().min(1), z.string().min(1))
  .refine(hasEnglishText, { message: 'English text is required' });

const LocalizedCaptionsSchema = z
  .record(z.string().min(1), z.array(z.string().min(1)).min(1))
  .refine(hasEnglishCaptions, { message: 'English captions are required' });

const CaptionsFileSchema = z.object({
  world: z.string().min(1).optional(),
  version: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
  locales: z.array(z.string().min(1)).optional(),
  achievements: z
    .array(
      z.object({
        id: z.number().int().min(1).max(30),
        key: z.string().regex(/^[a-z][a-z0-9_]*$/),
        scope: z.enum(['shared', 'personal']),
        title: LocalizedTextSchema,
        captions: LocalizedCaptionsSchema,
      }),
    )
    .length(30),
});

type ComputableSpec = {
  researchNumber: number;
  tier: AchievementTier;
  display: AchievementDisplay;
  rule: AchievementRule;
};

const COMPUTABLE_SPECS: readonly ComputableSpec[] = [
  {
    researchNumber: 3,
    tier: 'bronze',
    display: 'shelf',
    rule: { kind: 'company_accepted_tasks', threshold: 1 },
  },
  {
    researchNumber: 4,
    tier: 'bronze',
    display: 'medium',
    rule: { kind: 'agent_level', level: 2, threshold: agentLevelThreshold(2), agents: 1 },
  },
  {
    researchNumber: 5,
    tier: 'bronze',
    display: 'shelf',
    rule: { kind: 'human_request_answered', threshold: 1 },
  },
  {
    researchNumber: 9,
    tier: 'silver',
    display: 'medium',
    rule: { kind: 'weekly_rhythm', weeks: STEADY_NILE_WEEKS, daysPerWeek: STEADY_NILE_DAYS_PER_WEEK },
  },
  {
    researchNumber: 10,
    tier: 'bronze',
    display: 'shelf',
    rule: { kind: 'task_rework_accepted', threshold: 1 },
  },
  {
    researchNumber: 12,
    tier: 'silver',
    display: 'shelf',
    rule: { kind: 'failed_turn_recovered', threshold: 1 },
  },
  {
    researchNumber: 13,
    tier: 'bronze',
    display: 'shelf',
    rule: { kind: 'watchdog_recovered', threshold: 1 },
  },
  {
    researchNumber: 15,
    tier: 'silver',
    display: 'shelf',
    rule: { kind: 'provider_handover', threshold: 1 },
  },
  {
    researchNumber: 18,
    tier: 'silver',
    display: 'medium',
    rule: { kind: 'agent_level', level: 5, threshold: agentLevelThreshold(5), agents: MUDBRICK_AGENT_COUNT },
  },
  {
    researchNumber: 19,
    tier: 'silver',
    display: 'large',
    rule: { kind: 'agent_level', level: 10, threshold: agentLevelThreshold(10), agents: 1 },
  },
  {
    researchNumber: 20,
    tier: 'gold',
    display: 'large',
    rule: { kind: 'agent_level', level: 30, threshold: agentLevelThreshold(30), agents: 1 },
  },
  {
    researchNumber: 21,
    tier: 'bronze',
    display: 'medium',
    rule: { kind: 'department_accepted_tasks', threshold: DEPT_STAGE_TWO_TASKS },
  },
  {
    researchNumber: 22,
    tier: 'silver',
    display: 'medium',
    rule: { kind: 'department_accepted_tasks', threshold: STATUE_TASKS_PER_STAGE },
  },
  {
    researchNumber: 23,
    tier: 'gold',
    display: 'large',
    rule: { kind: 'department_accepted_tasks', threshold: STATUE_ALLEY_TASKS },
  },
  {
    researchNumber: 24,
    tier: 'silver',
    display: 'large',
    rule: { kind: 'company_accepted_tasks', threshold: RESIDENCE_STAGE_TWO_TASKS },
  },
  {
    researchNumber: 25,
    tier: 'bronze',
    display: 'medium',
    rule: { kind: 'goal_progress_ratio', ratio: FIRST_TIER_RATIO },
  },
  {
    researchNumber: 26,
    tier: 'gold',
    display: 'large',
    rule: { kind: 'top_goal_reached', threshold: 1 },
  },
];

function resolveCaptionsFilePath(): string {
  const candidates = [
    new URL('../../../../../game-layer/achievement-captions.json', import.meta.url),
    new URL('./achievement-captions.json', import.meta.url),
    new URL('../../../src/modules/world/achievement-captions.json', import.meta.url),
  ];
  for (const url of candidates) {
    const path = fileURLToPath(url);
    if (existsSync(path)) return path;
  }
  return fileURLToPath(candidates[1]!);
}

function loadAchievementCatalogue(): readonly AchievementCatalogueEntry[] {
  const parsed = CaptionsFileSchema.parse(JSON.parse(readFileSync(resolveCaptionsFilePath(), 'utf8')));
  const byNumber = new Map(parsed.achievements.map(entry => [entry.id, entry]));
  return COMPUTABLE_SPECS.map(spec => {
    const captionEntry = byNumber.get(spec.researchNumber);
    if (!captionEntry) {
      throw new Error(`Missing achievement caption entry for Section 8 id ${spec.researchNumber}`);
    }
    return {
      id: captionEntry.key,
      researchNumber: spec.researchNumber,
      scope: captionEntry.scope,
      name: captionEntry.title,
      captions: captionEntry.captions,
      rule: spec.rule,
      tier: spec.tier,
      display: spec.display,
      artKey: null,
    };
  });
}

export const ACHIEVEMENT_CATALOGUE: readonly AchievementCatalogueEntry[] = loadAchievementCatalogue();

export function safeShowcaseTheme(rawTheme: string, activePackId: string | null): string {
  if (activePackId === 'egypt' || rawTheme === 'egypt') return 'egypt';
  return 'cyberpunk';
}

function buildShareText(item: EarnedAchievementView, path: string): LocalizedText {
  const out: Record<string, string> = {};
  for (const [locale, lines] of Object.entries(item.captions)) {
    const title = item.name[locale] ?? item.name.en;
    const line = lines[0] ?? '';
    out[locale] = `${title}: ${line} ${path}`;
  }
  return out as LocalizedText;
}

function buildShareCard(theme: string, item: EarnedAchievementView): ShowcaseEarnedCard {
  const path = `https://hornhoof.org/found?w=${theme}&k=${item.id}`;
  return {
    achievementId: item.id,
    scope: item.scope,
    name: item.name,
    captions: item.captions,
    tier: item.tier,
    display: item.display,
    artKey: item.artKey,
    share: {
      path,
      text: buildShareText(item, path),
    },
  };
}

export function buildShowcaseRewards(
  rawTheme: string,
  activePackId: string | null,
  earned: readonly EarnedAchievementView[],
): ShowcaseRewardsView {
  const theme = safeShowcaseTheme(rawTheme, activePackId);
  return {
    theme,
    catalogue: ACHIEVEMENT_CATALOGUE.map(entry => ({
      id: entry.id,
      scope: entry.scope,
      name: entry.name,
      captions: entry.captions,
      tier: entry.tier,
      display: entry.display,
      artKey: entry.artKey,
    })),
    earned: earned.map(item => buildShareCard(theme, item)),
  };
}
