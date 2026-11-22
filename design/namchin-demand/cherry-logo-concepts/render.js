// Renders one cherry mascot icon with a ray-marched distance field: render.html?c=a|b|c|d&size=1024
// `&cutout=1` (concept B) shows the whole character on a transparent background.
const params = new URLSearchParams(location.search);
const concept = ['a', 'b', 'c', 'd'].indexOf(params.get('c') ?? 'a');
const size = Number(params.get('size') ?? 1024);
const canvas = document.querySelector('canvas');
canvas.width = canvas.height = size;
canvas.style.width = canvas.style.height = `${size}px`;
const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });

const vertex = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0., 1.); }`;

const fragment = `#version 300 es
precision highp float;
uniform vec2 res; uniform int concept; out vec4 outColor;

const float BODY = 1., BODY2 = 2., EYE = 3., STEM = 4., GLINT = 5., KNOB = 6., LID = 7., MOUTH = 8.;

float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * h * k / 6.; }
float sphere(vec3 p, vec3 c, float r) { return length(p - c) - r; }
float ellipsoid(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.) / k1; }
float capsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.); return length(pa - ba * h) - r; }
float tube(vec3 p, vec3 a, vec3 b, vec3 c, float r0, float r1) {
  float d = 1e5; vec3 prev = a;
  for (int i = 1; i <= 12; i++) { float t = float(i) / 12.; vec3 q = mix(mix(a, b, t), mix(b, c, t), t); d = min(d, capsule(p, prev, q, mix(r0, r1, t))); prev = q; }
  return d;
}
// Local frame on a sphere: forward is the surface direction, roll tilts the eye.
vec3 local(vec3 p, vec3 c, float r, vec2 dir, float roll) {
  vec3 f = normalize(vec3(dir, sqrt(max(0.05, 1. - dot(dir, dir)))));
  vec3 x = normalize(cross(vec3(0., 1., 0.), f)); vec3 y = cross(f, x);
  vec3 v = p - (c + f * r);
  vec2 q = vec2(dot(v, x), dot(v, y)); float s = sin(roll), k = cos(roll);
  return vec3(k * q.x + s * q.y, -s * q.x + k * q.y, dot(v, f));
}
float pill(vec3 q, float w, float h) {
  vec3 s = vec3(q.xy, q.z * 2.2); float y = max(abs(s.y) - (h - w), 0.);
  return (length(vec3(s.x, y, s.z)) - w) * .5;
}
void add(inout vec2 res, float d, float id) { if (d < res.x) res = vec2(d, id); }

void eye(inout vec2 res, vec3 p, vec3 c, float r, vec2 dir, float w, float h, float roll, vec2 glint, float gr) {
  vec3 q = local(p, c, r, dir, roll);
  add(res, pill(q, w, h), EYE);
  add(res, ellipsoid(q - vec3(glint, w * .42), vec3(gr, gr * 1.12, .03)), GLINT);
}

