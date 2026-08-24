import * as THREE from 'three';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uLeft;
uniform sampler2D uRight;
uniform vec3 uDivider;
uniform float uDividerPx;
uniform float uWidthPx;
varying vec2 vUv;

void main() {
  float halfWidth = max(1.0, uWidthPx * 0.5);
  float divider = uDividerPx / halfWidth;
  float localX = vUv.x < 0.5 ? vUv.x * 2.0 : (vUv.x - 0.5) * 2.0;
  vec3 color = vUv.x < 0.5
    ? texture2D(uLeft, vec2(localX, vUv.y)).rgb
    : texture2D(uRight, vec2(localX, vUv.y)).rgb;
  float line = 1.0 - smoothstep(0.0, divider, abs(vUv.x - 0.5));
  color = mix(color, uDivider, line * 0.92);
  gl_FragColor = vec4(color, 1.0);
}
`;

/** Final one-pass 50/50 compositor. Each input is already fully post-processed. */
export class SplitScreenRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly material: THREE.ShaderMaterial;
  private readonly drawingSize = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      name: 'TeamSplitComposite',
      uniforms: {
        uLeft: { value: null },
        uRight: { value: null },
        uDivider: { value: new THREE.Color(0xe9fff5) },
        uDividerPx: { value: 2 },
        uWidthPx: { value: 1 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  render(left: THREE.Texture, right: THREE.Texture): void {
    const size = this.renderer.getDrawingBufferSize(this.drawingSize);
    this.material.uniforms.uLeft.value = left;
    this.material.uniforms.uRight.value = right;
    this.material.uniforms.uWidthPx.value = size.x;
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.renderer.setScissorTest(false);
    this.renderer.clear(true, true, false);
    this.renderer.render(this.scene, this.camera);
  }
}
