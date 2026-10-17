import { test, expect, Page } from '@playwright/test';

// Covers the experimental Three.js renderer (scripts/mk-3d.js).
// Forces 3D mode via ?engine=3d, starts a local race through mkDev, then
// asserts the Three.js path actually engaged: no page errors, threeInfo on
// the screen canvas, and the 3D badge visible. Fails with a screenshot that
// shows what the ground renderer produced.

function waitForEvent(page: Page, type: string, fields: Record<string, any> = {}) {
  return page.waitForFunction(
    ([type, fields]) => (window as any).mkDevEvents.some((e: any) =>
      e.type === type && Object.keys(fields).every((k) => e[k] === fields[k])
    ),
    [type, fields] as const,
    { timeout: 30_000 }
  );
}

test('3D ground renderer engages and draws without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/mariokart.php?engine=3d');
  await waitForEvent(page, 'screen', { name: 'main' });

  expect(await page.evaluate(() => typeof (window as any).THREE)).not.toBe('undefined');
  expect(await page.evaluate(() => typeof (window as any).MK3D)).not.toBe('undefined');

  await page.evaluate(() => (window as any).mkDev.startRace({ character: 'mario', players: 2 }));
  await waitForEvent(page, 'raceStart', { race: 1 });
  // Countdown + early race so several frames render.
  await page.waitForTimeout(8000);

  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).mkDevEval('bThreeEngine'))).toBe(true);
  expect(await page.evaluate(() => (window as any).mkDevEval('oScreens.map(function(s) { return !!s.threeInfo; })'))).toEqual([true]);
  await expect(page.locator('.mk3d-badge')).toBeVisible();

  // Chase camera must face the direction of travel (regression: a
  // sign-flipped forward vector once pointed it backward, which made
  // driving look reversed and karts appear detached from the road).
  const p0 = await page.evaluate(() => (window as any).mkDevEval('({x: aKarts[0].x, y: aKarts[0].y})'));
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(3000);
  await page.keyboard.up('ArrowUp');
  const facing = await page.evaluate((p0: { x: number; y: number }) =>
    (window as any).mkDevEval(
      '(function(p0) { var k = aKarts[0];' +
      ' var d = oScreens[0].threeInfo.camera.getWorldDirection(new THREE.Vector3());' +
      ' return { dx: (k.x - p0.x) / 8, dz: (k.y - p0.y) / 8, cx: d.x, cz: d.z }; })(' +
      JSON.stringify(p0) + ')'
  ), p0);
  expect(Math.hypot(facing.dx, facing.dz)).toBeGreaterThan(5);
  expect(facing.dx * facing.cx + facing.dz * facing.cz).toBeGreaterThan(0);

  await page.screenshot({ path: 'test-results/mk-3d-race.png' });
});
