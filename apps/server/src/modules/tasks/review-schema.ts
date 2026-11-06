import { z } from 'zod';

export const ReviewSha = z.string().regex(/^[a-f0-9]{40}$/);
export const RepoPath = z.string().min(1).max(500).refine(path => !/[\\\u0000-\u001f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
