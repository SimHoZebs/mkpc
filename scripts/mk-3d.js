/*
 * MKPC 3D renderer (experimental) — scripts/mk-3d.js
 *
 * Third render mode next to the built-in WebGL (Mode7 shader) and legacy
 * Canvas engines. It reuses the exact same per-frame inputs:
 *   - fCamera {x, y, rotation} in map pixels, same as redrawCanvas()
 *   - mapCanvas, the 2D-composited ground (track + assets + sea), as texture
 * Physics and netcode are untouched. DOM sprites (karts, items, markers)
 * are positioned through MK3D.project so they sit exactly on the 3D
 * ground; true 3D meshes for them come later.
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
		H: 2.766,          // camera height, world units
		C: 4.407,          // camera backoff behind reference point, world units
		PITCH: 20.55 * Math.PI / 180, // camera tilt below horizontal
		F_AT_312: 417.2,  // focal length in backing px at 312 canvas rows
		KX: 0.0870         // world units per map px on the x axis
	};

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

		// Stock fades ground to the background color past ~238 map px ahead
		// (its distance cutoff). Reproduce it as (near-)hard fog so the DOM
		// background strips (hills/trees, positioned for stock framing) sit
		// over background color, not over detailed far ground. Without this,
		// the strips cover up to ~100px of visible track.
		// Cutoff in world units radial from the camera:
		// sqrt((C + 238/S)^2 + H^2) ~= 34.3.
		scene.fog = new THREE.Fog(0x000000, 34.15, 34.35);

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
			mapW: 0,
			mapH: 0,
			fov: 0
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

		var bg = parseBg(lMap && lMap.bgcolor);
		state.renderer.setClearColor(new THREE.Color(bg[0], bg[1], bg[2]), 1);
		state.scene.fog.color.setRGB(bg[0], bg[1], bg[2]);

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
		init: init,
		project: project,
		render: render
	};
})();
