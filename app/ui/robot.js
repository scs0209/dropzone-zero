// Zee as a small 3D robot (three.js). The screen face and the antenna light show
// the mood; zee.js decides the mood, this file only draws it.
import { RoundedBoxGeometry } from "./vendor/RoundedBoxGeometry.js";
import * as THREE from "./vendor/three.module.js";

const canvas = document.getElementById("robot");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
// Framed tight: the robot, its antenna, and the waving arm fill the 128px stage.
camera.position.set(0, 0.95, 6.4);
camera.lookAt(0, 0.42, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7680, 1.7));
const key = new THREE.DirectionalLight(0xffffff, 2.3);
key.position.set(3, 5, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0xbfd7ff, 0.9);
rim.position.set(-4, 2, -3);
scene.add(rim);

const clay = (color, roughness = 0.4) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
function mesh(geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}

const shellMat = clay(0xd7dee3, 0.35);
const trimMat = clay(0xc5ced4, 0.4);
const robot = new THREE.Group();
scene.add(robot);

// The upper body and its screen face are one piece ("head") that turns toward the
// pointer; only the wheeled base stays put. Turning the screen on its own let it
// sink into the shell, so the white surface covered the face.
const head = new THREE.Group();
head.position.set(0, 0.95, 0);
robot.add(head);
head.add(mesh(new RoundedBoxGeometry(1.8, 1.5, 1.3, 6, 0.32), shellMat, 0, -0.05, 0));
// The screen stands slightly proud of the shell's face (front at z 0.65), so no edge is hidden.
const FACE_Z = 0.74;
head.add(mesh(new RoundedBoxGeometry(1.36, 0.98, 0.1, 4, 0.12), clay(0x1d2731, 0.25), 0, 0.02, FACE_Z - 0.05));

const eyeMat = new THREE.MeshBasicMaterial({ color: 0x5dcaa5 });
const eyes = [-0.28, 0.28].map((x) => {
  const eye = mesh(new THREE.SphereGeometry(0.12, 20, 14), eyeMat, x, 0.08, FACE_Z + 0.01);
  head.add(eye);
  return eye;
});

// A mouth on the screen face, shown while eating: an oval that opens and closes.
const MOUTH_Y = -0.2;
const mouth = mesh(new THREE.TorusGeometry(0.11, 0.03, 8, 32), eyeMat, 0, MOUTH_Y, FACE_Z + 0.01);
mouth.scale.x = 1.35;
head.add(mouth);

head.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 12), clay(0x7d8a94), 0, 0.95, 0));
const bulbMat = new THREE.MeshStandardMaterial({ color: 0x9fb0b8, emissive: 0x000000, roughness: 0.3 });
head.add(mesh(new THREE.SphereGeometry(0.13, 24, 16), bulbMat, 0, 1.25, 0));

robot.add(mesh(new RoundedBoxGeometry(1.2, 0.5, 0.9, 4, 0.15), trimMat, 0, -0.1, 0));
for (const x of [-0.45, 0.45]) {
  const wheel = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 24), clay(0x5f6b74, 0.5), x, -0.38, 0.25);
  wheel.rotation.z = Math.PI / 2;
  robot.add(wheel);
}

const arm = mesh(new THREE.CapsuleGeometry(0.12, 0.5, 6, 12), trimMat, 1.15, 0.25, 0.2);
head.add(arm);
// The page Zee eats lives on the head, so it always lands in the mouth, wherever the head is turned.
const page = mesh(new RoundedBoxGeometry(0.4, 0.52, 0.04, 2, 0.02), clay(0xffffff));
head.add(page);

const shadow = mesh(new THREE.CircleGeometry(1.0, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.14 }), 0, -0.6, 0);
shadow.rotation.x = -Math.PI / 2;
scene.add(shadow);

