/*
 * MKPC 3D renderer (experimental) — scripts/mk-3d.js
 *
 * Third render mode next to the built-in WebGL (Mode7 shader) and legacy
 * Canvas engines. It reuses the exact same per-frame inputs:
 *   - fCamera {x, y, rotation} in map pixels, same as redrawCanvas()
 *   - mapCanvas, the 2D-composited ground (track + assets + sea), as texture
 * Physics and netcode are untouched. Karts and items stay DOM sprites
 * positioned through MK3D.project so they sit exactly on the 3D ground.
 * Walls (lMap.collision) are extruded to flat-shaded meshes and
 * obstacles/decors (lMap.decor) to low-poly volumetric meshes, both
 * rebuilt per map and synced per frame. Boost pads (lMap.accelerateurs)
 * get a pulsing glow decal and holes (lMap.trous) a darkened decal, both
 * flat on the ground; their artwork stays baked in the track texture.
 *
 * Camera calibration: the stock shader projection is not a true pinhole
 * camera, so the pinhole parameters below are a numerical least-squares
 * fit of the shader mapping (ground rows + lateral edges over the visible
 * depth band, weighted toward the near field). Fit script: see commit
 * history (fit-cam*.mjs). Residuals: near/mid-field <= ~6px, lateral <= ~1px.
 *
 * Loaded as a classic script (global MK3D), needs scripts/three.min.js first.
 */
