import { useEffect, useRef } from "react";
import { TEXTS } from "@/lib/texts";

/** Scan animation: a ring travels along a figure eight, a smaller ring follows with a lag. No text. */
export function ScanAnim() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const u = w / 50; // 1 enhet = 2 % av bredden
    const TAU = Math.PI * 2;
    const lw = 1.8 / u; // streckets tjocklek i px, oberoende av storlek
    const pos = (v: number) => [12 * Math.sin(v), 6 * Math.sin(2 * v)];
    const ring = (x: number, y: number, r: number, a: number) => {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.strokeStyle = `rgba(245,237,220,${a})`;
      ctx.lineWidth = lw;
      ctx.stroke();
    };
    let raf = 0;
    const draw = (now: number) => {
      const v = ((now / 1000) * TAU) / 4;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(dpr * u, 0, 0, dpr * u, (dpr * w) / 2, (dpr * h) / 2);
      const b = pos(v - 0.55);
      const a = pos(v);
      ring(b[0], b[1], 2.4, 0.6);
      ring(a[0], a[1], 4, 0.9);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={ref} role="status" aria-label={TEXTS.app.scanning} style={{ width: "70cqw", height: "40cqw" }} />;
}
