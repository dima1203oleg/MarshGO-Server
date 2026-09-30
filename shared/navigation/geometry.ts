import { coordinateSchema, type Coordinate } from './contracts';
// Polyline6 is transported as latitude then longitude; domain coordinates are longitude first.
export function encodePolyline6(points: Coordinate[]): string {
  let lat = 0, lon = 0, output = '';
  const encode = (value: number) => { let n = value < 0 ? -value * 2 - 1 : value * 2; let s = ''; while (n >= 32) { s += String.fromCharCode((n % 32) + 95); n = Math.floor(n / 32); } return s + String.fromCharCode(n + 63); };
  for (const point of points) { coordinateSchema.parse(point); const y = Math.round(point[1]*1e6), x = Math.round(point[0]*1e6); output += encode(y-lat) + encode(x-lon); lat=y; lon=x; }
  return output;
}
export function decodePolyline6(value: string): Coordinate[] {
  if (value.length > 2000000) throw new Error('ROUTING_INVALID_RESPONSE');
  let index=0, lat=0, lon=0; const points: Coordinate[]=[];
  const read = () => { let n=0, shift=0, b: number; do { if (index>=value.length || shift>30) throw new Error('ROUTING_INVALID_RESPONSE'); b=value.charCodeAt(index++)-63; if (b<0||b>63) throw new Error('ROUTING_INVALID_RESPONSE'); n+=(b%32)*2**shift; shift+=5; } while(b>=32); return n%2 ? -(n+1)/2 : n/2; };
  while(index<value.length) { lat+=read(); lon+=read(); points.push(coordinateSchema.parse([lon/1e6,lat/1e6])); }
  if(points.length<2) throw new Error('ROUTING_INVALID_RESPONSE'); return points;
}
export function distanceMeters(a: Coordinate,b: Coordinate): number {
  const r=Math.PI/180, dlat=(b[1]-a[1])*r, dlon=(b[0]-a[0])*r;
  const h=Math.sin(dlat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dlon/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,h)));
}
export function boundsOf(points: Coordinate[]): [Coordinate, Coordinate] {
  return [[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1]))],[Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))]];
}
export function projectOnRoute(point: Coordinate, points: Coordinate[]) {
  let best={ coordinate:point, distance:Infinity, along:0 }, along=0;
  const scale=Math.cos(point[1]*Math.PI/180);
  for(let i=1;i<points.length;i++) { const a=points[i-1],b=points[i]; const dx=(b[0]-a[0])*scale,dy=b[1]-a[1]; const denominator=dx*dx+dy*dy;
    const t=denominator ? Math.max(0,Math.min(1,((point[0]-a[0])*scale*dx+(point[1]-a[1])*dy)/denominator)) : 0;
    const coordinate:Coordinate=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]; const distance=distanceMeters(point,coordinate), segment=distanceMeters(a,b);
    if(distance<best.distance) best={coordinate,distance,along:along+t*segment}; along+=segment;
  } return {...best,total:along};
}