vec2 map(vec3 p) {
  vec2 res = vec2(1e5, 0.);
  if (concept == 0) {            // A: two lobes, one eye each, one shared stem
    vec3 a = vec3(-.43, -.33, 0.), b = vec3(.45, -.42, -.06);
    float l = sphere(p, a, .58), m = sphere(p, b, .52);
    add(res, smin(l, m, .3), BODY);
    float st = tube(p, vec3(-.36, .2, 0.), vec3(-.22, .62, .05), vec3(.12, .84, .0), .075, .085);
    st = smin(st, tube(p, vec3(.42, .06, -.06), vec3(.4, .5, .0), vec3(.12, .84, .0), .07, .085), .06);
    add(res, st, STEM);
    vec3 lf = p - vec3(.4, .86, .06); float an = .32; lf.xy = mat2(cos(an), sin(an), -sin(an), cos(an)) * lf.xy;
    add(res, ellipsoid(lf, vec3(.31, .155, .12)), KNOB);
    eye(res, p, a, .58, vec2(.2, .1), .128, .225, -.04, vec2(.034, .095), .044);
    eye(res, p, b, .52, vec2(-.16, .14), .118, .21, .06, vec2(-.022, .09), .041);
  } else if (concept == 1) {     // B: one cherry peeking over the edge, antenna with an alert dot
    vec3 a = vec3(.02, -.74, -.1); float r = 1.06;
    vec3 sq = p; sq.x *= .97;
    add(res, sphere(sq, a, r), BODY);
    add(res, tube(p, vec3(-.06, .26, .0), vec3(-.08, .56, .08), vec3(.2, .66, .1), .075, .07), STEM);
    add(res, sphere(p, vec3(.27, .67, .12), .15), KNOB);
    eye(res, p, a, r, vec2(.03, .5), .15, .265, -.1, vec2(.042, .115), .054);
    eye(res, p, a, r, vec2(.46, .46), .136, .245, -.16, vec2(.042, .11), .05);
  } else if (concept == 2) {     // C: suspicious close-up, heavy lids
    vec3 a = vec3(-.12, -.2, -.35); float r = 1.12;
    add(res, sphere(p, a, r), BODY);
    add(res, tube(p, vec3(.1, .84, .0), vec3(.16, 1.06, .1), vec3(.5, 1.2, .1), .1, .1), STEM);
    for (int i = 0; i < 2; i++) {
      vec2 dir = i == 0 ? vec2(-.22, .12) : vec2(.42, .16);
      float s = i == 0 ? 1. : .92, tilt = i == 0 ? -.2 : .17;
      vec3 q = local(p, a, r, dir, 0.);
      float e = ellipsoid(q, vec3(.25, .24, .085) * s);
      float cut = dot(q.xy, vec2(sin(tilt), cos(tilt))) - .01;
      add(res, max(e, cut), EYE);
      vec3 lq = q; lq.xy = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * lq.xy;
      add(res, ellipsoid(lq - vec3(0., .055, .012), vec3(.295, .09, .1) * s), LID);
      add(res, ellipsoid(q - vec3(.11 * s, -.09 * s, .07 * s), vec3(.05, .056, .034)), GLINT);
    }
    vec3 mq = local(p, a, r, vec2(.15, -.3), .12);
    add(res, pill(mq.yxz, .036, .15), MOUTH);
  } else {                       // D: two cherries cheek to cheek, looking the same way
    vec3 a = vec3(-.3, -.42, .06), b = vec3(.55, -.6, -.28);
    add(res, sphere(p, a, .72), BODY);
    add(res, sphere(p, b, .58), BODY2);
    float st = tube(p, vec3(-.22, .24, .0), vec3(-.12, .66, .05), vec3(.2, .9, .0), .07, .08);
    st = smin(st, tube(p, vec3(.52, -.04, -.28), vec3(.52, .5, -.1), vec3(.2, .9, .0), .065, .08), .05);
    add(res, st, STEM);
    eye(res, p, a, .72, vec2(.04, .2), .105, .18, -.1, vec2(.03, .075), .036);
    eye(res, p, a, .72, vec2(.42, .22), .1, .172, -.16, vec2(.03, .072), .034);
    eye(res, p, b, .58, vec2(.1, .2), .082, .14, -.1, vec2(.025, .06), .028);
    eye(res, p, b, .58, vec2(.5, .22), .076, .132, -.16, vec2(.025, .056), .026);
  }
  return res;
}

vec3 normalAt(vec3 p) { vec2 e = vec2(.0012, -.0012); return normalize(e.xyy * map(p + e.xyy).x + e.yyx * map(p + e.yyx).x + e.yxy * map(p + e.yxy).x + e.xxx * map(p + e.xxx).x); }
float occlusion(vec3 p, vec3 n) { float o = 0., s = 1.; for (int i = 1; i < 6; i++) { float h = .045 * float(i); o += (h - map(p + n * h).x) * s; s *= .72; } return clamp(1. - 1.9 * o, 0., 1.); }
float shadow(vec3 p, vec3 l) { float t = .05, k = 1.; for (int i = 0; i < 28; i++) { float d = map(p + l * t).x; k = min(k, 7. * d / t); t += clamp(d, .02, .16); if (k < .01 || t > 2.2) break; } return clamp(k, 0., 1.); }
vec3 srgb(int hex) { vec3 c = vec3(float((hex >> 16) & 255), float((hex >> 8) & 255), float(hex & 255)) / 255.; return pow(c, vec3(2.2)); }

vec3 background(vec2 uv) {
  vec3 inner, outer;
  if (concept == 0) { inner = srgb(0xfff3f2); outer = srgb(0xffd9dc); }
  else if (concept == 1) { inner = srgb(0x4a0f20); outer = srgb(0x1d070d); }
  else if (concept == 2) { inner = srgb(0xffe9d9); outer = srgb(0xffcfc4); }
  else { inner = srgb(0xffe3ea); outer = srgb(0xffb8c6); }
  return mix(inner, outer, smoothstep(.1, 1.5, length(uv - vec2(-.25, .35))));
}

vec3 soft(vec3 p, vec3 n, vec3 base, vec3 deep, vec3 rim, float gloss) {
  vec3 l = normalize(vec3(-.5, .78, .62)), v = vec3(0., 0., 1.), h = normalize(l + v);
  float sh = mix(.5, 1., shadow(p + n * .012, l)), wrap = clamp((dot(n, l) + .62) / 1.62, 0., 1.);
  vec3 c = mix(deep, base, smoothstep(.05, .95, wrap * sh));
  c += rim * pow(1. - clamp(n.z, 0., 1.), 2.6) * .5 * (.4 + .6 * clamp(n.y * .5 + .5, 0., 1.));
  c += vec3(1., .82, .84) * pow(max(dot(n, h), 0.), 16.) * .13 * gloss;
  c += vec3(1.) * pow(max(dot(n, h), 0.), 90.) * .2 * gloss;
  return c * mix(.62, 1., occlusion(p, n));
}

