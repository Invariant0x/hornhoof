import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';

/* Who reviewed a candidate it produced, or that grew from one it produced: the Review owner now or planned (current), or a
   Review verdict or repair already recorded (past), with the candidate it checked. */
export type ProducerReview = { agentId: string; candidateId: string | null; at: 'current' | 'past' };
export type ReviewIndependenceRoute = {
  companyId: string; taskId: string; number: number; status: string; stage: string | null; phase: string;
  oldReviewSkip: boolean; producerReviews: ProducerReview[];
};

/* One read of the in-flight routes with a Review stage that still carry the old author-check skip of #1217, or whose current or
   past Review owner produced a candidate in the lineage of what it checked. The lineage is the checked candidate and every
   candidate it grew from, with the task's executor; where the chain breaks, every producer of the task counts. Closed work
   ('done', 'cancelled') keeps its record and is left out. It reads only, so it runs as it is on a live database too. */
export const REVIEW_INDEPENDENCE_SQL = `WITH RECURSIVE live AS (
  SELECT t.company_id, t.id AS task_id, t.number, t.status, t.executor_agent_id::text AS executor, r.state,
    jsonb_path_exists(r.state, '$.stages[*] ? (@.stage == "review" && @.status == "skipped" && @.reason == "author_check_passed")') AS old_review_skip
  FROM task_routes r JOIN tasks t ON t.id = r.task_id AND t.company_id = r.company_id
  WHERE t.status NOT IN ('done', 'cancelled') AND coalesce(r.state->>'phase', '') NOT IN ('done', 'cancelled')
    AND jsonb_path_exists(r.state, '$.stages[*] ? (@.stage == "review")')
), candidates AS (
  SELECT e.task_id, e.data->'candidate'->>'id' AS id, e.data->'candidate'->>'parentId' AS parent_id,
    e.data->'candidate'->'producedBy'->>'stage' AS stage, e.data->'candidate'->'producedBy'->>'agentId' AS producer, e.agent_id::text AS submitter
  FROM task_events e JOIN live l ON l.task_id = e.task_id AND l.company_id = e.company_id
  WHERE e.kind = 'submitted' AND jsonb_typeof(e.data->'candidate') = 'object'
), reviews AS (
  SELECT l.task_id, s->>'ownerAgentId' AS agent_id, coalesce(s->>'inputCandidateId', l.state->>'candidateId') AS checked, 'current' AS at
  FROM live l CROSS JOIN LATERAL jsonb_array_elements(l.state->'stages') s
  WHERE s->>'stage' = 'review' AND s->>'ownerAgentId' IS NOT NULL
  UNION
  SELECT l.task_id, l.state->'assignment'->>'agentId', l.state->>'candidateId', 'current'
  FROM live l WHERE l.state->>'stage' = 'review' AND l.state->'assignment'->>'agentId' IS NOT NULL
  UNION
  SELECT e.task_id, e.agent_id::text, e.data->>'candidateId', 'past'
  FROM task_events e JOIN live l ON l.task_id = e.task_id AND l.company_id = e.company_id
  WHERE e.kind = 'verdict' AND e.data->>'stage' = 'review' AND e.agent_id IS NOT NULL
  UNION
  SELECT task_id, producer, parent_id, 'past' FROM candidates WHERE stage = 'review' AND producer IS NOT NULL
), lineage (task_id, agent_id, checked, at, id) AS (
  SELECT task_id, agent_id, checked, at, checked FROM reviews WHERE checked IS NOT NULL
  UNION
  SELECT w.task_id, w.agent_id, w.checked, w.at, c.parent_id
  FROM lineage w JOIN candidates c ON c.task_id = w.task_id AND c.id = w.id
  WHERE c.parent_id IS NOT NULL
), walked AS (
  SELECT w.task_id, w.agent_id, w.checked, w.at, c.producer, c.submitter, c.id IS NULL AS broken
  FROM lineage w LEFT JOIN candidates c ON c.task_id = w.task_id AND c.id = w.id
), produced AS (
  SELECT r.task_id, r.agent_id, r.checked, r.at FROM reviews r JOIN live l ON l.task_id = r.task_id
  WHERE r.agent_id = l.executor
    OR EXISTS (SELECT 1 FROM walked w WHERE w.task_id = r.task_id AND w.agent_id = r.agent_id AND w.checked = r.checked AND w.at = r.at
      AND r.agent_id IN (w.producer, w.submitter))
    OR ((r.checked IS NULL OR EXISTS (SELECT 1 FROM walked w WHERE w.task_id = r.task_id AND w.agent_id = r.agent_id AND w.checked = r.checked AND w.at = r.at AND w.broken))
      AND EXISTS (SELECT 1 FROM candidates c WHERE c.task_id = r.task_id AND r.agent_id IN (c.producer, c.submitter)))
)
SELECT l.company_id AS "companyId", l.task_id AS "taskId", l.number, l.status, l.state->>'stage' AS stage, l.state->>'phase' AS phase,
  l.old_review_skip AS "oldReviewSkip",
  coalesce((SELECT jsonb_agg(DISTINCT jsonb_build_object('agentId', p.agent_id, 'candidateId', p.checked, 'at', p.at)) FROM produced p WHERE p.task_id = l.task_id), '[]'::jsonb) AS "producerReviews"
FROM live l
WHERE l.old_review_skip OR EXISTS (SELECT 1 FROM produced p WHERE p.task_id = l.task_id)
ORDER BY l.company_id, l.number`;

const byReview = (a: ProducerReview, b: ProducerReview): number =>
  a.at.localeCompare(b.at) || a.agentId.localeCompare(b.agentId) || (a.candidateId ?? '').localeCompare(b.candidateId ?? '');

/* Reads in a read-only transaction and changes nothing; the same text runs in psql on a live database. */
export async function reviewIndependenceInventory(db: Db): Promise<ReviewIndependenceRoute[]> {
  const found = await db.transaction(tx => tx.execute(sql.raw(REVIEW_INDEPENDENCE_SQL)), { accessMode: 'read only' }) as unknown as { rows: ReviewIndependenceRoute[] };
  return found.rows.map(row => ({ ...row, producerReviews: [...row.producerReviews].sort(byReview) }));
}
