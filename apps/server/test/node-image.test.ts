import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_BUILD, nodeImageOfBuild } from '../src/modules/nodes/image.js';

const COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;
const BY_TAG = `ghcr.io/acme/hornhoof-node:${COMMIT}`;
const BY_DIGEST = `ghcr.io/acme/hornhoof-node@${DIGEST}`;

function lookup(digestOf: (tag: string) => Promise<string>, commit = COMMIT) {
  const asked = vi.fn(digestOf);
  const errors: unknown[] = [];
  return { image: nodeImageOfBuild({ image: 'ghcr.io/acme/hornhoof', commit, digestOf: asked, onError: err => errors.push(err) }), asked, errors };
}

describe('the node image of a build', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is the digest of the image built from the commit, which is asked for once', async () => {
    const { image, asked } = lookup(async () => DIGEST);
    expect(await image()).toBe(BY_DIGEST);
    expect(await image()).toBe(BY_DIGEST);
    expect(asked.mock.calls).toEqual([[COMMIT]]);
  });

  it.each(['local', 'abc1234', 'c'.repeat(39), 'c'.repeat(41), 'C'.repeat(40), `${COMMIT}\n`, `x${COMMIT}`])(
    'is none of its own for a build CI did not make, with the commit %j, and asks no registry',
    async commit => {
      const { image, asked } = lookup(async () => DIGEST, commit);
      expect(await image()).toBe(LOCAL_BUILD);
      expect(asked).not.toHaveBeenCalled();
    },
  );

  it("goes by the commit's tag while the registry lacks the image, and asks again only after a minute", async () => {
    let published = '';
    const { image, asked, errors } = lookup(async () => published);
    expect(await image()).toBe(BY_TAG);
    published = DIGEST;
    vi.advanceTimersByTime(59_999);
    expect(await image()).toBe(BY_TAG);
    expect(asked).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await image()).toBe(BY_DIGEST);
    expect(asked).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it("goes by the commit's tag when the registry fails, tells why, and asks again only after a minute", async () => {
    const down = new Error('The registry answered 503.');
    let answer = () => Promise.reject<string>(down);
    const { image, asked, errors } = lookup(() => answer());
    expect(await image()).toBe(BY_TAG);
    expect(errors).toEqual([down]);
    answer = async () => DIGEST;
    vi.advanceTimersByTime(59_999);
    expect(await image()).toBe(BY_TAG);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([down]);
    vi.advanceTimersByTime(1);
    expect(await image()).toBe(BY_DIGEST);
  });

  it('counts the minute from when the registry answered', async () => {
    let answer!: (digest: string) => void;
    const { image, asked } = lookup(() => new Promise(resolve => (answer = resolve)));
    void image();
    await vi.advanceTimersByTimeAsync(70_000);
    answer('');
    await vi.advanceTimersByTimeAsync(59_999);
    void image();
    expect(asked).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    void image();
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("keeps a person's curl waiting 5 seconds at most for a registry that does not answer, and asks it once", async () => {
    let answer!: (digest: string) => void;
    const { image, asked } = lookup(() => new Promise(resolve => (answer = resolve)));
    const settled: string[] = [];
    const first = image().then(got => settled.push(got));
    const second = image().then(got => settled.push(got));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(settled).toEqual([BY_TAG, BY_TAG]);
    expect(asked).toHaveBeenCalledTimes(1);

    /* One who comes after the wait does not wait again, however long the registry takes. */
    expect(await image()).toBe(BY_TAG);
    expect(asked).toHaveBeenCalledTimes(1);

    /* Its late answer still counts: the next machine gets the digest without asking again. */
    answer(DIGEST);
    expect(await image()).toBe(BY_DIGEST);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('makes one who comes during the wait wait only for what is left of it', async () => {
    const { image } = lookup(() => new Promise(() => {}));
    const settled: string[] = [];
    void image().then(got => settled.push(`first ${got}`));
    await vi.advanceTimersByTimeAsync(3_000);
    void image().then(got => settled.push(`second ${got}`));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toEqual([`first ${BY_TAG}`, `second ${BY_TAG}`]);
  });

  it('does not wait at all once it knows the digest or must not ask yet', async () => {
    const known = lookup(async () => DIGEST);
    await known.image();
    const got: string[] = [];
    void known.image().then(image => got.push(image));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([BY_DIGEST]);

    const lacking = lookup(async () => '');
    await lacking.image();
    void lacking.image().then(image => got.push(image));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([BY_DIGEST, BY_TAG]);
  });
});
