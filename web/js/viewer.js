// 3D preview of the reconstructed foot (three.js from CDN, loaded lazily).
let THREE = null, OrbitControls = null;

export async function showMesh(container, mesh) {
  if (!THREE) {
    THREE = await import('three');
    ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
  }
  container.innerHTML = '';
  const w = container.clientWidth || 400, h = container.clientHeight || 300;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  const bb = geom.boundingBox, c = new THREE.Vector3(); bb.getCenter(c);
  geom.translate(-c.x, -c.y, -bb.min.z);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd8a483, roughness: 0.75, metalness: 0 });
  const obj = new THREE.Mesh(geom, mat);
  scene.add(obj);
  const grid = new THREE.GridHelper(400, 40, 0x888888, 0xcccccc);
  grid.rotation.x = Math.PI / 2; grid.material.opacity = 0.35; grid.material.transparent = true;
  scene.add(grid);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6); dl.position.set(200, -300, 400); scene.add(dl);
  const size = bb.getSize(new THREE.Vector3());
  const cam = new THREE.PerspectiveCamera(40, w / h, 1, 5000);
  cam.up.set(0, 0, 1);
  const r = Math.max(size.x, size.y, size.z) * 1.7;
  cam.position.set(r * 0.8, -r * 0.9, r * 0.7);
  const controls = new OrbitControls(cam, renderer.domElement);
  controls.target.set(0, 0, size.z * 0.35);
  controls.enableDamping = true;
  controls.update();
  let alive = true;
  const loop = () => { if (!alive) return; controls.update(); renderer.render(scene, cam); requestAnimationFrame(loop); };
  loop();
  const ro = new ResizeObserver(() => {
    const W = container.clientWidth, H = container.clientHeight;
    if (!W || !H) return;
    renderer.setSize(W, H); cam.aspect = W / H; cam.updateProjectionMatrix();
  });
  ro.observe(container);
  return () => { alive = false; ro.disconnect(); renderer.dispose(); geom.dispose(); };
}
