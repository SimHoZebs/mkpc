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
    return f ? { near: f.near, far: f.far } : null;
  })()`));
  expect(fog).toBeNull();

  // 3D mode hides the flat background strips and renders its own sky:
  // no visible strip divs, and a non-black clear color (map1 samples a
  // cream sky from its hills artwork).
  const strips = await page.evaluate(() => Array.from(
    document.querySelectorAll('#mariokartcontainer div[style*="background-image"]')
  ).filter((d) => (d as HTMLElement).style.display !== 'none').length);
  expect(strips).toBe(0);
  const sky = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var c = oScreens[0].threeInfo.renderer.getClearColor();
    return [c.r, c.g, c.b];
  })()`));
  expect(sky[0] + sky[1] + sky[2]).toBeGreaterThan(1.5);

  // Distant scenery ring built from the track's own background layers.
  const ring = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var r = oScreens[0].threeInfo.ring;
    return r ? r.children.map(function(m) { return m.visible; }) : null;
  })()`));
  expect(ring).toEqual([true, true]);

  // Walls: collision rects/polys are extruded to flat-shaded meshes.
  // Present exactly when the map defines collision shapes.
  const walls = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var c = getCurrentLMap(getCurrentLapId(oPlayers[0])).collision || {};
    var total = (c.rectangle ? c.rectangle.length : 0) + (c.polygon ? c.polygon.length : 0);
    var w = oScreens[0].threeInfo.walls;
    return { total: total, built: w ? w.children.length : null };
  })()`));
  expect(walls.total).toBeGreaterThanOrEqual(0);
  if (walls.total > 0) expect(walls.built).toBeGreaterThan(0);
  else expect(walls.built).toBeNull();

  // Obstacles: decors sync to volumetric meshes instead of DOM billboards.
  const decor = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var k = aKarts[0];
    var ok = MK3D.syncDecor(oScreens[0].threeInfo, "tree", 9999, k.x, k.y, 0, 4, 4);
    var g = oScreens[0].threeInfo.decorGroup;
    var shown = g ? g.children.filter(function(m) { return m.visible; }).length : -1;
    return { sync: ok, shown: shown };
  })()`));
  expect(decor.sync).toBe(true);
  expect(decor.shown).toBeGreaterThan(0);

  // Sprites hide behind walls: park the camera in front of a real wall
  // and check the sight line to a point past it.
  const occl = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var info = oScreens[0].threeInfo;
    if (!info.wallList || !info.wallList.length) return { skipped: true };
    var lMap = getCurrentLMap(getCurrentLapId(oPlayers[0]));
    var rects = (lMap.collision && lMap.collision.rectangle) || [];
    var props = (lMap.collisionProps && lMap.collisionProps.rectangle) || {};
    var r = null;
    for (var k = 0; k < rects.length; k++) {
      var p = props[k];
      var z = (p && p.z != null) ? +p.z : 1;
      if (z >= 1 && rects[k][2] > 0 && rects[k][3] > 0) { r = rects[k]; break; }
    }
    if (!r) return { skipped: true };
    var cx = r[0] + r[2] / 2, before = r[1] - 30, after = r[1] + r[3] + 30;
    var cam = info.camera.position, ox = cam.x, oy = cam.y, oz = cam.z;
    cam.set(cx * MK3D.FIT.KX, 1.0, before / MK3D.WORLD_SCALE);
    var behind = MK3D.isOccluded(info, cx, after, 0);
    var front = MK3D.isOccluded(info, cx, before - 10, 0);
    cam.set(ox, oy, oz);
    return { behind: behind, front: front };
  })()`));
  if (walls.total > 0) expect(occl.skipped).not.toBe(true);
  if (!occl.skipped) {
    expect(occl.behind).toBe(true);
    expect(occl.front).toBe(false);
  }

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

test('3D boost pads and holes build from track data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // map8 defines both boost pads and hole zones.
  await page.goto('/mariokart.php?engine=3d');
  await waitForEvent(page, 'screen', { name: 'main' });

  await page.evaluate(() => (window as any).mkDev.startRace({ character: 'mario', players: 2, map: 8 }));
  await waitForEvent(page, 'raceStart', { race: 1 });
  await page.waitForTimeout(8000);

  expect(errors).toEqual([]);

  // Boost pads: one pulsing decal per accelerateurs zone.
  const boosts = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var lMap = getCurrentLMap(getCurrentLapId(oPlayers[0]));
    var acc = lMap.accelerateurs || {rectangle: [], polygon: []};
    var total = acc.rectangle.length + acc.polygon.length;
    var b = oScreens[0].threeInfo.boosts;
    return { total: total, built: b ? b.children.length : null };
  })()`));
  expect(boosts.total).toBeGreaterThan(0);
  expect(boosts.built).toEqual(boosts.total);

  // Holes: one darkened decal per trous zone across all groups.
  const holes = await page.evaluate(() => (window as any).mkDevEval(`(function() {
    var lMap = getCurrentLMap(getCurrentLapId(oPlayers[0]));
    var total = 0, trous = lMap.trous || {};
    for (var k in trous)
      total += trous[k].rectangle.length + trous[k].polygon.length;
    var h = oScreens[0].threeInfo.holes;
    return { total: total, built: h ? h.children.length : null };
  })()`));
  expect(holes.total).toBeGreaterThan(0);
  expect(holes.built).toBeGreaterThan(0);
  expect(holes.built).toBeLessThanOrEqual(holes.total);

  await page.screenshot({ path: 'test-results/mk-3d-boosts.png' });
});
