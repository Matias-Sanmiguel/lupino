<script lang="ts">
  import { onMount } from 'svelte';
  let canvas: HTMLCanvasElement;
  onMount(() => {
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const scale = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      let seed = 619;
      const random = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
      };
      context.fillStyle = '#c48a64';
      for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
          const u = x / width,
            v = y / height;
          const f =
            Math.cos(3 * Math.PI * u) * Math.cos(5 * Math.PI * v) -
            Math.cos(5 * Math.PI * u) * Math.cos(3 * Math.PI * v);
          if (Math.abs(f) < 0.075) {
            context.globalAlpha =
              0.65 * (1 - 0.85 * Math.exp(-((u - 0.5) ** 2 + (v - 0.45) ** 2) / 0.1));
            context.fillRect(x + random() * 3, y + random() * 3, 0.7, 0.7);
          }
        }
      }
    };
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  });
</script>

<canvas class="resonance" bind:this={canvas} aria-hidden="true"></canvas>
