export function eventually(check: () => boolean | Promise<boolean>): Promise<void>;
