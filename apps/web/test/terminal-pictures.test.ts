import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../src/api';
import { readied } from '../src/ui/MessagePictures';
import { uploadTerminalPictures } from '../src/ui/terminal-pictures';
import { mockApi } from './api-mock';

const picture = (name: string) => new File(['picture'], name, { type: 'image/png' });

describe('pictures uploaded from a terminal', () => {
  it('inserts the exact path the server prepared on the agent machine', async () => {
    const calls = mockApi({
      'POST /api/agents/orchestrator/pictures?name=one.png': [200, { id: 'p1', name: 'one.png', insert: "'/home/agent/one.png' " }],
    });
    await expect(uploadTerminalPictures('/api/agents/orchestrator/terminal', [picture('one.png')])).resolves.toBe("'/home/agent/one.png' ");
    expect(calls).toHaveLength(1);
  });

  it('keeps the fetch instruction for a server that does not return insert yet', async () => {
    mockApi({
      'POST /api/agents/orchestrator/pictures?name=one.png': [200, { id: 'p1', name: 'one.png' }],
    });
    await expect(uploadTerminalPictures('/api/agents/orchestrator/terminal', [picture('one.png')])).resolves.toBe('one.png: hh-fetch message p1');
  });

  it('uploads several pictures in order and separates their input with one space', async () => {
    const calls = mockApi({
      'POST /api/agents/orchestrator/pictures?name=one.png': [200, { id: 'p1', name: 'one.png', insert: "'/home/agent/one.png' " }],
      'POST /api/agents/orchestrator/pictures?name=two.png': [200, { id: 'p2', name: 'two.png', insert: "'/home/agent/two.png' " }],
    });
    await expect(uploadTerminalPictures('/api/agents/orchestrator/terminal', [picture('one.png'), picture('two.png')])).resolves.toBe("'/home/agent/one.png' '/home/agent/two.png' ");
    expect(calls.map(c => c.path)).toEqual([
      '/api/agents/orchestrator/pictures?name=one.png',
      '/api/agents/orchestrator/pictures?name=two.png',
    ]);
  });

  it('uploads a file of any kind and puts in the command that gets it', async () => {
    const calls = mockApi({
      'POST /api/agents/orchestrator/pictures?name=report.pdf': [201, { id: 'f1', name: 'report.pdf' }],
    });
    await expect(uploadTerminalPictures('/api/agents/orchestrator/terminal', [new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' })])).resolves.toBe('report.pdf: hh-fetch message f1');
    expect(calls.map(c => c.path)).toEqual(['/api/agents/orchestrator/pictures?name=report.pdf']);
  });

  it('turns away an empty file and one over 10 MB before any upload', async () => {
    const calls = mockApi({});
    const empty = uploadTerminalPictures('/api/agents/orchestrator/terminal', [new File([], 'Reports', { type: '' })]);
    await expect(empty).rejects.toMatchObject({ status: 400, reason: 'file_empty' });
    const big = uploadTerminalPictures('/api/agents/orchestrator/terminal', [new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'film.mov', { type: 'video/quicktime' })]);
    await expect(big).rejects.toMatchObject({ status: 400, reason: 'file_too_big' });
    expect(calls).toEqual([]);
  });

  it('returns no partial input when an upload fails', async () => {
    mockApi({
      'POST /api/agents/orchestrator/pictures?name=one.png': [200, { id: 'p1', name: 'one.png', insert: "'/home/agent/one.png' " }],
      'POST /api/agents/orchestrator/pictures?name=two.png': [403, { error: { code: 'forbidden', message: 'No access.', reason: 'forbidden' } }],
    });
    const failure = uploadTerminalPictures('/api/agents/orchestrator/terminal', [picture('one.png'), picture('two.png')]);
    await expect(failure).rejects.toBeInstanceOf(ApiFailure);
    await expect(failure).rejects.toMatchObject({ status: 403 });
  });
});


const BIG = 3 * 1024 * 1024;
const FILE_BYTES = 10 * 1024 * 1024;
const bigPicture = (size = BIG + 1) => new File([new Uint8Array(size)], 'big.png', { type: 'image/png' });

function imageBitmap() {
  const image = { width: 100, height: 50, close: vi.fn() };
  vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(image)));
  return image;
}

function canvasBlobs(blobs: (Blob | null)[]) {
  const context = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  const widths: number[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, done: BlobCallback) {
    widths.push(this.width);
    done(blobs.shift() ?? null);
  });
  return { context, widths };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('making a large terminal picture fit the upload limit', () => {
  it('tries smaller JPEG sizes until one fits and closes the decoded image', async () => {
    const image = imageBitmap();
    const small = new Blob(['small'], { type: 'image/jpeg' });
    const { context, widths } = canvasBlobs([new Blob([new Uint8Array(BIG + 1)]), small]);
    const ready = await readied(bigPicture());
    expect(ready).toEqual({ file: small, name: 'big.jpg' });
    expect(widths).toEqual([100, 75]);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('sends the picture as it is when no smaller JPEG fits, and still closes the image', async () => {
    const image = imageBitmap();
    canvasBlobs(Array.from({ length: 4 }, () => new Blob([new Uint8Array(BIG + 1)])));
    const big = bigPicture();
    await expect(readied(big)).resolves.toEqual({ file: big, name: 'big.png' });
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('sends a file the browser cannot decode as it is', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('not an image'))));
    const big = bigPicture();
    await expect(readied(big)).resolves.toEqual({ file: big, name: 'big.png' });
  });

  it('sends a picture the browser cannot draw as it is, and still closes the image', async () => {
    const image = imageBitmap();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const big = bigPicture();
    await expect(readied(big)).resolves.toEqual({ file: big, name: 'big.png' });
    expect(image.close).toHaveBeenCalledOnce();
  });

  it('turns away a picture over 10 MB that it cannot make smaller', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    await expect(readied(bigPicture(FILE_BYTES))).resolves.toEqual({ file: expect.any(File), name: 'big.png' });
    await expect(readied(bigPicture(FILE_BYTES + 1))).resolves.toBe('file_too_big');
  });
});
