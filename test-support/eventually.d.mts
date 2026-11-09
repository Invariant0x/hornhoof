export function eventually(check: () => boolean | Promise<boolean>, options?: { ms?: number; every?: number; message?: string }): Promise<void>;
