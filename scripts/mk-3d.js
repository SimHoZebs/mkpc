/*
 * MKPC 3D renderer (experimental) — scripts/mk-3d.js
 *
 * Third render mode next to the built-in WebGL (Mode7 shader) and legacy
 * Canvas engines. It reuses the exact same per-frame inputs:
 *   - fCamera {x, y, rotation} in map pixels, same as redrawCanvas()
 *   - mapCanvas, the 2D-composited ground (track + assets + sea), as texture
 * Physics, netcode and DOM sprites are untouched: this file only draws the
 * ground in true 3D perspective. Karts/items become meshes in a later step.
 *
 * Loaded as a classic script (global MK3D), needs scripts/three.min.js first.
 */
(function() {
	"use strict";

	// 1 world unit = WORLD_SCALE map pixels. A 512px track becomes 64 units.
	var WORLD_SCALE = 8;

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

	function init(canvas, opts) {
		opts = opts || {};
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
			window.__mk3dInits = (window.__mk3dInits || 0) + 1;
			console.log("[mk-3d] init #" + window.__mk3dInits + " guard=" + !!window.__mk3dBadge +
				" parent=" + (canvas.parentNode && (canvas.parentNode.nodeName + "." + canvas.parentNode.className)));
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
		var camera = new THREE.PerspectiveCamera(70, canvas.width / Math.max(1, canvas.height), 0.1, 2000);

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
			camHeight: (opts.camHeight || 24) / WORLD_SCALE,
			camDist: (opts.camDist || 32) / WORLD_SCALE,
			lookAhead: (opts.lookAhead || 26) / WORLD_SCALE
		};
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
		var W = w / WORLD_SCALE, H = h / WORLD_SCALE;
		var geo = new THREE.PlaneGeometry(W, H);
		// Lie flat: plane +Y (texture top, v=1) -> world -Z, then shift so
		// map pixel (x,y) lands on world (x/S, 0, y/S).
		geo.rotateX(-Math.PI / 2);
		geo.translate(W / 2, 0, H / 2);
		var tex = new THREE.CanvasTexture(mapCanvas);
		tex.encoding = THREE.sRGBEncoding;
		tex.magFilter = THREE.NearestFilter;
		tex.minFilter = THREE.NearestMipmapLinearFilter;
		var mat = new THREE.MeshBasicMaterial({ map: tex });
		state.ground = new THREE.Mesh(geo, mat);
		state.groundTex = tex;
		state.mapW = w;
		state.mapH = h;
		state.scene.add(state.ground);
	}

	// Project a map-space point (pixels; mapZ = height above ground in
	// pixels) to canvas backing-store pixels using the current chase camera.
	// Returns null when behind the camera. dist is in world units.
	function project(state, mapX, mapY, mapZ) {
		if (!state || !state.camera) return null;
		var v = new THREE.Vector3(mapX / WORLD_SCALE, (mapZ || 0) / WORLD_SCALE, mapY / WORLD_SCALE);
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

	function render(state, fCamera, lMap, mapCanvas, opts) {		opts = opts || {};
		if (!state || !mapCanvas || !mapCanvas.width) return;
		ensureGround(state, mapCanvas);
		state.groundTex.needsUpdate = true;

		var bg = parseBg(lMap && lMap.bgcolor);
		state.renderer.setClearColor(new THREE.Color(bg[0], bg[1], bg[2]), 1);

		var px = fCamera.x / WORLD_SCALE, py = fCamera.y / WORLD_SCALE;
		var fwd = forwardOf(fCamera.rotation || 0);
		if (opts.mirror) {
			px = state.mapW / WORLD_SCALE - px;
			fwd.x = -fwd.x;
		}

		var cam = state.camera;
		cam.position.set(
			px - fwd.x * state.camDist,
			state.camHeight,
			py - fwd.y * state.camDist
		);
		cam.lookAt(
			px + fwd.x * state.lookAhead,
			0,
			py + fwd.y * state.lookAhead
		);

		var canvas = state.renderer.domElement;
		if (canvas.width && canvas.height) {
			var w = canvas.width, h = canvas.height;
			if (cam.aspect !== w / h) {
				cam.aspect = w / h;
				cam.updateProjectionMatrix();
			}
		}
		state.renderer.render(state.scene, cam);
	}

	window.MK3D = {
		WORLD_SCALE: WORLD_SCALE,
		init: init,
		project: project,
		render: render
	};
})();