(function() {
	"use strict";

	// World mapping: 1 unit = 8 map px vertically/in depth. Laterally the
	// fitted world is narrower (Sx=0.696): the stock view is wider than a
	// true pinhole, and matching it keeps road width identical to stock.
	var WORLD_SCALE = 8;
	var FIT = {
		H: 2.514,          // camera height, world units
		C: 4.389,          // camera backoff behind reference point, world units
		PITCH: 18.22 * Math.PI / 180, // camera tilt below horizontal
		F_AT_312: 413.7,  // focal length in backing px at 312 canvas rows
		KX: 0.0875        // world units per map px on the x axis
	};

	// Walls: collision data carries a z height in "jump" units (see
	// jumpHeight0 in mk.js). True height (z*JUMP_PX/WORLD_SCALE) is nearly
	// invisible at chase-cam distance, so it is exaggerated for
	// readability. Collision behavior is unchanged; this is visual only.
	var JUMP_PX = 1.175;
	var WALL_VISUAL_SCALE = 8;
	var WALL_COLOR = 0x8e8e8e;

	// Shared unit geometries for decor parts (one upload per renderer).
	// Meshes scale these, so per-instance geometry allocation is zero.
	var UNIT_GEOS = {};
	function unitGeo(name) {
		if (UNIT_GEOS[name]) return UNIT_GEOS[name];
		var g = null;
		if (name === "box") g = new THREE.BoxGeometry(1, 1, 1);
		else if (name === "sphere") g = new THREE.SphereGeometry(0.5, 10, 8);
		else if (name === "cone") g = new THREE.ConeGeometry(0.5, 1, 12);
		else if (name === "cyl") g = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
		if (g) UNIT_GEOS[name] = g;
		return g;
	}

	// Plain colors are authored in sRGB (like stock's flat fills); convert
	// to linear so the sRGB output transform reproduces them exactly.
	// (Texture maps round-trip on their own and need no handling.)
	function srgbToLinear(c) {
		return c.convertSRGBToLinear();
	}

	function parseBg(bgcolor) {
		if (Array.isArray(bgcolor) && bgcolor.length >= 3)
			return [bgcolor[0] / 255, bgcolor[1] / 255, bgcolor[2] / 255];
		if (typeof bgcolor === "string") {
			var parts = bgcolor.split(",");
			if (parts.length >= 3)
				return [+parts[0] / 255, +parts[1] / 255, +parts[2] / 255];
		}
		return [0, 0, 0];
	}

	// Forward vector in map space for a kart rotation (degrees).
	// Grounded empirically: holding accelerate at rotation 180 drives the
	// kart toward -y, so forward(180) = (0,-1), i.e. (sin, cos), NOT
	// (-sin, -cos). (An earlier sign-flipped version pointed the chase
	// camera backward, which made driving look reversed.)
	function forwardOf(rotationDeg) {
		var rad = rotationDeg * Math.PI / 180;
		return { x: Math.sin(rad), y: Math.cos(rad) };
	}

	function focalForHeight(rows) {
		return FIT.F_AT_312 * (rows / 312);
	}

	function updateProjection(state) {
		var canvas = state.renderer.domElement;
		var w = canvas.width, h = canvas.height;
		var f = focalForHeight(h);
		var fov = 2 * Math.atan((h / 2) / f) * 180 / Math.PI;
		if (state.fov !== fov || state.camera.aspect !== w / Math.max(1, h)) {
			state.fov = fov;
			state.camera.fov = fov;
			state.camera.aspect = w / Math.max(1, h);
			state.camera.updateProjectionMatrix();
		}
	}

	function init(canvas) {
		if (typeof THREE === "undefined") {
			console.error("[mk-3d] THREE global missing, cannot init 3D renderer");
			return null;
		}
		try {
			var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, preserveDrawingBuffer: true });
		}
		catch (e) {
			console.error("[mk-3d] WebGL renderer creation failed", e);
			return null;
		}
		renderer.outputEncoding = THREE.sRGBEncoding;
		renderer.setSize(canvas.width, canvas.height, false);
		renderer.setPixelRatio(1);

		try {
			console.log("[mk-3d] 3D renderer active (" + canvas.width + "x" + canvas.height + ")");
			if (!window.__mk3dBadge) {
				var badge = document.createElement("div");
				badge.className = "mk3d-badge";
				badge.textContent = "3D";
				window.__mk3dBadge = badge;
				badge.style.position = "fixed";
				badge.style.right = "4px";
				badge.style.top = "4px";
				badge.style.zIndex = 9999;
				badge.style.background = "rgba(0,128,0,0.8)";
				badge.style.color = "#fff";
				badge.style.font = "bold 12px sans-serif";
				badge.style.padding = "2px 6px";
				badge.style.borderRadius = "4px";
				badge.style.pointerEvents = "none";
				// NB: appended to body, NOT the game container: resetScreen
				// deep-clones that subtree for motion-blur frames, which would
				// duplicate any badge inside it.
				document.body.appendChild(badge);
			}
		}
		catch (e) {}

		var scene = new THREE.Scene();
		var camera = new THREE.PerspectiveCamera(60, canvas.width / Math.max(1, canvas.height), 0.1, 2000);

		var hemi = new THREE.HemisphereLight(0xffffff, 0x334433, 0.9);
		scene.add(hemi);
		var dir = new THREE.DirectionalLight(0xffffff, 0.6);
		dir.position.set(30, 60, 20);
		scene.add(dir);

		var state = {
			renderer: renderer,
			scene: scene,
			camera: camera,
			ground: null,
			groundTex: null,
			skirt: null,
			ring: null,
			ringKey: null,
			mapW: 0,
			mapH: 0,
			fov: 0,
			skyCache: {},
			walls: null,
			wallMap: null,
			wallKey: null,
			wallList: null,
			decorGroup: null,
			decorMeshes: null,
			decorMap: null,
			mats: {},
			boosts: null,
			boostMap: null,
			boostKey: null,
			boostMat: null,
			holes: null,
			holeMap: null,
			holeKey: null,
			holeMat: null
		};
		updateProjection(state);
		return state;
	}

	function ensureGround(state, mapCanvas) {
		var w = mapCanvas.width, h = mapCanvas.height;
		if (state.ground && state.mapW === w && state.mapH === h)
			return;
		if (state.ground) {
			state.scene.remove(state.ground);
			state.ground.geometry.dispose();
			if (state.groundTex) state.groundTex.dispose();
			state.ground = null;
		}
		var W = w * FIT.KX, H = h / WORLD_SCALE;
		var geo = new THREE.PlaneGeometry(W, H);
		// Lie flat: plane +Y (texture top, v=1) -> world -Z, then shift so
		// map pixel (x,y) lands on world (x*KX, 0, y/S).
		geo.rotateX(-Math.PI / 2);
		geo.translate(W / 2, 0, H / 2);
		var tex = new THREE.CanvasTexture(mapCanvas);
		tex.encoding = THREE.sRGBEncoding;
		// Stock samples texels unfiltered; match it exactly (no mipmaps).
		tex.magFilter = THREE.NearestFilter;
		tex.minFilter = THREE.NearestFilter;
		tex.generateMipmaps = false;
		var mat = new THREE.MeshBasicMaterial({ map: tex });
		state.ground = new THREE.Mesh(geo, mat);
		state.groundTex = tex;
		state.mapW = w;
		state.mapH = h;
		state.scene.add(state.ground);
		// Plain backdrop plane far below the horizon line: whatever the
		// track texture doesn't cover (past map edges) shows the track
		// background color, like stock's out-of-bounds fill.
		if (!state.skirt) {
			var skirtGeo = new THREE.PlaneGeometry(4096, 4096);
			skirtGeo.rotateX(-Math.PI / 2);
			state.skirt = new THREE.Mesh(skirtGeo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
			state.skirt.position.y = -0.5;
			state.scene.add(state.skirt);
		}
	}

	// Cached Lambert material per state (one program per color; shared by
	// every mesh that uses it, across all screens).
	function matFor(state, hex, emissive, doubleSided) {
		var key = hex + ":" + (emissive || 0) + ":" + (doubleSided ? "2" : "1");
		if (!state.mats[key]) {
			var opts = { color: hex };
			if (doubleSided) opts.side = THREE.DoubleSide;
			var m = new THREE.MeshLambertMaterial(opts);
			srgbToLinear(m.color);
			if (emissive) {
				m.emissive = new THREE.Color(emissive);
				srgbToLinear(m.emissive);
			}
			state.mats[key] = m;
		}
		return state.mats[key];
	}

	// One scaled part inside a decor group.
	function part(state, parent, geoName, hex, sx, sy, sz, px, py, pz, emissive) {
		var geo = unitGeo(geoName);
		if (!geo) return null;
		var mesh = new THREE.Mesh(geo, matFor(state, hex, emissive, false));
		mesh.scale.set(sx, sy, sz);
		mesh.position.set(px, py, pz);
		parent.add(mesh);
		return mesh;
	}

	// Visual height of a wall in world units from its collision props.
	// Missing props default to z:1, matching getZoneHeight in mk.js.
	function wallHeightWorld(props) {
		var z = (props && props.z != null) ? +props.z : 1;
		if (!(z > 0)) return 0;
		return z * JUMP_PX * WALL_VISUAL_SCALE / WORLD_SCALE;
	}

	function clearWalls(state) {
		if (state.walls) {
			state.scene.remove(state.walls);
			state.walls.traverse(function(obj) {
				if (obj.geometry) obj.geometry.dispose();
			});
			state.walls = null;
		}
		state.wallMap = null;
		state.wallKey = null;
		state.wallList = null;
	}

	// Sight-line test height above the sprite base, in world units. Karts
	// read ~0.7 tall; testing partway up hides them only when the wall
	// truly covers them, not when they hop behind a low lip.
	var OCCLUDE_LIFT = 0.35;

	// Segment AB vs segment CD in map px. Returns the ray param t of the
	// hit along AB, or -1 on a miss.
	function segIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
		var dx = x2 - x1, dy = y2 - y1, ex = x4 - x3, ey = y4 - y3;
		var den = dx * ey - dy * ex;
		if (den > -1e-9 && den < 1e-9) return -1;
		var t = ((x3 - x1) * ey - (y3 - y1) * ex) / den;
		var u = ((x3 - x1) * dy - (y3 - y1) * dx) / den;
		if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
		return t;
	}

	// Nearest hit of the camera->sprite ray on one wall footprint, or -1.
	function wallHit(w, camX, camY, sprX, sprY) {
		var t = -1, c, k;
		if (w.t === "r") {
			var b = w.b, x0 = b[0], y0 = b[1], x1 = b[0] + b[2], y1 = b[1] + b[3];
			var edges = [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0];
			for (k = 0; k < 4; k++) {
				c = segIntersect(camX, camY, sprX, sprY, edges[k * 4], edges[k * 4 + 1], edges[k * 4 + 2], edges[k * 4 + 3]);
				if (c >= 0 && (t < 0 || c < t)) t = c;
			}
		}
		else {
			var pts = w.b;
			for (k = 0; k < pts.length; k++) {
				var p1 = pts[k], p2 = pts[(k + 1) % pts.length];
				c = segIntersect(camX, camY, sprX, sprY, p1[0], p1[1], p2[0], p2[1]);
				if (c >= 0 && (t < 0 || c < t)) t = c;
			}
		}
		return t;
	}

	// Smallest clearance of the camera->sprite sight line over the walls
	// it crosses (sight height minus wall top, world units; +Infinity when
	// nothing is crossed). Callers hide on negative clearance with a
	// deadband above zero, so grazing angles stick instead of flickering.
	// Never throws: bad input = +Infinity (visible).
	function occlusionClearance(state, mapX, mapY, mapZ) {
		try {
			if (!state || !state.camera || !state.wallList || !state.wallList.length)
				return Infinity;
			if (!isFinite(mapX) || !isFinite(mapY)) return Infinity;
			var cam = state.camera.position;
			var camX = cam.x / FIT.KX, camY = cam.z * WORLD_SCALE;
			if (!isFinite(camX) || !isFinite(camY) || !isFinite(cam.y)) return Infinity;
			var testY = ((+mapZ) || 0) / WORLD_SCALE + OCCLUDE_LIFT;
			var best = Infinity, walls = state.wallList;
			for (var i = 0; i < walls.length; i++) {
				var t = wallHit(walls[i], camX, camY, mapX, mapY);
				if (t > 0.001 && t < 0.999) {
					var c = (cam.y + t * (testY - cam.y)) - walls[i].top;
					if (c < best) best = c;
				}
			}
			return best;
		}
		catch (e) {
			return Infinity;
		}
	}

	// True when a wall stands between the chase camera and the map point
	// (map px). Hides DOM sprites behind walls; mesh decors occlude each
	// other through the depth buffer. Never throws: bad input = visible.
	function isOccluded(state, mapX, mapY, mapZ) {
		return occlusionClearance(state, mapX, mapY, mapZ) < 0;
	}

	// Extrude lMap.collision (rectangles + polygons, normalized to
	// {rectangle,polygon} by mk.js before the race) to flat-shaded boxes
	// and prisms. Rebuilt when the map or wall count changes; challenge
	// modes append walls mid-race, which changes the counts.
	function ensureWalls(state, lMap) {
		var c = lMap && lMap.collision;
		var rects = (c && c.rectangle) || [];
		var polys = (c && c.polygon) || [];
		var raw = (c && !c.rectangle && !c.polygon && Object.prototype.toString.call(c) === "[object Array]") ? c : null;
		if (!rects.length && !polys.length && !raw) {
			if (state.walls) clearWalls(state);
			return;
		}
		var key = rects.length + ":" + polys.length + ":" + (raw ? raw.length : 0);
		if (state.wallMap === lMap && state.wallKey === key && state.walls)
			return;
		clearWalls(state);
		var group = new THREE.Group();
		var wallList = [];
		var mat = matFor(state, WALL_COLOR, 0, true);
		var props = (lMap && lMap.collisionProps) || {};
		function addBox(cx, cz, wW, dW, hW) {
			if (wW <= 0 || dW <= 0 || hW <= 0) return;
			try {
				var mesh = new THREE.Mesh(new THREE.BoxGeometry(wW, hW, dW), mat);
				mesh.position.set(cx, hW / 2 + 0.02, cz);
				group.add(mesh);
			}
			catch (e) {}
		}
		function addPoly(points, hW) {
			if (!points || points.length < 3 || !hW) return;
			try {
				var shape = new THREE.Shape();
				shape.moveTo(points[0][0] * FIT.KX, points[0][1] / WORLD_SCALE);
				for (var k = 1; k < points.length; k++)
					shape.lineTo(points[k][0] * FIT.KX, points[k][1] / WORLD_SCALE);
				shape.closePath();
				var geo = new THREE.ExtrudeGeometry(shape, { depth: hW, bevelEnabled: false });
				// Shape (sx,sy) extruded along +Z -> rotate +90deg about X
				// maps (sx,sy,sz) to (sx,-sz,sy), then lift to [0,hW].
				geo.rotateX(Math.PI / 2);
				geo.translate(0, hW + 0.02, 0);
				group.add(new THREE.Mesh(geo, mat));
			}
			catch (e) {}
		}
		var i, r, hW;
		for (i = 0; i < rects.length; i++) {
			r = rects[i];
			var p = props.rectangle && props.rectangle[i];
			hW = wallHeightWorld(p);
			if (hW) {
				addBox((r[0] + r[2] / 2) * FIT.KX, (r[1] + r[3] / 2) / WORLD_SCALE, r[2] * FIT.KX, r[3] / WORLD_SCALE, hW);
				wallList.push({ t: "r", b: [r[0], r[1], r[2], r[3]], top: hW });
			}
		}
		for (i = 0; i < polys.length; i++) {
			var pp = props.polygon && props.polygon[i];
			hW = wallHeightWorld(pp);
			if (hW) {
				addPoly(polys[i], hW);
				wallList.push({ t: "p", b: polys[i], top: hW });
			}
		}
		if (raw) {
			for (i = 0; i < raw.length; i++) {
				var s = raw[i];
				hW = wallHeightWorld(props[i]);
				if (!hW) continue;
				if (typeof s[0] === "number") {
					if (s.length < 4) {
						// Circle [x,y,r]: map circles are ellipses in world
						// (KX vs 1/S), so correct the z radius by scale.
						try {
							var cg = new THREE.CylinderGeometry(s[2] * FIT.KX, s[2] * FIT.KX, hW, 20);
							var cm = new THREE.Mesh(cg, mat);
							cm.scale.z = 1 / (WORLD_SCALE * FIT.KX);
							cm.position.set(s[0] * FIT.KX, hW / 2 + 0.02, s[1] / WORLD_SCALE);
							group.add(cm);
							wallList.push({ t: "r", b: [s[0] - s[2], s[1] - s[2], s[2] * 2, s[2] * 2], top: hW });
						}
						catch (e) {}
					}
					else {
						addBox((s[0] + s[2] / 2) * FIT.KX, (s[1] + s[3] / 2) / WORLD_SCALE, s[2] * FIT.KX, s[3] / WORLD_SCALE, hW);
						wallList.push({ t: "r", b: [s[0], s[1], s[2], s[3]], top: hW });
					}
				}
				else {
					addPoly(s, hW);
					wallList.push({ t: "p", b: s, top: hW });
				}
			}
		}
		if (group.children.length)
			state.scene.add(group);
		state.walls = group;
		state.wallMap = lMap;
		state.wallKey = key;
		state.wallList = wallList;
	}

	// Boost pads (lMap.accelerateurs) and holes (lMap.trous) as flat ground
	// decals. Both normalize to {rectangle,polygon} at load; pad arrow art
	// stays baked in the track texture, so the boost decal is only a subtle
	// pulse (visible at glancing angles and on tracks without baked art)
	// and holes get a darkened inset. Rebuilt when the map or zone counts
	// change (lap overrides swap lMap mid-race).
	var BOOST_COLOR = 0xff9a2a;
	var BOOST_Y = 0.04;
	var HOLE_COLOR = 0x050505;
	var HOLE_Y = 0.02;

	// Flat decal from absolute map-px points. Shape +Y is negated so that
	// rotateX(-PI/2) maps (sx,sy) to (sx,0,sy) with an UP normal.
	function flatPoly(points) {
		if (!points || points.length < 3) return null;
		try {
			var shape = new THREE.Shape();
			shape.moveTo(points[0][0] * FIT.KX, -points[0][1] / WORLD_SCALE);
			for (var k = 1; k < points.length; k++)
				shape.lineTo(points[k][0] * FIT.KX, -points[k][1] / WORLD_SCALE);
			shape.closePath();
			var geo = new THREE.ShapeGeometry(shape);
			geo.rotateX(-Math.PI / 2);
			return geo;
		}
		catch (e) {
			return null;
		}
	}

	function flatRect(x, y, w, h) {
		if (!(w > 0) || !(h > 0)) return null;
		try {
			var geo = new THREE.PlaneGeometry(w * FIT.KX, h / WORLD_SCALE);
			geo.rotateX(-Math.PI / 2);
			geo.translate((x + w / 2) * FIT.KX, 0, (y + h / 2) / WORLD_SCALE);
			return geo;
		}
		catch (e) {
			return null;
		}
	}

	// Zone entries are [x,y,w,h] rectangles or [[x,y],...] polygons, but
	// hole groups may pair them with an origin ([box,origin]). Unwrap both.
	function zoneBox(r) {
		if (!r) return null;
		if (typeof r[0] === "number") return r;
		return zoneBox(r[0]);
	}

	function zonePoints(p) {
		if (!p || !p.length || !p[0]) return null;
		if (typeof p[0][0] === "object") return zonePoints(p[0]);
		return p;
	}

	function clearDecals(state, groupKey, mapKey, keyKey) {
		if (state[groupKey]) {
			state.scene.remove(state[groupKey]);
			state[groupKey].traverse(function(obj) {
				if (obj.geometry) obj.geometry.dispose();
			});
			state[groupKey] = null;
		}
		state[mapKey] = null;
		state[keyKey] = null;
	}

	function ensureBoosts(state, lMap) {
		var acc = lMap && lMap.accelerateurs;
		var rects = (acc && acc.rectangle) || [];
		var polys = (acc && acc.polygon) || [];
		if (!rects.length && !polys.length) {
			if (state.boosts) clearDecals(state, "boosts", "boostMap", "boostKey");
			return;
		}
		var key = rects.length + ":" + polys.length;
		if (state.boostMap === lMap && state.boostKey === key && state.boosts)
			return;
		clearDecals(state, "boosts", "boostMap", "boostKey");
		if (!state.boostMat) {
			state.boostMat = new THREE.MeshBasicMaterial({ color: BOOST_COLOR, transparent: true, opacity: 0.3, depthWrite: false });
			srgbToLinear(state.boostMat.color);
		}
		var group = new THREE.Group();
		var i, g, m;
		for (i = 0; i < rects.length; i++) {
			var r = zoneBox(rects[i]);
			if (!r) continue;
			var w = (r.length > 2 && r[2] > 0) ? r[2] : 8;
			var h = (r.length > 3 && r[3] > 0) ? r[3] : 8;
			g = flatRect(r[0], r[1], w, h);
			if (g) {
				m = new THREE.Mesh(g, state.boostMat);
				m.position.y = BOOST_Y;
				m.renderOrder = 1;
				group.add(m);
			}
		}
		for (i = 0; i < polys.length; i++) {
			g = flatPoly(zonePoints(polys[i]));
			if (g) {
				m = new THREE.Mesh(g, state.boostMat);
				m.position.y = BOOST_Y;
				m.renderOrder = 1;
				group.add(m);
			}
		}
		if (group.children.length) state.scene.add(group);
		state.boosts = group;
		state.boostMap = lMap;
		state.boostKey = key;
	}

	function ensureHoles(state, lMap) {
		var trous = lMap && lMap.trous;
		var rects = [], polys = [];
		if (trous) {
			for (var k in trous) {
				var grp = trous[k];
				if (!grp) continue;
				var rr = grp.rectangle || [], pp = grp.polygon || [];
				for (var i = 0; i < rr.length; i++) {
					var box = zoneBox(rr[i]);
					if (box && box.length >= 4) rects.push(box);
				}
				for (var j = 0; j < pp.length; j++) {
					var pts = zonePoints(pp[j]);
					if (pts) polys.push(pts);
				}
			}
		}
		if (!rects.length && !polys.length) {
			if (state.holes) clearDecals(state, "holes", "holeMap", "holeKey");
			return;
		}
		var key = rects.length + ":" + polys.length;
		if (state.holeMap === lMap && state.holeKey === key && state.holes)
			return;
		clearDecals(state, "holes", "holeMap", "holeKey");
		if (!state.holeMat) {
			state.holeMat = new THREE.MeshBasicMaterial({ color: HOLE_COLOR, transparent: true, opacity: 0.6, depthWrite: false });
		}
		var group = new THREE.Group();
		var i, g, m;
		for (i = 0; i < rects.length; i++) {
			var r = rects[i];
			g = flatRect(r[0], r[1], r[2], r[3]);
			if (g) {
				m = new THREE.Mesh(g, state.holeMat);
				m.position.y = HOLE_Y;
				m.renderOrder = 1;
				group.add(m);
			}
		}
		for (i = 0; i < polys.length; i++) {
			g = flatPoly(polys[i]);
			if (g) {
				m = new THREE.Mesh(g, state.holeMat);
				m.position.y = HOLE_Y;
				m.renderOrder = 1;
				group.add(m);
			}
		}
		if (group.children.length) state.scene.add(group);
		state.holes = group;
		state.holeMap = lMap;
		state.holeKey = key;
	}

	// Decor type -> solid family. Covers every decorBehaviors key in mk.js;
	// unknown (custom) types fall through to a neutral block.
	function decorFamily(type) {
		switch (type) {
		case "tree": case "mariotree": case "peachtree": case "falltree":
		case "mountaintree": case "movingtree": case "sinistertree":
		case "fir": case "palm":
			return "tree";
		case "pokey":
			return "pokey";
		case "box":
			return "box";
		case "thwomp": case "movingthwomp":
			return "thwomp";
		case "plante": case "fireplant":
			return "plant";
		case "goomba": case "crabe": case "taupe": case "tortitaupe":
		case "topitaupe": case "cheepcheep": case "poisson":
			return "enemy";
		case "firesnake": case "firebar": case "firering": case "fire3star":
		case "fireballs": case "fireball":
			return "fire";
		case "billball": case "cannonball": case "snowball": case "snowman":
			return "ball";
		case "truck": case "chomp": case "pendulum":
			return "truck";
		default:
			return "block";
		}
	}

	// Build the solid parts for one decor instance. wW/dW/hW come from the
	// gameplay hitbox (map px mapped to world), so visuals match collision.
	function buildDecorInto(state, group, type, wW, dW, hW) {
		var W = Math.max(0.35, wW), D = Math.max(0.35, dW), H = Math.max(0.45, hW);
		var R = Math.max(W, D);
		try {
			switch (decorFamily(type)) {
			case "tree": {
				var trunkH = 0.35 + H * 0.35;
				part(state, group, "cyl", 0x7a4a21, R * 0.22, trunkH, R * 0.22, 0, trunkH / 2, 0);
				var leaf = (type === "peachtree") ? 0xe8a0bf : (type === "palm" ? 0x3aa655 : (type === "fir" ? 0x1f6e2e : 0x2e8b3a));
				if (type === "palm")
					part(state, group, "sphere", leaf, R * 1.7, H * 0.7, D * 1.7, 0, trunkH + H * 0.3, 0);
				else
					part(state, group, "cone", leaf, R * 1.6, H * 1.5 + 0.3, D * 1.6, 0, trunkH + (H * 1.5 + 0.3) / 2 - 0.1, 0);
				break;
			}
			case "pokey": {
				var pr = R * 0.42 + 0.1;
				for (var k = 0; k < 3; k++)
					part(state, group, "sphere", 0xe8c33a, pr * 2, pr * 2, pr * 2, 0, pr + k * pr * 1.7, 0);
				break;
			}
			case "box": {
				var be = Math.max(W, D, H, 0.45);
				part(state, group, "box", 0xd8a53a, be, be, be, 0, be / 2, 0);
				break;
			}
			case "thwomp": {
				var te = Math.max(W, H, 0.6);
				part(state, group, "box", 0x8f8f9a, te * 1.1, te, te * 0.8, 0, te / 2, 0);
				break;
			}
			case "plant":
				part(state, group, "cyl", 0x2e8b3a, R * 0.18, H * 0.8, R * 0.18, 0, H * 0.4, 0);
				part(state, group, "sphere", 0xd83a2e, R * 0.9, H * 0.7, D * 0.9, 0, H * 0.9, 0);
				break;
			case "enemy":
				part(state, group, "sphere", 0x9c5a2e, R * 1.3, H * 0.9, D * 1.3, 0, H * 0.45, 0);
				break;
			case "fire":
				part(state, group, "sphere", 0xe6542a, R * 1.1, H * 0.9, D * 1.1, 0, H * 0.45, 0, 0x5a1500);
				break;
			case "ball": {
				var bc = (type === "snowball" || type === "snowman") ? 0xf2f2f2 : ((type === "billball" || type === "cannonball") ? 0x2e2e33 : 0xcfcfcf);
				part(state, group, "sphere", bc, R * 1.2, H, D * 1.2, 0, H / 2, 0);
				break;
			}
			case "truck":
				part(state, group, "box", 0xb03a2e, W * 1.6, H * 0.9, D, 0, H * 0.45, 0);
				part(state, group, "box", 0x3a6ea8, W * 0.6, H * 0.7, D * 0.9, W * 0.5, H * 0.35, 0);
				break;
			default: {
				var de = Math.max(W, D, 0.4);
				part(state, group, "box", 0xa08050, de, H, de, 0, H / 2, 0);
				break;
			}
			}
		}
		catch (e) {}
	}

	// Called once per render(): drop meshes from a previous map and hide
	// every instance. syncDecor re-shows the live ones later this frame,
	// so broken/removed decors vanish without index bookkeeping.
	function resetDecors(state, lMap) {
		if (!state.decorGroup) {
			state.decorGroup = new THREE.Group();
			state.decorMeshes = {};
			state.scene.add(state.decorGroup);
		}
		if (state.decorMap !== lMap) {
			var g = state.decorGroup, ch;
			while ((ch = g.children[0])) g.remove(ch);
			state.decorMeshes = {};
			state.decorMap = lMap;
		}
		var kids = state.decorGroup.children;
		for (var i = 0; i < kids.length; i++)
			kids[i].visible = false;
	}

	// Position one decor instance in the scene. Returns true when the
	// instance is shown as a mesh (caller skips the DOM billboard).
	// wPx/hPx are gameplay hitbox sizes in map px (mk.js decorBehaviors).
	function syncDecor(state, type, index, x, y, z, wPx, hPx) {
		if (!state || !state.scene) return false;
		try {
			if (!state.decorGroup) {
				state.decorGroup = new THREE.Group();
				state.decorMeshes = {};
				state.decorMap = null;
				state.scene.add(state.decorGroup);
			}
			var arr = state.decorMeshes[type];
			if (!arr) arr = state.decorMeshes[type] = [];
			var g = arr[index];
			if (!g || g.userData.w !== wPx || g.userData.h !== hPx) {
				if (g) state.decorGroup.remove(g);
				g = new THREE.Group();
				g.userData.w = wPx;
				g.userData.h = hPx;
				buildDecorInto(state, g, type, (wPx || 5) * FIT.KX, (wPx || 5) / WORLD_SCALE, (hPx || 4) / WORLD_SCALE);
				state.decorGroup.add(g);
				arr[index] = g;
			}
			g.position.set(x * FIT.KX, ((+z) || 0) / WORLD_SCALE, y / WORLD_SCALE);
			g.visible = true;
			return true;
		}
		catch (e) {
			return false;
		}
	}

	// Distant scenery ring: the track's flat background strips as textures
	// on open cylinders around the map. Static world geometry, so rotation
	// parallax comes out right by itself. Layer order = creation order:
	// index 0 is farthest (like stock's scroll factors). Rebuilt when the
	// URL set or map size changes.
	function updateRing(state, urls) {
		var key = state.mapW + "x" + state.mapH + "|" + urls.join("|");
		if (key === state.ringKey) return;
		state.ringKey = key;
		if (state.ring) {
			state.scene.remove(state.ring);
			state.ring.traverse(function(obj) {
				if (obj.geometry) obj.geometry.dispose();
				if (obj.material) {
					if (obj.material.map) obj.material.map.dispose();
					obj.material.dispose();
				}
			});
			state.ring = null;
		}
		if (!urls.length) return;
		var mapCX = state.mapW * FIT.KX / 2, mapCZ = state.mapH / WORLD_SCALE / 2;
		var mapDiag = Math.sqrt(Math.pow(state.mapW * FIT.KX, 2) + Math.pow(state.mapH / WORLD_SCALE, 2));
		var loader = new THREE.TextureLoader();
		loader.crossOrigin = "anonymous";
		var group = new THREE.Group();
		urls.forEach(function(url, i) {
			var radius = mapDiag * (1.5 - 0.3 * i);
			var height = radius * 0.2;
			var geo = new THREE.CylinderGeometry(radius, radius, height, 72, 1, true);
			var tex = loader.load(url,
				function() { mesh.visible = true; },
				undefined,
				function() { mesh.visible = false; });
			tex.encoding = THREE.sRGBEncoding;
			tex.magFilter = THREE.NearestFilter;
			tex.minFilter = THREE.NearestFilter;
			tex.generateMipmaps = false;
			var mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, alphaTest: 0.5 });
			var mesh = new THREE.Mesh(geo, mat);
			mesh.position.set(mapCX, height / 2, mapCZ);
			mesh.visible = false;
			mesh.renderOrder = -10 + i;
			group.add(mesh);
		});
		state.ring = group;
		state.scene.add(group);
	}
	// Same-origin artwork reads directly; anything else falls back to a
	// neutral sky blue. Cached per URL.
	var FALLBACK_SKY = [0.53, 0.81, 0.92];
	function sampleSky(state, url) {
		if (!url) return FALLBACK_SKY;
		var cached = state.skyCache[url];
		if (cached) return cached;
		state.skyCache[url] = FALLBACK_SKY;
		try {
			var img = new Image();
			img.onload = function() {
				try {
					var cv = document.createElement("canvas");
					cv.width = 8; cv.height = 8;
					var cx = cv.getContext("2d");
					cx.drawImage(img, 0, 0, 8, 8);
					var d = cx.getImageData(0, 0, 8, 2).data;
					var r = 0, g = 0, b = 0, n = 0;
					for (var i = 0; i < d.length; i += 4) {
						if (d[i + 3] < 128) continue;
						r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
					}
					if (n)
						state.skyCache[url] = [r / n / 255, g / n / 255, b / n / 255];
				}
				catch (e) {}
			};
			img.src = url;
		}
		catch (e) {}
		return FALLBACK_SKY;
	}

	function toWorld(mapX, mapY, mapZ) {
		return new THREE.Vector3(mapX * FIT.KX, (mapZ || 0) / WORLD_SCALE, mapY / WORLD_SCALE);
	}

	// Project a map-space point (pixels; mapZ = height above ground in
	// pixels) to canvas backing-store pixels using the current chase camera.
	// Always unmirrored: mirror mode flips the whole view in screen space
	// (canvas CSS + negated sprite offsets, like stock), so this stays put.
	// Returns null when behind the camera. dist is in world units.
	function project(state, mapX, mapY, mapZ) {
		if (!state || !state.camera) return null;
		var v = toWorld(mapX, mapY, mapZ);
		var dist = state.camera.position.distanceTo(v);
		v.project(state.camera);
		if (v.z > 1 || v.z < -1) return null;
		var cv = state.renderer.domElement;
		return {
			x: (v.x * 0.5 + 0.5) * cv.width,
			y: (-v.y * 0.5 + 0.5) * cv.height,
			dist: dist
		};
	}

	function cameraFrame(fCamera) {
		var fwd = forwardOf(fCamera.rotation || 0);
		// Map-space forward -> world direction (non-uniform scale), normalized.
		var dx = fwd.x * FIT.KX, dz = fwd.y / WORLD_SCALE;
		var len = Math.sqrt(dx * dx + dz * dz) || 1;
		var dirX = dx / len, dirZ = dz / len;
		var px = fCamera.x * FIT.KX, py = fCamera.y / WORLD_SCALE;
		var cosT = Math.cos(FIT.PITCH), sinT = Math.sin(FIT.PITCH);
		return {
			pos: {
				x: px - dirX * FIT.C,
				y: FIT.H,
				z: py - dirZ * FIT.C
			},
			dir: {
				x: dirX * cosT,
				y: -sinT,
				z: dirZ * cosT
			}
		};
	}

	function render(state, fCamera, lMap, mapCanvas, opts) {
		opts = opts || {};
		if (!state || !mapCanvas || !mapCanvas.width) return;
		ensureGround(state, mapCanvas);
		state.groundTex.needsUpdate = true;
		ensureWalls(state, lMap);
		ensureBoosts(state, lMap);
		ensureHoles(state, lMap);
		if (state.boostMat) {
			try {
				state.boostMat.opacity = 0.26 + 0.12 * Math.sin(performance.now() / 1000 * 4);
			}
			catch (e) {}
		}
		resetDecors(state, lMap);
		updateRing(state, opts.bgUrls || []);

		var bg = parseBg(lMap && lMap.bgcolor);
		if (state.skirt)
			state.skirt.material.color.setRGB(bg[0], bg[1], bg[2]).convertSRGBToLinear();
		var sky = sampleSky(state, opts.bgUrl);
		state.renderer.setClearColor(srgbToLinear(new THREE.Color(sky[0], sky[1], sky[2])), 1);

		var frame = cameraFrame(fCamera);
		var cam = state.camera;
		cam.position.set(frame.pos.x, frame.pos.y, frame.pos.z);
		cam.lookAt(
			frame.pos.x + frame.dir.x * 10,
			frame.pos.y + frame.dir.y * 10,
			frame.pos.z + frame.dir.z * 10
		);

		updateProjection(state);
		state.renderer.render(state.scene, cam);
	}

	window.MK3D = {
		WORLD_SCALE: WORLD_SCALE,
		FIT: FIT,
		WALL_COLOR: WALL_COLOR,
		WALL_VISUAL_SCALE: WALL_VISUAL_SCALE,
		init: init,
		project: project,
		render: render,
		syncDecor: syncDecor,
		isOccluded: isOccluded,
		occlusionClearance: occlusionClearance
	};
})();
