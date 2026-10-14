/* GPL-3.0-or-later. Site drawing adapter for Hina's unchanged Cubism animation stack.
 * No WebGL framebuffer copies: original deformed meshes are submitted to WebGPU.
 */
const shader = /* wgsl */ `
struct Draw { transform: vec4f, tint: vec4f, multiply: vec4f, screen: vec4f, clip: vec4f }
@group(0) @binding(0) var<uniform> d: Draw;
@group(0) @binding(1) var s: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var mask: texture_2d<f32>;
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@location(0) p: vec2f, @location(1) uv: vec2f) -> Out {
  var o: Out;
  o.position = vec4f(p * d.transform.xy + d.transform.zw, 0, 1);
  o.uv = vec2f(uv.x, 1.0 - uv.y);
  return o;
}
@fragment fn fragment(v: Out) -> @location(0) vec4f {
  let c = textureSample(tex, s, v.uv);
  var rgb = c.rgb * d.multiply.rgb;
  rgb = rgb + d.screen.rgb - rgb * d.screen.rgb;
  var alpha = c.a * d.tint.a;
  if (d.clip.z > 0.5) {
    let m = textureSample(mask, s, v.position.xy / d.clip.xy).a;
    alpha *= select(m, 1.0 - m, d.clip.w > 0.5);
  }
  return vec4f(rgb * d.tint.rgb * alpha, alpha);
}`;
let sharedDevice;
async function device() {
  if (!sharedDevice)
    sharedDevice = (async () => {
      if (!navigator.gpu) throw new Error("WebGPU unavailable");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
      if (!adapter) throw new Error("No WebGPU adapter");
      return adapter.requestDevice();
    })();
  return sharedDevice;
}
const blend = (mode) => ({
  color: {
    srcFactor: mode === 2 ? "dst" : "one",
    dstFactor: mode === 1 ? "one" : "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: mode ? "zero" : "one",
    dstFactor: mode ? "one" : "one-minus-src-alpha",
    operation: "add",
  },
});
export class CubismWebGPU {
  static async create(canvas, model) {
    const renderer = new CubismWebGPU(canvas, model, await device());
    try {
      await renderer.init();
      return renderer;
    } catch (error) {
      renderer.destroy();
      throw error;
    }
  }
  constructor(canvas, model, gpu) {
    this.canvas = canvas;
    this.model = model;
    this.gpu = gpu;
    this.core = model.internalModel.coreModel;
    this.raw = this.core.getModel();
    this.drawables = this.raw.drawables;
    this.resources = [];
    this.masks = new Map();
    this.frames = 0;
    this.geometryChanges = 0;
  }
  buffer(array, usage) {
    const b = this.gpu.createBuffer({
      size: Math.max(4, Math.ceil(array.byteLength / 4) * 4),
      usage: usage | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(b.getMappedRange()).set(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
    );
    b.unmap();
    this.resources.push(b);
    return b;
  }
  async init() {
    const g = this.gpu;
    g.pushErrorScope("validation");
    this.context = this.canvas.getContext("webgpu");
    if (!this.context) throw new Error("WebGPU context unavailable");
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: g, format: this.format, alphaMode: "premultiplied" });
    const module = g.createShaderModule({ code: shader });
    const info = await module.getCompilationInfo();
    if (info.messages.some((m) => m.type === "error"))
      throw new Error("WebGPU shader compilation failed");
    this.layout = g.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const pipelineLayout = g.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const pipeline = (format, mode) =>
      g.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: "vertex",
          buffers: [
            { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
            { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },
          ],
        },
        fragment: { module, entryPoint: "fragment", targets: [{ format, blend: blend(mode) }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      });
    this.pipelines = [0, 1, 2].map((m) => pipeline(this.format, m));
    this.maskPipeline = pipeline("rgba8unorm", 0);
    this.sampler = g.createSampler({
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.white = g.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    g.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
    this.resources.push(this.white);
    this.textures = [];
    for (const texture of this.model.textures) {
      const source = texture.baseTexture.resource.source;
      const bitmap = await createImageBitmap(source, { premultiplyAlpha: "none" });
      const target = g.createTexture({
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      g.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: target, premultipliedAlpha: false },
        [bitmap.width, bitmap.height]
      );
      bitmap.close();
      this.resources.push(target);
      this.textures.push(target.createView());
    }
    this.meshes = Array.from({ length: this.drawables.count }, (_, i) => {
      const maskIds = Array.from(this.drawables.masks[i]);
      const key = maskIds.join(",");
      if (maskIds.length && !this.masks.has(key)) this.masks.set(key, { ids: maskIds });
      return {
        i,
        key,
        positions: this.buffer(this.drawables.vertexPositions[i], GPUBufferUsage.VERTEX),
        uvs: this.buffer(this.drawables.vertexUvs[i], GPUBufferUsage.VERTEX),
        indices: this.buffer(this.drawables.indices[i], GPUBufferUsage.INDEX),
        uniform: this.buffer(new Float32Array(20), GPUBufferUsage.UNIFORM),
        maskUniform: this.buffer(new Float32Array(20), GPUBufferUsage.UNIFORM),
      };
    });
    this.resize();
    const error = await g.popErrorScope();
    if (error) throw new Error(error.message);
    // This listener does not invent a success state; a lost device disables drawing.
    g.lost.then(() => {
      this.lost = true;
    });
  }
  bind(mesh, uniform, mask) {
    return this.gpu.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.textures[this.drawables.textureIndices[mesh.i]] },
        { binding: 3, resource: mask },
      ],
    });
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr)),
      h = Math.max(1, Math.round(rect.height * dpr));
    if (this.width === w && this.height === h) return;
    this.width = this.canvas.width = w;
    this.height = this.canvas.height = h;
    for (const mask of this.masks.values()) {
      mask.texture?.destroy();
      mask.texture = this.gpu.createTexture({
        size: [w, h],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      mask.view = mask.texture.createView();
    }
    const white = this.white.createView();
    for (const mesh of this.meshes) {
      mesh.bind = this.bind(mesh, mesh.uniform, this.masks.get(mesh.key)?.view || white);
      mesh.maskBind = this.bind(mesh, mesh.maskUniform, white);
    }
  }
  render() {
    if (this.lost) throw new Error("WebGPU device lost");
    this.resize();
    const { gpu: g, drawables: d } = this;
    const c = this.raw.canvasinfo;
    const scale = Math.min(this.width / c.CanvasWidth, this.height / c.CanvasHeight) * 0.97;
    const transform = [
      (2 * c.PixelsPerUnit * scale) / this.width,
      (2 * c.PixelsPerUnit * scale) / this.height,
      ((2 * c.CanvasOriginX - c.CanvasWidth) * scale) / this.width,
      ((c.CanvasHeight - 2 * c.CanvasOriginY) * scale) / this.height,
    ];
    let sample = 0;
    for (const m of this.meshes) {
      const pos = d.vertexPositions[m.i];
      sample += pos[0] || 0;
      g.queue.writeBuffer(m.positions, 0, pos);
      const mul = d.multiplyColors?.subarray(m.i * 4, m.i * 4 + 4) || [1, 1, 1, 1];
      const screen = d.screenColors?.subarray(m.i * 4, m.i * 4 + 4) || [0, 0, 0, 0];
      const u = new Float32Array([
        ...transform,
        1,
        1,
        1,
        d.opacities[m.i],
        ...mul,
        ...screen,
        this.width,
        this.height,
        m.key ? 1 : 0,
        this.core.getDrawableInvertedMaskBit(m.i) ? 1 : 0,
      ]);
      g.queue.writeBuffer(m.uniform, 0, u);
      // Masks represent the source mesh coverage, independent of its display opacity.
      const mu = new Float32Array([
        ...transform,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        0,
        0,
        0,
        0,
        this.width,
        this.height,
        0,
        0,
      ]);
      g.queue.writeBuffer(m.maskUniform, 0, mu);
    }
    if (this.lastSample !== undefined && Math.abs(sample - this.lastSample) > 0.000001)
      this.geometryChanges++;
    this.lastSample = sample;
    const encoder = g.createCommandEncoder();
    const begin = (view) =>
      encoder.beginRenderPass({
        colorAttachments: [
          { view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: "clear", storeOp: "store" },
        ],
      });
    const draw = (pass, m, mask = false) => {
      if (!d.indices[m.i].length) return;
      pass.setBindGroup(0, mask ? m.maskBind : m.bind);
      pass.setVertexBuffer(0, m.positions);
      pass.setVertexBuffer(1, m.uvs);
      pass.setIndexBuffer(m.indices, "uint16");
      pass.drawIndexed(d.indices[m.i].length);
    };
    for (const mask of this.masks.values()) {
      const pass = begin(mask.view);
      pass.setPipeline(this.maskPipeline);
      for (const id of mask.ids) draw(pass, this.meshes[id], true);
      pass.end();
    }
    const pass = begin(this.context.getCurrentTexture().createView());
    const ordered = this.meshes.slice().sort((a, b) => d.renderOrders[a.i] - d.renderOrders[b.i]);
    for (const m of ordered) {
      if (d.opacities[m.i] <= 0) continue;
      pass.setPipeline(this.pipelines[this.core.getDrawableBlendMode(m.i)]);
      draw(pass, m);
    }
    pass.end();
    g.queue.submit([encoder.finish()]);
    this.frames++;
  }
  async validate() {
    this.gpu.pushErrorScope("validation");
    this.render();
    await this.gpu.queue.onSubmittedWorkDone();
    const error = await this.gpu.popErrorScope();
    if (error) throw new Error(error.message);
  }
  destroy() {
    for (const resource of this.resources) resource.destroy();
    for (const mask of this.masks.values()) mask.texture?.destroy();
    this.context?.unconfigure();
    this.lost = true;
  }
}
