import { authorCheckDocuments, type AuthorCheckDone } from '@hornhoof/protocol';

export const AUTHOR_CHECK_PASSED = 'author_check_passed';

export function authorCheckAllowsReviewSkip(small: boolean, paths: readonly string[], receipt: AuthorCheckDone): boolean {
  const documents = authorCheckDocuments(paths);
  if (!(small || documents) || receipt.reason !== null || receipt.exitCode !== 0) return false;
  if (receipt.crap.kind === 'no_functions') return documents;
  return receipt.crap.kind === 'measured' && receipt.crap.max < 10;
}
