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

  // Sprite divs must sit where the 3D camera projects them (regression:
  // entities used the Mode7 screen positions over the 3D ground).
  const align = await page.evaluate(() =>
    (window as any).mkDevEval(`(function() {
      var k = aKarts[0];
      var p = MK3D.project(oScreens[0].threeInfo, k.x, k.y, k.z);
      var el = k.sprite[0].div;
      var s = iScreenScale, W = iWidth*s, H = iHeight*s;
      var ex = p.x*(W+s)/W - s/2, ey = p.y*(H+s)/H + s;
      var r = el.getBoundingClientRect();
      var c = el.parentNode.getBoundingClientRect();
      return { dx: (r.left - c.left + r.width/2) - ex,
               dy: (r.top - c.top + r.height) - (ey + r.height/2) };
    })()`)
  );
  expect(Math.abs(align.dx)).toBeLessThan(8);
  expect(Math.abs(align.dy)).toBeLessThan(10);

  // Distance cutoff reproduces stock framing so the DOM background strips
  // sit over background color, not over detailed far ground.
  const fog = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var f = oScreens[0].threeInfo.scene.fog;
    return { near: f.near, far: f.far, color: [f.color.r, f.color.g, f.color.b] };
  })()`));
  expect(fog.near).toBeCloseTo(34.15, 1);
  expect(fog.far).toBeCloseTo(34.35, 1);
  expect(fog.color[1]).toBeCloseTo(161 / 255, 2); // map1 bgcolor green

  await page.screenshot({ path: 'test-results/mk-3d-race.png' });
});

test('3D renderer mirrors the whole view in mirror mode', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/mariokart.php?engine=3d');
  await waitForEvent(page, 'screen', { name: 'main' });

  await page.evaluate(() => (window as any).mkDev.startRace({ character: 'mario', players: 2, mirror: true }));
  await waitForEvent(page, 'raceStart', { race: 1 });
  await page.waitForTimeout(8000);

  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).mkDevEval('bSelectedMirror'))).toBe(true);
  // The 3D camera itself is identical mirrored or not; mirroring is purely
  // screen-space (regression: the camera position used to be mirrored,
  // which showed a different part of the track).
  const cams = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var c = oScreens[0].threeInfo.camera;
    return [c.position.x, c.position.z];
  })()`));
  const expectCam = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var k = aKarts[0], r = k.rotation * Math.PI / 180;
    var fx = Math.sin(r) * MK3D.FIT.KX, fz = Math.cos(r) / MK3D.WORLD_SCALE;
    var len = Math.sqrt(fx*fx + fz*fz);
    return [k.x * MK3D.FIT.KX - fx / len * MK3D.FIT.C,
            k.y / MK3D.WORLD_SCALE - fz / len * MK3D.FIT.C];
  })()`));
  expect(Math.abs(cams[0] - expectCam[0])).toBeLessThan(0.01);
  expect(Math.abs(cams[1] - expectCam[1])).toBeLessThan(0.01);

  // Sprites flip around the container center, like stock.
  const align = await page.evaluate(() =>
    (window as any).mkDevEval(`(function() {
      var k = aKarts[0];
      var p = MK3D.project(oScreens[0].threeInfo, k.x, k.y, k.z);
      var el = k.sprite[0].div;
      var s = iScreenScale, W = iWidth*s, H = iHeight*s;
      var ex = W - (p.x*(W+s)/W - s/2), ey = p.y*(H+s)/H + s;
      var r = el.getBoundingClientRect();
      var c = el.parentNode.getBoundingClientRect();
      return { dx: (r.left - c.left + r.width/2) - ex,
               dy: (r.top - c.top + r.height) - (ey + r.height/2) };
    })()`)
  );
  expect(Math.abs(align.dx)).toBeLessThan(8);
  expect(Math.abs(align.dy)).toBeLessThan(10);
});
