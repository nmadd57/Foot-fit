// Web Worker: ArUco marker detection off the main thread.
/* global importScripts, AR */
importScripts('vendor/cv.js', 'vendor/aruco.js');
let detector = null;
self.onmessage = (e) => {
  const { id, width, height, buffer } = e.data;
  try {
    if (!detector) detector = new AR.Detector({ dictionaryName: 'ARUCO_MIP_36h12', maxHammingDistance: 4 });
    const data = new Uint8ClampedArray(buffer);
    const markers = detector.detect({ width, height, data });
    self.postMessage({
      id,
      markers: markers.map((m) => ({ id: m.id, corners: m.corners.map((c) => [c.x, c.y]), dist: m.hammingDistance })),
    });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err), markers: [] });
  }
};
