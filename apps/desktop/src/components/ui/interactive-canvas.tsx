import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface InteractiveCanvasProps {
  gridWidth?: number;
  gridHeight?: number;
  dotColor?: string;
  lineColor?: string;
  backgroundColor?: string;
  padding?: number;
  maxDistance?: number;
  dotSizeMultiplier?: number;
  className?: string;
}

export function InteractiveCanvas({
  gridWidth = 28,
  gridHeight = 20,
  dotColor,
  lineColor,
  backgroundColor = "transparent",
  padding = 8,
  maxDistance = 2,
  dotSizeMultiplier = 36,
  className,
}: InteractiveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let frame = 0;
    let lastFrame = 0;
    let visible = true;
    let pointer: { x: number; y: number } | null = null;
    let dots: { x: number; y: number }[] = [];
    let fill = "";
    let stroke = "";

    const draw = (time: number) => {
      ctx.clearRect(0, 0, width, height);
      if (backgroundColor !== "transparent") {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, width, height);
      }
      const phase = motion.matches ? 0 : time / 2400;
      const focus = pointer ?? {
        x: width * (0.5 + Math.sin(phase) * 0.3),
        y: height * (0.5 + Math.cos(phase * 0.7) * 0.25),
      };
      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.6;
      for (const dot of dots) {
        const dx = focus.x - dot.x;
        const dy = focus.y - dot.y;
        const distance = Math.hypot(dx, dy);
        const influence = Math.max(0, 1 - distance / 160);
        const shift = motion.matches
          ? 0
          : Math.min(Math.max(0, maxDistance), distance) * influence;
        const x = dot.x + (distance ? (dx / distance) * shift : 0);
        const y = dot.y + (distance ? (dy / distance) * shift : 0);
        ctx.globalAlpha = 0.4 + influence * 0.6;
        ctx.beginPath();
        ctx.moveTo(dot.x, dot.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(
          x,
          y,
          Math.min(
            1.5,
            0.55 + (influence * Math.max(0, dotSizeMultiplier)) / 100,
          ),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    const animate = (time: number) => {
      if (time - lastFrame >= 1000 / 30) {
        draw(time);
        lastFrame = time;
      }
      frame = requestAnimationFrame(animate);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!visible || document.hidden || !width || !height) return;
      draw(performance.now());
      if (!motion.matches) frame = requestAnimationFrame(animate);
    };
    const resize = () => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const style = getComputedStyle(canvas);
      fill = dotColor ?? style.getPropertyValue("--thinking-dot").trim();
      stroke = lineColor ?? style.getPropertyValue("--thinking-line").trim();
      const inset = Math.max(0, Math.min(padding, width / 2, height / 2));
      const columns = Math.max(
        2,
        Math.min(60, Math.floor(gridWidth), Math.floor(width / 14)),
      );
      const rows = Math.max(
        2,
        Math.min(60, Math.floor(gridHeight), Math.floor(height / 14)),
      );
      dots = Array.from({ length: columns * rows }, (_, i) => ({
        x: inset + ((i % columns) * (width - inset * 2)) / (columns - 1),
        y:
          inset + (Math.floor(i / columns) * (height - inset * 2)) / (rows - 1),
      }));
      restart();
    };
    const move = (event: PointerEvent) => {
      if (motion.matches || !visible) return;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      pointer =
        x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
          ? { x, y }
          : null;
    };
    const leave = () => {
      pointer = null;
    };
    const observer = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      restart();
    });
    observer.observe(canvas);
    intersection.observe(canvas);
    resize();
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("blur", leave);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", restart);
    motion.addEventListener("change", restart);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      intersection.disconnect();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("blur", leave);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", restart);
      motion.removeEventListener("change", restart);
    };
  }, [
    gridWidth,
    gridHeight,
    dotColor,
    lineColor,
    backgroundColor,
    padding,
    maxDistance,
    dotSizeMultiplier,
  ]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "interactive-canvas pointer-events-none absolute inset-0 block size-full",
        className,
      )}
    />
  );
}
