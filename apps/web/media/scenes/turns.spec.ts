import { test } from '@playwright/test';
import { trackerFrames } from '../moonfern/tracker-scene';

test('tracker screenshots: turns and releases at desktop and phone widths', async ({ browser }, info) => {
  await trackerFrames(browser, info, 'turns');
});
