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

robot.add(mesh(new RoundedBoxGeometry(1.8, 1.5, 1.3, 6, 0.32), shellMat, 0, 0.9, 0));
const head = new THREE.Group();
head.position.set(0, 0.95, 0);
robot.add(head);
head.add(mesh(new RoundedBoxGeometry(1.36, 0.98, 0.1, 4, 0.12), clay(0x1d2731, 0.25), 0, 0.02, 0.62));

const eyeMat = new THREE.MeshBasicMaterial({ color: 0x5dcaa5 });
const eyes = [-0.28, 0.28].map((x) => {
  const eye = mesh(new THREE.SphereGeometry(0.12, 20, 14), eyeMat, x, 0.08, 0.69);
  head.add(eye);
  return eye;
});

head.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 12), clay(0x7d8a94), 0, 0.95, 0));
const bulbMat = new THREE.MeshStandardMaterial({ color: 0x9fb0b8, emissive: 0x000000, roughness: 0.3 });
head.add(mesh(new THREE.SphereGeometry(0.13, 24, 16), bulbMat, 0, 1.25, 0));

robot.add(mesh(new RoundedBoxGeometry(1.2, 0.5, 0.9, 4, 0.15), trimMat, 0, -0.1, 0));
for (const x of [-0.45, 0.45]) {
  const wheel = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 24), clay(0x5f6b74, 0.5), x, -0.38, 0.25);
  wheel.rotation.z = Math.PI / 2;
  robot.add(wheel);
}

const arm = mesh(new THREE.CapsuleGeometry(0.12, 0.5, 6, 12), trimMat, 1.15, 1.2, 0.2);
robot.add(arm);
const page = mesh(new RoundedBoxGeometry(0.4, 0.52, 0.04, 2, 0.02), clay(0xffffff));
robot.add(page);

const shadow = mesh(new THREE.CircleGeometry(1.0, 48), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.14 }), 0, -0.6, 0);
shadow.rotation.x = -Math.PI / 2;
scene.add(shadow);

// Moods, as set by zee.js: sleeping, eating, asking, dizzy, paused.
let mood = document.body.className || "sleeping";
const pointer = { x: 0, y: 0 };
window.addEventListener("mousemove", (event) => {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -((event.clientY / window.innerHeight) * 2 - 1);
});

window.zeeRobot = {
  setMood(next) {
    mood = next;
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
  const fps = mood === "sleeping" || mood === "paused" ? 12 : 30;
  if (t - last < 1 / fps) return;
  last = t;

  const resting = mood === "sleeping" || mood === "paused";
  robot.position.y = mood === "paused" ? 0 : Math.sin(t * (resting ? 1.6 : 3)) * (resting ? 0.03 : 0.05);

  const lookX = resting ? 0 : pointer.x * 0.5;
  const lookY = resting ? -0.12 : -pointer.y * 0.25;
  head.rotation.y += (lookX - head.rotation.y) * 0.12;
  head.rotation.x += (lookY - head.rotation.x) * 0.12;
  head.rotation.z = mood === "dizzy" ? Math.sin(t * 4) * 0.18 : head.rotation.z * 0.8;
  robot.rotation.y += ((resting ? Math.sin(t * 0.4) * 0.2 : pointer.x * 0.2) - robot.rotation.y) * 0.06;

  const blink = t % 3.4 < 0.12;
  for (const eye of eyes) eye.scale.y = resting ? 0.12 : blink ? 0.1 : 1;
  eyeMat.color.setHex(mood === "paused" ? 0x2b3640 : mood === "dizzy" ? 0xef9f27 : 0x5dcaa5);
  shellMat.color.setHex(mood === "paused" ? 0xa7b0b6 : 0xd7dee3);

  arm.visible = mood === "asking";
  if (arm.visible) arm.rotation.z = Math.sin(t * 6) * 0.35;

  page.visible = mood === "eating";
  if (page.visible) {
    const p = (t * 0.9) % 1;
    page.position.set(1.6 - p * 1.6, 2.2 - p * 1.3, 0.6);
    page.rotation.z = p * 3;
    page.scale.setScalar(1 - p * 0.7);
    head.scale.y = 1 + Math.sin(t * 18) * 0.04;
  } else {
    head.scale.y = 1;
  }

  const glow = { asking: Math.sin(t * 5) > 0 ? 0xef9f27 : 0x6a3a08, eating: 0x1d9e75 }[mood] ?? 0x000000;
  bulbMat.emissive.setHex(glow);

  renderer.render(scene, camera);
}
frame();