vec3 render(vec2 uv) {
  // Crop per concept: the icon frame cuts into the character.
  vec3 crop = concept == 0 ? vec3(.8, .0, -.15) : concept == 1 ? vec3(.84, .04, -.13) : concept == 2 ? vec3(.8, .02, -.08) : vec3(.8, .08, -.2);
  vec2 q = uv * crop.x + crop.yz;
  vec3 ro = vec3(q, 3.2), rd = normalize(vec3(uv * .07, -1.));
  float t = 0.; vec2 hit = vec2(1e5, 0.); bool found = false;
  for (int i = 0; i < 150; i++) { hit = map(ro + rd * t); if (hit.x < .0008) { found = true; break; } t += hit.x * .8; if (t > 6.) break; }
  if (!found) return background(uv);
  vec3 p = ro + rd * t, n = normalAt(p);
  float id = hit.y;
  if (id == EYE || id == MOUTH) { vec3 l = normalize(vec3(-.5, .78, .62)); vec3 h = normalize(l + vec3(0., 0., 1.)); return srgb(0x12060a) + vec3(.07) * pow(max(dot(n, h), 0.), 18.); }
  if (id == GLINT) return vec3(.98);
  if (id == STEM) return concept == 1 ? soft(p, n, srgb(0xffb7c1), srgb(0xd9697c), srgb(0xffe6ea), .6) : soft(p, n, srgb(0x2fa85f), srgb(0x0e5c3a), srgb(0xa8f0c0), .6);
  if (id == KNOB) return concept == 1 ? soft(p, n, srgb(0xfff4f4), srgb(0xffc3cb), vec3(1.), 1.) : soft(p, n, srgb(0x45c877), srgb(0x148a50), srgb(0xb8f5cc), .7);
  if (id == BODY2) return soft(p, n, srgb(0xff8ba0), srgb(0xd84a68), srgb(0xffd0d8), 1.);
  if (id == LID) return soft(p, n, srgb(0xe6304b), srgb(0xa10e2a), srgb(0xff8fa0), .6);
  return soft(p, n, srgb(0xf23a55), srgb(0xb00f2e), srgb(0xff9aa8), 1.);
}

void main() {
  vec3 c = vec3(0.);
  for (int y = 0; y < 3; y++) for (int x = 0; x < 3; x++) {
    vec2 f = gl_FragCoord.xy + (vec2(float(x), float(y)) - 1.) / 3.;
    c += render((f * 2. - res) / res.y);
  }
  c /= 9.;
  outColor = vec4(pow(clamp(c, 0., 1.), vec3(1. / 2.2)), 1.);
}`;

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
const cutout = params.has('cutout')
  ? fragment
    .replace('vec3 render(vec2 uv) {', 'float covered = 0.;\nvec3 render(vec2 uv) {')
    .replace('concept == 1 ? vec3(.84, .04, -.13)', 'concept == 1 ? vec3(1.36, .03, -.47)')
    .replace('if (!found) return background(uv);', 'covered = found ? 1. : 0.; if (!found) return vec3(0.);')
    .replace('vec3 c = vec3(0.);', 'vec3 c = vec3(0.); float a = 0.;')
    .replace('c += render((f * 2. - res) / res.y);', 'c += render((f * 2. - res) / res.y); a += covered;')
    .replace('c /= 9.;', 'c /= max(a, 1.); a /= 9.;')
    .replace('outColor = vec4(pow(clamp(c, 0., 1.), vec3(1. / 2.2)), 1.);', 'outColor = vec4(pow(clamp(c, 0., 1.), vec3(1. / 2.2)) * a, a);')
  : fragment;
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, cutout));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const location0 = gl.getAttribLocation(program, 'p');
gl.enableVertexAttribArray(location0);
gl.vertexAttribPointer(location0, 2, gl.FLOAT, false, 0, 0);
gl.uniform2f(gl.getUniformLocation(program, 'res'), size, size);
gl.uniform1i(gl.getUniformLocation(program, 'concept'), concept);

// Tiled drawing keeps each GPU job short.
const tiles = 8;
gl.enable(gl.SCISSOR_TEST);
gl.viewport(0, 0, size, size);
for (let y = 0; y < tiles; y += 1) {
  for (let x = 0; x < tiles; x += 1) {
    gl.scissor((x * size) / tiles, (y * size) / tiles, size / tiles, size / tiles);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
  }
}
document.documentElement.dataset.ready = '1';
