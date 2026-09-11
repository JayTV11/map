const topojson = require('topojson-client');
const land = require('world-atlas/land-110m.json');

const W = 1000, H = 500; // equirectangular canvas size (matches lon 360 / lat 180 aspect *no*, we use 2:1)

function project([lon, lat]) {
  const x = (lon + 180) / 360 * W;
  const y = (90 - lat) / 180 * H;
  return [Number(x.toFixed(2)), Number(y.toFixed(2))];
}

function ringToPath(ring) {
  let d = '';
  ring.forEach(([lon, lat], i) => {
    const [x, y] = project([lon, lat]);
    d += (i === 0 ? 'M' : 'L') + x + ' ' + y + ' ';
  });
  return d + 'Z ';
}

function polygonToPath(polygon) {
  // polygon = array of rings, first is exterior, rest are holes
  return polygon.map(ringToPath).join('');
}

const geo = topojson.feature(land, land.objects.land);

let d = '';
if (geo.type === 'FeatureCollection') {
  geo.features.forEach(f => {
    const g = f.geometry;
    if (g.type === 'Polygon') d += polygonToPath(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => d += polygonToPath(p));
  });
} else {
  const g = geo.geometry;
  if (g.type === 'Polygon') d += polygonToPath(g.coordinates);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => d += polygonToPath(p));
}

console.log('PATH_LENGTH:', d.length);
require('fs').writeFileSync('worldpath.txt', d.trim());
console.log('done');
