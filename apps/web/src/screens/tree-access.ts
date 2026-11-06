import type { Department, DepartmentTree, TreeReview, TreeSegment } from '../types';

function visibleSegments(segments: TreeSegment[], allowed: Set<string>): TreeSegment[] {
  return segments.filter(segment => !segment.waitsForAgent || allowed.has(segment.waitsForAgent.id));
}

function visibleReviews(reviews: TreeReview[], allowed: Set<string>): TreeReview[] {
  return reviews.filter(review => allowed.has(review.head.id)).map(review => ({
    ...review,
    reviewers: review.reviewers.filter(reviewer => allowed.has(reviewer.agent.id)).map(reviewer => ({ ...reviewer, segments: visibleSegments(reviewer.segments, allowed) })),
  })).filter(review => review.reviewers.length > 0);
}

function visibleLines(tree: DepartmentTree, allowed: Set<string>): DepartmentTree['lines'] {
  return tree.lines.filter(line => allowed.has(line.agent.id)).map(line => ({ ...line, segments: visibleSegments(line.segments, allowed) }));
}

function visibleActivity(tree: DepartmentTree, allowed: Set<string>): DepartmentTree['activity'] {
  return tree.activity?.filter(item => allowed.has(item.agent.id)).map(item => ({ ...item, segments: visibleSegments(item.segments, allowed) }));
}

function visibleWaiting(tree: DepartmentTree, allowed: Set<string>): DepartmentTree['waiting'] {
  return tree.waiting?.filter(item => allowed.has(item.agent.id) && allowed.has(item.waitsForAgent.id));
}

function visibleIdle(tree: DepartmentTree, allowed: Set<string>): DepartmentTree['idle'] {
  return tree.idle.filter(item => allowed.has(item.agent.id) && (!item.waitsForAgent || allowed.has(item.waitsForAgent.id)));
}

/* The server limits the roster; related tree data must not name or draw agents outside it. */
export function visibleDepartmentTree(tree: DepartmentTree, department: Department): DepartmentTree {
  const allowed = new Set(department.employees.map(employee => employee.id));
  const reviews = visibleReviews(tree.reviews ?? (tree.review ? [tree.review] : []), allowed);
  return {
    ...tree,
    lines: visibleLines(tree, allowed),
    review: tree.review ? reviews.find(review => review.taskId === tree.review!.taskId) ?? null : null,
    reviews: tree.reviews ? reviews : undefined,
    activity: visibleActivity(tree, allowed),
    waiting: visibleWaiting(tree, allowed),
    time: tree.time.filter(item => allowed.has(item.agent.id)),
    idle: visibleIdle(tree, allowed),
  };
}
