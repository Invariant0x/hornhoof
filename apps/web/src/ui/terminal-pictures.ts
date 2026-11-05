import { api, ApiFailure } from '../api';
import { readied } from './MessagePictures';

type UploadedPicture = { id: string; name: string; insert?: string };

function inputOf(picture: UploadedPicture): string {
  return picture.insert ?? `${picture.name}: hh-fetch message ${picture.id}`;
}

function addInput(before: string, next: string): string {
  return before && !before.endsWith(' ') ? `${before} ${next}` : before + next;
}

/* Uploads finish before any path reaches the program, so a failed batch inserts nothing. */
export async function uploadTerminalPictures(path: string, files: File[]): Promise<string> {
  let input = '';
  const base = path.replace(/\/terminal$/, '');
  for (const file of files) {
    const ready = await readied(file);
    if (typeof ready === 'string') throw new ApiFailure(400, 'validation', '', ready);
    const picture = await api.upload<UploadedPicture>(`${base}/pictures?name=${encodeURIComponent(ready.name)}`, ready.file);
    input = addInput(input, inputOf(picture));
  }
  return input;
}