// The hole Zee dives into when it is hidden or quits, and pops out of when it comes
// back. Anything below the ground is clipped while Zee goes through it, so Zee
// sinks into the hole instead of showing through the floor around it.
const holeMat = new THREE.MeshBasicMaterial({ color: 0x0b0f12 });
const hole = new THREE.Group();
const holeFloor = mesh(new THREE.CircleGeometry(1.15, 48), holeMat);
const holeRim = mesh(new THREE.RingGeometry(1.15, 1.32, 48), new THREE.MeshBasicMaterial({ color: 0x4a5560 }), 0, 0, -0.001);
hole.add(holeFloor, holeRim);
hole.position.y = -0.6;
hole.rotation.x = -Math.PI / 2;
hole.scale.setScalar(0);
hole.visible = false;
scene.add(hole);
renderer.localClippingEnabled = true;
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6); // far away: nothing clipped
robot.traverse((node) => {
  if (node.material) node.material.clippingPlanes = [ground];
});

/** A running dive or pop-out: owns Zee's position and turn until it ends. */
let action = null;
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const span = (t, from, to) => (t - from) / (to - from);

function play(kind) {
  return new Promise((resolve) => {
    action = { kind, start: clock.getElapsedTime(), resolve };
  });
}

/** One frame of the dive (seconds since it began); true when it is over. */
function diveFrame(e) {
  hole.visible = true;
  shadow.visible = false;
  ground.constant = 0.6;
  // The hole opens, Zee crouches, hops, flips head first, and drops in; then the hole closes.
  hole.scale.setScalar(e < 1.25 ? ease(span(e, 0, 0.3)) : 1 - ease(span(e, 1.25, 1.55)));
  const crouch = e < 0.35 ? Math.sin(span(e, 0, 0.35) * Math.PI) : 0;
  robot.scale.set(1 + crouch * 0.08, 1 - crouch * 0.15, 1 + crouch * 0.08);
  if (e < 0.35) {
    robot.position.y = -crouch * 0.08;
    robot.rotation.x = 0;
  } else {
    const air = span(e, 0.35, 1.15); // 0 at take-off, 1 well inside the hole
    // A small hop, then head first into the hole, tipping away from the viewer
    // (tipping toward the camera filled the frame with Zee's back).
    robot.position.y = 0.5 * Math.sin(Math.min(air, 0.5) * Math.PI) - (air > 0.5 ? 12 * Math.pow(air - 0.5, 2) : 0);
    robot.rotation.x = -ease(air) * 0.8 * Math.PI;
  }
  robot.rotation.y *= 0.8;
  return e > 1.6;
}

/** One frame of popping back out of the hole; true when Zee stands where it was. */
function emergeFrame(e) {
  robot.visible = true;
  hole.visible = true;
  shadow.visible = false;
  ground.constant = 0.6;
  hole.scale.setScalar(e < 0.75 ? ease(span(e, 0, 0.25)) : 1 - ease(span(e, 0.75, 1.05)));
  const up = span(e, 0.2, 0.75);
  // Comes up from below, overshoots a little, and settles.
  robot.position.y = up <= 0 ? -3 : up < 1 ? -3 + 3.35 * ease(up) : 0.35 * Math.max(0, 1 - span(e, 0.75, 1.0)) * Math.cos(span(e, 0.75, 1.0) * Math.PI / 2);
  robot.rotation.x = 0;
  robot.scale.setScalar(1);
  return e > 1.1;
}

function endAction() {
  const { kind, resolve } = action;
  action = null;
  hole.visible = false;
  hole.scale.setScalar(0);
  ground.constant = 1e6;
  shadow.visible = kind !== "dive";
  robot.scale.setScalar(1);
  robot.rotation.x = 0;
  // After a dive Zee stays down there, out of sight, until it pops back out.
  submerged = kind === "dive";
  robot.position.y = submerged ? -3 : 0;
  robot.visible = !submerged;
  resolve();
}
let submerged = false;

// Moods, as set by zee.js: sleeping, thinking, eating, asking, dizzy, paused.
let mood = document.body.className || "sleeping";
const pointer = { x: 0, y: 0 };
// Where the pointer is relative to Zee itself, not to the window: the window changes
// size while the bubble is resized, and measured against it the pointer seemed to
// jump, so Zee's head swung back and forth.
const REACH = 160; // pixels from Zee's centre at which Zee looks fully to one side
window.addEventListener("mousemove", (event) => {
  const box = canvas.getBoundingClientRect();
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  pointer.x = clamp((event.clientX - (box.left + box.width / 2)) / REACH);
  pointer.y = clamp(-(event.clientY - (box.top + box.height / 2)) / REACH);
});

window.zeeRobot = {
  setMood(next) {
    mood = next;
  },
  /** Dives into a hole in the ground; resolves when Zee is gone. */
  dive() {
    return submerged ? Promise.resolve() : play("dive");
  },
  /** Pops back out of the hole; resolves when Zee stands where it was. */
  emerge() {
    return submerged ? play("emerge") : Promise.resolve();
  },
};

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();

const clock = new THREE.Clock();
let last = 0;

function frame() {
  requestAnimationFrame(frame);
  const t = clock.getElapsedTime();
  // An always-on companion should be cheap: 30 fps when active, 12 when resting.
  // A dive or pop-out always runs at 60, or it looks choppy.
  const fps = action ? 60 : mood === "sleeping" || mood === "paused" ? 12 : 30;
  if (t - last < 1 / fps) return;
  last = t;

  const resting = mood === "sleeping" || mood === "paused";
  if (action) {
    const elapsed = t - action.start;
    if ((action.kind === "dive" ? diveFrame : emergeFrame)(elapsed)) endAction();
  } else if (!submerged) {
    robot.position.y = mood === "paused" ? 0 : Math.sin(t * (resting ? 1.6 : 3)) * (resting ? 0.03 : 0.05);
  }

  // Eating: face a little toward the upper right, where the page comes from, not the pointer.
  const eating = mood === "eating";
  const lookX = resting ? 0 : eating ? 0.22 : pointer.x * 0.5;
  const lookY = resting ? -0.12 : eating ? -0.06 : -pointer.y * 0.25;
  head.rotation.y += (lookX - head.rotation.y) * 0.12;
  head.rotation.x += (lookY - head.rotation.x) * 0.12;
  head.rotation.z = mood === "dizzy" ? Math.sin(t * 4) * 0.18 : head.rotation.z * 0.8;
  if (!action) robot.rotation.y += ((resting ? Math.sin(t * 0.4) * 0.2 : eating ? 0.08 : pointer.x * 0.2) - robot.rotation.y) * 0.06;

  const blink = t % 3.4 < 0.12;
  const thinking = mood === "thinking";
  // Thinking: smaller eyes scanning the screen side to side, as if reading.
  const scan = thinking ? Math.sin(t * 2.6) * 0.13 : 0;
  eyes.forEach((eye, i) => {
    eye.position.x = (i === 0 ? -0.28 : 0.28) + scan;
    eye.scale.setScalar(thinking ? 0.78 : 1);
    eye.scale.y = resting ? 0.12 : blink ? 0.1 : thinking ? 0.78 : 1;
  });
  if (thinking) head.rotation.z = Math.sin(t * 1.5) * 0.06;
  eyeMat.color.setHex(mood === "paused" ? 0x2b3640 : mood === "dizzy" ? 0xef9f27 : 0x5dcaa5);
  shellMat.color.setHex(mood === "paused" ? 0xa7b0b6 : 0xd7dee3);

  arm.visible = mood === "asking";
  if (arm.visible) arm.rotation.z = Math.sin(t * 6) * 0.35;

  mouth.visible = mood === "eating";
  if (mouth.visible) mouth.scale.y = 0.2 + Math.abs(Math.sin(t * 9)) * 0.9;
  page.visible = mood === "eating";
  if (page.visible) {
    const p = (t * 0.9) % 1;
    // In the head's own space: drops from the upper right to mouth height first,
    // then slides straight in, so it never crosses the eyes.
    const q = 1 - p;
    page.position.set(1.4 * q, MOUTH_Y + 1.3 * q * q * q, FACE_Z + 0.08 + 0.45 * q);
    page.rotation.z = p * 3;
    page.scale.setScalar(1 - p * 0.7);
    head.scale.y = 1 + Math.sin(t * 18) * 0.04;
  } else {
    head.scale.y = 1;
  }

  const glow =
    {
      asking: Math.sin(t * 5) > 0 ? 0xef9f27 : 0x6a3a08,
      eating: 0x1d9e75,
      thinking: Math.sin(t * 7) > 0 ? 0x378add : 0x0c447c,
    }[mood] ?? 0x000000;
  bulbMat.emissive.setHex(glow);

  renderer.render(scene, camera);
}
frame();
